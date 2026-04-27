import { loadMarketIndex } from "./role-scorer.js";
import type { Direction } from "../schemas/analysis-outputs.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import type { MarketIndexEntry, RegionStats } from "../schemas/market-index.js";
import { KNOWN_ROLES, type KnownRoleSlug } from "./known-roles.js";
import { canonicalizeRoleSlug, matchRoleToSlug } from "./role-matcher.js";

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
    let slug = (d.roleSlug || "").trim();

    if (!slug) {
      console.warn(`[postValidate] DROP "${d.title}": empty roleSlug`);
      continue;
    }

    // Канонизация slug'а: Claude часто придумывает свои варианты вроде
    // `fullstack_react_node`, `frontend_react_typescript`, `data_engineer_python` —
    // которые не попадают в KNOWN_ROLES и market-index, поэтому direction уходит
    // в off-index или дропается. Пробуем мапить через role-matcher (alias hits +
    // substring + fuzzy). Если нашли канонический slug с хорошим confidence —
    // подменяем. Это ставит direction на канонические рельсы (с реальными
    // данными рынка из market-index) и снимает лишний поход в Perplexity.
    if (!knownSet.has(slug)) {
      const directCanonical = canonicalizeRoleSlug(slug);
      if (directCanonical) {
        console.log(
          `[postValidate] canonical slug override ${slug} → ${directCanonical} ` +
            `(title "${d.title}")`,
        );
        slug = directCanonical;
        d.roleSlug = directCanonical;
        d.offIndex = false;
        d.marketEvidence = undefined;
      }
    }

    if (!knownSet.has(slug)) {
      const candidates = [
        slug.replace(/[_\-]+/g, " "),
        d.title,
        `${slug.replace(/[_\-]+/g, " ")} ${d.title}`,
      ];
      let normalized: string | null = null;
      let normalizedAlias = "";
      let normalizedConf = 0;
      for (const probe of candidates) {
        const hit = await matchRoleToSlug(probe);
        if (!hit || hit.confidence < 0.85) continue;
        if (!knownSet.has(hit.slug)) continue;
        if (hit.confidence > normalizedConf) {
          normalized = hit.slug;
          normalizedAlias = hit.matchedAlias;
          normalizedConf = hit.confidence;
        }
      }
      if (normalized && normalized !== slug) {
        console.log(
          `[postValidate] normalize slug ${slug} → ${normalized} ` +
            `(conf ${normalizedConf}, alias "${normalizedAlias}", title "${d.title}")`,
        );
        slug = normalized;
        d.roleSlug = normalized;
        d.offIndex = false;
        d.marketEvidence = undefined;
      }
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

/**
 * Источник данных в EnrichedDirection после Phase 2 enrichment.
 *
 * - `market-index`        — данные из локальной KB (надёжно, наш датасет).
 * - `perplexity`          — заполнено через Perplexity Sonar с URL-citations.
 * - `perplexity-estimate` — Perplexity дал оценку по аналогии (низкая уверенность).
 * - `claude`              — заполнено через Claude + web_search, citations прошли relevance-gate.
 * - `claude-estimate`     — Claude вернул confidence=low ИЛИ citations не прошли relevance-gate.
 * - `itjw-canonical`      — Phase 2 niche-resolver нашёл per-niche row в основной
 *                            таблице `<region>_<slug>.md` (через alias или
 *                            scoring fallback). Надёжно, тот же источник что
 *                            market-index.
 * - `itjw-live`           — Phase 2 niche-resolver на лету заскрейпил
 *                            itjobswatch (alias miss + scoring miss). Данные
 *                            одноразовые, не сохраняются в md.
 * - `none`                — данных нет ни в KB, ни provider не помог. Phase 3 разбирается вручную.
 *
 * Для Phase 1 enriched (до Phase 2) поле всегда либо `market-index`, либо `none`.
 */
export type EnrichDataSource =
  | "market-index"
  | "perplexity"
  | "perplexity-estimate"
  | "claude"
  | "claude-estimate"
  | "itjw-canonical"
  | "itjw-live"
  | "none";

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

  /**
   * Phase 2: источник данных (market-index по умолчанию, perplexity/claude
   * после успешного дозаполнения, none если данных нет).
   */
  dataSource: EnrichDataSource;
  /**
   * URL-citations от внешнего провайдера (Perplexity/Claude). Поле сохранило
   * старое имя для обратной совместимости со state-файлами на проде; новое
   * заполнение пишет сюда же независимо от провайдера.
   */
  perplexityCitations?: string[];
  /** Reasoning от провайдера (часто только для оценок по аналогии). */
  perplexityReasoning?: string;
}

