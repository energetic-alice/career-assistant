/**
 * Phase 2 — Deep Research Service.
 *
 * Цель: ТОЧЕЧНОЕ обогащение `EnrichedDirection` там где данных не хватает.
 * Никакого Claude — только детерминированный merge KB + опциональный
 * Perplexity Sonar Pro для дозаполнения дыр.
 *
 * Триггер (одно условие):
 *   У direction'а есть РЕАЛЬНАЯ дыра в основных полях (vacancies, medianSalaryMid,
 *   competitionPer100) И target region клиента не cis (для cis ru-данные считаем
 *   достаточным прокси, повторно их не запрашиваем).
 *
 * На практике дыра возникает когда:
 *   - slug off-index (нет в market-index) — не было baseline
 *   - slug известный, но в market-index нет stats для нужного bucket'а (ru или
 *     uk-as-proxy для abroad). Например recruiter без uk-stats для EU клиента.
 *   - exotic region (latam/asia-pacific/middle-east/global) — proxy не подходит.
 *
 * Anti-hallucination protocol:
 *   1. Один batch-запрос на клиента, baseline = всё что уже есть из market-index.
 *   2. Жёсткий промпт: "не знаешь = null, выдумывать запрещено, citations обязательны".
 *   3. Validate-gate после ответа: если число пришло без URL-citations — drop в null.
 *   4. dataSource различает "perplexity" (с citations) и "perplexity-estimate"
 *      (по аналогии, низкая уверенность).
 */

import { createHash } from "node:crypto";
import { saveMap, loadMap } from "./state-store.js";
import { KNOWN_ROLES } from "./known-roles.js";
import type { Direction, Region } from "../schemas/analysis-outputs.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import type { EnrichedDirection } from "./direction-enricher.js";

const SONAR_URL = "https://api.perplexity.ai/chat/completions";
const SONAR_MODEL = "sonar-pro";
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const CACHE_STORE_NAME = "deep-research-cache";

/**
 * Регионы для которых ru-данные считаем достаточным прокси.
 * Для cis-таргета даже если есть дыры — Perplexity не дёргаем
 * (Казахстан/Грузия/Армения имеют близкую структуру IT-рынка к РФ;
 * если ru-данные пустые — это проблема market-index, а не задача Perplexity).
 */
const RU_PROXY_REGIONS: ReadonlySet<Region> = new Set<Region>(["ru", "cis"]);

const KNOWN_SLUGS_SET: ReadonlySet<string> = new Set(KNOWN_ROLES);

// ─── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  fills: PerplexityFill[];
  rawCitations: string[];
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

function setCache(key: string, fills: PerplexityFill[], rawCitations: string[]): void {
  cache.set(key, { fills, rawCitations, fetchedAt: new Date().toISOString() });
  saveMap(CACHE_STORE_NAME, cache);
}

// ─── Gap detection ───────────────────────────────────────────────────────────

interface GapDescriptor {
  direction: Direction;
  baseline: EnrichedDirection;
  /** Какие поля null и нужно дозаполнить. */
  missingFields: Array<keyof Pick<EnrichedDirection,
    "vacancies" | "medianSalaryMid" | "aiRisk" | "competitionPer100" | "trendRatio"
  >>;
  /** Почему дозапрос разрешён (для логов и UI). */
  reason: "off-index" | "missing-stats";
}

/**
 * Дыра в "основных" полях которые используются для скоринга и UI.
 * `aiRisk` — отдельная метрика, не блокирующая (часто известна даже когда нет vac/median).
 * `trendRatio` — приятный nice-to-have, не критичный.
 */
function hasCoreGap(e: EnrichedDirection): boolean {
  return (
    e.vacancies === null ||
    e.medianSalaryMid === null ||
    e.competitionPer100 === null
  );
}

