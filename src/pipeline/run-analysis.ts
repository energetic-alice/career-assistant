import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodType } from "zod";
import {
  candidateProfileSchema,
  directionsOutputSchema,
  analysisOutputSchema,
  type CandidateProfile,
  type DirectionsOutput,
  type AnalysisOutput,
  type Direction,
} from "../schemas/analysis-outputs.js";
import {
  loadPrompt00,
  loadPrompt01,
  loadPrompt02,
  loadPrompt03,
  loadPrompt04,
  inferRelevantDomains,
} from "./prompt-loader.js";
import { clientSummarySchema, type ClientSummary } from "../schemas/client-summary.js";
import { buildReviewSummary, formatReviewForTelegram } from "../services/review-summary.js";
import { fetchMarketDataForDirections } from "../services/perplexity-service.js";
import {
  loadMarketOverview,
  optimizeTitles,
  loadRoleReports,
  computeMarketAccess,
  buildFullMarketSummary,
  type TitleOptimizationResult,
} from "../services/market-data-service.js";
import { rankRoles, formatScorerTop20ForPrompt } from "../services/role-scorer.js";
import { resolveClientGrade } from "../services/client-grade.js";
import { computeAccessibleMarkets } from "../services/market-access.js";
import {
  enrichDirections,
  formatEnrichedForLog,
  postValidateDirections,
  type EnrichedDirection,
} from "../services/direction-enricher.js";
import type { Region } from "../schemas/analysis-outputs.js";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-20250514";

/**
 * Generic: TOutput — z.output<schema>, TInput — z.input<schema>. Разделение
 * нужно, потому что union+transform (tolerantNullableNumber и др.) делают
 * Input ≠ Output, и старый `ZodSchema<T>` заставлял TS объединять оба в T,
 * из-за чего потребители получали input-типы ("string | number | null")
 * вместо чистого Output ("number | null").
 */
async function callClaudeStructured<TOutput, TInput = TOutput>(
  prompt: string,
  schema: ZodType<TOutput, any, TInput>,
  toolName: string,
  maxTokens = 8192,
): Promise<TOutput> {
  const jsonSchema = zodToJsonSchema(schema);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    tools: [
      {
        name: toolName,
        description: `Output structured data according to the schema`,
        input_schema: jsonSchema as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: toolName },
    messages: [{ role: "user", content: prompt }],
  });

  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    throw new Error(`No tool_use block in response for ${toolName}`);
  }

  return schema.parse(toolBlock.input);
}

async function callClaudeText(prompt: string, maxTokens = 16000): Promise<string> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text block in Claude response");
  }
  return textBlock.text;
}

export interface AnalysisPipelineInput {
  questionnaire: string;
  resumeText: string;
  linkedinUrl: string;
  linkedinSSI: string;
  resumeUrl?: string;
  marketData?: string;
  expertFeedback?: string;
  /**
   * Optional pre-computed clientSummary (Phase 0 output). If provided,
   * scorer.rankRoles(summary, 20) is run and its top-20 is passed as
   * context to prompt-02. If absent — prompt-02 falls back to marketOverview
   * without scorer hints.
   */
  clientSummary?: ClientSummary;
}

export interface Phase1Result {
  profile: CandidateProfile;
  directions: DirectionsOutput;
  analysis: AnalysisOutput;
  reviewSummaryText: string;
  perplexityMarketData?: unknown;
  titleOptimization?: TitleOptimizationResult[];
  timings: Record<string, number>;
}

/**
 * Результат Phase 1 — Shortlist (легковесный предварительный анализ).
 *
 * Сериализуем и храним в `stageOutputs.shortlist`, чтобы админ мог
 * отредактировать список направлений в Telegram (Gate 1), а после
 * Approve — `runDeepFromShortlist` подхватил тот же контекст без
 * повторной генерации профиля и marketOverview.
 */
export interface ShortlistResult {
  profile: CandidateProfile;
  clientSummary?: ClientSummary;
  marketOverview: string;
  scorerTop20?: string;
  regions: Region[];
  directions: DirectionsOutput;
  enriched: EnrichedDirection[];
  timings: Record<string, number>;
}