/**
 * Маппинг bucket'а КОНКРЕТНОГО направления (из Direction.bucket, его
 * поставил Claude в Phase 1) на bucket, которым мы тянем stats из
 * market-index: "usa" → "abroad" (USA-коэффициент ×1.5 применяется
 * отдельно в scorer-е). "ru" / "abroad" — 1-к-1.
 *
 * ВАЖНО: раньше был единый `pickBucket(summary)` для ВСЕГО клиента
 * (prefer "ru"), из-за чего у Алисы (access=[ru,eu,uk], target=[eu,uk])
 * все abroad-направления Claude'а обогащались RU-данными: Full-Stack
 * показывал vacancies=280 (RU) и medianSalary=270000 (RUB/мес как "€270k"),
 * вместо UK-цифр 876/£70k. Теперь enrichment идёт per-direction.
 */
function bucketStats(
  entry: MarketIndexEntry,
  bucket: Direction["bucket"],
): RegionStats | null {
  if (bucket === "ru") return entry.ru ?? null;
  // abroad и usa — UK/EU/US-статистика как proxy. USA-адъюстмент ×1.5
  // применяется в scorer-е (см. `roleSalaryForClient`), enricher здесь
  // зовётся для UI-цифр и делает только прямой lookup.
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
  _summary: ClientSummary,
): Promise<EnrichedDirection[]> {
  const index = await loadMarketIndex();
  const knownSet: Set<string> = new Set(KNOWN_ROLES);

  return directions.map((d, i) => {
    const rawSlug = d.roleSlug?.trim() ?? "";
    const slug = canonicalizeRoleSlug(rawSlug) ?? rawSlug;
    const entry = slug && index[slug] ? index[slug] : null;
    const known = knownSet.has(slug);
    const offIndex = known ? false : Boolean(d.offIndex);

    let source: EnrichSource;
    if (entry) {
      source = "market-index";
    } else if (offIndex) {
      source = "off-index";
    } else {
      source = "missing";
    }

    // Per-direction bucket: Claude в Phase 1 сам расставляет "ru"|"abroad"|"usa"
    // для каждой роли. Соответствие stats-источнику: ru→entry.ru; abroad/usa →
    // entry.uk (fallback на eu/us). Нельзя выбрать единый bucket для клиента —
    // у мульти-рынка клиента (Алиса: ru+eu+uk) направления должны показывать
    // СВОЮ рыночную цифру, а не RU-подмену.
    const stats = entry ? bucketStats(entry, d.bucket) : null;
    // Для отчётности в EnrichedDirection.bucket сохраняем enrichment-bucket
    // ("usa" нормализуем в "abroad" — это он и есть по данным).
    const enrichBucket: EnrichBucket = d.bucket === "ru" ? "ru" : "abroad";

    // dataSource: для baseline (Phase 1) — market-index если есть данные,
    // иначе none. Phase 2 enrichGapsForClient может пометить perplexity*.
    const hasAnyValue =
      stats?.vacancies !== undefined ||
      stats?.medianSalaryMid !== undefined ||
      entry?.aiRisk !== undefined;
    const dataSource: EnrichDataSource = hasAnyValue ? "market-index" : "none";

    return {
      index: i,
      title: d.title,
      roleSlug: slug,
      knownRole: known,
      offIndex,
      marketEvidence: d.marketEvidence,
      source,
      bucket: enrichBucket,
      vacancies: stats?.vacancies ?? null,
      medianSalaryMid: stats?.medianSalaryMid ?? null,
      aiRisk: entry?.aiRisk ?? null,
      competitionPer100: stats?.competitionPer100Specialists ?? null,
      trendRatio: stats?.trend?.ratio ?? null,
      entry,
      dataSource,
    };
  });
}

