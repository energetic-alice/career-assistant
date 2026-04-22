import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MarketIndex } from "../schemas/market-index.js";

/**
 * Mine category→category transitions from the expert-reviewed matrix in
 * `app/src/prompts/training-examples.md`.
 *
 * Input: slug annotations block in training-examples.md with columns:
 *   # | current_slug | t1_slug | t1_pct | t2_slug | t2_pct | t3_slug | t3_pct
 *
 * Output:
 *   - app/src/data/category-transitions.json — raw & aggregated transition stats
 *   - app/src/data/category-bridge.generated.ts — TS module with final matrix
 *     (Bayesian smoothing over PRIOR_BRIDGE, k=3)
 *
 * Run with:
 *   pnpm tsx app/src/scripts/mine-transitions.ts
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const MATRIX_PATH = join(__dirname, "..", "prompts", "training-examples.md");
const INDEX_PATH = join(__dirname, "..", "..", "data", "market-index.json");
const TRANSITIONS_OUT = join(__dirname, "..", "data", "category-transitions.json");
const BRIDGE_OUT = join(__dirname, "..", "data", "category-bridge.generated.ts");

// Bayesian smoothing constant (prior weight in virtual observations).
// empirical_sum + prior*K  /  n + K
const SMOOTHING_K = 3;

// Priors are transcribed from the historical hand-tuned CATEGORY_BRIDGE.
// They are kept here so mine-transitions.ts is the single source of truth
// for the generated bridge file. Keep this in sync if priors ever change.
const PRIOR_BRIDGE: Record<string, Record<string, number>> = {
  backend: { frontend: 55, fullstack: 70, data: 55, devops: 45, mobile: 35, qa: 40, architecture: 65, analysis: 40 },
  frontend: { backend: 55, fullstack: 70, mobile: 45, design: 40, qa: 40 },
  fullstack: { backend: 70, frontend: 70, mobile: 50 },
  mobile: { frontend: 45, backend: 35, design: 40, gamedev: 45 },
  devops: { backend: 45, data: 40, security: 55, infra: 70, support: 50, architecture: 55 },
  data: { analytics: 75, backend: 55, devops: 40 },
  analytics: { data: 75, management: 45, analysis: 55, marketing: 45 },
  analysis: { analytics: 55, management: 60, design: 40, backend: 40 },
  management: { analysis: 60, analytics: 45, design: 40, architecture: 65, hr: 40, marketing: 50 },
  architecture: { management: 65, backend: 65, devops: 55, analysis: 45 },
  security: { devops: 55, backend: 40, infra: 50 },
  infra: { devops: 70, support: 55, security: 50 },
  support: { infra: 55, devops: 50, hr: 35 },
  qa: { backend: 40, frontend: 40, mobile: 35 },
  design: { frontend: 40, mobile: 40, management: 40, marketing: 40 },
  hr: { management: 40, marketing: 35, docs: 30 },
  marketing: { management: 50, hr: 35, analytics: 45, design: 40 },
  docs: { analysis: 40, hr: 30 },
  gamedev: { mobile: 45, frontend: 35, backend: 30 },
  other: {},
};

interface Case {
  idx: number;
  currentSlug: string | null;
  targets: Array<{ slug: string | null; pct: number | null }>;
}

interface RawObs {
  caseIdx: number;
  fromSlug: string;
  toSlug: string;
  fromCategory: string;
  toCategory: string;
  pct: number;
}

interface PairStats {
  n: number;
  sum: number;
  mean: number;
  cases: string[];
}

// ---------------------------------------------------------------------------
// 1. Parse slug-annotation table from training-examples.md
// ---------------------------------------------------------------------------

function parseCases(md: string): Case[] {
  const lines = md.split("\n");
  const headerIdx = lines.findIndex((l) =>
    l.includes("| # | current_slug |") && l.includes("t1_slug"),
  );
  if (headerIdx === -1) {
    throw new Error("slug-annotation table not found in training-examples.md");
  }

  const cases: Case[] = [];
  // skip header + separator
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("|")) break;
    const cells = line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length < 8) continue;

    const [idxStr, current, t1s, t1p, t2s, t2p, t3s, t3p] = cells;
    const caseIdx = Number(idxStr);
    if (!Number.isFinite(caseIdx)) continue;

    cases.push({
      idx: caseIdx,
      currentSlug: normalizeSlug(current),
      targets: [
        { slug: normalizeSlug(t1s), pct: parsePct(t1p) },
        { slug: normalizeSlug(t2s), pct: parsePct(t2p) },
        { slug: normalizeSlug(t3s), pct: parsePct(t3p) },
      ],
    });
  }
  return cases;
}

function normalizeSlug(s: string): string | null {
  const v = s.trim();
  if (!v || v === "-" || v.toLowerCase() === "null") return null;
  return v;
}

function parsePct(s: string): number | null {
  const v = s.trim();
  if (!v || v === "-") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// 2. Convert cases → category-level observations
// ---------------------------------------------------------------------------

function buildObservations(cases: Case[], index: MarketIndex): {
  raw: RawObs[];
  skipped: Array<{ caseIdx: number; reason: string }>;
} {
  const raw: RawObs[] = [];
  const skipped: Array<{ caseIdx: number; reason: string }> = [];

  for (const c of cases) {
    if (!c.currentSlug) {
      skipped.push({ caseIdx: c.idx, reason: "non-IT current (null)" });
      continue;
    }
    const fromEntry = index[c.currentSlug];
    if (!fromEntry) {
      skipped.push({ caseIdx: c.idx, reason: `unknown current slug: ${c.currentSlug}` });
      continue;
    }

    for (const t of c.targets) {
      if (!t.slug || t.pct === null) continue;
      const toEntry = index[t.slug];
      if (!toEntry) {
        skipped.push({ caseIdx: c.idx, reason: `unknown target slug: ${t.slug}` });
        continue;
      }
      raw.push({
        caseIdx: c.idx,
        fromSlug: c.currentSlug,
        toSlug: t.slug,
        fromCategory: fromEntry.category,
        toCategory: toEntry.category,
        pct: t.pct,
      });
    }
  }
  return { raw, skipped };
}

// ---------------------------------------------------------------------------
// 3. Aggregate by (fromCategory, toCategory)
// ---------------------------------------------------------------------------

function aggregate(raw: RawObs[]): Record<string, Record<string, PairStats>> {
  const out: Record<string, Record<string, PairStats>> = {};
  for (const o of raw) {
    out[o.fromCategory] ??= {};
    const cell = (out[o.fromCategory][o.toCategory] ??= {
      n: 0, sum: 0, mean: 0, cases: [],
    });
    cell.n += 1;
    cell.sum += o.pct;
    cell.cases.push(`#${o.caseIdx} ${o.fromSlug}→${o.toSlug} (${o.pct}%)`);
  }
  for (const from of Object.keys(out)) {
    for (const to of Object.keys(out[from])) {
      const c = out[from][to];
      c.mean = Math.round(c.sum / c.n);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Bayesian smoothing merge: empirical + prior
// ---------------------------------------------------------------------------

interface MergedCell {
  value: number;
  n: number;
  empiricalMean: number | null;
  prior: number | null;
  cases: string[];
}

function mergeBridge(
  agg: Record<string, Record<string, PairStats>>,
): Record<string, Record<string, MergedCell>> {
  const allFromCats = new Set<string>([
    ...Object.keys(PRIOR_BRIDGE),
    ...Object.keys(agg),
  ]);

  const merged: Record<string, Record<string, MergedCell>> = {};
  for (const from of allFromCats) {
    const priors = PRIOR_BRIDGE[from] ?? {};
    const empirical = agg[from] ?? {};
    const allToCats = new Set<string>([
      ...Object.keys(priors),
      ...Object.keys(empirical),
    ]);

    for (const to of allToCats) {
      if (from === to) continue; // same-category handled by adjacencyComponent (=75)
      const prior = priors[to];
      const emp = empirical[to];
      const n = emp?.n ?? 0;
      const empSum = emp?.sum ?? 0;
      const empMean = emp ? emp.mean : null;

      let value: number;
      if (prior !== undefined && n > 0) {
        value = Math.round((empSum + prior * SMOOTHING_K) / (n + SMOOTHING_K));
      } else if (prior !== undefined) {
        value = prior;
      } else if (n > 0) {
        // no prior — use empirical mean alone (no smoothing toward default)
        value = Math.round(empSum / n);
      } else {
        continue;
      }

      (merged[from] ??= {})[to] = {
        value,
        n,
        empiricalMean: empMean,
        prior: prior ?? null,
        cases: emp?.cases ?? [],
      };
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 5. Serialize outputs
// ---------------------------------------------------------------------------

function toTransitionsJson(
  agg: Record<string, Record<string, PairStats>>,
  raw: RawObs[],
  skipped: Array<{ caseIdx: number; reason: string }>,
): string {
  const payload = {
    generatedAt: new Date().toISOString(),
    smoothingK: SMOOTHING_K,
    totalObservations: raw.length,
    skipped,
    pairs: Object.fromEntries(
      Object.entries(agg)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([from, to]) => [
          from,
          Object.fromEntries(
            Object.entries(to).sort(([a], [b]) => a.localeCompare(b)),
          ),
        ]),
    ),
  };
  return JSON.stringify(payload, null, 2);
}

function toBridgeTs(merged: Record<string, Record<string, MergedCell>>): string {
  const lines: string[] = [];
  lines.push("/* eslint-disable */");
  lines.push("// AUTO-GENERATED by app/src/scripts/mine-transitions.ts");
  lines.push("// Do not edit by hand. Re-run the mining script after changing");
  lines.push("// training-examples.md or PRIOR_BRIDGE.");
  lines.push("//");
  lines.push(`// Smoothing formula: (empirical_sum + prior * ${SMOOTHING_K}) / (n + ${SMOOTHING_K})`);
  lines.push("//");
  lines.push("// Inline comments show: n=observations, emp=empirical mean, prior=hand-tuned prior");
  lines.push("");
  lines.push("export const CATEGORY_BRIDGE: Record<string, Record<string, number>> = {");

  const fromCats = Object.keys(merged).sort();
  for (const from of fromCats) {
    const cells = merged[from];
    const toCats = Object.keys(cells).sort();
    if (toCats.length === 0) {
      lines.push(`  ${from}: {},`);
      continue;
    }
    lines.push(`  ${from}: {`);
    for (const to of toCats) {
      const c = cells[to];
      const parts: string[] = [];
      parts.push(`n=${c.n}`);
      if (c.empiricalMean !== null) parts.push(`emp=${c.empiricalMean}`);
      if (c.prior !== null) parts.push(`prior=${c.prior}`);
      lines.push(`    ${to}: ${c.value}, // ${parts.join(", ")}`);
    }
    lines.push("  },");
  }
  lines.push("};");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const md = await readFile(MATRIX_PATH, "utf-8");
  const index = JSON.parse(await readFile(INDEX_PATH, "utf-8")) as MarketIndex;

  const cases = parseCases(md);
  console.log(`Parsed ${cases.length} cases from training matrix.`);

  const { raw, skipped } = buildObservations(cases, index);
  console.log(`Observations: ${raw.length} valid, ${skipped.length} skipped.`);

  const agg = aggregate(raw);
  const merged = mergeBridge(agg);

  await mkdir(dirname(TRANSITIONS_OUT), { recursive: true });
  await writeFile(TRANSITIONS_OUT, toTransitionsJson(agg, raw, skipped), "utf-8");
  await writeFile(BRIDGE_OUT, toBridgeTs(merged), "utf-8");

  // Coverage report
  const priorPairs = Object.entries(PRIOR_BRIDGE).reduce(
    (n, [_, to]) => n + Object.keys(to).length,
    0,
  );
  const empiricalPairs = Object.entries(agg).reduce(
    (n, [from, to]) =>
      n + Object.keys(to).filter((t) => t !== from).length,
    0,
  );
  const bridgeCells = Object.entries(merged).reduce(
    (n, [_, to]) => n + Object.keys(to).length,
    0,
  );
  console.log("\nCoverage:");
  console.log(`  prior pairs:     ${priorPairs}`);
  console.log(`  empirical pairs: ${empiricalPairs} (cross-category, excl. self)`);
  console.log(`  final bridge:    ${bridgeCells} non-empty cells`);

  // Top-5 largest deltas (empirical vs prior) for sanity check
  interface Delta { from: string; to: string; prior: number; value: number; n: number; emp: number | null }
  const deltas: Delta[] = [];
  for (const [from, cells] of Object.entries(merged)) {
    for (const [to, c] of Object.entries(cells)) {
      if (c.prior !== null && c.n > 0) {
        deltas.push({ from, to, prior: c.prior, value: c.value, n: c.n, emp: c.empiricalMean });
      }
    }
  }
  deltas.sort((a, b) => Math.abs(b.value - b.prior) - Math.abs(a.value - a.prior));
  console.log("\nTop pairs with biggest prior → empirical shift:");
  for (const d of deltas.slice(0, 10)) {
    const dv = d.value - d.prior;
    const sign = dv > 0 ? "+" : "";
    console.log(
      `  ${d.from} → ${d.to}: ${d.prior} → ${d.value} (${sign}${dv}, n=${d.n}, emp=${d.emp})`,
    );
  }

  console.log(`\nWrote ${TRANSITIONS_OUT}`);
  console.log(`Wrote ${BRIDGE_OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
