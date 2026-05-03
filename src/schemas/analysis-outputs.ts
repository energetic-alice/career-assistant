import { z } from "zod";
import { KNOWN_ROLES } from "../services/known-roles.js";

/**
 * Уровень конкуренции на рынке.
 * В enum включены и «размытые» формулировки — модель иногда возвращает «средняя-высокая» и т.п.
 */
/**
 * Уровень конкуренции на рынке.
 * Кладём и женский («низкая/средняя/высокая»), и мужской («низкий/средний/высокий») род —
 * Claude свободно перескакивает между ними в зависимости от того, согласует ли с
 * существительным «конкуренция» (ж.р.) или «уровень/AI-риск» (м.р.). Нормализация
 * на UI/post-validate этапе при необходимости.
 */
export const competitionDiscrete = z.enum([
  "очень низкая",
  "низкая",
  "средняя",
  "высокая",
  "очень высокая",
  "средняя-высокая",
  "средне-высокая",
  "высокая-средняя",
  "высоко-средняя",
  "низкая-средняя",
  "низко-средняя",
  "средняя-низкая",
  "средне-низкая",
  "высокая-очень высокая",
  "очень высокая-высокая",
  "очень низкая-низкая",
  "низкая-очень низкая",
  // мужской род (как в aiRisk.level) — Claude иногда копирует структуру
  "очень низкий",
  "низкий",
  "средний",
  "высокий",
  "очень высокий",
  "средний-высокий",
  "средне-высокий",
  "высокий-средний",
  "высоко-средний",
  "низкий-средний",
  "низко-средний",
  "средний-низкий",
  "средне-низкий",
  "высокий-очень высокий",
  "очень высокий-высокий",
  "очень низкий-низкий",
  "низкий-очень низкий",
]);

export type CompetitionLevel = z.infer<typeof competitionDiscrete>;

// ─── Shared enums ───

export const regionEnum = z.enum([
  "eu",
  "us",
  "uk",
  "ru",
  "cis",
  "latam",
  "asia-pacific",
  "middle-east",
  "global",
]);

export type Region = z.infer<typeof regionEnum>;

export const cefrEnum = z.enum(["0", "A1", "A2", "B1", "B2", "C1", "C2"]);

export type CEFRLevel = z.infer<typeof cefrEnum>;

// ─── Step 1: Profile Extraction Output ───