/**
 * Renders Phase 2 EnrichedDirection[] in a markdown shape suitable for
 * substitution into prompt-03's `{{marketData}}` slot. Replaces the
 * `formattedText` from Perplexity Step 5 when caller has decided to skip
 * Step 5 (`runDeepFromShortlist({ skipPerplexityStep5: true })`).
 *
 * Goal: keep prompt-03 stable, but feed it data that already passed the
 * relevance gate. Each direction gets a clear source badge so Claude in
 * Step 6 knows which numbers to lean on and which to treat as estimates.
 */
export function formatEnrichedAsMarketData(rows: EnrichedDirection[]): string {
  if (rows.length === 0) return "Данные рынка не предоставлены.";

  const lines: string[] = [];
  lines.push("# Данные рынка по направлениям (Phase 2 enrichment)\n");
  lines.push(
    "Источники: `[m]` market-index (наша KB), `[p]` Perplexity, `[~p]` Perplexity-estimate, " +
      "`[c]` Claude+web_search, `[~c]` Claude-estimate, " +
      "`[itjw]` itjobswatch canonical, `[itjw·live]` itjw live-scraped, `[?]` нет данных.\n",
  );

  for (const r of rows) {
    const badge = sourceBadge(r.dataSource);
    const title = `## ${badge} ${r.title || r.roleSlug}`;
    lines.push(title);
    lines.push(`- slug: \`${r.roleSlug}\`${r.offIndex ? " (off-index)" : ""}`);
    lines.push(`- bucket: ${r.bucket ?? "—"}`);
    // competition/100 — точная метрика только для RU (расчёт hh.ru вакансий/резюме).
    // Для bucket=abroad число в market-index приходит из competition-eu.md
    // (оценочное ratio LinkedIn/ITJW), и подавать его модели как факт не стоит —
    // см. user-rule «оставим только где они реально есть из данных рынка».
    const compPart =
      r.bucket === "ru" && r.competitionPer100 !== null
        ? ` · competition/100 (hh.ru): ${r.competitionPer100.toFixed(1)}`
        : "";
    lines.push(
      `- vacancies: ${fmtNum(r.vacancies)} · medianSalary: ${fmtNum(r.medianSalaryMid)}${compPart}`,
    );
    lines.push(
      `- aiRisk: ${r.aiRisk ?? "—"} · trend: ${r.trendRatio !== null ? `${((r.trendRatio - 1) * 100).toFixed(0)}%` : "—"}`,
    );
    if (r.perplexityReasoning) {
      lines.push(`- reasoning: ${r.perplexityReasoning}`);
    }
    if (r.perplexityCitations && r.perplexityCitations.length > 0) {
      lines.push(`- sources:`);
      for (const c of r.perplexityCitations.slice(0, 5)) {
        lines.push(`  - ${c}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function sourceBadge(src: EnrichDataSource): string {
  switch (src) {
    case "market-index": return "[m]";
    case "perplexity": return "[p]";
    case "perplexity-estimate": return "[~p]";
    case "claude": return "[c]";
    case "claude-estimate": return "[~c]";
    case "itjw-canonical": return "[itjw]";
    case "itjw-live": return "[itjw·live]";
    case "none": return "[?]";
    default: return "[ ]";
  }
}

function fmtNum(n: number | null): string {
  return n === null ? "—" : String(n);
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
