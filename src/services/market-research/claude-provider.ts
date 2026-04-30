/**
 * ClaudeWebSearchProvider — Phase 2 enrichment через Claude Sonnet с
 * server-side `web_search_20250305` tool.
 *
 * Архитектура:
 *   - Per-direction параллельные вызовы (concurrency limit = 3) вместо batch.
 *     Так Claude фокусируется на одной нише за раз, и web_search не
 *     перемешивает результаты для нескольких ролей с одним slug.
 *   - Custom tool `extract_market_data` для structured output (как с Sonar
 *     JSON-schema).
 *   - Allowlist источников через `allowed_domains` в web_search-tool.
 *   - Cache (14 дней) по `directionKey + region + grade`.
 *   - Validate-gate релевантности citations через `validate-relevance.ts`.
 *
 * Прямой fetch к Anthropic API (а не SDK) — потому что v0.39 SDK не знает
 * про server-side `web_search_20250305` tool, и мы не хотим обновлять
 * мажор только ради этого.
 */

import { createHash } from "node:crypto";
import type { Direction, Region } from "../../schemas/analysis-outputs.js";
import type { ClientSummary } from "../../schemas/client-summary.js";
import { resolveClientGrade } from "../client-grade.js";
import { directionKey } from "../deep-research-service.js";
import type { EnrichDataSource, EnrichedDirection } from "../direction-enricher.js";
import { loadMap, saveMap } from "../state-store.js";
import type {
  MarketResearchEnrichArgs,
  MarketResearchProvider,
} from "./provider.js";
import { resolveCorrectedSlug } from "./slug-validator.js";
import { resolveNiche, type ResolvedNiche } from "./niche-resolver.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.MARKET_RESEARCH_CLAUDE_MODEL || "claude-sonnet-4-20250514";
const ANTHROPIC_VERSION = "2023-06-01";
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const CACHE_STORE_NAME = "claude-market-research-cache";
const CACHE_VERSION = "v5-niche-aliases";
const CONCURRENCY = 3;
const WEB_SEARCH_MAX_USES = 5;
const MAX_TOKENS = 4096;

// Allowlist для web_search. Совпадает с Sonar-промптом, плюс пара национальных
// доменов которые Claude может пропустить без явного хинта.
// NB: некоторые сайты Anthropic web_search crawler блокирует robots.txt-ом.
// Эмпирически (HTTP 400 при `allowed_domains`):
//   - stackoverflow.com / stackoverflow.blog
//   - kununu.com
// Не добавляй сюда домены не проверив — один забанённый домен валит весь call.
const ALLOWED_DOMAINS: ReadonlyArray<string> = [
  // Job boards
  "itjobswatch.co.uk",
  "indeed.com",
  "reed.co.uk",
  "totaljobs.co.uk",
  "stepstone.de",
  "stepstone.fr",
  "talent.com",
  "ziprecruiter.com",
  "welcometothejungle.com",
  "jobs.ch",
  "hh.ru",
  "hh.kz",
  "habr.com",
  "career.habr.com",
  "djinni.co",
  "linkedin.com",
  // Salary aggregators
  "glassdoor.com",
  "levels.fyi",
  "payscale.com",
  "salary.com",
  "salaryexpert.com",
  "salaries.dev",
  "trueup.io",
  // Surveys / stats
  "developer-survey.com",
  "eurostat.ec.europa.eu",
  "oecd.org",
  "bls.gov",
];

// ─── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  fill: ValidatedClaudeFill;
  fetchedAt: string;
}

const cache: Map<string, CacheEntry> = loadMap<CacheEntry>(CACHE_STORE_NAME);