function listMissingFields(e: EnrichedDirection): GapDescriptor["missingFields"] {
  const out: GapDescriptor["missingFields"] = [];
  if (e.vacancies === null) out.push("vacancies");
  if (e.medianSalaryMid === null) out.push("medianSalaryMid");
  if (e.aiRisk === null) out.push("aiRisk");
  if (e.competitionPer100 === null) out.push("competitionPer100");
  if (e.trendRatio === null) out.push("trendRatio");
  return out;
}

function isOffIndex(direction: Direction): boolean {
  if (direction.offIndex === true) return true;
  return !KNOWN_SLUGS_SET.has(direction.roleSlug);
}

/**
 * Все ли таргетные регионы клиента покрываются ru-прокси (ru/cis)?
 * Если да — Perplexity не дёргаем даже при наличии дыр (это бажный market-index).
 */
function allTargetsAreRuProxy(summary: ClientSummary): boolean {
  const regions = summary.targetMarketRegions ?? [];
  if (regions.length === 0) return false;
  return regions.every((r) => RU_PROXY_REGIONS.has(r as Region));
}

function detectGaps(
  directions: Direction[],
  baseline: EnrichedDirection[],
  summary: ClientSummary,
): GapDescriptor[] {
  const ruOnly = allTargetsAreRuProxy(summary);
  const out: GapDescriptor[] = [];

  for (let i = 0; i < directions.length; i++) {
    const d = directions[i];
    const e = baseline[i];
    if (!d || !e) continue;
    // Rejected directions не идут в финальные рекомендации — Perplexity не нужен.
    // Они остаются с baseline-данными (или без), для UI/финала этого хватает.
    if (d.recommended === false) continue;
    if (!hasCoreGap(e)) continue;
    if (ruOnly) continue; // для cis/ru прокси Perplexity не помощник

    out.push({
      direction: d,
      baseline: e,
      missingFields: listMissingFields(e),
      reason: isOffIndex(d) ? "off-index" : "missing-stats",
    });
  }

  return out;
}

// ─── Perplexity request/response types ───────────────────────────────────────

interface PerplexityFill {
  slug: string;
  bucket: "ru" | "abroad";
  vacancies: number | null;
  medianSalaryMid: number | null;
  medianSalaryCurrency: "GBP" | "EUR" | "USD" | "RUB" | null;
  competitionPer100: number | null;
  aiRisk: "low" | "medium" | "high" | "extreme" | null;
  trendRatio: number | null;
  citations: string[];
  reasoning?: string;
}

interface PerplexityResponse {
  fills: PerplexityFill[];
}

const FILL_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    fills: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          slug: { type: "string" as const },
          bucket: { type: "string" as const, enum: ["ru", "abroad"] },
          vacancies: { type: ["number", "null"] as const },
          medianSalaryMid: { type: ["number", "null"] as const },
          medianSalaryCurrency: { type: ["string", "null"] as const, enum: ["GBP", "EUR", "USD", "RUB", null] },
          competitionPer100: { type: ["number", "null"] as const },
          aiRisk: { type: ["string", "null"] as const, enum: ["low", "medium", "high", "extreme", null] },
          trendRatio: { type: ["number", "null"] as const },
          citations: { type: "array" as const, items: { type: "string" as const } },
          reasoning: { type: "string" as const },
        },
        required: ["slug", "bucket", "vacancies", "medianSalaryMid", "competitionPer100", "aiRisk", "citations"],
      },
    },
  },
  required: ["fills"],
};

// ─── Prompt builder ──────────────────────────────────────────────────────────

function regionLabel(summary: ClientSummary): string {
  const regions = summary.targetMarketRegions ?? [];
  if (regions.length === 0) return "не указан (использовать UK как proxy)";
  return regions.join(", ");
}

