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
  // ── Финальный гейт (после Approve Gate 1) ──────────────────────────
  // `deep_approved` — shortlist одобрен, готов к генерации финала.
  // `deep_failed` — подготовка финального гейта упала.
  // `deep_generating`/`deep_ready` — LEGACY: код их больше не выставляет
  //   (Gate 2 / Perplexity-дозаполнение убраны и слиты в Gate 1). Оставлены
  //   в enum только чтобы не падала загрузка старых сохранённых состояний.
  "deep_generating",
  "deep_ready",
  "deep_failed",
  "deep_approved",
  // ── Final analysis (Phase 3 + Phase 4 + Google Doc) ────────────────────────
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
 *   - "КА2"  — предыдущая программа (закрыта после старта КА3).
 *   - "КА3"  — текущая активная программа.
 *   - "М14"  — отдельный mentoring-трек.
 *   - "тест" — тестовые/пилотные клиенты.
 *
 * VIP — отдельный, ОРТОГОНАЛЬНЫЙ программе флаг (`stageOutputs.vip: boolean`):
 * клиент может быть одновременно в потоке и VIP (например, «КА3 + VIP»).
 * Проставляется кнопкой в карточке (`prog:vip:*`), показывается тегом в
 * /clients и имеет свой селектор-фильтр. В PROGRAM_LABELS его НЕ добавляем.
 */
export const PROGRAM_LABELS = ["КА1", "КА2", "КА3", "М14", "тест"] as const;
export type ProgramLabel = (typeof PROGRAM_LABELS)[number];

/**
 * Метки, доступные для ВЫБОРА в интерфейсе (фильтр /clients + кнопки карточки).
 * "М14" — закрытый mentoring-трек: остаётся валидной меткой в данных и типе
 * (старые клиенты сохраняют свой тег, он отображается в списке), но из
 * интерфейса убран, чтобы не мешать куратору. Валидация prog:set по-прежнему
 * принимает полный PROGRAM_LABELS (можно снять старую метку, если осталась).
 */
export const SELECTABLE_PROGRAM_LABELS: readonly ProgramLabel[] =
  PROGRAM_LABELS.filter((l) => l !== "М14");

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
