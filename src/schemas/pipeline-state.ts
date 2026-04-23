import { z } from "zod";

export const pipelineStageEnum = z.enum([
  "intake_received",
  "resume_parsed",
  "awaiting_analysis",
  "analysis_running",
  "profile_extracted",
  "directions_generated",
  "market_data_fetched",
  "directions_analyzed",
  "admin_review_pending",
  "admin_reviewed",
  "final_compiled",
  "completed",
  "completed_legacy",
  // ── Gate 1 — интерактивный shortlist ─────────────────────────────────
  "shortlist_generating",
  "shortlist_ready",
  "shortlist_failed",
  "shortlist_approved",
  // ── Gate 2 — глубокий анализ (после Approve Gate 1) ─────────────────
  "deep_generating",
  "deep_ready",
  "deep_failed",
  "deep_approved",
]);

export type PipelineStage = z.infer<typeof pipelineStageEnum>;

export const pipelineStateSchema = z.object({
  participantId: z.string(),
  telegramNick: z.string(),
  stage: pipelineStageEnum,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  error: z.string().optional(),
  stageOutputs: z.record(z.string(), z.unknown()).optional(),
});

export type PipelineState = z.infer<typeof pipelineStateSchema>;