function getCached(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  const age = Date.now() - new Date(entry.fetchedAt).getTime();
  if (age > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function setCache(key: string, fill: ValidatedClaudeFill): void {
  cache.set(key, { fill, fetchedAt: new Date().toISOString() });
  saveMap(CACHE_STORE_NAME, cache);
}

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Что нам нужно от Claude в v3:
 *  - подтверждение что найденная itjobswatch-ниша (`resolverMatchedTitle`) реально
 *    соответствует direction-у (`matchAccepted: true/false`); если false —
 *    Claude должен пояснить ПОЧЕМУ.
 *  - regional salary (annual gross USD) — для всех target-регионов кроме
 *    UK/EU/global (их покрывает niche-resolver UK-данными) и RU/CIS (отдельно).
 *  - AI risk — Claude оценивает per-direction всегда (наш market-index содержит
 *    aggregate AI risk, и для sub-niche он менее точен).
 *
 * Vacancies / trend / UK-salary — берём из niche-resolver-а напрямую,
 * Claude к ним не возвращается.
 */
interface ClaudeFillRaw {
  matchAccepted: boolean;
  matchRejectionReason?: string;
  /** Annual gross USD на effective-grade направления (см. effectiveGrade()). */
  medianSalaryRegional: number | null;
  /** Лейбл региона для которого посчитана medianSalaryRegional ("US"/"LATAM"/...). */
  medianSalaryRegionLabel?: string | null;
  aiRisk: "low" | "medium" | "high" | "extreme" | null;
  citations: string[];
  reasoning?: string;
  confidence?: "high" | "medium" | "low";
}

interface ValidatedClaudeFill {
  directionKey: string;
  matchAccepted: boolean;
  matchRejectionReason?: string;
  medianSalaryRegional: number | null;
  medianSalaryRegionLabel: string | null;
  aiRisk: ClaudeFillRaw["aiRisk"];
  source: "claude" | "claude-estimate";
  citations: string[];
  reasoning?: string;
  droppedFields: string[];
}

// ─── Region helpers ──────────────────────────────────────────────────────────

const RU_PROXY_REGIONS: ReadonlySet<Region> = new Set<Region>(["ru", "cis"]);

function allTargetsAreRuProxy(summary: ClientSummary): boolean {
  const regions = summary.targetMarketRegions ?? [];
  if (regions.length === 0) return false;
  return regions.every((r) => RU_PROXY_REGIONS.has(r as Region));
}

/**
 * На этапе shortlist НЕ ходим в Claude за региональными salary.
 *
 * История: раньше для bucket=usa или bucket=abroad с non-UK-proxy target
 * (us/latam/asia-pacific/middle-east) мы просили Claude вернуть
 * `medianSalaryRegional` в USD. Это приводило к двум проблемам:
 *   1. Claude регулярно давал senior-уровня цифры даже для middle
 *      direction'ов (например $140k для DevOps middle).
 *   2. UI `formatMoney` для bucket=abroad конвертирует значение как GBP/год
 *      через курс ×1.17/12 → USD-число рендерилось как €14k/мес.
 *
 * На этапе shortlist нам достаточно UK-proxy (£/год) из itjobswatch —
 * шкала между направлениями сохраняется, а USA-аплифт (×1.5) применяется
 * в UI при bucket=usa. Claude по-прежнему вызывается, но только для
 * `matchAccepted` и `aiRisk` (это его настоящая ценность).
 *
 * Финальный анализ (Phase 3/4) при необходимости может запрашивать
 * отдельные страны через `probe-country-salary`-файлы.
 */
function needsClaudeSalary(_direction: Direction, _summary: ClientSummary): {
  needed: boolean;
  regionLabel: string;
} {
  return { needed: false, regionLabel: "UK-proxy only (Claude salary отключен на shortlist)" };
}

function regionLabel(direction: Direction, summary: ClientSummary): string {
  const targetRegions = (summary.targetMarketRegions ?? []).join(", ") || "не указан";
  if (direction.bucket === "ru") return `RU (target: ${targetRegions})`;
  if (direction.bucket === "usa") return `USA (target: ${targetRegions})`;
  return `Abroad / EU / UK (target: ${targetRegions})`;
}

/**
 * Парсит grade-маркер из direction.title: ищет суффикс вроде "(senior)",
 * "(staff)", "(principal)", "(middle)", "(junior)".
 *
 * Возвращает effective grade: грейд из title (точнее — описывает уровень
 * конкретного направления), либо fallback на client-grade (что Phase 1 решил
 * для всего клиента в целом).
 */
function effectiveGrade(direction: Direction, clientGrade: string): string {
  const m = direction.title.match(
    /\((staff\+?|principal|senior|sr|middle|mid|middle\+?|junior|jr|intern|lead|head)\b[^)]*\)/i,
  );
  if (!m) return clientGrade;
  const raw = m[1]!.toLowerCase();
  if (raw.startsWith("staff")) return "Staff";
  if (raw.startsWith("principal")) return "Principal";
  if (raw === "senior" || raw === "sr") return "Senior";
  if (raw.startsWith("middle") || raw === "mid") return "Mid";
  if (raw === "junior" || raw === "jr") return "Junior";
  if (raw === "intern") return "Intern";
  if (raw === "lead") return "Lead";
  if (raw === "head") return "Head";
  return clientGrade;
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const EXTRACT_TOOL_DEFINITION = {
  name: "extract_market_data",
  description:
    "Submit your assessment for the niche. Three pieces: " +
    "(1) is the itjobswatch-matched title we found a good representative of " +
    "the direction, (2) regional median salary in USD (only if target region " +
    "is NOT UK/EU/global — those we already cover with itjobswatch data), " +
    "(3) AI displacement risk over 3-5 years.",
  input_schema: {
    type: "object",
    properties: {
      matchAccepted: {
        type: "boolean",
        description:
          "True if the itjobswatch row title we provided is a reasonable proxy " +
          "for the direction (same career path, same skill stack). False if the " +
          "row is from a different niche (e.g. we matched 'Performance Tester' " +
          "but direction is 'Penetration Tester').",
      },
      matchRejectionReason: {
        type: "string",
        description:
          "Required ONLY if matchAccepted=false. 1-2 sentences: why the matched " +
          "title is not a good proxy for the direction.",
      },
      medianSalaryRegional: {
        type: ["number", "null"],
        description:
          "Median ANNUAL GROSS compensation in USD at the grade we specify in " +
          "the prompt (NOT mid by default — we tell you per-direction). " +
          "Sources: levels.fyi (US, preferred), salary.com, bls.gov (USA), " +
          "glassdoor.com, talent.com (LATAM/APAC), payscale.com. " +
          "Set null if salary is not needed (we'll say so explicitly).",
      },
      medianSalaryRegionLabel: {
        type: ["string", "null"],
        description:
          "Short label of the region for which medianSalaryRegional applies " +
          "(e.g. 'US', 'LATAM', 'Singapore', 'UAE'). Null if salary is null.",
      },
      aiRisk: {
        type: ["string", "null"],
        enum: ["low", "medium", "high", "extreme", null],
        description:
          "Your assessment of AI displacement risk over the next 3-5 years for " +
          "THIS specific niche (not the umbrella slug). E.g. SOC L1 = high, " +
          "AppSec = low, ML research = low, manual QA = high.",
      },
      citations: {
        type: "array",
        items: { type: "string" },
        description:
          "URLs you actually opened/searched. Must be relevant to the niche, " +
          "not generic tech-salary pages.",
      },
      reasoning: {
        type: "string",
        description:
          "1-3 sentences explaining your match decision and AI-risk reasoning.",
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "How confident are you in the numbers above.",
      },
    },
    required: ["matchAccepted", "aiRisk", "citations"],
  },
} as const;

const WEB_SEARCH_TOOL_DEFINITION = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: WEB_SEARCH_MAX_USES,
  allowed_domains: ALLOWED_DOMAINS as unknown as string[],
} as const;

// ─── Prompt builder ──────────────────────────────────────────────────────────

function buildPrompt(args: {
  direction: Direction;
  resolved: ResolvedNiche | null;
  summary: ClientSummary;
  clientGrade: string;
  needsSalary: boolean;
  salaryRegion: string;
}): string {
  const { direction, resolved, summary, clientGrade, needsSalary, salaryRegion } = args;
  const region = regionLabel(direction, summary);
  const grade = effectiveGrade(direction, clientGrade);

  const evidenceLine = direction.marketEvidence
    ? `Phase-1 hint: ${direction.marketEvidence}`
    : "";

  const resolverBlock = resolved
    ? `## itjobswatch lookup (UK proxy — already done by us)
We searched itjobswatch.co.uk for "${direction.title}" and matched this row:
- **Title:** "${resolved.matchedTitle}"
- **Live UK vacancies:** ${resolved.vacancies}
- **Median salary UK:** ${resolved.medianSalaryGbp !== null ? `£${resolved.medianSalaryGbp.toLocaleString("en-GB")}` : "N/A"}${resolved.salaryYoYPct !== null ? ` (YoY ${resolved.salaryYoYPct >= 0 ? "+" : ""}${resolved.salaryYoYPct}%)` : ""}
- **Trend (vacancies now / 2y ago):** ${resolved.trendRatio !== null ? `${((resolved.trendRatio - 1) * 100).toFixed(0)}%` : "n/a"}
- **Source:** ${resolved.sourceUrl}

These numbers are CANONICAL — we don't ask you to re-verify them. We need
your help on different things (see Your task below).`
    : `## itjobswatch lookup
We could not find "${direction.title}" on itjobswatch (neither in our
canonical KB nor via live search). You may proceed with US/regional data
only — vacancies and trend stay null.`;

  const salaryTask = needsSalary
    ? `2. **Regional median salary** for ${salaryRegion} at **${grade}** level
   (USD/year, annual gross). Set \`medianSalaryRegional\` and
   \`medianSalaryRegionLabel\`.

   **The grade matters a lot.** Senior AppSec / DevSecOps in US ≈ $170-200k,
   Staff +$50k, Mid $130-150k. If you cite a generic "AppSec salary" page
   without checking grade, you'll undershoot for Senior/Staff.

   Sources (preferred first): levels.fyi (US tech), salary.com, glassdoor.com,
   ziprecruiter.com, payscale.com, bls.gov, talent.com (LATAM/APAC).
   Pick the MEDIAN for ${grade} grade, not range floor.`
    : `2. **Regional median salary**: NOT NEEDED for this client (their target
   regions ${salaryRegion} are already covered by the UK itjobswatch data
   above). Return \`medianSalaryRegional: null\`.`;

  return `You are a labor-market analyst. We have ONE direction, and we already pulled
canonical UK data for it. Your job is narrow: confirm the match, and add
information UK data does NOT cover (regional salary outside UK/EU, AI risk).

## Direction
- Title: "${direction.title}"
- Slug: ${direction.roleSlug}
- Direction's bucket: ${direction.bucket}
- Region (client target): ${region}
- **Grade for THIS direction: ${grade}** (parsed from title; client overall grade: ${clientGrade})
${evidenceLine ? `- ${evidenceLine}` : ""}

${resolverBlock}

## Your task
Call \`extract_market_data\` exactly once with:

1. **\`matchAccepted\`**: is "${resolved?.matchedTitle ?? "(no itjw match)"}" a
   reasonable representative for "${direction.title}"? Same career path,
   overlapping skill stack, comparable seniority? Answer true/false. If false,
   set \`matchRejectionReason\` (1-2 sentences). DO NOT spend web_search calls
   on this — judge from the title alone unless ambiguous.

${salaryTask}

3. **\`aiRisk\`** for THIS specific niche over 3-5 years
   (low / medium / high / extreme). Examples: SOC L1 = high, AppSec = low,
   ML research = low, manual QA = high. Use \`web_search\` if you need to
   verify with recent industry analyses.

## Hard rules
- **Don't re-search vacancies, UK salary, or trend.** They're canonical in
  itjobswatch and already shown above. Job-board aggregates (LinkedIn,
  Glassdoor "X jobs") inflate by duplicates and are useless for our purpose.
- **Only cite URLs you actually opened/searched.** Empty citations OK if you
  didn't need web_search (e.g. matchAccepted=true was obvious from titles).
- Citations MUST be relevant to the niche AND grade. Don't cite a generic
  "Security Engineer salary" page when direction is Senior AppSec.
- Set \`confidence: "low"\` if you had to extrapolate or only found 1 weak source.
- Reply ONLY by calling \`extract_market_data\`. No prose answer.`;
}

// ─── Anthropic API call ──────────────────────────────────────────────────────

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface AnthropicWebSearchToolResultBlock {
  type: "web_search_tool_result";
  tool_use_id: string;
  content: Array<{
    type: "web_search_result";
    url: string;
    title?: string;
    page_age?: string;
  }>;
}
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicWebSearchToolResultBlock
  | { type: string; [k: string]: unknown };

interface AnthropicMessageResponse {
  id: string;
  content: AnthropicContentBlock[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    server_tool_use?: { web_search_requests?: number };
  };
}

async function callClaude(
  prompt: string,
  apiKey: string,
): Promise<AnthropicMessageResponse> {
  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools: [WEB_SEARCH_TOOL_DEFINITION, EXTRACT_TOOL_DEFINITION],
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  return (await response.json()) as AnthropicMessageResponse;
}

// ─── Validate ─────────────────────────────────────────────────────────────────

function validateClaudeFill(
  raw: ClaudeFillRaw,
  direction: Direction,
  needsSalary: boolean,
): ValidatedClaudeFill {
  const dropped: string[] = [];
  const cites = (raw.citations ?? []).filter(
    (c): c is string => typeof c === "string" && c.length > 0,
  );

  // Salary: если был нужен и Claude вернул null или забыл — фиксируем.
  let medianSalaryRegional = raw.medianSalaryRegional;
  let medianSalaryRegionLabel = raw.medianSalaryRegionLabel ?? null;

  // Если нам salary НЕ нужен — игнорируем что прислал Claude (защита от
  // случайно вкатанной UK-цифры).
  if (!needsSalary && medianSalaryRegional !== null) {
    dropped.push("medianSalaryRegional (not needed for client targets)");
    medianSalaryRegional = null;
    medianSalaryRegionLabel = null;
  }

  // Sanity: salary в USD должна быть в разумном диапазоне для tech-роли
  // (annual). Меньше $20k или больше $500k — почти наверняка ошибка
  // (monthly вместо annual, либо CEO-level).
  if (medianSalaryRegional !== null && (medianSalaryRegional < 20_000 || medianSalaryRegional > 500_000)) {
    dropped.push(`medianSalaryRegional out of range ($${medianSalaryRegional})`);
    medianSalaryRegional = null;
    medianSalaryRegionLabel = null;
  }

  const lowConfidence = raw.confidence === "low";
  const noCites = cites.length === 0;

  // Estimate-режим: если salary был нужен, но цитат нет, либо confidence=low.
  // matchAccepted и aiRisk не требуют citations (это subjective judgment).
  const salaryIsEstimate = needsSalary && medianSalaryRegional !== null && (noCites || lowConfidence);
  const isEstimate = salaryIsEstimate || (lowConfidence && raw.aiRisk !== null);

  return {
    directionKey: directionKey(direction),
    matchAccepted: raw.matchAccepted,
    matchRejectionReason: raw.matchRejectionReason,
    medianSalaryRegional,
    medianSalaryRegionLabel,
    aiRisk: raw.aiRisk,
    source: isEstimate ? "claude-estimate" : "claude",
    citations: cites,
    reasoning: raw.reasoning,
    droppedFields: dropped,
  };
}

// ─── Merge ───────────────────────────────────────────────────────────────────

/**
 * Сливает данные niche-resolver-а (canonical UK proxy) и Claude-fill
 * (regional salary + AI risk) в финальный EnrichedDirection.
 *
 * Поведение по полям:
 *   - vacancies         ← resolver (UK live count), всегда
 *   - trendRatio        ← resolver (UK 2y trend), всегда
 *   - medianSalaryMid   ← resolver UK GBP, ИЛИ Claude USD если client target
 *                          вне UK/EU/global. Кто пишет — определяется в
 *                          enrichGaps (флаг salaryFromClaude).
 *   - aiRisk            ← Claude (всегда перезаписывает, если matchAccepted).
 *                          market-index aiRisk для sub-niche менее точен.
 *   - dataSource        ← itjw-canonical / itjw-live для
 *                          случаев когда resolver предоставил данные;
 *                          claude / claude-estimate если только Claude дал
 *                          salary без resolver-а.
 *
 * `matchAccepted: false` — фоллбэк: НЕ применяем resolver данные (Claude
 * сказал что найденная ниша не релевантна). vacancies/trend идут в null.
 */
function mergeFromResolverAndClaude(args: {
  baseline: EnrichedDirection;
  resolved: ResolvedNiche | null;
  fill: ValidatedClaudeFill | null;
}): EnrichedDirection {
  const { baseline, resolved, fill } = args;
  const merged: EnrichedDirection = { ...baseline };

  // 1. Resolver-данные применяем ТОЛЬКО если Claude подтвердил match (или
  // Claude вообще не вызвался — например, off-fill direction).
  const useResolver =
    resolved !== null && (fill === null || fill.matchAccepted === true);

  if (useResolver && resolved) {
    merged.vacancies = resolved.vacancies;
    merged.trendRatio = resolved.trendRatio;

    // dataSource: помечаем источником resolver-а.
    const resolverSource: EnrichDataSource =
      resolved.source === "itjw-canonical" ? "itjw-canonical" : "itjw-live";
    merged.dataSource = resolverSource;
  }

  // 2. Salary: только UK-proxy от resolver-а. Claude regional USD на
  // shortlist-этапе больше не используем — смешение GBP и USD в одном
  // поле `medianSalaryMid` ломало UI (formatMoney считает abroad как GBP).
  // Если нужны country-specific цифры — они подтянутся в Phase 3/4 из
  // `by-country/*.md` файлов.
  if (useResolver && resolved?.medianSalaryGbp !== null && resolved?.medianSalaryGbp !== undefined) {
    merged.medianSalaryMid = resolved.medianSalaryGbp;
  }

  // 3. AI risk от Claude — он точнее per-niche, чем market-index aggregate.
  if (fill?.aiRisk != null) {
    merged.aiRisk = fill.aiRisk;
  }

  // 4. dataSource override: если Claude дал salary (regional) → отметим
  // claude-у, иначе оставим resolver-source выше. Если ничего не сработало
  // и Claude был — claude/claude-estimate.
  if (!useResolver && fill !== null && fill.matchAccepted === false) {
    // Resolver-match отвергнут Claude'ом → данных нет надёжных.
    merged.dataSource = fill.source; // claude / claude-estimate
  } else if (!useResolver && fill !== null) {
    merged.dataSource = fill.source;
  }

  // 5. Citations / reasoning складываем из обоих источников для UI.
  const citations: string[] = [];
  if (resolved?.sourceUrl) citations.push(resolved.sourceUrl);
  if (fill?.citations) citations.push(...fill.citations);
  if (citations.length > 0) merged.perplexityCitations = citations;

  const reasoningParts: string[] = [];
  if (resolved) {
    reasoningParts.push(
      `itjw match: "${resolved.matchedTitle}" (${resolved.source})`,
    );
  }
  if (fill?.reasoning) {
    reasoningParts.push(fill.reasoning);
  }
  if (fill?.matchAccepted === false && fill.matchRejectionReason) {
    reasoningParts.push(`match rejected: ${fill.matchRejectionReason}`);
  }
  if (reasoningParts.length > 0) {
    merged.perplexityReasoning = reasoningParts.join(" · ");
  }

  return merged;
}

// ─── Concurrency helper ──────────────────────────────────────────────────────

async function mapPool<TIn, TOut>(
  items: TIn[],
  worker: (item: TIn, idx: number) => Promise<TOut>,
  concurrency: number,
): Promise<TOut[]> {
  const out: TOut[] = new Array(items.length) as TOut[];
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push((async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) break;
        out[i] = await worker(items[i] as TIn, i);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

// ─── Resolution targets ──────────────────────────────────────────────────────
//
// Политика на shortlist-этапе:
//   - known slugs (есть в market-index) → НЕ трогаем. Берём медиану и
//     vacancies по slug из market-index как есть. Niche-resolver не ходит
//     (раньше он подменял top-row на "Senior React Developer" и т.п.).
//     aiRisk/matchAccepted Claude-ом тоже не перезаписываем — market-index
//     наш единственный источник правды для known ролей.
//   - off-index slugs (не в market-index) → резолвер + Claude как раньше,
//     это единственный способ получить хоть какие-то цифры. При этом
//     Claude-salary (USD) теперь всё равно не применяется — см.
//     `needsClaudeSalary` и `mergeFromResolverAndClaude`.
//   - ru-only target / bucket=ru → пропускаем (RU-резолвера у нас нет).

interface ResolveTarget {
  index: number;
  direction: Direction;
  baseline: EnrichedDirection;
}

function detectResolveTargets(
  directions: Direction[],
  baseline: EnrichedDirection[],
  summary: ClientSummary,
): ResolveTarget[] {
  const ruOnly = allTargetsAreRuProxy(summary);
  const out: ResolveTarget[] = [];
  for (let i = 0; i < directions.length; i++) {
    const d = directions[i];
    const e = baseline[i];
    if (!d || !e) continue;
    if (d.recommended === false) continue;
    if (ruOnly) continue;
    if (d.bucket === "ru") continue;
    if (e.source === "market-index") continue;
    out.push({ index: i, direction: d, baseline: e });
  }
  return out;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class ClaudeWebSearchProvider implements MarketResearchProvider {
  readonly name = "claude" as const;

  isAvailable(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }

  async enrichGaps(args: MarketResearchEnrichArgs): Promise<EnrichedDirection[]> {
    const { directions, baseline, summary } = args;

    if (directions.length !== baseline.length) {
      throw new Error(
        `[ClaudeMR] directions(${directions.length}) and baseline(${baseline.length}) length mismatch`,
      );
    }

    const targets = detectResolveTargets(directions, baseline, summary);
    if (targets.length === 0) {
      console.log("[ClaudeMR] No directions to resolve, returning baseline as-is");
      return baseline.map((b) => ({ ...b }));
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn("[ClaudeMR] ANTHROPIC_API_KEY not set, skipping Claude (resolver still runs)");
    }

    const grade = resolveClientGrade(summary);
    const targetRegions = (summary.targetMarketRegions ?? []).join(",") || "any";

    console.log(
      `[ClaudeMR] Resolving ${targets.length} direction(s): ` +
      targets.map((t) => `"${t.direction.title}" [${t.direction.bucket}]`).join(", "),
    );

    // ─── Stage A: niche-resolver per direction ─────────────────────────────
    // Параллельный resolve через alias/scoring в uk_<slug>.md + live-scrape fallback.
    // Concurrency 2: itjobswatch не любит >2 одновременных HTTP к нему.
    interface ResolutionRow {
      target: ResolveTarget;
      effectiveSlug: string;
      slugCorrected: boolean;
      resolved: ResolvedNiche | null;
    }

    const resolutionRows = await mapPool(
      targets,
      async (target): Promise<ResolutionRow> => {
        const correction = await resolveCorrectedSlug(target.direction);
        try {
          const resolved = await resolveNiche(target.direction, correction.effectiveSlug);
          return {
            target,
            effectiveSlug: correction.effectiveSlug,
            slugCorrected: correction.corrected,
            resolved,
          };
        } catch (err) {
          console.warn(`[ClaudeMR/resolver] "${target.direction.title}":`, err);
          return {
            target,
            effectiveSlug: correction.effectiveSlug,
            slugCorrected: correction.corrected,
            resolved: null,
          };
        }
      },
      2,
    );

    for (const r of resolutionRows) {
      if (r.resolved) {
        console.log(
          `[ClaudeMR/resolver] "${r.target.direction.title}" → ${r.resolved.source} ` +
          `match="${r.resolved.matchedTitle}" vac=${r.resolved.vacancies} ` +
          `salary=${r.resolved.medianSalaryGbp !== null ? `£${r.resolved.medianSalaryGbp}` : "N/A"} ` +
          `trend=${r.resolved.trendRatio ?? "?"} (slug=${r.effectiveSlug}${r.slugCorrected ? " corrected" : ""})`,
        );
      } else {
        console.warn(
          `[ClaudeMR/resolver] "${r.target.direction.title}": no resolution (slug=${r.effectiveSlug})`,
        );
      }
    }

    // ─── Stage B: Claude per direction (если ANTHROPIC_API_KEY) ────────────
    let cacheHits = 0;
    let webSearchTotal = 0;
    let inputTokensTotal = 0;
    let outputTokensTotal = 0;

    const fillByIndex = new Map<number, ValidatedClaudeFill>();

    if (apiKey) {
      const fillResults = await mapPool(
        resolutionRows,
        async (row) => {
          const { target, resolved } = row;
          const salaryDecision = needsClaudeSalary(target.direction, summary);

          const key = directionKey(target.direction);
          const cacheKey = createHash("sha256")
            .update(`${CACHE_VERSION}|${key}|${targetRegions}|${grade}|${resolved?.matchedTitle ?? "no-match"}`)
            .digest("hex")
            .slice(0, 32);

          const cached = getCached(cacheKey);
          if (cached) {
            cacheHits++;
            console.log(`[ClaudeMR] cache hit "${target.direction.title}"`);
            return { row, fill: cached.fill };
          }

          const prompt = buildPrompt({
            direction: target.direction,
            resolved,
            summary,
            clientGrade: grade,
            needsSalary: salaryDecision.needed,
            salaryRegion: salaryDecision.regionLabel,
          });

          try {
            const t0 = Date.now();
            const response = await callClaude(prompt, apiKey);
            const elapsed = Date.now() - t0;

            const usage = response.usage;
            if (usage) {
              inputTokensTotal += usage.input_tokens ?? 0;
              outputTokensTotal += usage.output_tokens ?? 0;
              webSearchTotal += usage.server_tool_use?.web_search_requests ?? 0;
            }

            const toolUseBlock = response.content.find(
              (b): b is AnthropicToolUseBlock =>
                b.type === "tool_use" && (b as AnthropicToolUseBlock).name === "extract_market_data",
            );

            if (!toolUseBlock) {
              console.warn(
                `[ClaudeMR] "${target.direction.title}": no tool_use in response (elapsed=${elapsed}ms)`,
              );
              return { row, fill: null };
            }

            const raw = toolUseBlock.input as unknown as ClaudeFillRaw;
            const validated = validateClaudeFill(raw, target.direction, salaryDecision.needed);

            if (validated.droppedFields.length > 0) {
              console.warn(
                `[ClaudeMR] "${target.direction.title}": dropped ${validated.droppedFields.join("/")}`,
              );
            }
            console.log(
              `[ClaudeMR] "${target.direction.title}" → ${validated.source} ` +
              `match=${validated.matchAccepted} ` +
              `salary=${validated.medianSalaryRegional ?? "—"}${validated.medianSalaryRegionLabel ? `(${validated.medianSalaryRegionLabel})` : ""} ` +
              `aiRisk=${validated.aiRisk ?? "—"} cit=${validated.citations.length} (${elapsed}ms)`,
            );

            setCache(cacheKey, validated);
            return { row, fill: validated };
          } catch (err) {
            console.error(`[ClaudeMR] "${target.direction.title}": call failed:`, err);
            return { row, fill: null };
          }
        },
        CONCURRENCY,
      );

      for (const r of fillResults) {
        if (r.fill) fillByIndex.set(r.row.target.index, r.fill);
      }
    }

    // ─── Stage C: merge resolver + Claude → final EnrichedDirection ─────────
    const resolutionByIndex = new Map<number, ResolutionRow>();
    for (const r of resolutionRows) resolutionByIndex.set(r.target.index, r);

    const merged = baseline.map((b, i) => {
      const row = resolutionByIndex.get(i);
      const fill = fillByIndex.get(i) ?? null;
      const resolved = row?.resolved ?? null;

      if (!row) return { ...b }; // skipped target (ru-bucket / not recommended)

      return mergeFromResolverAndClaude({
        baseline: b,
        resolved,
        fill,
      });
    });

    const resolverFilled = resolutionRows.filter((r) => r.resolved !== null).length;
    console.log(
      `[ClaudeMR] done. tokens_in=${inputTokensTotal} out=${outputTokensTotal} ` +
      `web_uses=${webSearchTotal} cache_hits=${cacheHits}/${targets.length} ` +
      `resolver_hits=${resolverFilled}/${targets.length} claude_fills=${fillByIndex.size}/${targets.length}`,
    );

    return merged;
  }
}
