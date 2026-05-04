import { z } from "zod";

/**
 * Zod-схемы для LinkedIn Pack MVP (см. app/docs/linkedin-mvp.md).
 *
 * MVP = аудит профиля по чек-листу Алисы (методология из
 * `kb/linkedin-methodology.md` + резюме-правила, применимые к LinkedIn) +
 * 5 вариантов headline + полный конструктор профиля.
 *
 * Жёстких лимитов на число пунктов/блоков не держим — структура задаётся
 * промптом `01-audit.md` и может эволюционировать. Баллы вообще не считаем:
 * только статусы pass/fail/unknown по каждому пункту и итоговые счётчики.
 */

export const auditItemStatusEnum = z.enum(["pass", "fail", "unknown"]);
export type AuditItemStatus = z.infer<typeof auditItemStatusEnum>;

export const auditItemSchema = z
  .object({
    /** Сквозной номер пункта чек-листа (см. 01-audit.md). */
    number: z.number().int().min(1).max(99),
    title: z.string().min(3),
    status: auditItemStatusEnum,
    /** 1-2 предложения. Пустая строка допустима, если status=pass. */
    recommendation: z.string().default(""),
  })
  .passthrough(); // игнорируем легаси-поля вроде maxPoints/pointsAwarded, если придут
export type AuditItem = z.infer<typeof auditItemSchema>;

export const auditBlockSchema = z
  .object({
    name: z.string(),
    items: z.array(auditItemSchema).min(1),
  })
  .passthrough(); // игнорируем maxScore, если модель вернёт
export type AuditBlock = z.infer<typeof auditBlockSchema>;

/**
 * Итоговые счётчики pass/fail/unknown считаются детерминированно в коде
 * (см. `recomputeAuditTotals`). Баллы в документе не показываем — только
 * количество пунктов по статусам.
 */
export const linkedinAuditSchema = z
  .object({
    blocks: z.array(auditBlockSchema).min(3).max(8),
    passCount: z.number().int().min(0).default(0),
    failCount: z.number().int().min(0).default(0),
    unknownCount: z.number().int().min(0).default(0),
    totalCount: z.number().int().min(1).default(1),
    topPriorities: z.array(z.string().min(3)).min(3).max(5),
  })
  .passthrough();
export type LinkedinAudit = z.infer<typeof linkedinAuditSchema>;

/**
 * Пересчитать pass/fail/unknown/total от статусов пунктов.
 * Вызывается ПОСЛЕ `linkedinAuditSchema.parse` внутри run-pack.ts.
 */