export const candidateProfileSchema = z.object({
  name: z.string().describe("Имя кандидата (из резюме или анкеты)"),
  telegramNick: z.string().optional().describe("Telegram-ник кандидата, если указан"),

  currentBase: z.object({
    currentRole: z.string().describe("Текущая должность"),
    yearsInCurrentRole: z.string().describe("Опыт в текущей профессии"),
    // previousExperience / hardSkills / domainExpertise намеренно убраны:
    // полный текст резюме и анкеты прокидываются в prompt-02 напрямую
    // ({{resumeText}}, {{questionnaireHuman}}), нормализованный список
    // реального опыта живёт в ClientSummary.currentSlugs. Эти три поля
    // были перефразированной копией одного и того же из резюме и только
    // раздували профиль Клоду.
    softSkills: z.array(z.string()).describe("Софт-скиллы из контекста"),
    managementExperience: z.string().optional().describe("Управленческий опыт"),
    education: z.string(),
    englishLevel: cefrEnum.describe(
      "Уровень английского нормализованный в CEFR. " +
      "'Никак, около нуля' = 0. 'Могу читать/писать, иногда переводчик' = A2. " +
      "'Говорю и понимаю не-IT темы' = B1. 'Могу проходить собеседования' = B2. " +
      "Если неясно — определи по резюме (рус = 0/A1, англ = B2+).",
    ),
    currentSalary: z.string(),
    currentOccupation: z.string(),
  }),

  careerGoals: z.object({
    desiredSalaryNow: z.string(),
    desiredSalary3to5y: z.string(),
    targetCountries: z.string(),
    workFormat: z.string(),
    targetMarketRegions: z
      .array(regionEnum)
      .describe(
        "Нормализованные целевые рынки из targetCountries + workFormat. " +
        "Remote EU/Europe/любая EU-страна = eu. UK всегда отдельно. " +
        "Сингапур/Малайзия/Австралия/Япония = asia-pacific. " +
        "Office в конкретной EU-стране = тоже eu. Россия = ru. " +
        "СНГ без РФ (Казахстан, Грузия, Армения, Узбекистан) = cis.",
      ),
    retrainingReadiness: z.string(),
    weeklyHours: z.string(),
    desiredResult: z.string(),
    careerGoalsYear: z.string().describe("Карьерные цели на ближайший год"),
    aspirationLevel: z.string().optional().describe("IC / менеджер / консультант / бизнес"),
  }),

  psychologicalProfile: z.object({
    communicationStyle: z.string(),
    routineAttitude: z.string(),
    workPreference: z.string().describe("Что любит делать"),
    hatedTasks: z.string().describe("Что не любит"),
    thinkingType: z.string().describe("Тип мышления: аналитик / креативщик / системщик"),
  }),

  barriers: z.object({
    // --- Claude заполняет из анкеты ---
    physicalCountry: z.string().describe(
      "Страна проживания, нормализованная на английском: Russia, Germany, Argentina, Kazakhstan...",
    ),
    citizenships: z.array(z.string()).describe(
      "Гражданства (нормализованные на англ): ['Belarus'], ['Kazakhstan','Russia']",
    ),
    isRemoteOnly: z.boolean().describe(
      "Ищет только удалённую работу, не готов к релокации",
    ),
    explicitlyExcludesRU: z.boolean().describe(
      "Кандидат ЯВНО указал что не хочет работать на РФ-рынок. По умолчанию false.",
    ),
    languageBarrier: z.string().describe("Достаточен ли английский для целевого рынка"),
    visaWorkPermit: z.string().describe("Право на работу / необходимость визы"),
    otherBarriers: z.array(z.string()).describe("Прочие ограничения"),

    // --- Вычисляется кодом после Step 1 (computeMarketAccess) ---
    accessibleMarkets: z.array(regionEnum).optional()
      .describe("Вычисляется кодом. Не заполнять."),
    isPhysicallyInRU: z.boolean().optional()
      .describe("Вычисляется кодом."),
    isPhysicallyInEU: z.boolean().optional()
      .describe("Вычисляется кодом."),
    hasRuWorkPermit: z.boolean().optional()
      .describe("Вычисляется кодом. РФ/BY/ЕАЭС паспорт или ВНЖ РФ."),
    hasEUWorkPermit: z.boolean().optional()
      .describe("Вычисляется кодом. EU/UK паспорт/ВНЖ или рабочая виза."),
  }),

  directionInterest: z.object({
    stated: z.string().describe("Что указал кандидат как интерес"),
    reasoning: z.string().describe("Почему именно это направление"),
  }),

  previousAttempts: z.string().describe("Были ли попытки что-то менять"),

  additionalContext: z.string().optional().describe("Дополнительные мысли кандидата"),

  resumeHighlights: z
    .array(z.string())
    .describe("Ключевые достижения/цифры из резюме для позиционирования"),

  linkedinSSI: z.string().optional().describe("SSI рейтинг LinkedIn"),
});

export type CandidateProfile = z.infer<typeof candidateProfileSchema>;

// ─── Step 2: Direction Generation Output ───