export interface Phase4Result {
  finalDocument: string;
  timing: number;
}

export interface AnalysisPipelineResult {
  profile: CandidateProfile;
  directions: DirectionsOutput;
  analysis: AnalysisOutput;
  finalDocument: string;
  reviewSummaryText: string;
  timings: Record<string, number>;
}

/**
 * Phase 0: One-shot client summary for the Telegram client card.
 *
 * Runs ONCE per participant right after intake (and resume parsing if any),
 * persisted in `state.stageOutputs.clientSummary` and reused everywhere.
 * Cheap, fast, independent from the heavy analysis pipeline.
 */
export async function runClientSummary(input: {
  rawNamedValues: Record<string, string>;
  resumeText?: string;
  linkedinUrl?: string;
  linkedinSSI?: string;
}): Promise<ClientSummary> {
  console.log("[Phase 0] Building client summary...");
  const t0 = Date.now();
  const prompt = await loadPrompt00({
    rawNamedValues: JSON.stringify(input.rawNamedValues, null, 2),
    resumeText: input.resumeText ?? "",
    linkedinUrl: input.linkedinUrl ?? "",
    linkedinSSI: input.linkedinSSI ?? "",
  });
  const raw = await callClaudeStructured(
    prompt,
    clientSummarySchema,
    "client_summary",
    2048,
  );
  const summary = await sanitizeRoleSlugs(raw);
  normalizeClientGrade(summary);
  normalizeCitizenships(summary);
  summary.accessibleMarkets = computeAccessibleMarkets({
    citizenships: summary.citizenships ?? [],
    physicalCountry: summary.physicalCountry ?? "",
    targetMarketRegions: summary.targetMarketRegions ?? [],
  });
  console.log(
    `[Phase 0] Done in ${Date.now() - t0}ms (${summary.firstNameLatin} ${summary.lastNameLatin}, ` +
      `current=${summary.currentProfessionSlug ?? "<non-IT>"}, ` +
      `grade=${summary.currentGrade ?? "null"}, ` +
      `desired=${summary.desiredDirectionSlugs?.length ?? 0}, ` +
      `target=[${(summary.targetMarketRegions ?? []).join(", ")}], ` +
      `access=[${summary.accessibleMarkets.join(", ")}])`,
  );
  return summary;
}

/**
 * Заменяет `currentGrade=null` на вычисленный через `resolveClientGrade`.
 *
 * Клод в Phase 0 иногда возвращает `null` для клиентов, которые сейчас не
 * работают (декрет / между работ), хотя по правилу non-IT c прошлым опытом =
 * middle. Для скоринга нам нужен непустой grade, иначе `roleSalaryAtGrade`
 * не сможет подобрать точку на seniorityCurve. Поэтому:
 *   - non-IT (`slug === null`) с прошлым опытом → `middle`
 *   - IT (`slug !== null`) без грейда → fallback по опыту (≤3 → middle, >3 → senior)
 *   - совсем без опыта — всё равно `middle` (вход в IT из вне)
 */
function normalizeClientGrade(summary: ClientSummary): void {
  if (summary.currentGrade != null) return;
  summary.currentGrade = resolveClientGrade(summary);
}

/**
 * Fallback для `citizenships`: если Клод вернул пустой массив,
 * но у клиента есть `physicalCountry` — предполагаем, что право
 * на работу в стране проживания есть (иначе он бы там не жил/работал).
 * Это покрывает неполные анкеты без явного указания паспорта/ВНЖ.
 */
function normalizeCitizenships(summary: ClientSummary): void {
  if ((summary.citizenships ?? []).length > 0) return;
  if (summary.physicalCountry && summary.physicalCountry.trim() !== "") {
    summary.citizenships = [summary.physicalCountry];
  }
}