export function recomputeAuditTotals(audit: LinkedinAudit): LinkedinAudit {
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
 * Ожидаемая структура промпта (справка для разработчиков/probes).
 * Реальные пункты читаются динамически из ответа модели.
 */
export const EXPECTED_AUDIT_STRUCTURE = [
  { blockIdx: 0, blockName: "Профиль и контакты", items: 7 },
  { blockIdx: 1, blockName: "Headline", items: 2 },
  { blockIdx: 2, blockName: "Раздел «О себе»", items: 5 },
  { blockIdx: 3, blockName: "Опыт работы", items: 7 },
  {
    blockIdx: 4,
    blockName: "Навыки, рекомендации, образование, активность",
    items: 6,
  },
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

// ── Profile content (Phase 3) ───────────────────────────────────────────────
//
// Готовые тексты для copy-paste в профиль + инструкции по настройкам +
// план действий, по всем пунктам чеклиста (02-audit).

export const aboutBlockSchema = z.object({
  /** Первый абзац — summary как в резюме (target title + grade + years + индустрии + достижение). */
  firstParagraph: z.string().min(40),
  /**
   * Professional highlights — 3-8 строк, каждая одно достижение / факт /
   * контекст. Может включать: количественные достижения, образование,
   * опыт на конференциях, open source, менторство, награды, ключевые
   * проекты. По строке, без префиксов — буллеты добавит renderer.
   */
  highlights: z.array(z.string().min(8)).min(3).max(8),
  /** Строка вроде "Tech stack: Kubernetes, AWS, Terraform, Python…". */
  technicalSkills: z.string().min(10),
  /** CTA + прямой контакт (email или Telegram). */
  cta: z.string().min(10),
  /** Готовый текст для copy-paste в About. Без эмодзи. Склеен из блоков выше. */
  fullText: z.string().min(80),
});
export type AboutBlock = z.infer<typeof aboutBlockSchema>;

export const experienceRewriteSchema = z.object({
  /** Как сейчас в LinkedIn/резюме — для понятного сопоставления. */
  original: z.object({
    company: z.string(),
    title: z.string(),
    dates: z.string(),
  }),
  /** Что клиент должен выставить. */
  suggested: z.object({
    /** Компания — чаще = original, но для санкционных/госа = нейтральная формулировка. */
    company: z.string().min(2),
    /** Job title — = target или близко к нему. */
    title: z.string().min(2),
    /** Пара слов про компанию (users/top-N/тип). */
    companyContext: z.string().min(5),
    /** Формат/локация — обычно `Remote`. */
    location: z.string().min(2),
    /** Достижения с цифрами (bullets). */
    bullets: z.array(z.string().min(10)).min(2).max(8),
    /** Skills внутри этого Experience (target-ключевики). */
    skills: z.array(z.string().min(1)).min(3).max(25),
  }),
  /** Комментарий клиенту (почему переименовали / что подшлифовать). */
  notes: z.string().default(""),
});
export type ExperienceRewrite = z.infer<typeof experienceRewriteSchema>;

export const profileSettingSchema = z.object({
  /** Например: "Locations", "Cover Banner", "Contact info", "Custom URL", "Open to Work". */
  section: z.string().min(2),
  /** Инструкция как найти/кликнуть в UI. */
  how: z.string().min(5),
  /** Готовое значение для copy-paste (если применимо). */
  valueToUse: z.string().default(""),
});
export type ProfileSetting = z.infer<typeof profileSettingSchema>;

export const actionItemSchema = z.object({
  title: z.string().min(3),
  details: z.string().min(10),
  /** Шаблон сообщения/поста/запроса (если применимо). */
  template: z.string().default(""),
});
export type ActionItem = z.infer<typeof actionItemSchema>;

export const contentIdeaSchema = z.object({
  topic: z.string().min(3),
  /** Цепляющее первое предложение поста. */
  hook: z.string().min(10),
  /** Ключевые тезисы (3-5 буллетов). */
  keyPoints: z.array(z.string().min(5)).min(2).max(6),
});
export type ContentIdea = z.infer<typeof contentIdeaSchema>;

export const supportingSectionsSchema = z.object({
  /** Как заполнить Education (степень + вуз, без года или с омоложенным). */
  education: z.string().min(5),
  /** Languages в правильном порядке (English первым, ≥ B2). */
  languages: z.array(z.string().min(2)).min(1).max(8),
  /** Релевантные сертификаты к получению (минимум 1). */
  certificationsToEarn: z.array(z.string().min(3)).min(1).max(5),
  /** Волонтёрство (если релевантно target-роли). */
  volunteering: z.string().default(""),
});
export type SupportingSections = z.infer<typeof supportingSectionsSchema>;

export const profileContentSchema = z.object({
  about: aboutBlockSchema,
  topSkills: z.array(z.string().min(2)).length(5),
  experience: z.array(experienceRewriteSchema).min(1).max(12),
  profileSettings: z.array(profileSettingSchema).min(3),
  supportingSections: supportingSectionsSchema,
  actionPlan: z.array(actionItemSchema).min(3),
  contentIdeas: z.array(contentIdeaSchema).length(4),
});
export type ProfileContent = z.infer<typeof profileContentSchema>;

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
  /** Может отсутствовать — для пакетов, сгенерированных до Phase 3 MVP. */
  profileContent: profileContentSchema.optional(),
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
