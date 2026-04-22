import { z } from "zod";

/**
 * Claude периодически возвращает number как строку ("0.9", "100000") и boolean
 * как строку ("true"/"false"). Чтобы не падать zod-валидацией на каждом 15-м
 * клиенте, оборачиваем числовые/булевы поля в preprocess: пытаемся аккуратно
 * скоэрсить, при провале оставляем исходное значение (пусть zod покажет
 * нормальную ошибку).
 */
const coerceNumber = (v: unknown): unknown => {
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return v;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : v;
  }
  return v;
};
const coerceBool = (v: unknown): unknown => {
  if (typeof v === "string") {
    const lower = v.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return v;
};
const tolerantNumber = () => z.preprocess(coerceNumber, z.number());
const tolerantNullableNumber = () =>
  z.preprocess(coerceNumber, z.number().nullable());
const tolerantBool = () => z.preprocess(coerceBool, z.boolean());

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
  /** Текущая зарплата "как в анкете" (для UI), например "2000 EUR" */
  currentSalary: z.string(),
  /**
   * Текущая зарплата в рублях — только если в анкете явно в RUB.
   * Иначе null (конверсия из EUR/USD не выполняется). Используется salary-фильтром RU-рынка.
   */
  currentSalaryRub: tolerantNullableNumber().optional(),
  /**
   * Текущая зарплата в EUR — только если в анкете в EUR/USD/GBP.
   * USD × 0.92, GBP × 1.17 → EUR. Иначе null. Используется salary-фильтром abroad-рынка.
   */
  currentSalaryEur: tolerantNullableNumber().optional(),

  /** Главная карьерная цель одной фразой */
  goal: z.string(),
  /** Желаемая зарплата сейчас "как в анкете" */
  desiredSalary: z.string(),
  /** Желаемая зарплата сейчас в рублях (только если в анкете RUB, иначе null). */
  desiredSalaryRub: tolerantNullableNumber().optional(),
  /** Желаемая зарплата сейчас в EUR (EUR/USD×0.92/GBP×1.17, иначе null). */
  desiredSalaryEur: tolerantNullableNumber().optional(),
  /** Желаемая зарплата через 3-5 лет "как в анкете" */
  desiredSalary3to5y: z.string(),
  /** Желаемая 3-5y зп в рублях (только если RUB, иначе null). */
  desiredSalary3to5yRub: tolerantNullableNumber().optional(),
  /** Желаемая 3-5y зп в EUR (иначе null). */
  desiredSalary3to5yEur: tolerantNullableNumber().optional(),

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

  // ─── Canonical role slugs (Phase 1A) ────────────────────────────────────
  // Заполняются Клодом в Phase 0 на основе каталога market-index.json.
  // currentProfessionSlug — СТРОГО из каталога или null (non-IT).
  // desiredDirectionSlugs — преимущественно из каталога, но off-index
  // разрешён, если клиент явно хочет эту роль и рынок существует.

  /**
   * Канонический slug текущей профессии. Три варианта:
   *   1) snake_case ключ из `app/data/market-index.json` (обычный путь, есть рынок)
   *   2) off-index slug (IT-роль без данных в нашем индексе, e.g. `cloud_engineer`,
   *      `ai_automation_engineer`) — тогда currentProfessionOffIndex=true и
   *      currentProfessionMarketEvidence заполнен.
   *   3) null — только для non-IT (врач, маникюрша, PLC Engineer).
   * Галлюцинированные IT-slug'и без marketEvidence пост-процессом заменяются на null.
   */
  currentProfessionSlug: z.string().nullable().optional(),
  /** confidence Клода 0..1, round(x, 2). Toleratum к строкам: "0.9" → 0.9. */
  currentProfessionSlugConfidence: tolerantNumber().optional(),
  /** true — slug НЕ из каталога market-index, обязателен marketEvidence. */
  currentProfessionOffIndex: tolerantBool().optional(),
  /** 1-2 предложения: чем рынок подтверждается (для currentProfessionOffIndex=true). */
  currentProfessionMarketEvidence: z.string().optional(),

  /**
   * Канонические slug'и желаемых направлений, по одному на смысловую позицию
   * (дубликаты сливаются). Клод может добавлять:
   *  — slug из каталога market-index.json (offIndex=false), или
   *  — свой slug не из каталога (offIndex=true), но только если клиент явно
   *    хочет эту роль и она имеет рынок (marketEvidence обязателен).
   */
  desiredDirectionSlugs: z
    .array(
      z.object({
        /** snake_case slug (из каталога либо off-index). */
        slug: z.string(),
        /** Уверенность Клода, 0..1. */
        confidence: tolerantNumber(),
        /** Фрагмент анкеты/резюме клиента, породивший этот slug (≤ 60 симв). */
        raw: z.string(),
        /** true — slug НЕ из каталога market-index, обязателен marketEvidence. */
        offIndex: tolerantBool().optional(),
        /** 1-2 предложения: чем этот рынок подтверждается (для offIndex=true). */
        marketEvidence: z.string().optional(),
      }),
    )
    .optional(),
});

export type ClientSummary = z.infer<typeof clientSummarySchema>;