let _knownSlugs: Set<string> | null = null;
async function getKnownSlugs(): Promise<Set<string>> {
  if (_knownSlugs) return _knownSlugs;
  const { readFile } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const indexPath = join(__dirname, "..", "..", "data", "market-index.json");
  const content = await readFile(indexPath, "utf-8");
  const parsed = JSON.parse(content) as Record<string, unknown>;
  _knownSlugs = new Set(Object.keys(parsed));
  return _knownSlugs;
}

/**
 * Safety-net для slug'ов от Клода.
 *
 * Правила:
 *   - `currentProfessionSlug`:
 *       • если в каталоге → оставляем, currentProfessionOffIndex=false.
 *       • `"other"` — IT-маркер без market-data (редкая ниша: AWS Architect,
 *         FinOps, IoT Firmware). Оставляем, evidence не требуется. В scoring
 *         не участвует, обогащение на Phase 1B.
 *       • если НЕТ в каталоге, но Клод пометил offIndex=true + заполнил
 *         marketEvidence → оставляем (off-index IT-роль с известным рынком —
 *         e.g. Cloud Engineer, AI Automation Engineer; рынок дозапросим позже).
 *       • если НЕТ в каталоге и без marketEvidence → null (non-IT или
 *         галлюцинация без обоснования).
 *   - `desiredDirectionSlugs[]` — аналогично, но per-item. `"other"`
 *     сохраняется как «точно IT, направление выявится на Phase 1B».
 *     Unvalidated off-index дропаем.
 */
export const OTHER_IT_SLUG = "other";

