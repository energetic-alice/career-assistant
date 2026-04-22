import { loadMarketIndex } from "./role-scorer.js";
import type { Direction } from "../schemas/analysis-outputs.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import type { MarketIndexEntry, RegionStats } from "../schemas/market-index.js";
import { computeMarketBuckets } from "./market-buckets.js";
import { KNOWN_ROLES, type KnownRoleSlug } from "./known-roles.js";

/**
 * «Широкие» slug'и — их каталожная запись на деле покрывает семейство
 * близких, но разных ниш; для клиента на верхних грейдах полезно видеть
 * несколько direction'ов с одним slug (AppSec + DevSecOps + Cloud Sec —
 * все infosecspec, но для senior-клиента это реально разные карьерные треки).
 *
 * Для этих slug разрешаем до `MAX_DUPES_IN_FAMILY` directions. Для остальных —
 * строго один, как раньше.
 */
const WIDE_FAMILY_SLUGS: ReadonlySet<string> = new Set([
  "infosecspec",
  "devops",
  "data_engineer",
  "ml_engineer",
  "marketing_manager",
  "product_manager",
  "ui_ux_designer",
  "fullstack",
]);
const MAX_DUPES_IN_FAMILY = 3;

/**
 * Post-validate directions returned by Claude in prompt-02:
 *  - drops empty roleSlug
 *  - drops roles with aiRisk === "extreme" (lookup via market-index)
 *  - drops off-index roles without marketEvidence
 *  - для обычных slug: drops duplicates (keeps first occurrence)
 *  - для WIDE_FAMILY_SLUGS (infosecspec/devops/data_engineer/ml_engineer/
 *    marketing_manager/product_manager/ui_ux_designer/fullstack) разрешаем
 *    до MAX_DUPES_IN_FAMILY направлений с одним slug (разные ниши одного семейства)
 *  - normalises offIndex flag based on KNOWN_ROLES membership
 *  - junior level → warning (клиент мог явно попросить)
 *  - для type="краткосрочный мост":
 *      - если bridgeTo не указан → downgrade в "запасной вариант" с warn
 *      - если bridgeTo указывает на несуществующую в списке долгосрочную ставку
 *        → downgrade в "запасной вариант" с warn
 *
 * Returns a NEW array (does not mutate input).
 */
export async function postValidateDirections(
  directions: Direction[],
  _opts?: { targetMarketRegions?: string[] },
): Promise<Direction[]> {
  const index = await loadMarketIndex();
  const knownSet: Set<string> = new Set(KNOWN_ROLES);
  const slugCounts = new Map<string, number>();
  const firstPass: Direction[] = [];

  const JUNIOR_RE = /[\s,()\[\]\-]+junior[\s,()\[\]\-]*/i;

  for (const orig of directions) {
    const d: Direction = { ...orig };
    const slug = (d.roleSlug || "").trim();

    if (!slug) {
      console.warn(`[postValidate] DROP "${d.title}": empty roleSlug`);
      continue;
    }

    const entry = index[slug] || null;
    if (entry && entry.aiRisk === "extreme") {
      console.warn(`[postValidate] DROP "${d.title}" (slug=${slug}): aiRisk=extreme`);
      continue;
    }

    if (knownSet.has(slug)) {
      d.offIndex = false;
    } else if (d.offIndex && d.marketEvidence && d.marketEvidence.trim().length > 0) {
      console.log(`[postValidate] off-index OK: ${slug} ("${d.title}")`);
    } else {
      console.warn(
        `[postValidate] DROP "${d.title}" (slug=${slug}): unknown slug without offIndex+marketEvidence`,
      );
      continue;
    }

    const count = slugCounts.get(slug) ?? 0;
    const limit = WIDE_FAMILY_SLUGS.has(slug) ? MAX_DUPES_IN_FAMILY : 1;
    if (count >= limit) {
      console.warn(
        `[postValidate] DROP "${d.title}": duplicate roleSlug=${slug} (уже ${count}, лимит ${limit})`,
      );
      continue;
    }
    slugCounts.set(slug, count + 1);

    if (JUNIOR_RE.test(d.title)) {
      console.warn(`[postValidate] WARN junior level in title "${d.title}" (допустимо ТОЛЬКО если клиент явно просил)`);
    }

    firstPass.push(d);
  }

  // ── second pass: validate bridge links across the whole array ──
  // Мост может указывать на "основной трек" ИЛИ "долгосрочную ставку" —
  // это целевые, "куда ведёт мост". НЕ на "запасной вариант" (альтернатива,
  // не цель) и НЕ на другой "мост".
  const validBridgeTargets = new Set(
    firstPass
      .filter((d) => d.type === "основной трек" || d.type === "долгосрочная ставка")
      .map((d) => d.roleSlug),
  );
  for (const d of firstPass) {
    if (d.type !== "краткосрочный мост") {
      if (d.bridgeTo) {
        console.warn(
          `[postValidate] "${d.title}": bridgeTo="${d.bridgeTo}" указан, но type="${d.type}" — игнорируется`,
        );
        d.bridgeTo = undefined;
      }
      continue;
    }
    const target = (d.bridgeTo || "").trim();
    if (!target) {
      console.warn(
        `[postValidate] DOWNGRADE "${d.title}" (slug=${d.roleSlug}): мост без bridgeTo → "запасной вариант"`,
      );
      d.type = "запасной вариант";
      continue;
    }
    if (!validBridgeTargets.has(target)) {
      console.warn(
        `[postValidate] DOWNGRADE "${d.title}" (slug=${d.roleSlug}): bridgeTo="${target}" не указывает на "основной трек"/"долгосрочная ставка" из списка → "запасной вариант"`,
      );
      d.type = "запасной вариант";
      d.bridgeTo = undefined;
    }
  }

  return firstPass;
}

