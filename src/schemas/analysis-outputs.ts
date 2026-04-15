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
    englishLevel: z.string(),
    currentSalary: z.string(),
    currentOccupation: z.string(),
  }),

  careerGoals: z.object({
    desiredSalaryNow: z.string(),
    desiredSalary3to5y: z.string(),
    targetCountries: z.string(),
    workFormat: z.string(),
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
    accessibleMarkets: z
      .array(z.string())
      .describe("Доступные рынки труда исходя из локации и гражданства"),
    languageBarrier: z.string().describe("Достаточен ли английский для целевого рынка"),
    visaWorkPermit: z.string().describe("Право на работу / необходимость визы"),
    otherBarriers: z.array(z.string()).describe("Прочие ограничения"),
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

  languageMode: z
    .enum(["ru-only", "ru-with-en-terms", "bilingual", "en-only"])
    .describe(
      "ru-only: англ на нуле, RU рынок; ru-with-en-terms: базовый English, RU/СНГ рынок; bilingual: хороший English, международный рынок; en-only: native English speaker"
    ),
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
  superpower: z.object({
    formulation: z
      .string()
      .describe(
        "Конкретная формулировка позиционирования. Язык зависит от languageMode: ru-only — на русском, остальные — на английском"
      ),
    explanation: z.string().describe("Почему именно этого кандидата выберут"),
    competitiveAdvantage: z.string().describe("В чём конкурентное преимущество"),
    marketAlignment: z
      .string()
      .describe("Совпадает ли суперсила с рынком, или нужно переформулировать"),
  }),

  strategicAlert: z.object({
    currentStackOutlook: z.enum([
      "хороший долгосрочный трек",
      "краткосрочный мост",
      "сужающийся рискованный стек",
    ]),
    needsTransition: z.boolean(),
    transitionDirection: z.string().optional(),
    reasoning: z.string(),
  }),

  directions: z.array(directionSchema).length(3),

  rejectedDirections: z
    .array(
      z.object({
        title: z.string().describe("Роль, которую НЕ включили в топ-3"),
        reason: z.string().describe("Честное объяснение на 1-2 предложения, почему не подходит"),
      })
    )
    .describe(
      "Роли, которые кандидат озвучил в анкете, но не вошли в топ-3; а также текущая роль, если она не среди предложенных"
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
  languageMode: z.string(),
  currentRole: z.string(),
  targetMarket: z.string(),
  englishLevel: z.string(),
  linkedinSSI: z.string().optional(),
  superpower: z.string(),
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