function fmtBaselineRow(e: EnrichedDirection): string {
  const vac = e.vacancies !== null ? String(e.vacancies) : "NULL";
  const med = e.medianSalaryMid !== null ? String(e.medianSalaryMid) : "NULL";
  const comp = e.competitionPer100 !== null ? e.competitionPer100.toFixed(1) : "NULL";
  const ai = e.aiRisk ?? "NULL";
  const trend = e.trendRatio !== null ? `${((e.trendRatio - 1) * 100).toFixed(0)}%` : "NULL";
  const bucket = e.bucket ?? "abroad";
  return `| ${e.roleSlug} | ${bucket} | ${vac} | ${med} | ${comp} | ${ai} | ${trend} |`;
}

function buildBatchPrompt(
  gaps: GapDescriptor[],
  baselineAll: EnrichedDirection[],
  summary: ClientSummary,
): string {
  const baselineTable = baselineAll.map(fmtBaselineRow).join("\n");

  const gapList = gaps.map((g) => {
    const fields = g.missingFields.join(", ");
    const offIdxFlag = g.reason === "off-index" ? " [OFF-INDEX]" : "";
    const evidence = g.direction.marketEvidence
      ? `\n  - market hint from prior step: ${g.direction.marketEvidence}`
      : "";
    return `- slug: \`${g.direction.roleSlug}\` (title: "${g.direction.title}", bucket: ${g.direction.bucket})${offIdxFlag}${evidence}\n  - missing fields: ${fields}`;
  }).join("\n");

  return `You are a labor market analyst for IT/digital jobs. Your task is to fill MISSING numbers for specific roles.

## Client target region
${regionLabel(summary)}

## Baseline (already known data, DO NOT recalculate)

These directions are being considered. Trust the values that are NOT NULL:

| slug | bucket | vacancies | median (local) | comp/100 | aiRisk | trend |
|---|---|---|---|---|---|---|
${baselineTable}

## What needs to be filled

${gapList}

## STRICT RULES (anti-hallucination)

1. **If you don't know — return null. Inventing numbers is FORBIDDEN.**
2. For EVERY non-null value you return, include URL citations in the \`citations\` array. No URL = no number.
3. If your number is an estimate by analogy (e.g. "role X is similar to Y in skills, so I take 70% of Y"), put that explanation in \`reasoning\` field. This is an ESTIMATE, not a fact.
4. You do NOT have direct LinkedIn API access. If data is only available from LinkedIn widgets — return null. Do not guess.
5. Trustworthy sources: itjobswatch.co.uk, hh.ru, glassdoor.com, levels.fyi, Stack Overflow Developer Survey 2024-2025, Eurostat, Trueup, official government statistics. AVOID generic "search engine snippets" or "general knowledge".
6. \`bucket\`:
   - If client targets RU/CIS — use "ru" and report numbers in RUB
   - Otherwise — use "abroad" and report numbers in GBP/EUR/USD (specify in \`medianSalaryCurrency\`)
7. \`competitionPer100\`: vacancies per 100 specialists in the region (LinkedIn talent insights / hh.ru index, etc.). If unavailable — null.
8. \`aiRisk\`: low / medium / high / extreme — your assessment of how AI will affect this role over 3-5 years. Required field, but only fill if you have any reasonable basis.
9. \`trendRatio\`: ratio relative to 2 years ago (1.15 = +15% growth, 0.85 = -15%). If unavailable — null.

## Output

Return strict JSON per the provided schema:

\`\`\`json
{
  "fills": [
    {
      "slug": "ai_automation_engineer",
      "bucket": "abroad",
      "vacancies": 850,
      "medianSalaryMid": 7500,
      "medianSalaryCurrency": "GBP",
      "competitionPer100": 6.0,
      "aiRisk": "low",
      "trendRatio": 1.18,
      "citations": ["https://itjobswatch.co.uk/...", "https://trueup.io/..."],
      "reasoning": "estimate by analogy with devops + ai-platform-engineer; trueup data 2025-12"
    }
  ]
}
\`\`\`

Reply with JSON only, no surrounding text.`;
}

// ─── Perplexity call ─────────────────────────────────────────────────────────