/**
 * Enrichment = lookup LLM-generated `Direction` against the pre-scraped
 * `market-index.json` (single source of truth, no markdown re-parsing).
 *
 * Each row gets either:
 *   - source: "market-index"  — entry found, stats filled for the chosen bucket
 *   - source: "off-index"     — direction.offIndex === true, stats null/evidence kept
 *   - source: "missing"       — slug not in index AND not flagged off-index
 *                               (= post-validation error in run-analysis)
 */

export type EnrichSource = "market-index" | "off-index" | "missing";
export type EnrichBucket = "ru" | "abroad";

export interface EnrichedDirection {
  /** Index in original `directions` array. */
  index: number;
  title: string;
  roleSlug: string;
  /** True if slug is a canonical `KNOWN_ROLES` slug. */
  knownRole: boolean;
  offIndex: boolean;
  marketEvidence?: string;
  source: EnrichSource;

  /** Which bucket was used for salary/vacancy fill. */
  bucket: EnrichBucket | null;

  /** Values from market-index for the chosen bucket (null if off-index). */
  vacancies: number | null;
  medianSalaryMid: number | null;
  aiRisk: MarketIndexEntry["aiRisk"] | null;
  competitionPer100: number | null;
  trendRatio: number | null;

  /** Raw market-index entry for downstream use (prompt-03, UI). */
  entry: MarketIndexEntry | null;
}

function pickBucket(
  summary: ClientSummary,
): EnrichBucket | null {
  const buckets = computeMarketBuckets(summary);
  if (buckets.ru && buckets.abroad) {
    // Prefer ru when both available (client usually skews to home market).
    return "ru";
  }
  if (buckets.ru) return "ru";
  if (buckets.abroad) return "abroad";
  return null;
}

function bucketStats(entry: MarketIndexEntry, bucket: EnrichBucket): RegionStats | null {
  if (bucket === "ru") return entry.ru ?? null;
  // abroad и usa в enrichment идут через UK/EU-статистику; для USA
  // зарплатный коэффициент ×1.5 применяется в scorer'е отдельно.
  return entry.uk ?? entry.eu ?? entry.us ?? null;
}

/**
 * Enrich LLM-generated directions with market-index data.
 *
 * @param directions array of `Direction` from prompt-02 output
 * @param summary    clientSummary used to pick RU vs abroad bucket
 */
export async function enrichDirections(
  directions: Direction[],
  summary: ClientSummary,
): Promise<EnrichedDirection[]> {
  const index = await loadMarketIndex();
  const knownSet: Set<string> = new Set(KNOWN_ROLES);
  const bucket = pickBucket(summary);

  return directions.map((d, i) => {
    const slug = d.roleSlug?.trim() ?? "";
    const entry = slug && index[slug] ? index[slug] : null;
    const known = knownSet.has(slug);
    const offIndex = Boolean(d.offIndex);

    let source: EnrichSource;
    if (entry) {
      source = "market-index";
    } else if (offIndex) {
      source = "off-index";
    } else {
      source = "missing";
    }

    const stats = entry && bucket ? bucketStats(entry, bucket) : null;

    return {
      index: i,
      title: d.title,
      roleSlug: slug,
      knownRole: known,
      offIndex,
      marketEvidence: d.marketEvidence,
      source,
      bucket,
      vacancies: stats?.vacancies ?? null,
      medianSalaryMid: stats?.medianSalaryMid ?? null,
      aiRisk: entry?.aiRisk ?? null,
      competitionPer100: stats?.competitionPer100Specialists ?? null,
      trendRatio: stats?.trend?.ratio ?? null,
      entry,
    };
  });
}

export function formatEnrichedForLog(rows: EnrichedDirection[]): string {
  if (rows.length === 0) return "(пусто)";
  const lines = rows.map((r) => {
    const vac = r.vacancies !== null ? `${r.vacancies} вак` : "—";
    const sal = r.medianSalaryMid !== null ? `med=${r.medianSalaryMid}` : "—";
    const ai = r.aiRisk ?? "—";
    const src =
      r.source === "market-index"
        ? "✓index"
        : r.source === "off-index"
        ? "⚠off-index"
        : "✗missing";
    return `  ${r.index + 1}. [${src}] ${r.roleSlug || "(no slug)"} — ${r.title} · ${vac} · ${sal} · ai=${ai}`;
  });
  return lines.join("\n");
}
