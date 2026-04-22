import "dotenv/config";
import { rankRoles, type ScoredRole } from "../services/role-scorer.js";
import type { PipelineState } from "../schemas/pipeline-state.js";
import type { ClientSummary } from "../schemas/client-summary.js";

/**
 * Sanity-check role-scorer against all production clients that have a
 * `clientSummary` (with canonical slug'и после Phase 0).
 *
 * Env:
 *   PROD_URL     — override prod base URL (default: career-assistant-w7z3.onrender.com)
 *   SCORER_TOP   — top-N rows per bucket (default 10)
 *   SCORER_LIMIT — process only first N clients
 *   SCORER_NICK  — process only this @nick
 *
 * Никаких записей на prod — только чтение.
 */

const PROD_URL = process.env.PROD_URL || "https://career-assistant-w7z3.onrender.com";
const TOP_N = Number(process.env.SCORER_TOP ?? 10);
const LIMIT = process.env.SCORER_LIMIT ? Number(process.env.SCORER_LIMIT) : undefined;
const NICK_FILTER = (process.env.SCORER_NICK || "").replace(/^@/, "").toLowerCase();

async function fetchProd(): Promise<PipelineState[]> {
  const res = await fetch(`${PROD_URL}/api/participants`);
  if (!res.ok) throw new Error(`GET /api/participants → HTTP ${res.status}`);
  return (await res.json()) as PipelineState[];
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

function fmtRow(i: number, r: ScoredRole): string {
  const tag = r.guaranteed ? " ✱" : "  ";
  const slug = pad(r.slug, 24);
  const score = pad(String(r.score), 4);
  const parts = [
    `m${r.components.market}`,
    `c${r.components.competition ?? "—"}`,
    `s${r.components.salary}`,
    `ai${r.components.aiRisk}`,
    `adj${r.components.adjacency}`,
    `t${r.components.trend ?? "—"}`,
  ];
  const comps = pad(parts.join(" "), 38);
  return `    ${String(i + 1).padStart(2)}. ${tag} ${slug} ${score} ${comps} ${r.reasons.join(", ")}`;
}

function fmtHeader(s: PipelineState, cs: ClientSummary): string {
  const nick = (s.telegramNick || "").replace(/^@/, "") || "—";
  const name = [cs.firstNameLatin, cs.lastNameLatin].filter((x) => x && x !== "—").join(" ")
    || [cs.firstName, cs.lastName].filter((x) => x && x !== "—").join(" ")
    || "—";

  const curSlug = cs.currentProfessionSlug
    ? cs.currentProfessionSlug + (cs.currentProfessionOffIndex ? " ⚠off-index" : "")
    : "<non-IT>";
  const desired = (cs.desiredDirectionSlugs ?? [])
    .map((d) => d.slug + (d.offIndex ? "⚠" : ""))
    .join(", ") || "∅";

  const salaryParts: string[] = [];
  if (cs.currentSalaryRub) salaryParts.push(`curRUB=${cs.currentSalaryRub}`);
  if (cs.currentSalaryEur) salaryParts.push(`curEUR=${cs.currentSalaryEur}`);
  if (cs.desiredSalaryRub) salaryParts.push(`desRUB=${cs.desiredSalaryRub}`);
  if (cs.desiredSalaryEur) salaryParts.push(`desEUR=${cs.desiredSalaryEur}`);
  const salaries = salaryParts.length ? salaryParts.join(" ") : "<no numeric salary>";

  return (
    `\n━━━ @${nick}  ${name}  ━━━\n` +
    `  location: ${cs.location || "—"}  |  citizenships: [${(cs.citizenships ?? []).join(", ") || "—"}]  |  target: [${(cs.targetMarketRegions ?? []).join(", ") || "—"}]  |  access: [${(cs.accessibleMarkets ?? []).join(", ") || "—"}]\n` +
    `  current:  ${cs.currentProfession || "—"}  →  slug: ${curSlug}\n` +
    `  desired:  ${cs.desiredDirections || "—"}  →  slugs: ${desired}\n` +
    `  salary:   ${salaries}`
  );
}

interface Agg {
  total: number;
  withCurrent: number;
  offIndexCurrent: number;
  nonIt: number;
  withDesired: number;
  ruOnly: number;
  abroadOnly: number;
  both: number;
  neither: number;
  noSalary: number;
  slugCounts: Map<string, number>;
  topRuHits: Map<string, number>;
  topAbroadHits: Map<string, number>;
}

function newAgg(): Agg {
  return {
    total: 0,
    withCurrent: 0,
    offIndexCurrent: 0,
    nonIt: 0,
    withDesired: 0,
    ruOnly: 0,
    abroadOnly: 0,
    both: 0,
    neither: 0,
    noSalary: 0,
    slugCounts: new Map(),
    topRuHits: new Map(),
    topAbroadHits: new Map(),
  };
}

function printAggregate(agg: Agg): void {
  console.log(`\n\n━━━━━━━━━━━━━━━ AGGREGATE (${agg.total} clients) ━━━━━━━━━━━━━━━`);
  console.log(
    `  currentSlug: withSlug=${agg.withCurrent}, offIndex=${agg.offIndexCurrent}, non-IT=${agg.nonIt}`,
  );
  console.log(`  desiredSlugs: with=${agg.withDesired}, without=${agg.total - agg.withDesired}`);
  console.log(
    `  buckets: ru-only=${agg.ruOnly}, abroad-only=${agg.abroadOnly}, both=${agg.both}, neither=${agg.neither}`,
  );
  console.log(`  no numeric salary in summary: ${agg.noSalary}`);

  const topCurrent = [...agg.slugCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (topCurrent.length > 0) {
    console.log(`\n  Top current slugs:`);
    for (const [slug, n] of topCurrent) {
      console.log(`    ${pad(slug, 30)} ${n}`);
    }
  }

  const topRu = [...agg.topRuHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (topRu.length > 0) {
    console.log(`\n  Most recommended in RU top-${TOP_N} (excluding guaranteed):`);
    for (const [slug, n] of topRu) {
      console.log(`    ${pad(slug, 30)} ${n}`);
    }
  }

  const topAbr = [...agg.topAbroadHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (topAbr.length > 0) {
    console.log(`\n  Most recommended in ABROAD top-${TOP_N} (excluding guaranteed):`);
    for (const [slug, n] of topAbr) {
      console.log(`    ${pad(slug, 30)} ${n}`);
    }
  }
}

interface CompactRow {
  nick: string;
  current: string;
  desired: string;
  ruTop: string;
  abroadTop: string;
}

function fmtTopCompact(roles: ScoredRole[]): string {
  return roles
    .slice(0, 5)
    .map((r) => `${r.slug}:${r.score}${r.guaranteed ? "*" : ""}`)
    .join(", ");
}

function printCompactTable(rows: CompactRow[]): void {
  if (rows.length === 0) return;
  console.log(`\n\n━━━━━━━━━━━━━━━ COMPACT TABLE (${rows.length} clients) ━━━━━━━━━━━━━━━`);
  console.log(`(* — guaranteed: current/desired; :NN — итоговый скор)\n`);
  console.log(`| @nick | current → desired | RU top-5 | ABROAD top-5 |`);
  console.log(`|---|---|---|---|`);
  for (const r of rows) {
    const path = `${r.current} → ${r.desired}`;
    console.log(`| ${r.nick} | ${path} | ${r.ruTop || "—"} | ${r.abroadTop || "—"} |`);
  }
}

async function main(): Promise<void> {
  console.log(`[Scorer] Fetching prod from ${PROD_URL}`);
  const states = await fetchProd();
  console.log(`[Scorer] Received ${states.length} records`);

  let targets = states.filter((s) => {
    const outs = (s.stageOutputs ?? {}) as Record<string, unknown>;
    return !!outs.clientSummary;
  });

  if (NICK_FILTER) {
    targets = targets.filter((s) => (s.telegramNick || "").replace(/^@/, "").toLowerCase() === NICK_FILTER);
  }
  if (typeof LIMIT === "number" && LIMIT > 0) {
    targets = targets.slice(0, LIMIT);
  }

  console.log(
    `[Scorer] With clientSummary: ${targets.length}` +
      (NICK_FILTER ? ` | nick=${NICK_FILTER}` : "") +
      (typeof LIMIT === "number" ? ` | limit=${LIMIT}` : ""),
  );

  const agg = newAgg();
  const compactRows: CompactRow[] = [];

  for (const s of targets) {
    const outs = s.stageOutputs as Record<string, unknown>;
    const cs = outs.clientSummary as ClientSummary;
    agg.total += 1;

    if (cs.currentProfessionSlug) {
      agg.withCurrent += 1;
      if (cs.currentProfessionOffIndex) agg.offIndexCurrent += 1;
      agg.slugCounts.set(cs.currentProfessionSlug, (agg.slugCounts.get(cs.currentProfessionSlug) ?? 0) + 1);
    } else {
      agg.nonIt += 1;
    }
    if ((cs.desiredDirectionSlugs ?? []).length > 0) agg.withDesired += 1;
    if (
      !cs.currentSalaryRub && !cs.currentSalaryEur &&
      !cs.desiredSalaryRub && !cs.desiredSalaryEur
    ) {
      agg.noSalary += 1;
    }

    try {
      const { ru, abroad, buckets } = await rankRoles(cs, TOP_N);
      if (buckets.ru && buckets.abroad) agg.both += 1;
      else if (buckets.ru) agg.ruOnly += 1;
      else if (buckets.abroad) agg.abroadOnly += 1;
      else agg.neither += 1;

      for (const r of ru) if (!r.guaranteed) agg.topRuHits.set(r.slug, (agg.topRuHits.get(r.slug) ?? 0) + 1);
      for (const r of abroad) if (!r.guaranteed) agg.topAbroadHits.set(r.slug, (agg.topAbroadHits.get(r.slug) ?? 0) + 1);

      console.log(fmtHeader(s, cs));
      console.log(`  buckets: ru=${buckets.ru} abroad=${buckets.abroad}  (${buckets.reason})`);
      if (ru.length) {
        console.log(`  RU top-${ru.length}:`);
        ru.forEach((r, i) => console.log(fmtRow(i, r)));
      } else {
        console.log("  RU: — (bucket off)");
      }
      if (abroad.length) {
        console.log(`  abroad top-${abroad.length}:`);
        abroad.forEach((r, i) => console.log(fmtRow(i, r)));
      } else {
        console.log("  abroad: — (bucket off)");
      }

      compactRows.push({
        nick: "@" + (s.telegramNick || "—").replace(/^@/, ""),
        current: cs.currentProfessionSlug || "<non-IT>",
        desired: (cs.desiredDirectionSlugs ?? []).map((d) => d.slug).join(",") || "∅",
        ruTop: ru.length ? fmtTopCompact(ru) : "— (off)",
        abroadTop: abroad.length ? fmtTopCompact(abroad) : "— (off)",
      });
    } catch (err) {
      console.error(`[Scorer] ✗ @${s.telegramNick}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  printAggregate(agg);
  printCompactTable(compactRows);
}

main().catch((err) => {
  console.error("[Scorer] Fatal:", err);
  process.exit(1);
});
