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
} from "../schemas/analysis-outputs.js";
import {
  loadPrompt01,
  loadPrompt02,
  loadPrompt03,
  loadPrompt04,
  inferRelevantDomains,
} from "./prompt-loader.js";
import { buildReviewSummary, formatReviewForTelegram } from "../services/review-summary.js";

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
 * Phase 1: Steps 1-3 (profile extraction, direction generation, direction analysis).
 * Returns structured data + review summary for admin approval.
 */
export async function runAnalysisPhase1(
  input: AnalysisPipelineInput,
): Promise<Phase1Result> {
  const timings: Record<string, number> = {};

  console.log("[Step 1] Extracting candidate profile...");
  let t0 = Date.now();
  const prompt01 = await loadPrompt01({
    questionnaire: input.questionnaire,
    resumeText: input.resumeText,
    linkedinUrl: input.linkedinUrl,
    linkedinSSI: input.linkedinSSI,
  });
  const profile = await callClaudeStructured(
    prompt01,
    candidateProfileSchema,
    "extract_profile",
  );
  timings["step1_profile"] = Date.now() - t0;
  console.log(`[Step 1] Done in ${timings["step1_profile"]}ms. Language mode: ${profile.languageMode}`);

  console.log("[Step 2] Generating directions...");
  t0 = Date.now();
  const prompt02 = await loadPrompt02({
    candidateProfile: JSON.stringify(profile, null, 2),
  });
  const directions = await callClaudeStructured(
    prompt02,
    directionsOutputSchema,
    "generate_directions",
    12000,
  );
  timings["step2_directions"] = Date.now() - t0;
  console.log(`[Step 2] Done in ${timings["step2_directions"]}ms. Directions: ${directions.directions.map((d) => d.title).join(" | ")}`);

  console.log("[Step 3] Analyzing directions...");
  t0 = Date.now();
  const relevantDomains = inferRelevantDomains(
    directions.directions.map((d) => d.title),
  );
  console.log(`[Step 3] Relevant domains: ${relevantDomains.join(", ")}`);

  const prompt03 = await loadPrompt03({
    candidateProfile: JSON.stringify(profile, null, 2),
    directionsOutput: JSON.stringify(directions, null, 2),
    marketData: input.marketData || "Данные рынка не предоставлены, используй справочник конкуренции.",
    relevantDomains,
  });
  const analysis = await callClaudeStructured(
    prompt03,
    analysisOutputSchema,
    "analyze_directions",
    16000,
  );
  timings["step3_analysis"] = Date.now() - t0;
  console.log(`[Step 3] Done in ${timings["step3_analysis"]}ms`);

  const reviewSummary = buildReviewSummary(profile, directions, analysis);
  const reviewSummaryText = formatReviewForTelegram(reviewSummary);
  console.log("\n[Review Summary]");
  console.log(reviewSummaryText.replace(/<\/?b>/g, "**"));

  const totalTime = Object.values(timings).reduce((a, b) => a + b, 0);
  console.log(`\n[Phase 1 Total] ${totalTime}ms (${(totalTime / 1000).toFixed(1)}s)`);

  return { profile, directions, analysis, reviewSummaryText, timings };
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
