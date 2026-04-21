import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodSchema } from "zod";
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

const client = new Anthropic();
const MODEL = "claude-sonnet-4-20250514";

async function callClaudeStructured<T>(
  prompt: string,
  schema: ZodSchema<T>,
  toolName: string,
  maxTokens = 8192,
): Promise<T> {
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
  const summary = await callClaudeStructured(
    prompt,
    clientSummarySchema,
    "client_summary",
    2048,
  );
  console.log(`[Phase 0] Done in ${Date.now() - t0}ms (${summary.firstNameLatin} ${summary.lastNameLatin})`);
  return summary;
}

/**
 * Phase 1: Market-aware pipeline v2.
 *
 * Step 1:  Profile extraction
 * Step 0*: Pre-load market reports for target regions
 * Step 2:  Direction generation (with marketOverview)
 * Step 3:  Title optimization (itjobswatch / hh.ru)
 * Step 4:  KB check — ensure role reports exist
 * Step 5:  Actualization (source-aware Perplexity)
 * Step 6:  Analysis (with feedback loop — max 2 iterations)
 *
 * *Step 0 runs after Step 1 because we need the profile to know target regions.
 */
export async function runAnalysisPhase1(
  input: AnalysisPipelineInput,
): Promise<Phase1Result> {
  const timings: Record<string, number> = {};

  // ── Step 1: Profile extraction ──────────────────────────────────────────
  console.log("[Step 1] Extracting candidate profile...");
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
  console.log(`[Step 1] Done in ${timings["step1_profile"]}ms. English: ${profile.currentBase.englishLevel}`);

  // ── Step 1b: Compute market access flags ──────────────────────────────
  profile = computeMarketAccess(profile);
  const regions = profile.careerGoals.targetMarketRegions;
  console.log(`[Step 1] Target regions: ${regions.join(", ")}`);
  console.log(`[Step 1] Accessible markets: ${profile.barriers.accessibleMarkets?.join(", ")}`);
  console.log(`[Step 1] PhysRU=${profile.barriers.isPhysicallyInRU} PhysEU=${profile.barriers.isPhysicallyInEU} RUwp=${profile.barriers.hasRuWorkPermit} EUwp=${profile.barriers.hasEUWorkPermit}`);

  // ── Step 0: Pre-load KB + scraped market summary ──────────────────────
  console.log("[Step 0] Pre-loading market overview...");
  t0 = Date.now();
  let marketOverview: string;
  try {
    const [kbOverview, scrapedSummary] = await Promise.all([
      loadMarketOverview(regions),
      buildFullMarketSummary(profile),
    ]);
    marketOverview = kbOverview + "\n\n---\n\n" + scrapedSummary.markdown;
    timings["step0_preload"] = Date.now() - t0;
    console.log(`[Step 0] Done in ${timings["step0_preload"]}ms (${marketOverview.length} chars, ${scrapedSummary.roles.length} roles in table)`);
  } catch (err) {
    timings["step0_preload"] = Date.now() - t0;
    console.error("[Step 0] Pre-load failed, continuing without market data:", err);
    marketOverview = "Рыночные данные не загружены. Используй свои знания о рынке IT 2026.";
  }

  // ── Step 2: Direction generation (market-informed) ─────────────────────
  console.log("[Step 2] Generating directions (with market overview)...");
  t0 = Date.now();
  const prompt02 = await loadPrompt02({
    candidateProfile: JSON.stringify(profile, null, 2),
    marketOverview,
  });
  let directions = await callClaudeStructured(
    prompt02,
    directionsOutputSchema,
    "generate_directions",
    12000,
  );
  timings["step2_directions"] = Date.now() - t0;
  console.log(`[Step 2] Done in ${timings["step2_directions"]}ms. ${directions.directions.length} directions: ${directions.directions.map((d) => d.title).join(" | ")}`);

  // ── Steps 3-6: single pass (no feedback loop — Step 6 selects top-3) ──
  const currentDirections = directions.directions;
  let titleOptResults: TitleOptimizationResult[] = [];
  let perplexityRawData: unknown = null;

  // ── Step 3: Title optimization ─────────────────────────────────────
  if (process.env.PERPLEXITY_API_KEY) {
    console.log("[Step 3] Optimizing titles...");
    t0 = Date.now();
    try {
      titleOptResults = await optimizeTitles(currentDirections, regions);
      timings["step3_titles"] = Date.now() - t0;
      for (const r of titleOptResults) {
        console.log(`[Step 3] "${r.directionTitle}" → best: "${r.bestTitle}" (market: ${r.totalMarketSize})`);
      }
    } catch (err) {
      timings["step3_titles"] = Date.now() - t0;
      console.error("[Step 3] Title optimization failed:", err);
    }
  } else {
    console.log("[Step 3] PERPLEXITY_API_KEY not set, skipping title optimization");
  }

  // ── Step 4: KB check — ensure role reports exist ───────────────────
  console.log("[Step 4] Checking/fetching role reports...");
  t0 = Date.now();
  let roleReports: string;
  try {
    roleReports = await loadRoleReports(currentDirections, regions);
    timings["step4_kb"] = Date.now() - t0;
    console.log(`[Step 4] Done in ${timings["step4_kb"]}ms (${roleReports.length} chars)`);
  } catch (err) {
    timings["step4_kb"] = Date.now() - t0;
    console.error("[Step 4] Role reports failed:", err);
    roleReports = "Детальные отчёты по ролям не загружены.";
  }

  // ── Step 5: Actualization (source-aware Perplexity) ────────────────
  let marketData = input.marketData || "Данные рынка не предоставлены, используй справочник конкуренции.";

  if (process.env.PERPLEXITY_API_KEY) {
    console.log("[Step 5] Fetching market data from Perplexity (source-aware)...");
    t0 = Date.now();
    try {
      const perplexityResult = await fetchMarketDataForDirections(
        currentDirections,
        profile,
      );
      marketData = perplexityResult.formattedText;
      perplexityRawData = perplexityResult.rawData;
      timings["step5_market"] = Date.now() - t0;
      console.log(`[Step 5] Done in ${timings["step5_market"]}ms`);
    } catch (err) {
      timings["step5_market"] = Date.now() - t0;
      console.error("[Step 5] Perplexity failed, using fallback:", err);
    }
  } else {
    console.log("[Step 5] PERPLEXITY_API_KEY not set, skipping market data fetch");
  }

  // ── Step 5.5: Build scraped market summary for analysis ──────────
  let scrapedMarketData = "";
  try {
    const scrapedSummary = await buildFullMarketSummary(profile);
    scrapedMarketData = scrapedSummary.markdown;
  } catch (err) {
    console.error("[Step 5.5] Scraped market summary failed:", err);
  }

  // ── Step 6: Analysis (5-9 → top-3) ────────────────────────────────
  console.log(`[Step 6] Analyzing ${currentDirections.length} directions → selecting top-3...`);
  t0 = Date.now();
  const relevantDomains = inferRelevantDomains(
    currentDirections.map((d) => d.title),
  );
  console.log(`[Step 6] Relevant domains: ${relevantDomains.join(", ")}`);

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
  console.log(`[Step 6] Done in ${timings["step6_analysis"]}ms. Top-3: ${analysis.directions.map((d) => d.title).join(" | ")}`);

  if (analysis.replacedDirections?.length) {
    console.log(`[Step 6] Отклонено ${analysis.replacedDirections.length} направлений:`);
    for (const r of analysis.replacedDirections) {
      console.log(`  ✗ "${r.originalTitle}": ${r.reason}`);
    }
  }

  if (!analysis) {
    throw new Error("Analysis was not produced");
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