export const directionSchema = z.object({
  /**
   * Роль + стек. БЕЗ домена/ниши (fintech, SaaS, EdTech, biotech и т.п.) —
   * нишу определяем на следующем шаге глубокого анализа. Например:
   *   ✓ "Backend Developer, Go (middle+/senior)"
   *   ✗ "Backend Developer for fintech, Go" — fintech не нужен на 1A
   */
  title: z
    .string()
    .describe(
      "Роль + стек БЕЗ домена/ниши. Уровень обязательно middle+ или выше. Пример: 'Backend Developer, Go (senior)'",
    ),
  /**
   * Канонический slug роли. Должен быть из `KNOWN_ROLES` (40 snake_case
   * слагов), либо off-index slug если `offIndex=true` и есть `marketEvidence`.
   * Один и тот же slug в массиве directions встречается **ровно один раз**.
   */
  roleSlug: z
    .string()
    .describe(
      `snake_case из KNOWN_ROLES. Если роль не в списке — offIndex=true + marketEvidence. УНИКАЛЬНЫЙ в массиве. Список: ${KNOWN_ROLES.join(", ")}`,
    ),
  /** true — slug НЕ из KNOWN_ROLES. Требуется marketEvidence. */
  offIndex: z.boolean().optional(),
  /** 1-2 предложения: чем подтверждается существующий рынок для off-index роли. */
  marketEvidence: z.string().optional(),
  /**
   * Узкий рыночный словарь **Phase 1**, покрывающий реальные данные scorer'а:
   *   - "ru"     — РФ-рынок (RUB)
   *   - "abroad" — UK-данные как proxy для всей заграницы кроме USA (EUR)
   *   - "usa"    — UK-данные × 1.5 (EUR, для клиентов с US в target/физ.локации)
   *
   * Конкретные регионы (eu/latam/asia-pacific/…) хранятся отдельно в профиле
   * клиента (`careerGoals.targetMarketRegions`, `accessibleMarkets`) — они
   * нужны для Phase 2+ (Perplexity по Финляндии, Германии и т.п.) и UI
   * (флаги). На Phase 1 у нас нет таких данных, поэтому в bucket'е их нет.
   *
   * «Направление и в РФ, и за границей» = **два direction'а** с разными bucket
   * (это разрешено для widened-семейств в postValidate), а не один с "both".
   *
   * Preprocess нормализует типичные ошибки Claude:
   *   - все конкретные заграничные регионы (eu/uk/europe/latam/apac/me/global/
   *     international) и "abroad"/"both"  → "abroad"
   *   - us/usa/united states                                    → "usa"
   *   - ru/russia/cis                                           → "ru"
   */
  bucket: z
    .preprocess((v) => {
      if (typeof v !== "string") return v;
      const s = v.trim().toLowerCase();
      if (s === "ru" || s === "russia" || s === "cis") return "ru";
      if (s === "us" || s === "usa" || s === "united states") return "usa";
      return "abroad";
    }, z.enum(["ru", "abroad", "usa"]))
    .describe("Рынок Phase 1: ru | abroad | usa."),
  whyFits: z.string().describe("Почему подходит кандидату"),
  transferableSkills: z.array(z.string()).describe("Какие навыки переносятся напрямую"),
  skillsToLearn: z.array(z.string()).describe("Что нужно доучить"),
  adjacencyScorePercent: z
    .number()
    .min(0)
    .max(100)
    .describe("Близость перехода: 80-100% очень близкий, 60-79% умеренный, 40-59% сложный, <40% новая карьера"),
  /**
   * Интегральная оценка направления от Claude (0-100). Учитывает: переносимость
   * опыта, близость к desiredSalary (primary) / desiredSalary3to5y (secondary),
   * объём рынка, AI-риск, реалистичность пути для клиента. По ней сортируется
   * shortlist и красятся бейджи в UI Gate 1.
   *
   * Калибровка:
   *   - 80-100 — «отлично подходит» (🟢): meet expectations, норм переносимость,
   *     хороший рынок, низкий AI-риск.
   *   - 55-79  — «подходит, есть оговорки» (🟡): либо зп просаживается <15% на
   *     время, либо высокий AI-риск, либо перегретый рынок.
   *   - 0-54   — «слабо подходит» (🔴): просадка зп >15%, низкая переносимость,
   *     AI-риск extreme, или клиент сам просил, но не тянет (тогда + recommended=false).
   */
  score: z
    .number()
    .min(0)
    .max(100)
    .describe(
      "0-100, интегральная оценка «насколько это направление подходит клиенту». Учитывай: переносимость опыта, близость к desiredSalary (главное) и desiredSalary3to5y, объём рынка, AI-риск, реалистичность. 80+ = 🟢 отлично, 55-79 = 🟡 с оговорками, <55 = 🔴 слабо. Отсортируй directions по score DESC.",
    ),
  searchQueries: z
    .array(z.string())
    .default([])
    .describe(
      "Поисковые запросы для проверки рынка (вакансии, зарплаты, тренды). Optional — если Claude не вернул, падаем на []. Используется в Phase 2 (Perplexity).",
    ),
  /**
   * true (default) — рекомендуемое направление.
   * false — включено потому что клиент сам его просит (desiredDirectionSlugs /
   * directionInterest), но объективно не подходит (нет технического бэкграунда
   * для DevOps/ML/tech_lead; очень низкая близость перехода; и т.п.). В UI
   * shortlist'а такие пункты показываются как 🚫, в финальном документе попадут
   * в `rejectedDirections` с причиной.
   */
  recommended: z
    .boolean()
    .optional()
    .describe(
      "true/undefined по умолчанию = рекомендуем. Поставь false если клиент сам просит это направление, но оно ему объективно не подходит (non-technical → DevOps/ML/tech_lead, слишком низкая близость, мёртвая роль). В этом случае заполни rejectionReason.",
    ),
  rejectionReason: z
    .string()
    .optional()
    .describe(
      "Обязательно для recommended=false. 1-2 предложения почему направление не подходит (нет технического бэкграунда, слишком низкая adjacency, высокий AI-риск при lead-грейде и т.п.).",
    ),
});

