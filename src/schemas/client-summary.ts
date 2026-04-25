import { z } from "zod";
import { regionEnum } from "./analysis-outputs.js";
import { KNOWN_ROLES } from "../services/known-roles.js";

/**
 * Claude периодически возвращает number как строку ("0.9", "100000") и boolean
 * как строку ("true"/"false"). Чтобы не падать zod-валидацией на каждом 15-м
 * клиенте, оборачиваем числовые/булевы поля в preprocess: пытаемся аккуратно
 * скоэрсить, при провале оставляем исходное значение (пусть zod покажет
 * нормальную ошибку).
 */
/**
 * Union+transform вместо `z.preprocess` — сохраняет правильный output type
 * для TypeScript (`z.preprocess((v: unknown) => unknown, ...)` выводит
 * output как unknown, ломая типизацию потребителей).
 */
const tolerantNumber = () =>
  z
    .union([
      z.number(),
      z.string().transform((s, ctx) => {
        const n = Number(s.trim());
        if (!Number.isFinite(n)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a number: ${s}` });
          return z.NEVER;
        }
        return n;
      }),
    ])
    .pipe(z.number());

const tolerantNullableNumber = () =>
  z
    .union([
      z.number(),
      z.null(),
      z.literal("").transform(() => null),
      z.string().transform((s, ctx) => {
        const n = Number(s.trim());
        if (!Number.isFinite(n)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a number: ${s}` });
          return z.NEVER;
        }
        return n;
      }),
    ])
    .pipe(z.number().nullable());

