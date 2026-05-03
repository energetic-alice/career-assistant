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
  // ── Final analysis (Phase 3 + Phase 4 + Google Doc, после Approve Gate 2) ──
  "final_generating",
  "final_ready",
  "final_failed",
  // ── После отправки клиенту (ставится вручную куратором через карточку) ──
  "final_sent",
  // ── LinkedIn Pack (MVP: аудит + 5 headline вариантов) ───────────────────
  "linkedin_generating",
  "linkedin_ready",
  "linkedin_failed",
  "linkedin_sent",
]);

export type PipelineStage = z.infer<typeof pipelineStageEnum>;

/**
 * Метка программы Алисы, в рамках которой пришёл клиент.
 * Хранится в `stageOutputs.program` (extra-метаданные для UI карточки и
 * /clients-списка), НЕ участвует в pipeline-логике, поэтому не часть
 * `pipelineStateSchema`. Проставляется вручную через backfill/скрипты;
 * webhook сам ничего не выставляет — куратор решает.
 *
 *   - "КА1"  — первая «живая» программа (legacy-импорт из Google Doc'ов).
 *   - "КА2"  — текущая активная программа.
 *   - "М14"  — отдельный mentoring-трек.
 *   - "тест" — тестовые/пилотные клиенты.
 */
export const PROGRAM_LABELS = ["КА1", "КА2", "М14", "тест"] as const;
export type ProgramLabel = (typeof PROGRAM_LABELS)[number];

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
