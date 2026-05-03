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
  loadPrompt04bCleanup,
  inferRelevantDomains,
  renderQuestionnaireForPrompt,
  renderPhase0SlugsHint,
} from "./prompt-loader.js";
import { clientSummarySchema, type ClientSummary } from "../schemas/client-summary.js";
import { buildReviewSummary, formatReviewForTelegram } from "../services/review-summary.js";
import { fetchMarketDataForDirections } from "../services/perplexity-service.js";
import {
  loadMarketOverview,
  computeMarketAccess,
  buildFullMarketSummary,
} from "../services/market-data-service.js";
import { rankRoles, formatScorerTop20ForPrompt } from "../services/role-scorer.js";
import { resolveClientGrade } from "../services/client-grade.js";
import { computeAccessibleMarkets } from "../services/market-access.js";
import {
  enrichDirections,
  formatEnrichedForLog,
  postValidateDirections,
  buildTableHints,
  formatTableHints,
  resolveCandidateCurrentRoleStats,
  type EnrichedDirection,
} from "../services/direction-enricher.js";
import { directionKey } from "../services/deep-research-service.js";
import { getMarketResearchProvider } from "../services/market-research/index.js";
import { sanitizeRussianText } from "../services/text-sanitize.js";
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
  /**
   * Сырой snapshot анкеты из Google Form ({вопрос-заголовок → ответ}).
   * Прокидывается в Phase 1 prompt-02 как человекочитаемый первоисточник
   * (через `renderQuestionnaireForPrompt`). `questionnaire` выше —
   * JSON-дамп, структурированный для Phase 1 profile extraction; а
   * `rawNamedValues` сохраняет оригинальные формулировки клиента.
   */
  rawNamedValues?: Record<string, string>;
}

export interface Phase1Result {
  profile: CandidateProfile;
  directions: DirectionsOutput;
  analysis: AnalysisOutput;
  reviewSummaryText: string;
  perplexityMarketData?: unknown;
  timings: Record<string, number>;
  /**
   * Прокинутый из ShortlistResult clientSummary - нужен в Phase 4 для
   * детерминированного расчёта медианы рынка по текущей роли кандидата
   * (колонка Таблицы 3 "Senior сейчас" в финальном документе).
   */
  clientSummary?: ClientSummary;
  /**
   * EnrichedDirection-ы для 3 топ-направлений, выбранных Phase 3 — с
   * готовыми значениями vacancies/competition/trend/aiRisk из market-index
   * для подстановки в Таблицу 1 финального документа.
   */
  enrichedTop3?: EnrichedDirection[];
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
  /** Полный текст резюме (первоисточник для Phase 1 промпта и regen). */
  resumeText?: string;
  /** Человекочитаемая анкета (Q→A), первоисточник для Phase 1 и regen. */
  questionnaireHuman?: string;
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
  // Используем общий multi-path loader, чтобы не плодить одну и ту же
  // логику разрешения путей (на проде встречались ENOENT из-за разной
  // структуры dist vs src при запуске).
  const { loadMarketIndex } = await import("../services/role-scorer.js");
  const parsed = await loadMarketIndex();
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

  // Дедуп: нет смысла дублировать в desiredDirectionSlugs то, что уже
  // в currentSlugs — scorer в любом случае проскорит все currentSlugs
  // и включит их в `guaranteed`. Если клиент явно написал «хочу остаться
  // в X», то X должен быть в currentSlugs, и повторять его в desired
  // не нужно (в промпте 00 это тоже явно указано, но подстраховка на
  // случай, если Claude всё же продублирует).
  if (
    out.currentSlugs &&
    out.currentSlugs.length > 0 &&
    out.desiredDirectionSlugs &&
    out.desiredDirectionSlugs.length > 0
  ) {
    const curSet = new Set(out.currentSlugs);
    const before = out.desiredDirectionSlugs.length;
    out.desiredDirectionSlugs = out.desiredDirectionSlugs.filter(
      (d) => !curSet.has(d.slug),
    );
    const removed = before - out.desiredDirectionSlugs.length;
    if (removed > 0) {
      console.log(
        `[Phase 0] dedup: убрал ${removed} desiredDirectionSlugs уже входящих в currentSlugs ` +
          `(${out.currentSlugs.join(", ")})`,
      );
    }
  }

