import { z } from "zod";

/**
 * Zod-схемы для LinkedIn Pack MVP (см. app/docs/linkedin-mvp.md).
 *
 * MVP = аудит профиля по 18-пунктовому чек-листу Алисы + 5 вариантов headline.
 * Тексты секций (About/Experience/Skills), контент-план и посты — v2+.
 */

export const auditItemStatusEnum = z.enum(["pass", "fail", "unknown"]);
export type AuditItemStatus = z.infer<typeof auditItemStatusEnum>;

export const auditItemSchema = z.object({
  /** 1..18 — номер пункта чек-листа (см. 01-audit.md). */
  number: z.number().int().min(1).max(18),
  title: z.string().min(3),
  maxPoints: z.number().int().min(1).max(2),
  status: auditItemStatusEnum,
  pointsAwarded: z.number().int().min(0).max(2),
  /** 1-2 предложения. Пустая строка допустима, если status=pass. */
  recommendation: z.string().default(""),
});
export type AuditItem = z.infer<typeof auditItemSchema>;

export const auditBlockSchema = z.object({
  name: z.string(),
  maxScore: z.number().int().min(1),
  items: z.array(auditItemSchema).min(1),
});
export type AuditBlock = z.infer<typeof auditBlockSchema>;

/**
 * Модель может ошибиться в арифметике, поэтому `totalScore` / `maxTotalScore` /
 * `ssiEstimate` мы пересчитываем детерминированно в коде (см.
 * `recomputeAuditTotals`). Для входной валидации делаем их optional.
 */
export const linkedinAuditSchema = z.object({
  blocks: z.array(auditBlockSchema).length(4),
  totalScore: z.number().int().min(0).max(30).default(0),
  maxTotalScore: z.number().int().min(1).max(30).default(30),
  ssiEstimate: z.enum(["low", "medium", "high"]).default("medium"),
  topPriorities: z.array(z.string().min(3)).min(3).max(5),
});
export type LinkedinAudit = z.infer<typeof linkedinAuditSchema>;

/**
 * Пересчитать totalScore/maxTotalScore/ssiEstimate от pointsAwarded.
 * Вызывается ПОСЛЕ `linkedinAuditSchema.parse` внутри run-pack.ts.
 */
export function recomputeAuditTotals(audit: LinkedinAudit): LinkedinAudit {
  const items = audit.blocks.flatMap((b) => b.items);
  const total = items.reduce((acc, it) => acc + it.pointsAwarded, 0);
  const maxTotal = items.reduce((acc, it) => acc + it.maxPoints, 0);
  let ssi: "low" | "medium" | "high" = "medium";
  if (total <= 14) ssi = "low";
  else if (total >= 23) ssi = "high";
  return {
    ...audit,
    totalScore: total,
    maxTotalScore: maxTotal,
    ssiEstimate: ssi,
  };
}

/** Ровно 18 пунктов по блокам: 7 + 4 + 4 + 3. */
export const EXPECTED_AUDIT_STRUCTURE = [
  { blockIdx: 0, blockName: "Базовая информация", maxScore: 10, items: 7 },
  { blockIdx: 1, blockName: "Раздел «О себе»", maxScore: 8, items: 4 },
  { blockIdx: 2, blockName: "Опыт работы", maxScore: 7, items: 4 },
  { blockIdx: 3, blockName: "Навыки и рекомендации", maxScore: 5, items: 3 },
] as const;

// ── Headline ────────────────────────────────────────────────────────────────

export const headlineAngleEnum = z.enum([
  "classic",
  "achievement",
  "industry",
  "b2b_remote",
  "keyword_heavy",
]);
export type HeadlineAngle = z.infer<typeof headlineAngleEnum>;

export const HEADLINE_MAX_LENGTH = 120;

/**
 * `length` модель считает ненадёжно, поэтому делаем optional и пересчитываем
 * в коде (см. `recomputeHeadlineLengths`). Жёсткая проверка на
 * `text.length <= HEADLINE_MAX_LENGTH` остаётся — это то, из-за чего retry-им.
 */
export const headlineCandidateSchema = z
  .object({
    angle: headlineAngleEnum,
    text: z.string().min(10).max(HEADLINE_MAX_LENGTH),
    length: z.number().int().min(0).max(HEADLINE_MAX_LENGTH).default(0),
    keywords: z.array(z.string().min(1)).min(2).max(12),
    whyThis: z.string().min(5),
  })
  .refine((v) => v.text.length <= HEADLINE_MAX_LENGTH, {
    message: `headline превышает ${HEADLINE_MAX_LENGTH} символов`,
  });
export type HeadlineCandidate = z.infer<typeof headlineCandidateSchema>;

export const headlinePackSchema = z.object({
  currentHeadline: z.string().default(""),
  variants: z.array(headlineCandidateSchema).length(5),
});
export type HeadlinePack = z.infer<typeof headlinePackSchema>;

/** Пересчитываем `length` детерминированно. Вызываем после Zod-валидации. */
export function recomputeHeadlineLengths(pack: HeadlinePack): HeadlinePack {
  return {
    ...pack,
    variants: pack.variants.map((v) => ({ ...v, length: v.text.length })),
  };
}

// ── Итоговый артефакт ───────────────────────────────────────────────────────

export const linkedinPackMetaSchema = z.object({
  participantId: z.string(),
  nick: z.string(),
  generatedAt: z.string(),
  model: z.string(),
  usedLinkedinProfile: z.boolean(),
  usedResume: z.boolean(),
  linkedinUrl: z.string().nullable(),
  targetRoleSlug: z.string().nullable(),
  targetRoleTitle: z.string().nullable(),
});
export type LinkedinPackMeta = z.infer<typeof linkedinPackMetaSchema>;

export const linkedinPackSchema = z.object({
  meta: linkedinPackMetaSchema,
  audit: linkedinAuditSchema,
  headline: headlinePackSchema,
});
export type LinkedinPack = z.infer<typeof linkedinPackSchema>;

/**
 * Артефакт — то, что реально складывается в stageOutputs.linkedinPack и
 * передаётся в Telegram-UI/renderer (включая URL гугл-дока).
 */
export const linkedinPackArtifactSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  generatedAt: z.string(),
  version: z.number().int().min(1),
  data: linkedinPackSchema,
});
export type LinkedinPackArtifact = z.infer<typeof linkedinPackArtifactSchema>;
