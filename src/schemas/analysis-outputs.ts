import { z } from "zod";

/**
 * Уровень конкуренции на рынке.
 * В enum включены и «размытые» формулировки — модель иногда возвращает «средняя-высокая» и т.п.
 */
export const competitionDiscrete = z.enum([
  "очень низкая",
  "низкая",
  "средняя",
  "высокая",
  "очень высокая",
  "средняя-высокая",
  "средне-высокая",
  "низкая-средняя",
  "низко-средняя",
  "высокая-очень высокая",
  "очень низкая-низкая",
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
    previousExperience: z
      .array(z.string())
      .describe("Ключевой прошлый и смежный опыт"),
    hardSkills: z.array(z.string()).describe("Технические навыки"),
    softSkills: z.array(z.string()).describe("Софт-скиллы из контекста"),
    domainExpertise: z.array(z.string()).describe("Доменная экспертиза"),
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
  title: z
    .string()
    .describe("Роль + задачи + домен + стек, например: 'Backend engineer for distributed systems in fintech, Ruby → Go'"),
  type: z.enum(["основной трек", "запасной вариант", "краткосрочный мост", "долгосрочная ставка"]),
  whyFits: z.string().describe("Почему подходит кандидату"),
  transferableSkills: z.array(z.string()).describe("Какие навыки переносятся напрямую"),
  skillsToLearn: z.array(z.string()).describe("Что нужно доучить"),
  adjacencyScorePercent: z
    .number()
    .min(0)
    .max(100)
    .describe("Близость перехода: 80-100% очень близкий, 60-79% умеренный, 40-59% сложный, <40% новая карьера"),
  searchQueries: z
    .array(z.string())
    .describe("Поисковые запросы для проверки рынка (вакансии, зарплаты, тренды)"),
});

export type Direction = z.infer<typeof directionSchema>;

export const directionsOutputSchema = z.object({
  directions: z.array(directionSchema).min(5).max(9)
    .describe(
      "5-9 направлений. Обязательно включают текущую роль кандидата и все явно озвученные " +
      "directionInterest (даже если ты считаешь их неоптимальными — отсев будет на следующем шаге)."
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
      .describe("Из справочника конкуренции: вакансий на 100 специалистов"),
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

  offerProbability3to9months: z.enum(["высокая", "средняя", "низкая"]),
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

  replacedDirections: z
    .array(
      z.object({
        originalTitle: z.string().describe("Тайтл направления, которое заменяется"),
        newTitle: z.string().describe("Новое предлагаемое направление (роль + стек + домен)"),
        reason: z.string().describe("Почему заменяем: слишком узкий рынок, нет данных, не подходит кандидату"),
      }),
    )
    .optional()
    .describe(
      "Если на основе рыночных данных одно или несколько направлений явно плохие — предложи замену. " +
      "Pipeline перезапустит анализ для новых направлений.",
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
      vacPer100: z.number(),
      salary: z.string(),
      aiRisk: z.string(),
    })
  ),
  flags: z.array(reviewFlagSchema),
});

export type ReviewSummary = z.infer<typeof reviewSummarySchema>;