async function callPerplexityBatch(
  prompt: string,
): Promise<{ fills: PerplexityFill[]; rawCitations: string[] }> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("PERPLEXITY_API_KEY not set");

  const response = await fetch(SONAR_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: SONAR_MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: { schema: FILL_JSON_SCHEMA },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Perplexity HTTP ${response.status}: ${text}`);
  }

  const json = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    citations?: string[];
  };

  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty Perplexity response");

  let parsed: PerplexityResponse;
  try {
    parsed = JSON.parse(content) as PerplexityResponse;
  } catch (err) {
    console.error("[DeepResearch] Failed to parse Perplexity JSON:", content.slice(0, 200));
    throw err;
  }

  return {
    fills: parsed.fills ?? [],
    rawCitations: json.citations ?? [],
  };
}

// ─── Validate-gate (anti-fantasy) ────────────────────────────────────────────

const ANALOGY_MARKERS = /\b(estimate|analogy|approximate|approximately|по аналогии|оценка|примерно)\b/i;

interface ValidatedFill {
  slug: string;
  bucket: "ru" | "abroad";
  vacancies: number | null;
  medianSalaryMid: number | null;
  competitionPer100: number | null;
  aiRisk: EnrichedDirection["aiRisk"];
  trendRatio: number | null;
  source: "perplexity" | "perplexity-estimate";
  citations: string[];
  reasoning?: string;
  droppedFields: string[];
}

function validateFill(fill: PerplexityFill): ValidatedFill {
  const dropped: string[] = [];
  const hasCitations = (fill.citations ?? []).length > 0;

  // Если число дано без citations — drop в null. Анти-фантазия gate.
  let vacancies = fill.vacancies;
  if (vacancies !== null && !hasCitations) {
    dropped.push("vacancies");
    vacancies = null;
  }

  let medianSalaryMid = fill.medianSalaryMid;
  if (medianSalaryMid !== null && !hasCitations) {
    dropped.push("medianSalaryMid");
    medianSalaryMid = null;
  }

  let competitionPer100 = fill.competitionPer100;
  if (competitionPer100 !== null && !hasCitations) {
    dropped.push("competitionPer100");
    competitionPer100 = null;
  }

  let trendRatio = fill.trendRatio;
  if (trendRatio !== null && !hasCitations) {
    dropped.push("trendRatio");
    trendRatio = null;
  }

  // aiRisk — это качественная оценка, citations можно не требовать строго
  // (модель вполне может оценить по описанию роли).
  const aiRisk = fill.aiRisk;

  // Конверсия валюты в наш формат: market-index хранит UK в GBP, RU в RUB.
  // Если Perplexity вернул EUR/USD — оставляем как есть (UI разберётся).
  // Главное чтобы число было осмысленным.

  const isEstimate = !!(fill.reasoning && ANALOGY_MARKERS.test(fill.reasoning));
  const source: "perplexity" | "perplexity-estimate" = isEstimate
    ? "perplexity-estimate"
    : "perplexity";

  return {
    slug: fill.slug,
    bucket: fill.bucket,
    vacancies,
    medianSalaryMid,
    competitionPer100,
    aiRisk,
    trendRatio,
    source,
    citations: fill.citations ?? [],
    reasoning: fill.reasoning,
    droppedFields: dropped,
  };
}

// ─── Merge into baseline ─────────────────────────────────────────────────────

function mergeFillIntoEnriched(
  baseline: EnrichedDirection,
  fill: ValidatedFill,
): EnrichedDirection {
  const merged: EnrichedDirection = { ...baseline };

  // Заполняем только те поля где было null. Никогда не перезаписываем
  // подтверждённые market-index данные.
  let touched = false;
  if (merged.vacancies === null && fill.vacancies !== null) {
    merged.vacancies = fill.vacancies;
    touched = true;
  }
  if (merged.medianSalaryMid === null && fill.medianSalaryMid !== null) {
    merged.medianSalaryMid = fill.medianSalaryMid;
    touched = true;
  }
  if (merged.competitionPer100 === null && fill.competitionPer100 !== null) {
    merged.competitionPer100 = fill.competitionPer100;
    touched = true;
  }
  if (merged.aiRisk === null && fill.aiRisk !== null) {
    merged.aiRisk = fill.aiRisk;
    touched = true;
  }
  if (merged.trendRatio === null && fill.trendRatio !== null) {
    merged.trendRatio = fill.trendRatio;
    touched = true;
  }

  if (touched) {
    merged.dataSource = fill.source;
    merged.perplexityCitations = fill.citations;
    if (fill.reasoning) merged.perplexityReasoning = fill.reasoning;
  }

  return merged;
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Phase 2: точечно дозаполняет дыры в `EnrichedDirection`.
 *
 * Возвращает новый массив той же длины. Если Perplexity не нужен —
 * возвращает baseline as-is (с уже выставленными dataSource из Phase 1).
 *
 * Никогда не бросает исключение из-за Perplexity (логирует и возвращает baseline).
 */
export async function enrichGapsForClient(
  directions: Direction[],
  baseline: EnrichedDirection[],
  summary: ClientSummary,
): Promise<EnrichedDirection[]> {
  if (directions.length !== baseline.length) {
    throw new Error(
      `[DeepResearch] directions(${directions.length}) and baseline(${baseline.length}) length mismatch`,
    );
  }

  const gaps = detectGaps(directions, baseline, summary);
  if (gaps.length === 0) {
    console.log("[DeepResearch] No gaps to fill, returning baseline as-is");
    return baseline.map((b) => ({ ...b }));
  }

  console.log(
    `[DeepResearch] Detected ${gaps.length} gap(s): ` +
    gaps.map((g) => `${g.direction.roleSlug}[${g.reason}:${g.missingFields.join("/")}]`).join(", "),
  );

  if (!process.env.PERPLEXITY_API_KEY) {
    console.warn("[DeepResearch] PERPLEXITY_API_KEY not set, skipping enrichment");
    return baseline.map((b) => ({ ...b }));
  }

  // Промпт + cache key
  const prompt = buildBatchPrompt(gaps, baseline, summary);
  const cacheKey = createHash("sha256").update(prompt).digest("hex").slice(0, 32);

  let fills: PerplexityFill[];
  let rawCitations: string[];
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[DeepResearch] Cache hit (${cached.fills.length} fills)`);
    fills = cached.fills;
    rawCitations = cached.rawCitations;
  } else {
    console.log(`[DeepResearch] Calling Perplexity (${prompt.length} chars prompt)...`);
    try {
      const result = await callPerplexityBatch(prompt);
      fills = result.fills;
      rawCitations = result.rawCitations;
      setCache(cacheKey, fills, rawCitations);
      console.log(`[DeepResearch] Perplexity returned ${fills.length} fills`);
    } catch (err) {
      console.error("[DeepResearch] Perplexity call failed:", err);
      return baseline.map((b) => ({ ...b }));
    }
  }

  // Validate + merge
  const fillBySlug = new Map<string, ValidatedFill>();
  for (const raw of fills) {
    const validated = validateFill(raw);
    if (validated.droppedFields.length > 0) {
      console.warn(
        `[DeepResearch] ${validated.slug}: dropped ${validated.droppedFields.join("/")} (no citations)`,
      );
    }
    // Если для одного slug пришло несколько fills (странно, но возможно) — берём последний.
    fillBySlug.set(validated.slug, validated);
  }

  const result = baseline.map((b, i) => {
    const direction = directions[i];
    if (!direction) return { ...b };
    const fill = fillBySlug.get(b.roleSlug);
    if (!fill) return { ...b };
    return mergeFillIntoEnriched(b, fill);
  });

  return result;
}

// ─── Helpers re-export for probe ─────────────────────────────────────────────

export const _internals = {
  detectGaps,
  buildBatchPrompt,
  validateFill,
  mergeFillIntoEnriched,
  isOffIndex,
  allTargetsAreRuProxy,
};