export type Direction = z.infer<typeof directionSchema>;

export const directionsOutputSchema = z.object({
  directions: z.array(directionSchema).min(10).max(14)
    .describe(
      "10-14 направлений, отсортированы по `score` DESC. Первые ~10 покажем клиенту сразу, остаток " +
      "используем как запас для быстрой замены без нового вызова Claude. Обязательно включи " +
      "текущую роль кандидата (или её ближайший IT-аналог если клиент non-IT) и все явно " +
      "озвученные directionInterest/desiredDirectionSlugs (даже если ты считаешь их " +
      "неоптимальными — с recommended=false и rejectionReason)."
    ),
});

export type DirectionsOutput = z.infer<typeof directionsOutputSchema>;

// ─── Step 3: Market Data (from web search, not LLM) ───

export const marketDataSchema = z.object({
  directionTitle: z.string(),
  vacancyCount: z.string().describe("Примерное число вакансий в регионе"),
  specialistCount: z
    .string()
    .describe("Примерное число специалистов в регионе"),
  marketWidth: z.enum(["широкий", "средний", "нишевый"]),
  dynamics: z.enum(["растёт", "стабильно", "падает"]),
  dynamicsPercentChange: z
    .string()
    .describe("% изменения за 1-2 года с конкретной цифрой, например: -20% за год"),
  competition: competitionDiscrete,
  vacanciesPer100Specialists: z
    .number()
    .describe(
      "Вакансий на 100 специалистов: >=10 низкая (рынок кандидата), 3-9 средняя, <3 высокая (рынок работодателя)"
    ),
  salaryRange: z.string().describe("Зарплатная вилка в целевой локации"),
  aiRisk: z.enum(["низкий", "средний", "средний-высокий", "высокий"]),
  aiRiskExplanation: z.string(),
  forecast2026_2030: z.string(),
  employers: z.array(z.string()).describe("Типичные работодатели"),
  sources: z.array(z.string()).describe("Источники данных с URL"),
  rawSearchResults: z
    .string()
    .optional()
    .describe("Сырые результаты поиска для контекста"),
  dataSource: z
    .string()
    .optional()
    .describe("Основной источник данных: itjobswatch.co.uk, hh.ru, reed.co.uk и т.д."),
  titleVariations: z
    .array(
      z.object({
        title: z.string(),
        vacancies: z.string(),
        salary: z.string().optional(),
      }),
    )
    .optional()
    .describe("Вариации тайтлов с числом вакансий — из itjobswatch или hh.ru"),
  bestSearchTitle: z
    .string()
    .optional()
    .describe("Тайтл, дающий максимум релевантных вакансий"),
});

export type MarketData = z.infer<typeof marketDataSchema>;

// ─── Step 4: Direction Analysis Output ───

