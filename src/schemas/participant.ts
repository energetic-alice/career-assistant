import { z } from "zod";

export const itStatusEnum = z.enum([
  "Еще не в IT, но хочу в IT",
  "Уже в IT, и хочу оставаться в IT",
  "Уже в IT, и хочу куда-то из IT",
  "Другое",
]);

export const workFormatEnum = z.enum([
  "Офис или гибрид",
  "Удаленно из РФ",
  "Удаленно из ЕС",
  "Удаленно из любой точки мира (кроме РФ)",
  "Хочу релокацию в страну мечты",
]);

export const englishLevelEnum = z.enum([
  "Никак, около нуля",
  "Могу читать/писать, иногда использую переводчик",
  "Говорю и понимаю не-IT темы",
  "Могу проходить собеседования на английском",
]);

export const educationEnum = z.enum([
  "Нет высшего",
  "Есть высшее техническое",
  "Есть высшее, но не техническое",
]);

export const currentOccupationEnum = z.enum([
  "Учеба",
  "Работаю в найме",
  "Фриланс/свой бизнес",
  "Сейчас без работы",
]);

export const experienceEnum = z.enum([
  "Нет опыта",
  "До 3 лет опыта",
  "3-5 лет опыта",
  "5+ лет опыта",
]);

export const retrainingReadinessEnum = z.enum([
  "Хочу расти в текущей профессии",
  "Готов(а) сменить специализацию внутри своей профессии",
  "Готов(а) полностью менять профессию",
]);

export const weeklyHoursEnum = z.enum([
  "До 3 часов в неделю",
  "3-5 часов в неделю",
  "5-10 часов в неделю",
  "10-20 часов в неделю",
  "20+ часов в неделю",
]);

export const communicationStyleEnum = z.enum([
  "Я интроверт, созвоны не люблю",
  "Мне нравится работать в команде, созвоны ок в меру",
  "Я обожаю руководить и/или общаться",
  "Я гибкий человек, могу итак-итак",
]);

export const workPreferenceEnum = z.enum([
  "Создавать новое",
  "Разбираться в сложных системах",
  "Улучшать и оптимизировать",
  "Помогать людям и обучать",
  "Исследовать и анализировать",
  "Ничего не люблю, просто дайте денег",
]);

/**
 * Full questionnaire as received from Google Forms webhook.
 * All 30 fields, including marketing-only ones.
 */
export const rawQuestionnaireSchema = z.object({
  timestamp: z.string(),
  telegramNick: z.string(),
  itStatus: z.string(),
  citizenship: z.string(),
  currentLocation: z.string(),
  targetCountries: z.string(),
  workFormat: z.string(),
  englishLevel: z.string().optional(),
  education: z.string().optional(),
  currentOccupation: z.string(),
  currentJobAndSalary: z.string(),
  yearsExperience: z.string(),
  desiredSalary: z.string(),
  desiredSalary3to5y: z.string(),
  whyAccelerator: z.string().optional(),
  desiredResult: z.string(),
  directionInterest: z.string(),
  whyThisDirection: z.string(),
  retrainingReadiness: z.string(),
  weeklyHours: z.string(),
  currentSituation: z.string(),
  careerGoals: z.string(),
  previousAttempts: z.string(),
  communicationStyle: z.string().optional(),
  aspirationLevel: z.string().optional(),
  routineAttitude: z.string(),
  workPreference: z.string(),
  hatedTasks: z.string(),
  additionalThoughts: z.string().optional(),
  resumeFileUrl: z.string().optional(),
  resumeTextDirect: z.string().optional(),
  linkedinUrl: z.string().optional(),
  linkedinSSI: z.string().optional(),
});

export type RawQuestionnaire = z.infer<typeof rawQuestionnaireSchema>;

/**
 * Subset of fields passed to AI analysis pipeline.
 * Excludes marketing-only field (whyAccelerator).
 */
export const analysisInputSchema = z.object({
  telegramNick: z.string(),
  itStatus: z.string(),
  citizenship: z.string(),
  currentLocation: z.string(),
  targetCountries: z.string(),
  workFormat: z.string(),
  englishLevel: z.string().optional(),
  education: z.string().optional(),
  currentOccupation: z.string(),
  currentJobAndSalary: z.string(),
  yearsExperience: z.string(),
  desiredSalary: z.string(),
  desiredSalary3to5y: z.string(),
  desiredResult: z.string(),
  directionInterest: z.string(),
  whyThisDirection: z.string(),
  retrainingReadiness: z.string(),
  weeklyHours: z.string(),
  currentSituation: z.string(),
  careerGoals: z.string(),
  previousAttempts: z.string(),
  communicationStyle: z.string().optional(),
  aspirationLevel: z.string().optional(),
  routineAttitude: z.string(),
  workPreference: z.string(),
  hatedTasks: z.string(),
  additionalThoughts: z.string().optional(),
  resumeText: z.string().optional(),
  linkedinUrl: z.string().optional(),
  linkedinSSI: z.string().optional(),
});

export type AnalysisInput = z.infer<typeof analysisInputSchema>;

/**
 * Extract analysis-relevant fields from raw questionnaire.
 * Drops marketing-only field (whyAccelerator) and replaces resumeFileUrl
 * with extracted resumeText (populated later).
 */
export function toAnalysisInput(raw: RawQuestionnaire): AnalysisInput {
  const { whyAccelerator, resumeFileUrl, resumeTextDirect, ...rest } = raw;
  return analysisInputSchema.parse({
    ...rest,
    resumeText: resumeTextDirect || undefined,
  });
}
