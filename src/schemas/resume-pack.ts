import { z } from "zod";

import {
  auditItemSchema,
  auditBlockSchema,
  auditItemStatusEnum,
  type AuditItem,
  type AuditBlock,
  type AuditItemStatus,
} from "./linkedin-pack.js";

/**
 * Zod-схемы для Resume Pack MVP.
 *
 * MVP сейчас = только Phase 1 (audit резюме по чек-листу Алисы из
 * `kb/resume-methodology.md`). Структура артефакта намеренно сделана
 * по образцу LinkedIn-пака, чтобы потом можно было дозалить Phase 2/3
 * (переписанные Summary/Experience/Skills) в `resumePackSchema` без
 * миграции уже сохранённых аудитов.
 *
 * Общие audit-типы (AuditItem, AuditBlock, AuditItemStatus) переиспользуем
 * из `linkedin-pack.ts` — статусы pass/fail/unknown одинаковы, нет смысла
 * клонировать определения и расходиться по неосторожности.
 */

export {
  auditItemSchema,
  auditBlockSchema,
  auditItemStatusEnum,
  type AuditItem,
  type AuditBlock,
  type AuditItemStatus,
};

/**
 * `targetMarket` — модель проставляет его в самом ответе аудита, мы потом
 * переносим в `resumePackMetaSchema.targetMarket` в run-pack.ts. Делаем
 * optional на случай, если старый промпт не пропишет — fallback на null.
 */
export const resumeTargetMarketEnum = z.enum(["abroad", "ru", "mixed"]);
export type ResumeTargetMarket = z.infer<typeof resumeTargetMarketEnum>;

export const resumeAuditSchema = z
  .object({
    targetMarket: resumeTargetMarketEnum.optional(),
    blocks: z.array(auditBlockSchema).min(3).max(8),
    passCount: z.number().int().min(0).default(0),
    failCount: z.number().int().min(0).default(0),
    unknownCount: z.number().int().min(0).default(0),
    totalCount: z.number().int().min(1).default(1),
    topPriorities: z.array(z.string().min(3)).min(3).max(5),
  })
  .passthrough();
export type ResumeAudit = z.infer<typeof resumeAuditSchema>;

/**
 * Пересчитать pass/fail/unknown/total от статусов пунктов. Дублируем
 * (а не импортируем) функцию из linkedin-pack, чтобы тип возвращаемого
 * значения был ResumeAudit, а не LinkedinAudit (схемы структурно равны,
 * но в TS — номинально разные через `infer<typeof ...>`).
 */
export function recomputeResumeAuditTotals(audit: ResumeAudit): ResumeAudit {
  const items = audit.blocks.flatMap((b) => b.items);
  let pass = 0;
  let fail = 0;
  let unknown = 0;
  for (const it of items) {
    if (it.status === "pass") pass += 1;
    else if (it.status === "fail") fail += 1;
    else unknown += 1;
  }
  return {
    ...audit,
    passCount: pass,
    failCount: fail,
    unknownCount: unknown,
    totalCount: items.length,
  };
}

/**
 * Ожидаемая структура чек-листа — справка для разработчиков и probe'ов.
 * Реальные пункты читаются динамически из ответа модели.
 */
export const EXPECTED_RESUME_AUDIT_STRUCTURE = [
  { blockIdx: 0, blockName: "Формат и контакты", items: 5 },
  { blockIdx: 1, blockName: "Заголовок и Summary", items: 7 },
  { blockIdx: 2, blockName: "Skills", items: 2 },
  { blockIdx: 3, blockName: "Опыт работы", items: 12 },
  {
    blockIdx: 4,
    blockName: "Образование, языки, сертификации",
    items: 4,
  },
  { blockIdx: 5, blockName: "AI и HeadHunter", items: 2 },
] as const;

// ── Итоговый артефакт ───────────────────────────────────────────────────────

export const resumePackMetaSchema = z.object({
  participantId: z.string(),
  nick: z.string(),
  generatedAt: z.string(),
  model: z.string(),
  /** Версия резюме, по которой строился аудит. */
  resumeVersionId: z.string().nullable(),
  /** Использовался ли LinkedIn-профиль как дополнительный источник keyword'ов и опыта. */
  usedLinkedinProfile: z.boolean(),
  targetRoleSlug: z.string().nullable(),
  targetRoleTitle: z.string().nullable(),
  /**
   * Какой рынок предполагался при оценке (зарубежный / RU). Влияет на
   * пункты вокруг локации/телефона/санкционных компаний/HH-секции.
   * Модель проставляет это поле в Phase 1 (из clientSummary либо
   * выведенно из резюме). Если не удалось определить — null.
   */
  targetMarket: z.enum(["abroad", "ru", "mixed"]).nullable(),
});
export type ResumePackMeta = z.infer<typeof resumePackMetaSchema>;

export const resumePackSchema = z.object({
  meta: resumePackMetaSchema,
  audit: resumeAuditSchema,
  /**
   * Зарезервировано под Phase 2+ (переписанные Summary, Skills, Experience).
   * Сейчас всегда отсутствует — добавим, когда дойдём до этой фазы.
   */
  // rewrite: resumeRewriteSchema.optional(),
});
export type ResumePack = z.infer<typeof resumePackSchema>;

export const resumePackArtifactSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  generatedAt: z.string(),
  version: z.number().int().min(1),
  data: resumePackSchema,
});
export type ResumePackArtifact = z.infer<typeof resumePackArtifactSchema>;