  // closestItSlugs не должен пересекаться с currentSlugs/desiredDirectionSlugs.
  // Это другой кейс: closest = функциональный аналог без опыта, current = с опытом,
  // desired = клиент сам просил. Если они совпали — приоритет current/desired
  // (там есть либо опыт, либо явное желание), closest можно убрать.
  if (out.closestItSlugs && out.closestItSlugs.length > 0) {
    const overlap = new Set<string>([
      ...(out.currentSlugs ?? []),
      ...((out.desiredDirectionSlugs ?? []).map((d) => d.slug)),
    ]);
    const before = out.closestItSlugs.length;
    out.closestItSlugs = out.closestItSlugs.filter((s) => !overlap.has(s));
    const removed = before - out.closestItSlugs.length;
    if (removed > 0) {
      console.log(
        `[Phase 0] dedup: убрал ${removed} closestItSlugs уже покрытых current/desired`,
      );
    }
  }

  return out;
}

/**
 * Phase 1 — Shortlist: лёгкая генерация 10–14 направлений без глубоких
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

  // Для Phase 1 нам достаточно scorer top-20: в нём реальные цифры из
  // market-index (vac / медиана / конкуренция / тренд) по топ-20 ролей под
  // клиента. Матрица конкуренции из competition-eu.md и compact market
  // summary (buildMarketSummary) — это те же числа, только для всех 40+ ролей
  // и без учёта релевантности. Оставляем только competition-ru для RU-таргета
  // как текстовый контекст по hh.ru-специфике.
  console.log("[Shortlist/Step 0] Pre-loading market overview...");
  t0 = Date.now();
  let marketOverview: string;
  try {
    marketOverview = await loadMarketOverview(regions);
    timings["step0_preload"] = Date.now() - t0;
    console.log(
      `[Shortlist/Step 0] Done in ${timings["step0_preload"]}ms (${marketOverview.length} chars)`,
    );
  } catch (err) {
    timings["step0_preload"] = Date.now() - t0;
    console.error("[Shortlist/Step 0] Pre-load failed, continuing without market overview:", err);
    marketOverview = "_(рыночный контекст не загружен — используй scorer top-20 ниже)_";
  }

  const showRu = regions.some((r) => r === "ru" || r === "cis");
  const showAbroad = regions.some(
    (r) => r === "eu" || r === "uk" || r === "us" || r === "global",
  );
  let scorerTop20: string | undefined;
  if (input.clientSummary) {
    try {
      const rank = await rankRoles(input.clientSummary, 20);
      scorerTop20 = formatScorerTop20ForPrompt(rank, 20, { showRu, showAbroad });
      console.log(
        `[Shortlist/Step 1c] Scorer top-20 ready (ru=${rank.ru.length}, abroad=${rank.abroad.length}, showRu=${showRu}, showAbroad=${showAbroad})`,
      );
    } catch (err) {
      console.error("[Shortlist/Step 1c] rankRoles failed, continuing without scorerTop20:", err);
    }
  } else {
    console.log("[Shortlist/Step 1c] clientSummary not provided, skipping scorer context");
  }

  console.log("[Shortlist/Step 2] Generating directions (market + scorer top-20)...");
  t0 = Date.now();
  const questionnaireHuman = renderQuestionnaireForPrompt(input.rawNamedValues);
  const phase0SlugsHint = input.clientSummary
    ? renderPhase0SlugsHint(input.clientSummary)
    : "";
  const prompt02 = await loadPrompt02({
    candidateProfile: JSON.stringify(profile, null, 2),
    marketOverview,
    scorerTop20,
    resumeText: input.resumeText,
    questionnaireHuman,
    phase0SlugsHint,
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
  // Страховка от случаев когда Клод проигнорировал «отсортируй по score DESC».
  directions.directions.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  console.log(
    `[Shortlist/Step 2] After post-validate + score-sort: ${directions.directions.length} directions ` +
      `(scores: ${directions.directions.map((d) => d.score ?? "?").join(", ")})`,
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
    resumeText: input.resumeText,
    questionnaireHuman,
  };
}

/**
 * Перегенерация одного направления в рамках Gate 1.
 *
 * Зовёт prompt-02 заново с теми же контекстом (profile/marketOverview/
 * scorerTop20) и ищет в новом 10–14 списке первое направление с парой
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
    resumeText: shortlist.resumeText,
    questionnaireHuman: shortlist.questionnaireHuman,
    phase0SlugsHint: shortlist.clientSummary
      ? renderPhase0SlugsHint(shortlist.clientSummary)
      : "",
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
  // Сортируем кандидатов по score DESC, чтобы в качестве замены выдать ЛУЧШЕЕ
  // новое направление, а не просто первое по порядку.
  validated.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

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

// ─── Phase 2 — Deep Research (Gate 2) ────────────────────────────────────────

export interface DeepResearchResult {
  /**
   * Те же одобренные direction'ы что пришли на вход (порядок сохранён).
   * Phase 2 НЕ перегенерирует и НЕ переранжирует — это работа Phase 3.
   */
  directions: Direction[];
  /** EnrichedDirection с дозаполненными через Perplexity дырами. */
  enriched: EnrichedDirection[];
  timings: Record<string, number>;
  /** Сколько направлений реально дёрнули через Perplexity. */
  perplexityFills: number;
  resumeText?: string;
  questionnaireHuman?: string;
}