const tolerantBool = () =>
  z
    .union([
      z.boolean(),
      z.string().transform((s, ctx) => {
        const lower = s.trim().toLowerCase();
        if (lower === "true") return true;
        if (lower === "false") return false;
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a boolean: ${s}` });
        return z.NEVER;
      }),
    ])
    .pipe(z.boolean());

const knownRolesSet = new Set<string>(KNOWN_ROLES);

const selectedTargetRoleSchema = z.object({
  id: z.string(),
  selectedAt: z.string(),
  source: z.enum(["shortlist", "deep", "resume"]),
  roleSlug: z.string(),
  title: z.string(),
  bucket: z.enum(["ru", "abroad", "usa"]),
  offIndex: z.boolean().optional(),
  marketEvidence: z.string().optional(),
  direction: z.unknown().optional(),
}).superRefine((role, ctx) => {
  const known = knownRolesSet.has(role.roleSlug);
  if (known && role.offIndex) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["offIndex"],
      message: "known role slug must not be offIndex",
    });
  }
  if (!known && !role.offIndex) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["offIndex"],
      message: "unknown role slug requires offIndex=true",
    });
  }
  if (!known && !role.marketEvidence?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["marketEvidence"],
      message: "off-index selected target requires marketEvidence",
    });
  }
});

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

  /**
   * Страны, где у клиента есть легальное право на работу: паспорт,
   * постоянный ВНЖ / permanent residence, либо долгосрочная рабочая
   * виза (national visa D, skilled worker visa и т.п.). Туристические
   * шенгенские / B1-B2 визы сюда НЕ включаются.
   *
   * Названия на английском в нормализованных формах (как в таблицах
   * `EU_COUNTRIES`/`CIS_COUNTRIES`/... в market-access.ts).
   * Пример: ["Belarus", "Poland"] — BY паспорт + PL ВНЖ.
   *
   * Используется `computeAccessibleMarkets` для вычисления bucket'ов
   * и UI для рендера флагов.
   */
  citizenships: z.array(z.string()).default([]),
  /** Локация в формате "Город, Страна" (для UI). */
  location: z.string(),
  /**
   * Страна физического нахождения на английском (как в `EU_COUNTRIES`
   * и т.п.). Например "Georgia", "Russia", "United States".
   * Используется кодом для вычисления `accessibleMarkets`.
   */
  physicalCountry: z.string().default(""),
  /** Английский в шкале CEFR (0/A1/A2/B1/B2/C1/C2) или текстом из анкеты */
  englishLevel: z.string(),
  /** LinkedIn SSI как число-строка ("24") или "—" если нет */
  linkedinSSI: z.string(),
  /**
   * Целевые рынки как нормализованный массив кодов регионов.
   * Заменяет прежнее свободно-текстовое поле `targetMarket`.
   * Значения из `regionEnum`: "ru" | "eu" | "uk" | "us" | "cis" | "latam" |
   * "asia-pacific" | "middle-east" | "global". Клод заполняет по анкете.
   * Пустой массив = клиент не указал таргет (обычно в паре с location-fallback).
   */
  targetMarketRegions: z.array(regionEnum).default([]),

  /**
   * Доступные клиенту рынки — вычисляется КОДОМ после Phase 0 (не заполнять Клодом).
   * Учитывает `citizenships` (EU/RU/CIS work permit), `physicalCountry` и
   * `targetMarketRegions` (remote B2B доступен куда клиент сам нацелен).
   * Может отличаться от `targetMarketRegions`: например KZ-клиент ищет EU,
   * но RU-рынок ему тоже accessible по паспорту — показываем оба bucket'а.
   */
  accessibleMarkets: z.array(regionEnum).default([]),

  /** Кто по профессии сейчас, например "Doctoral researcher in neuroscience" */
  currentProfession: z.string(),
  /** Лет опыта в текущей профессии, например "5+ лет" */
  yearsExperience: z.string(),
  /**
   * Текущий грейд клиента в его профессии.
   *   - "junior" — явно junior/стажёр/после курсов, < 2 лет коммерческого опыта
   *   - "middle" — fallback для ≤3 лет опыта или non-IT (заходит в IT с middle)
   *   - "senior" — fallback для >3 лет, а также явно Senior/Ведущий в резюме
   *   - "lead"   — явно Tech Lead / Engineering Manager / Head of
   *   - null     — клиент без релевантного опыта/совсем не в IT без IT-карьеры в прошлом
   * Используется role-scorer'ом для сравнения зп на правильной точке seniorityCurve
   * (чтобы senior-клиента не фильтровать по middle-медиане).
   */
  currentGrade: z
    .enum(["junior", "middle", "senior", "lead"])
    .nullable()
    .optional(),
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
  /**
   * confidence Клода 0..1, round(x, 2). Toleratum к строкам: "0.9" → 0.9.
   * Nullable — Клод для non-IT иногда присылает `null` вместо пропуска поля.
   */
  currentProfessionSlugConfidence: tolerantNullableNumber().optional(),
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

  /**
   * Направления, которые клиент в итоге выбрал для упаковки и поиска работы
   * после карьерного анализа. Это ручной/операционный выбор консультанта,
   * не генерируется Клодом в Phase 0. Хранится в clientSummary, чтобы карточка
   * клиента и дальнейшие шаги (идеальное резюме) имели один бизнес-источник.
   */
  selectedTargetRoles: z
    .array(selectedTargetRoleSchema)
    .default([]),

  /**
   * Список slug-ов из каталога `market-index.json`, на которые клиент может
   * **прямо сейчас** выйти на работу без переобучения — по опыту из резюме и
   * анкеты. Включает `currentProfessionSlug` и все близкие роли по стеку.
   *
   * Используется role-scorer.adjacencyComponent: если `role.slug ∈ currentSlugs`,
   * adjacency = 100 (вместо bridge / family-based). Это даёт корректный буст
   * всем ролям, где у клиента есть реальный коммерческий опыт, даже если
   * `currentProfessionSlug` их не покрывает (например fullstack-JS клиент
   * с коммерческим C#/.NET в резюме — сюда попадут и `backend_nodejs`,
   * и `backend_csharp`).
   *
   * Правила заполнения (см. промпт 00-client-summary.md):
   *   - только slug-и из каталога (not off-index);
   *   - только с коммерческим опытом (не «видел на курсах»);
   *   - включать `currentProfessionSlug` если он не null;
   *   - обычно 2-6 элементов, максимум 8.
   *
   * Optional ради совместимости со старыми `clientSummary`, созданными до
   * добавления поля — чтобы их парсинг не падал. Потребители должны
   * читать как `summary.currentSlugs ?? []`.
   */
  currentSlugs: z.array(z.string()).optional(),

  /**
   * Ближайшие IT-эквиваленты к текущей профессии клиента — заполняется,
   * когда `currentProfessionSlug = null` (non-IT, например HR Administrative,
   * менеджер ресторанов, юрист, врач) ИЛИ когда формальный slug сильно
   * сужает картину (рекрутер не-IT → recruiter, проджект не-IT → project_manager).
   *
   * Цель: гарантировать, что в Phase 1 шортлисте всегда будет «самый
   * близкий IT-вход» к текущей профессии клиента, даже если он не входит
   * в `currentSlugs` (нет коммерческого IT-опыта) и не в `desiredDirectionSlugs`
   * (клиент не указал явно).
   *
   * Примеры:
   *   - HR Administrative / любой HR не-IT → ["recruiter"]
   *   - Менеджер ресторанов, retail-management → ["project_manager", "product_manager"]
   *   - Юрист, бухгалтер, консультант — без IT опыта → [] (ничего близкого нет)
   *   - Маркетолог не-IT → ["marketing_manager"]
   *   - Графический дизайнер из рекламы → ["ui_ux_designer"]
   *
   * Правила:
   *   - 0..2 элемента;
   *   - только slug-и из каталога market-index;
   *   - НЕ дублирует `currentSlugs` и `desiredDirectionSlugs`;
   *   - заполняется когда currentProfessionSlug=null или когда есть очевидный
   *     IT-аналог за пределами текущего slug.
   *
   * Используется в run-analysis: эти slug-и идут в guaranteed для Claude
   * («обязательно покажи в шортлисте даже если score низкий»).
   *
   * Optional ради совместимости с старыми `clientSummary`.
   */
  closestItSlugs: z.array(z.string()).max(2).optional(),
});

export type ClientSummary = z.infer<typeof clientSummarySchema>;