export async function sanitizeRoleSlugs(summary: ClientSummary): Promise<ClientSummary> {
  const known = await getKnownSlugs();
  const out: ClientSummary = { ...summary };

  if (!out.currentProfessionSlug) {
    out.currentProfessionOffIndex = undefined;
    out.currentProfessionMarketEvidence = undefined;
  } else if (out.currentProfessionSlug === OTHER_IT_SLUG) {
    console.log(
      `[Phase 0] Keeping currentProfessionSlug="${OTHER_IT_SLUG}" (IT-маркер без рыночных данных)`,
    );
    out.currentProfessionOffIndex = undefined;
    out.currentProfessionMarketEvidence = undefined;
  } else if (known.has(out.currentProfessionSlug)) {
    out.currentProfessionOffIndex = undefined;
    out.currentProfessionMarketEvidence = undefined;
  } else if (
    out.currentProfessionOffIndex &&
    out.currentProfessionMarketEvidence &&
    out.currentProfessionMarketEvidence.trim().length > 0
  ) {
    console.log(
      `[Phase 0] Keeping off-index currentProfessionSlug=${out.currentProfessionSlug} ` +
        `(evidence: ${out.currentProfessionMarketEvidence.slice(0, 80)})`,
    );
    out.currentProfessionOffIndex = true;
  } else {
    console.warn(
      `[Phase 0] Dropping unvalidated currentProfessionSlug=${out.currentProfessionSlug} → null`,
    );
    out.currentProfessionSlug = null;
    out.currentProfessionSlugConfidence = undefined;
    out.currentProfessionOffIndex = undefined;
    out.currentProfessionMarketEvidence = undefined;
  }

  if (out.desiredDirectionSlugs && out.desiredDirectionSlugs.length > 0) {
    const before = out.desiredDirectionSlugs.length;
    out.desiredDirectionSlugs = out.desiredDirectionSlugs
      .map((d) => {
        if (d.slug === OTHER_IT_SLUG) {
          console.log(
            `[Phase 0] Keeping desired slug="${OTHER_IT_SLUG}" (IT без рыночных данных, raw="${d.raw}")`,
          );
          const { offIndex: _ox, marketEvidence: _ev, ...rest } = d;
          void _ox; void _ev;
          return rest;
        }
        if (known.has(d.slug)) {
          const { offIndex: _ox, marketEvidence: _ev, ...rest } = d;
          void _ox; void _ev;
          return rest;
        }
        if (d.offIndex && d.marketEvidence && d.marketEvidence.trim().length > 0) {
          console.log(
            `[Phase 0] Keeping off-index desired slug=${d.slug} (evidence: ${d.marketEvidence.slice(0, 80)})`,
          );
          return { ...d, offIndex: true };
        }
        console.warn(
          `[Phase 0] Dropping unvalidated off-index slug=${d.slug} (raw="${d.raw}", no marketEvidence)`,
        );
        return null;
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);
    if (out.desiredDirectionSlugs.length !== before) {
      console.warn(
        `[Phase 0] desiredDirectionSlugs filtered ${before} → ${out.desiredDirectionSlugs.length}`,
      );
    }
  }

  return out;
}

/**
 * Phase 1 — Shortlist: лёгкая генерация 8–10 направлений без глубоких
 * внешних запросов (Perplexity, детальные role reports, prompt-03).
 *
 * Используется для Gate 1: админ смотрит сырой shortlist в Telegram,
 * может удалить пункт или попросить заменить. После Approve вызывается
 * `runDeepFromShortlist` с теми же `profile`/`marketOverview`.
 *
 * Шаги: Step 1 (profile) → Step 1b (market access) → Step 0 (preload KB
 * overview + scraped summary) → Step 1c (scorer top-20) → Step 2 (Claude
 * 02) → post-validate → Step 2b (enrich).
 */
export async function runShortlist(
  input: AnalysisPipelineInput,
): Promise<ShortlistResult> {
  const timings: Record<string, number> = {};

  console.log("[Shortlist/Step 1] Extracting candidate profile...");
  let t0 = Date.now();
  const prompt01 = await loadPrompt01({
    questionnaire: input.questionnaire,
    resumeText: input.resumeText,
    linkedinSSI: input.linkedinSSI,
  });
  let profile = await callClaudeStructured(
    prompt01,
    candidateProfileSchema,
    "extract_profile",
  );
  timings["step1_profile"] = Date.now() - t0;
  console.log(
    `[Shortlist/Step 1] Done in ${timings["step1_profile"]}ms. English: ${profile.currentBase.englishLevel}`,
  );

  profile = computeMarketAccess(profile);
  const regions = profile.careerGoals.targetMarketRegions;
  console.log(`[Shortlist/Step 1] Target regions: ${regions.join(", ")}`);
  console.log(
    `[Shortlist/Step 1] Accessible markets: ${profile.barriers.accessibleMarkets?.join(", ")}`,
  );
  console.log(
    `[Shortlist/Step 1] PhysRU=${profile.barriers.isPhysicallyInRU} PhysEU=${profile.barriers.isPhysicallyInEU} RUwp=${profile.barriers.hasRuWorkPermit} EUwp=${profile.barriers.hasEUWorkPermit}`,
  );

  console.log("[Shortlist/Step 0] Pre-loading market overview...");
  t0 = Date.now();
  let marketOverview: string;
  try {
    const [kbOverview, scrapedSummary] = await Promise.all([
      loadMarketOverview(regions),
      buildFullMarketSummary(profile),
    ]);
    marketOverview = kbOverview + "\n\n---\n\n" + scrapedSummary.markdown;
    timings["step0_preload"] = Date.now() - t0;
    console.log(
      `[Shortlist/Step 0] Done in ${timings["step0_preload"]}ms (${marketOverview.length} chars, ${scrapedSummary.roles.length} roles in table)`,
    );
  } catch (err) {
    timings["step0_preload"] = Date.now() - t0;
    console.error("[Shortlist/Step 0] Pre-load failed, continuing without market data:", err);
    marketOverview = "Рыночные данные не загружены. Используй свои знания о рынке IT 2026.";
  }

  let scorerTop20: string | undefined;
  if (input.clientSummary) {
    try {
      const rank = await rankRoles(input.clientSummary, 20);
      scorerTop20 = formatScorerTop20ForPrompt(rank, 20);
      console.log(
        `[Shortlist/Step 1c] Scorer top-20 ready (ru=${rank.ru.length}, abroad=${rank.abroad.length})`,
      );
    } catch (err) {
      console.error("[Shortlist/Step 1c] rankRoles failed, continuing without scorerTop20:", err);
    }
  } else {
    console.log("[Shortlist/Step 1c] clientSummary not provided, skipping scorer context");
  }

  console.log("[Shortlist/Step 2] Generating directions (market + scorer top-20)...");
  t0 = Date.now();
  const prompt02 = await loadPrompt02({
    candidateProfile: JSON.stringify(profile, null, 2),
    marketOverview,
    scorerTop20,
  });
  const directions = await callClaudeStructured(
    prompt02,
    directionsOutputSchema,
    "generate_directions",
    12000,
  );
  timings["step2_directions"] = Date.now() - t0;
  console.log(
    `[Shortlist/Step 2] Done in ${timings["step2_directions"]}ms. ${directions.directions.length} directions: ${directions.directions.map((d) => d.title).join(" | ")}`,
  );

  directions.directions = await postValidateDirections(directions.directions, {
    targetMarketRegions: profile.careerGoals.targetMarketRegions,
  });
  console.log(
    `[Shortlist/Step 2] After post-validate: ${directions.directions.length} directions`,
  );

  let enriched: EnrichedDirection[] = [];
  if (input.clientSummary) {
    try {
      enriched = await enrichDirections(directions.directions, input.clientSummary);
      console.log(
        `[Shortlist/Step 2b] Enriched ${enriched.length} directions:\n${formatEnrichedForLog(enriched)}`,
      );
    } catch (err) {
      console.error("[Shortlist/Step 2b] enrichDirections failed:", err);
    }
  }

  const totalTime = Object.values(timings).reduce((a, b) => a + b, 0);
  console.log(`\n[Shortlist Total] ${totalTime}ms (${(totalTime / 1000).toFixed(1)}s)`);

  return {
    profile,
    clientSummary: input.clientSummary,
    marketOverview,
    scorerTop20,
    regions,
    directions,
    enriched,
    timings,
  };
}

/**
 * Перегенерация одного направления в рамках Gate 1.
 *
 * Зовёт prompt-02 заново с теми же контекстом (profile/marketOverview/
 * scorerTop20) и ищет в новом 8–10 списке первое направление с парой
 * `(roleSlug, bucket)`, которой ещё нет в `existingDirections`. Если
 * ничего не нашлось — возвращает `null`.
 *
 * Это «черновой» вариант под v1 Gate 1: мы не меняем prompt-02, чтобы не
 * делать ещё один контракт. Полноценная «регенерация с excluded=...» с
 * гарантией уникальности — отдельная задача.
 */
export async function regenerateOneDirection(
  shortlist: ShortlistResult,
  existingDirections: Direction[],
): Promise<{ direction: Direction; enriched?: EnrichedDirection } | null> {
  console.log(
    `[Regen] Looking for a replacement (current slugs: ${existingDirections.map((d) => `${d.roleSlug}/${d.bucket}`).join(", ")})`,
  );

  const prompt02 = await loadPrompt02({
    candidateProfile: JSON.stringify(shortlist.profile, null, 2),
    marketOverview: shortlist.marketOverview,
    scorerTop20: shortlist.scorerTop20,
  });
  const fresh = await callClaudeStructured(
    prompt02,
    directionsOutputSchema,
    "generate_directions",
    12000,
  );
  const validated = await postValidateDirections(fresh.directions, {
    targetMarketRegions: shortlist.profile.careerGoals.targetMarketRegions,
  });

  const existingKey = new Set(
    existingDirections.map((d) => `${d.roleSlug}|${d.bucket}`),
  );
  const candidate = validated.find(
    (d) => !existingKey.has(`${d.roleSlug}|${d.bucket}`),
  );
  if (!candidate) {
    console.warn("[Regen] No new direction found (all slugs/buckets overlap with current list).");
    return null;
  }

  let enrichedRow: EnrichedDirection | undefined;
  if (shortlist.clientSummary) {
    try {
      const rows = await enrichDirections([candidate], shortlist.clientSummary);
      enrichedRow = rows[0];
    } catch (err) {
      console.error("[Regen] enrichDirections failed:", err);
    }
  }

  console.log(
    `[Regen] Picked "${candidate.title}" (slug=${candidate.roleSlug}, bucket=${candidate.bucket})`,
  );
  return { direction: candidate, enriched: enrichedRow };
}

/**
 * Phase 2 — Deep analysis. Работает поверх уже готового `ShortlistResult`
 * и принятого админом списка `approvedDirections` (после Gate 1).
 *
 * Шаги: Step 3 (title optimization) → Step 4 (role reports) → Step 5
 * (Perplexity) → Step 5.5 (scraped summary) → Step 6 (prompt-03 analysis).
 */
export async function runDeepFromShortlist(
  shortlist: ShortlistResult,
  approvedDirections: Direction[],
  opts: { marketData?: string } = {},
): Promise<Phase1Result> {
  const timings: Record<string, number> = { ...shortlist.timings };
  const { profile, regions } = shortlist;
  const directions: DirectionsOutput = { directions: approvedDirections };
  const currentDirections = approvedDirections;
  let titleOptResults: TitleOptimizationResult[] = [];
  let perplexityRawData: unknown = null;

  let t0 = Date.now();
  if (process.env.PERPLEXITY_API_KEY) {
    console.log("[Deep/Step 3] Optimizing titles...");
    try {
      titleOptResults = await optimizeTitles(currentDirections, regions);
      timings["step3_titles"] = Date.now() - t0;
      for (const r of titleOptResults) {
        console.log(
          `[Deep/Step 3] "${r.directionTitle}" → best: "${r.bestTitle}" (market: ${r.totalMarketSize})`,
        );
      }
    } catch (err) {
      timings["step3_titles"] = Date.now() - t0;
      console.error("[Deep/Step 3] Title optimization failed:", err);
    }
  } else {
    console.log("[Deep/Step 3] PERPLEXITY_API_KEY not set, skipping title optimization");
  }

  console.log("[Deep/Step 4] Checking/fetching role reports...");
  t0 = Date.now();
  let roleReports: string;
  try {
    roleReports = await loadRoleReports(currentDirections, regions);
    timings["step4_kb"] = Date.now() - t0;
    console.log(`[Deep/Step 4] Done in ${timings["step4_kb"]}ms (${roleReports.length} chars)`);
  } catch (err) {
    timings["step4_kb"] = Date.now() - t0;
    console.error("[Deep/Step 4] Role reports failed:", err);
    roleReports = "Детальные отчёты по ролям не загружены.";
  }

  let marketData =
    opts.marketData ?? "Данные рынка не предоставлены, используй справочник конкуренции.";

  if (process.env.PERPLEXITY_API_KEY) {
    console.log("[Deep/Step 5] Fetching market data from Perplexity (source-aware)...");
    t0 = Date.now();
    try {
      const perplexityResult = await fetchMarketDataForDirections(currentDirections, profile);
      marketData = perplexityResult.formattedText;
      perplexityRawData = perplexityResult.rawData;
      timings["step5_market"] = Date.now() - t0;
      console.log(`[Deep/Step 5] Done in ${timings["step5_market"]}ms`);
    } catch (err) {
      timings["step5_market"] = Date.now() - t0;
      console.error("[Deep/Step 5] Perplexity failed, using fallback:", err);
    }
  } else {
    console.log("[Deep/Step 5] PERPLEXITY_API_KEY not set, skipping market data fetch");
  }

  let scrapedMarketData = "";
  try {
    const scrapedSummary = await buildFullMarketSummary(profile);
    scrapedMarketData = scrapedSummary.markdown;
  } catch (err) {
    console.error("[Deep/Step 5.5] Scraped market summary failed:", err);
  }

  console.log(
    `[Deep/Step 6] Analyzing ${currentDirections.length} directions → selecting top-3...`,
  );
  t0 = Date.now();
  const relevantDomains = inferRelevantDomains(currentDirections.map((d) => d.title));
  console.log(`[Deep/Step 6] Relevant domains: ${relevantDomains.join(", ")}`);

  const prompt03 = await loadPrompt03({
    candidateProfile: JSON.stringify(profile, null, 2),
    directionsOutput: JSON.stringify(directions, null, 2),
    marketData,
    scrapedMarketData,
    roleReports,
    relevantDomains,
  });
  const analysis = await callClaudeStructured(
    prompt03,
    analysisOutputSchema,
    "analyze_directions",
    16000,
  );
  timings["step6_analysis"] = Date.now() - t0;
  console.log(
    `[Deep/Step 6] Done in ${timings["step6_analysis"]}ms. Top-3: ${analysis.directions.map((d) => d.title).join(" | ")}`,
  );

  if (analysis.replacedDirections?.length) {
    console.log(`[Deep/Step 6] Отклонено ${analysis.replacedDirections.length} направлений:`);
    for (const r of analysis.replacedDirections) {
      console.log(`  ✗ "${r.originalTitle}": ${r.reason}`);
    }
  }

  const reviewSummary = buildReviewSummary(profile, directions, analysis);
  const reviewSummaryText = formatReviewForTelegram(reviewSummary);
  console.log("\n[Review Summary]");
  console.log(reviewSummaryText.replace(/<\/?b>/g, "**"));

  const totalTime = Object.values(timings).reduce((a, b) => a + b, 0);
  console.log(`\n[Phase 1 Total] ${totalTime}ms (${(totalTime / 1000).toFixed(1)}s)`);

  return {
    profile,
    directions,
    analysis,
    reviewSummaryText,
    perplexityMarketData: perplexityRawData,
    titleOptimization: titleOptResults,
    timings,
  };
}

/**
 * Legacy wrapper: full Phase 1 (shortlist + deep) в один вызов. Сохранён
 * для обратной совместимости с e2e-тестами и `runAnalysisPipeline`.
 * Новый код должен явно использовать `runShortlist` и потом
 * `runDeepFromShortlist`.
 */
export async function runAnalysisPhase1(
  input: AnalysisPipelineInput,
): Promise<Phase1Result> {
  const shortlist = await runShortlist(input);
  return runDeepFromShortlist(shortlist, shortlist.directions.directions, {
    marketData: input.marketData,
  });
}

/**
 * Phase 4: Final compilation (free-form Markdown).
 * Runs after admin review, optionally incorporating expert feedback.
 */
export async function runAnalysisPhase4(
  profile: CandidateProfile,
  directions: DirectionsOutput,
  analysis: AnalysisOutput,
  expertFeedback?: string,
): Promise<Phase4Result> {
  console.log("\n[Step 4] Compiling final document...");
  const t0 = Date.now();
  const prompt04 = await loadPrompt04({
    candidateProfile: JSON.stringify(profile, null, 2),
    directionsOutput: JSON.stringify(directions, null, 2),
    analysisOutput: JSON.stringify(analysis, null, 2),
    expertFeedback: expertFeedback || "Нет комментариев",
  });
  const finalDocument = await callClaudeText(prompt04);
  const timing = Date.now() - t0;
  console.log(`[Step 4] Done in ${timing}ms`);

  return { finalDocument, timing };
}

/**
 * Full pipeline (Phase 1 + Phase 4) for backward compatibility with E2E tests.
 */
export async function runAnalysisPipeline(
  input: AnalysisPipelineInput,
): Promise<AnalysisPipelineResult> {
  const phase1 = await runAnalysisPhase1(input);
  const phase4 = await runAnalysisPhase4(
    phase1.profile,
    phase1.directions,
    phase1.analysis,
    input.expertFeedback,
  );

  const timings = { ...phase1.timings, step4_final: phase4.timing };
  const totalTime = Object.values(timings).reduce((a, b) => a + b, 0);
  console.log(`\n[Total] ${totalTime}ms (${(totalTime / 1000).toFixed(1)}s)`);

  return {
    profile: phase1.profile,
    directions: phase1.directions,
    analysis: phase1.analysis,
    finalDocument: phase4.finalDocument,
    reviewSummaryText: phase1.reviewSummaryText,
    timings,
  };
}