/**
 * Phase 2 — Gate 2: точечное обогащение данных по одобренным после Gate 1 направлениям.
 *
 * Архитектура (anti-hallucination):
 *   - Никакого Claude — только детерминированный merge KB + опциональный Perplexity.
 *   - Perplexity дёргается ТОЛЬКО когда у direction'а есть дыры (vacancies/aiRisk/median = null)
 *     И эти дыры объяснимы внешним фактором: off-index slug или экзотический регион
 *     (latam/asia-pacific/middle-east/global).
 *   - cis = ru-данные (RU как прокси), для них Perplexity не дёргаем.
 *   - Один batch Perplexity-запрос на клиента, baseline = всё что уже есть из market-index.
 *   - Validate-gate: число без citations → drop в null.
 *
 * Phase 3 (финальный анализ + позиционирование) — отдельная задача и здесь не делается.
 */
export async function runDeepResearch(
  shortlist: ShortlistResult,
  approvedDirections: Direction[],
): Promise<DeepResearchResult> {
  const timings: Record<string, number> = {};
  const { clientSummary, resumeText, questionnaireHuman } = shortlist;

  if (!clientSummary) {
    throw new Error("[DeepResearch] clientSummary is required for Phase 2");
  }
  if (approvedDirections.length === 0) {
    throw new Error("[DeepResearch] approvedDirections is empty");
  }

  console.log(
    `[DeepResearch] Starting for ${approvedDirections.length} approved directions: ` +
    approvedDirections.map((d) => d.roleSlug).join(", "),
  );

  // Step 1: получаем baseline EnrichedDirection (либо из shortlist.enriched,
  // либо пересчитываем для approved).
  //
  // ВАЖНО: ключ — `directionKey()` (title|bucket), а не `slug|bucket`.
  // Иначе для wide-family slug-ов (`infosecspec`, `devops`, ...) три разных
  // approved direction'а с одинаковым slug+bucket (Daria — AppSec / DevSecOps /
  // SOC, все `infosecspec|usa`) схлопываются в один и берут одну и ту же enriched
  // запись из shortlist. См. `directionKey` в deep-research-service.
  let t0 = Date.now();
  const enrichedByDirKey = new Map<string, EnrichedDirection>();
  for (const e of shortlist.enriched) {
    enrichedByDirKey.set(directionKey(e), e);
  }
  // baseline идёт строго в порядке approvedDirections — так Phase 2 enrichment
  // (`enrichGaps`) и downstream (`formatEnrichedAsMarketData`) видят данные
  // ровно в том же порядке, что и approved направления.
  const baseline: (EnrichedDirection | null)[] = approvedDirections.map((d) =>
    enrichedByDirKey.get(directionKey(d)) ?? null,
  );
  const missingFromShortlist: { direction: Direction; index: number }[] = [];
  for (let i = 0; i < approvedDirections.length; i++) {
    if (baseline[i] === null) {
      missingFromShortlist.push({ direction: approvedDirections[i], index: i });
    }
  }
  if (missingFromShortlist.length > 0) {
    const fresh = await enrichDirections(
      missingFromShortlist.map((m) => m.direction),
      clientSummary,
    );
    for (let i = 0; i < missingFromShortlist.length; i++) {
      baseline[missingFromShortlist[i].index] = fresh[i];
    }
  }
  const baselineFilled: EnrichedDirection[] = baseline.filter(
    (e): e is EnrichedDirection => e !== null,
  );
  timings["baseline"] = Date.now() - t0;

  // Step 2: дозаполняем дыры через выбранный provider (only где нужно)
  t0 = Date.now();
  const provider = getMarketResearchProvider();
  const enriched = await provider.enrichGaps({
    directions: approvedDirections,
    baseline: baselineFilled,
    summary: clientSummary,
  });
  timings["market_research_enrich"] = Date.now() - t0;

  // Kept legacy name `perplexityFills` for state/UI compatibility, but it's
  // actually a generic enrichment-fills counter (any external provider).
  const perplexityFills = enriched.filter((e) =>
    [
      "perplexity",
      "perplexity-estimate",
      "claude",
      "claude-estimate",
    ].includes(e.dataSource),
  ).length;

  const totalTime = Object.values(timings).reduce((a, b) => a + b, 0);
  console.log(
    `[DeepResearch Total] ${totalTime}ms (${(totalTime / 1000).toFixed(1)}s) · ` +
    `provider=${provider.name} fills: ${perplexityFills}/${enriched.length}`,
  );

  return {
    directions: approvedDirections,
    enriched,
    timings,
    perplexityFills,
    resumeText,
    questionnaireHuman,
  };
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
  opts: {
    marketData?: string;
    /**
     * Если true — Step 5 (Perplexity `fetchMarketDataForDirections`) пропускается.
     * Используется когда вызывающий код уже передал в `marketData` агрегированные
     * данные Phase 2 enrichment (через `formatEnrichedAsMarketData`), чтобы не
     * дёргать Perplexity повторно ради тех же чисел.
     */
    skipPerplexityStep5?: boolean;
  } = {},
): Promise<Phase1Result> {
  const timings: Record<string, number> = { ...shortlist.timings };
  const { profile } = shortlist;
  const directions: DirectionsOutput = { directions: approvedDirections };
  const currentDirections = approvedDirections;
  let perplexityRawData: unknown = null;

  // Step 3 (Perplexity title optimization) и Step 4 (loadRoleReports
  // через Perplexity-скрап в `prompts/market-data/role-*.md`) убраны:
  //   - Step 3 возвращал мусорный markdown с цитатами ("**: **Senior X**
  //     gives MOST vacancies (604 vs 66)[2][8].") и противоречил данным
  //     itjobswatch — `bestTitle` не парсился и в prompt-03 не попадал.
  //   - Step 4 без спроса дёргал Perplexity и писал .md-файлы в repo
  //     (`role-<slug>-<region>.md`), при этом для US-региона возвращал UK-
  //     данные. KB о ролях теперь живёт в `uk_<slug>.md` + `niche-aliases.json`.
  // Точные цифры по approved направлениям приходят из Phase 2 enrichment
  // (`marketData` — `formatEnrichedAsMarketData(enriched)`), широкий рынок —
  // из Step 5.5 `buildFullMarketSummary`.

  let t0 = Date.now();
  let marketData =
    opts.marketData ?? "Данные рынка не предоставлены, используй справочник конкуренции.";

  if (opts.skipPerplexityStep5) {
    console.log(
      "[Deep/Step 5] Skipped (caller passed market data from Phase 2 enrichment)",
    );
    timings["step5_market"] = 0;
  } else if (process.env.PERPLEXITY_API_KEY) {
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
    relevantDomains,
  });
  const analysis = await callClaudeStructured(
    prompt03,
    analysisOutputSchema,
    "analyze_directions",
    16000,
  );
  timings["step6_analysis"] = Date.now() - t0;

  // Детерминированный пересчёт retrainingVolume из adjacencyScorePercent.
  // Модель склонна ставить "существенное" даже когда adjacency=85% (разраб→DevOps
  // и т.п.) и пугать клиента 12+ месяцами переобучения. Шкала в коде:
  //   >= 80  → минимальное  (по сути та же/очень близкая роль)
  //   60-79  → умеренное    (смежная ниша, 3-6 мес)
  //   < 60   → существенное (существенно новая специализация)
  // Модель больше не решает retrainingVolume, только оценивает adjacency.
  for (const d of analysis.directions) {
    const adj = d.transition?.adjacencyScorePercent ?? 0;
    const prevVolume = d.transition.retrainingVolume;
    const newVolume: "минимальное" | "умеренное" | "существенное" =
      adj >= 80 ? "минимальное" : adj >= 60 ? "умеренное" : "существенное";
    if (prevVolume !== newVolume) {
      console.log(
        `[Deep/Step 6] retrainingVolume "${d.title}": ${prevVolume} → ${newVolume} (adjacency=${adj}%)`,
      );
    }
    d.transition.retrainingVolume = newVolume;
  }

  console.log(
    `[Deep/Step 6] Done in ${timings["step6_analysis"]}ms. Top-3: ${analysis.directions.map((d) => d.title).join(" | ")}`,
  );

  if (analysis.rejectedDirections?.length) {
    console.log(`[Deep/Step 6] Отклонено ${analysis.rejectedDirections.length} направлений:`);
    for (const r of analysis.rejectedDirections) {
      console.log(`  ✗ "${r.originalTitle}": ${r.reason}`);
    }
  }

  const reviewSummary = buildReviewSummary(profile, directions, analysis);
  const reviewSummaryText = formatReviewForTelegram(reviewSummary);
  console.log("\n[Review Summary]");
  console.log(reviewSummaryText.replace(/<\/?b>/g, "**"));

  const totalTime = Object.values(timings).reduce((a, b) => a + b, 0);
  console.log(`\n[Phase 1 Total] ${totalTime}ms (${(totalTime / 1000).toFixed(1)}s)`);

  // Дёргаем enriched именно для ТОП-3 (после Phase 3 отбора). Это нужно
  // Phase 4 чтобы заполнить Таблицу 1 готовыми значениями. Берём из
  // shortlist.enriched по совпадению title — titles у Phase 3 и Phase 1
  // совпадают (Phase 3 не переименовывает direction'ы).
  const enrichedTop3: EnrichedDirection[] = [];
  if (shortlist.enriched && shortlist.enriched.length > 0) {
    for (const d of analysis.directions) {
      const match = shortlist.enriched.find((e) => e.title === d.title);
      if (match) enrichedTop3.push(match);
    }
  }

  return {
    profile,
    directions,
    analysis,
    reviewSummaryText,
    perplexityMarketData: perplexityRawData,
    timings,
    clientSummary: shortlist.clientSummary,
    enrichedTop3,
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
/**
 * Best-effort определение уровня кандидата (junior/middle/senior) для
 * адаптивной чистки в Phase 4b. Главные сигналы:
 *   1. Низкий английский (0/A1/A2) почти всегда означает ru-only / non-IT
 *      кандидата — для них вычищаем максимально жёстко (как junior).
 *   2. Иначе ориентируемся на yearsInCurrentRole: <2 → junior, 2-5 → middle,
 *      5+ → senior. Это грубо для non-IT с большим стажем (HR с 15 лет
 *      опыта формально получит senior), но это безопасный fallback —
 *      "лишняя" чистка не вредит, а недочистка — вредит.
 */
function inferCandidateLevel(profile: CandidateProfile): "junior" | "middle" | "senior" {
  const englishLevel = profile.currentBase?.englishLevel;
  if (englishLevel === "0" || englishLevel === "A1" || englishLevel === "A2") {
    return "junior";
  }
  const yearsRaw = profile.currentBase?.yearsInCurrentRole ?? "";
  const yearsMatch = yearsRaw.match(/(\d+(?:\.\d+)?)/);
  const years = yearsMatch ? parseFloat(yearsMatch[1]!) : 0;
  if (years >= 5) return "senior";
  if (years >= 2) return "middle";
  return "junior";
}

/**
 * Грубая эвристика: документ англоязычный, если в первых 2k символов латиницы
 * заметно больше кириллицы. Тогда Phase 4b cleanup пропускаем — он заточен
 * под чистку русского текста и в английском только испортит формулировки.
 */
function isEnglishDocument(md: string): boolean {
  const sample = md.slice(0, 2000);
  const cyrillic = (sample.match(/[а-яА-ЯёЁ]/g) ?? []).length;
  const latin = (sample.match(/[a-zA-Z]/g) ?? []).length;
  return latin > cyrillic * 2;
}

export async function runAnalysisPhase4(
  profile: CandidateProfile,
  directions: DirectionsOutput,
  analysis: AnalysisOutput,
  expertFeedback?: string,
  opts?: {
    candidateLevel?: "junior" | "middle" | "senior";
    skipStyleCleanup?: boolean;
    /**
     * Enriched directions из Phase 2+ (с slug-level vacancies/competition/trend
     * из market-index). Используются для детерминированного заполнения
     * колонок Таблицы 1 и Таблицы 3 в финальном документе (ширина рынка,
     * динамика, конкуренция, AI-риск, медиана для текущей роли). Если не
     * передан - `tableHints` будет пустой и модель сгенерирует таблицы как
     * раньше (legacy режим, на случай вызова из старых e2e-тестов).
     */
    enriched?: EnrichedDirection[];
    /**
     * ClientSummary клиента - нужен чтобы посчитать медиану рынка по
     * ТЕКУЩЕЙ роли кандидата для Таблицы 3 "Senior сейчас". Если не
     * передан, соответствующая колонка в hints останется пустой.
     */
    clientSummary?: ClientSummary;
  },
): Promise<Phase4Result> {
  console.log("\n[Step 4] Compiling final document...");
  const t0 = Date.now();

  // Собираем готовые значения для Таблиц 1 и 3 из кода, чтобы модель не
  // пересчитывала (частый источник рассинхрона проза ↔ таблицы).
  let tableHintsText = "";
  if (opts?.enriched && opts.enriched.length > 0) {
    const hints = buildTableHints(opts.enriched);
    const topTitles = analysis.directions.map((d) => {
      const enriched = opts.enriched!.find((e) => e.title === d.title);
      return {
        title: d.title,
        roleSlug: enriched?.roleSlug ?? "",
      };
    });
    let currentRole: Awaited<ReturnType<typeof resolveCandidateCurrentRoleStats>> = null;
    if (opts.clientSummary) {
      try {
        currentRole = await resolveCandidateCurrentRoleStats(opts.clientSummary);
      } catch (err) {
        console.warn(
          `[Step 4] resolveCandidateCurrentRoleStats failed: ${(err as Error).message}`,
        );
      }
    }
    // EU/UK B2B подсказка: клиент выбрал только ru/cis, но с B2+ английским
    // это реалистичная опция. В Стратегическом алерте финала упомянем
    // аккуратно, без расширения accessibleMarkets (это меняло бы весь
    // анализ и направления).
    const targets = opts.clientSummary?.targetMarketRegions ?? [];
    const onlyRuCis =
      targets.length > 0 && targets.every((r) => r === "ru" || r === "cis");
    const eng = (opts.clientSummary?.englishLevel ?? "").toUpperCase();
    const hasB2PlusEnglish = /\b(B2|C1|C2)\b/.test(eng);
    const shouldMentionEuB2B = onlyRuCis && hasB2PlusEnglish;

    tableHintsText = formatTableHints({
      topDirections: topTitles,
      hints,
      candidateCurrentRole: currentRole,
      shouldMentionEuB2B,
    });
    console.log(
      `[Step 4] tableHints: ${hints.length} directions, currentRoleMedian=${currentRole?.medianSalaryMid ?? "—"}, euB2B=${shouldMentionEuB2B}`,
    );
  } else {
    tableHintsText =
      "# Готовые значения для таблиц\n\n(не переданы — собери значения из analysisOutput как обычно)";
  }

  const prompt04 = await loadPrompt04({
    candidateProfile: JSON.stringify(profile, null, 2),
    directionsOutput: JSON.stringify(directions, null, 2),
    analysisOutput: JSON.stringify(analysis, null, 2),
    expertFeedback: expertFeedback || "Нет комментариев",
    tableHints: tableHintsText,
  });
  const draftDocument = await callClaudeText(prompt04);
  const draftTiming = Date.now() - t0;
  console.log(`[Step 4] Draft ready in ${draftTiming}ms (${draftDocument.length} chars)`);

  // Phase 4b: style cleanup pass.
  // Запускается на русскоязычных документах для вычистки англицизмов и
  // раскрытия аббревиатур. Английские документы пропускаем - там cleanup
  // только испортит формулировки.
  const englishDoc = isEnglishDocument(draftDocument);
  if (opts?.skipStyleCleanup || englishDoc) {
    if (opts?.skipStyleCleanup) {
      console.log("[Step 4b] SKIPPED (skipStyleCleanup=true)");
    } else {
      console.log("[Step 4b] SKIPPED (документ англоязычный)");
    }
    // Для англоязычных документов символьную зачистку не применяем -
    // em-dash в английском это норма; для русских пропуск всё равно
    // прогоняем через sanitize (на случай ручного skipStyleCleanup=true
    // из вызывающего кода).
    const out = englishDoc ? draftDocument : sanitizeRussianText(draftDocument);
    return { finalDocument: out, timing: draftTiming };
  }

  console.log("[Step 4b] Style cleanup pass...");
  const tCleanup = Date.now();
  const candidateLevel = opts?.candidateLevel ?? inferCandidateLevel(profile);
  const englishLevel = profile.currentBase?.englishLevel ?? "B1";
  const cleanupPrompt = await loadPrompt04bCleanup({
    originalDocument: draftDocument,
    candidateLevel,
    englishLevel,
  });

  let finalDocument = draftDocument;
  try {
    finalDocument = await callClaudeText(cleanupPrompt, 16000);
    const cleanupTiming = Date.now() - tCleanup;
    console.log(
      `[Step 4b] Cleanup done in ${cleanupTiming}ms ` +
        `(level=${candidateLevel}, en=${englishLevel}, ` +
        `${draftDocument.length} -> ${finalDocument.length} chars)`,
    );
  } catch (err) {
    console.warn(
      `[Step 4b] Cleanup FAILED, fallback to draft: ${(err as Error).message}`,
    );
  }

  // Финальная детерминированная зачистка - последний рубеж против ё/тире,
  // которые регулярно проскакивают через LLM. Применяется и к успешному
  // cleanup-результату, и к draft-fallback.
  const beforeSanitize = finalDocument.length;
  finalDocument = sanitizeRussianText(finalDocument);
  if (finalDocument.length !== beforeSanitize) {
    console.log(
      `[Step 4b] Sanitize: ${beforeSanitize} -> ${finalDocument.length} chars (ё/—/– убраны)`,
    );
  }

  const timing = Date.now() - t0;
  console.log(`[Step 4 + 4b] Total ${timing}ms`);
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
    {
      enriched: phase1.enrichedTop3,
      clientSummary: phase1.clientSummary,
    },
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