export const analyzedDirectionSchema = z.object({
  title: z.string(),
  /**
   * Канонический slug из исходного `directionSchema.roleSlug`. Нужен для
   * детерминированной стыковки analyzed↔enriched в Phase 4 (чтобы заполнять
   * таблицы 1/3 значениями из market-index по slug, а не по title —
   * модель часто переименовывает direction в "Role, Specialization (senior)"
   * и string-match по title ломается). Optional для обратной совместимости
   * со старыми state-ами на проде.
   */
  roleSlug: z.string().optional(),
  type: z.enum(["основной трек", "запасной вариант", "краткосрочный мост", "долгосрочная ставка"]),
  whyFits: z.string(),
  whatToHighlightToRecruiters: z.string(),

  market: z.object({
    demand: z.string(),
    width: z.enum(["широкий", "средний", "нишевый"]),
    dynamics: z.string().describe("Растет/стабильно/падает + % за 1-2 года"),
    competition: competitionDiscrete,
    vacanciesPer100Specialists: z
      .number()
      .nullable()
      .describe(
        "Вакансий на 100 специалистов — заполняй ТОЛЬКО если есть точные данные " +
        "(RU-рынок, расчёт hh.ru вакансий/резюме). Для UK/EU/US оставляй `null`: " +
        "оценочные ratio из competition-eu — синтетика, не выдавай их как факт.",
      ),
  }),

  salary: z.object({
    range: z.string(),
    isDesiredSalaryAchievable: z.string().describe("сейчас / через X мес / нереалистична"),
    trajectory: z.string(),
  }),

  aiRisk: z.object({
    level: z.enum(["низкий", "средний", "средний-высокий", "высокий"]),
    explanation: z.string(),
  }),

  transition: z.object({
    roiLevel: z.enum(["высокий", "средний", "низкий"]),
    roiExplanation: z.string(),
    adjacencyScorePercent: z.number(),
    transferableSkills: z.array(z.string()),
    skillsToLearn: z.array(z.string()),
    riskLevel: z.enum(["низкий", "средний", "высокий"]),
    retrainingVolume: z.enum(["минимальное", "умеренное", "существенное"]),
    timeToMarket: z.string(),
  }),

  candidateMatchScore: z.number().min(1).max(10),

  horizons: z.object({
    shortTerm: z.string().describe("3-9 мес"),
    mediumTerm: z.string().describe("2-3 года"),
    longTerm: z.string().describe("3-5 лет"),
  }),

  nextStep: z
    .string()
    .optional()
    .describe("Если не лучший долгосрочный трек: куда логично перейти дальше"),

  recommendedTitle: z
    .string()
    .optional()
    .describe(
      "Рекомендуемый тайтл для поиска вакансий на основе рыночных данных. " +
      "Например: 'DevOps' вместо 'DevOps Engineer' если первый даёт больше вакансий.",
    ),
});

export type AnalyzedDirection = z.infer<typeof analyzedDirectionSchema>;

export const analysisOutputSchema = z.object({
  directions: z.array(analyzedDirectionSchema).length(3),

  recommendation: z.object({
    primaryChoice: z.string().describe("Основной выбор сейчас (3-5 предложений почему)"),
    backup: z.string().describe("Запасной вариант"),
    longTermBet: z.string().describe("Долгосрочная ставка"),
  }),

  honestRisks: z.array(z.string()).describe("Узкие рынки, завышенные ожидания, барьеры, тупики"),

  rejectedDirections: z
    .array(
      z.object({
        originalTitle: z.string().describe("Тайтл направления из approved-списка, не вошедшего в топ-3"),
        reason: z.string().describe("Почему не прошло в топ-3: меньше вакансий, AI-риск выше, salary дальше от target и т.п."),
      }),
    )
    .optional()
    .describe(
      "Направления из approved-списка, которые НЕ вошли в топ-3, с объяснением. " +
      "НЕ предлагай новые направления — выбор всегда из переданного списка.",
    ),
});

export type AnalysisOutput = z.infer<typeof analysisOutputSchema>;

// ─── Review Summary (generated, not LLM) ───

export const reviewFlagSchema = z.object({
  type: z.enum(["red", "yellow", "info"]),
  message: z.string(),
});

export type ReviewFlag = z.infer<typeof reviewFlagSchema>;

export const reviewSummarySchema = z.object({
  candidateName: z.string(),
  currentRole: z.string(),
  targetMarket: z.string(),
  englishLevel: z.string(),
  linkedinSSI: z.string().optional(),
  superpower: z.string().optional(),
  directions: z.array(
    z.object({
      title: z.string(),
      type: z.string(),
      adjacency: z.number(),
      competition: z.string(),
      vacPer100: z.number().nullable(),
      salary: z.string(),
      aiRisk: z.string(),
    })
  ),
  flags: z.array(reviewFlagSchema),
});

export type ReviewSummary = z.infer<typeof reviewSummarySchema>;
