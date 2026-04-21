import { z } from "zod";

/**
 * Compact one-shot summary built right after intake (Claude call).
 * Persisted in `state.stageOutputs.clientSummary` and reused for every
 * /client request and review-card render. Generated ONCE per participant.
 */
export const clientSummarySchema = z.object({
  /** Имя на кириллице как в анкете/резюме */
  firstName: z.string(),
  /** Фамилия на кириллице как в анкете/резюме */
  lastName: z.string(),
  /** Имя транслитом, для сортировки и заголовков */
  firstNameLatin: z.string(),
  /** Фамилия транслитом, для сортировки и заголовков */
  lastNameLatin: z.string(),
  /** Telegram-ник КАК В АНКЕТЕ (с @ или без — нормализуется на стороне UI) */
  telegramNick: z.string(),

  /** Гражданство одной фразой */
  citizenship: z.string(),
  /** Локация в формате "Город, Страна" */
  location: z.string(),
  /** Английский в шкале CEFR (0/A1/A2/B1/B2/C1/C2) или текстом из анкеты */
  englishLevel: z.string(),
  /** LinkedIn SSI как число-строка ("24") или "—" если нет */
  linkedinSSI: z.string(),
  /** Целевой рынок, например "EU remote" / "RU" / "Finland local + EU remote" */
  targetMarket: z.string(),

  /** Кто по профессии сейчас, например "Doctoral researcher in neuroscience" */
  currentProfession: z.string(),
  /** Лет опыта в текущей профессии, например "5+ лет" */
  yearsExperience: z.string(),
  /** Текущая зарплата, например "2000 EUR" */
  currentSalary: z.string(),

  /** Главная карьерная цель одной фразой */
  goal: z.string(),
  /** Желаемая зарплата сейчас */
  desiredSalary: z.string(),
  /** Желаемая зарплата через 3-5 лет */
  desiredSalary3to5y: z.string(),

  /** Желаемые направления одной строкой, например "Data analytics, Backend" */
  desiredDirections: z.string(),
  /**
   * Опыт в желаемом направлении одной короткой фразой.
   * Например: "0 лет опыта", "2 года опыта", "год пет-проектов".
   * Если человек переходит в новую область с нуля — "0 лет опыта".
   */
  targetFieldExperience: z.string(),
  /** Готовность к переобучению одной короткой фразой ("готова полностью менять") */
  retrainingReadiness: z.string(),
  /** Часов в неделю компактно: "20+", "10-15", "5" */
  weeklyHours: z.string(),

  /**
   * Хайлайты — массив из 3-5 коротких самостоятельных фраз про важные риски /
   * контекст, которые консультанту нужно увидеть сразу.
   * Каждая фраза — ОТДЕЛЬНЫЙ элемент (рендерится буллетом в Telegram).
   * НЕ ДУБЛИРОВАТЬ SSI (он уже отдельно).
   */
  highlights: z.array(z.string()),

  /**
   * Все ссылки на резюме из анкеты (Google Drive, чаще одна, иногда несколько).
   * Пустой массив если резюме не приложено.
   */
  resumeUrls: z.array(z.string()),
  /** Прямая ссылка на LinkedIn. null если нет. */
  linkedinUrl: z.string().nullable(),

  /** @deprecated legacy single-URL поле, оставлено для миграции старых стейтов */
  resumeUrl: z.string().nullable().optional(),
});

export type ClientSummary = z.infer<typeof clientSummarySchema>;
