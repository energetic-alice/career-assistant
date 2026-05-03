import { z } from "zod";

/**
 * Compact market-index — single source of truth for all known roles.
 * Generated once by `scripts/build-market-index.ts` from `hh-*.md` / `itjw-*.md`
 * in `app/src/prompts/market-data/`.
 *
 * Consumed by:
 *  - `role-matcher.ts`  — canonical list for free-text → slug matching
 *  - `role-scorer.ts`   — market signals for ranker
 *  - Claude judge       — cached compact representation (~8 KB)
 */

export const aiRiskEnum = z.enum(["low", "medium", "high", "extreme"]);
export type AiRisk = z.infer<typeof aiRiskEnum>;

export const competitionLabelEnum = z.enum(["низкая", "средняя", "высокая"]);
export type CompetitionLabel = z.infer<typeof competitionLabelEnum>;

/**
 * Детерминированное преобразование числа "вакансий на 100 специалистов"
 * в качественную метку. Используется везде, где текст идёт в промпт или
 * в UI - чтобы модель не путала шкалу.
 *
 * Шкала (согласована с `kb/competition-eu.md`):
 *   >= 8   → низкая (рынок кандидата, много вакансий)
 *   3-7.9  → средняя
 *   < 3    → высокая (рынок работодателя, много соискателей)
 */
export function competitionLabel(per100: number | null | undefined): CompetitionLabel | null {
  if (per100 === null || per100 === undefined) return null;
  if (per100 >= 8) return "низкая";
  if (per100 >= 3) return "средняя";
  return "высокая";
}

/**
 * Конвертирует ratio = now/twoYearsAgo в короткий текстовый лейбл для таблицы.
 * Примеры:
 *   1.50 → "+50% за 2 года"
 *   0.75 → "-25% за 2 года"
 *   0.97..1.03 → "стабильно"
 *   null → null
 */
export function trendLabelPct(ratio: number | null | undefined): string | null {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio) || ratio <= 0) {
    return null;
  }
  const pct = Math.round((ratio - 1) * 100);
  if (Math.abs(pct) < 5) return "стабильно";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct}% за 2 года`;
}

export const regionStatsSchema = z.object({
  /** Number of live vacancies (hh.ru total / itjw "Live Now" for top title). */
  vacancies: z.number().nullable(),
  /** Median monthly salary for middle+ in local currency (RUB / GBP / EUR / USD). */
  medianSalaryMid: z.number().nullable(),
  /**
   * Vacancies per 100 active specialist CVs — market pressure.
   *   >= 10 → candidate's market; 3..10 → balanced; < 3 → employer's market.
   * Source: `app/src/prompts/kb/competition-ru.md` (RU) and `competition-eu.md`
   * (UK/EU/US use same value — no per-country split in the KB yet).
   * `null` if the slug is missing from the KB.
   */
  competitionPer100Specialists: z.number().nullable().optional(),
  /** Optional seniority curve for potolok estimates. */
  seniorityCurve: z
    .object({
      junior: z.number().nullable().optional(),
      middle: z.number().nullable().optional(),
      senior: z.number().nullable().optional(),
      lead: z.number().nullable().optional(),
    })
    .optional(),
  /**
   * Динамика спроса по perm-vacancies (UK: 6m now/yearAgo/twoYearsAgo из
   * itjobswatch; RU: агрегат из JSON-снапшотов по датам, см.
   * `market-data/snapshots/`). `ratio = now / twoYearsAgo` (fallback на
   * yearAgo). Используется в role-scorer как отдельный компонент.
   * `null` — истории нет (частый кейс для RU до накопления snapshot-ов).
   */
  trend: z
    .object({
      now: z.number(),
      yearAgo: z.number(),
      twoYearsAgo: z.number(),
      ratio: z.number(),
    })
    .nullable()
    .optional(),
  /** Source tag for downstream debugging. */
  source: z.string(),
});
export type RegionStats = z.infer<typeof regionStatsSchema>;

export const marketIndexEntrySchema = z.object({
  /** Canonical slug (kebab-case) — also the lookup key in the index. */
  slug: z.string(),
  /** Human-readable title shown in UI (e.g. "Backend Python Developer"). */
  displayTitle: z.string(),
  /** Broad bucket used in UI grouping (backend / frontend / mobile / data / devops / management / design / analytics / qa / marketing / other). */
  category: z.string(),
  /**
   * Основной технологический стек/язык роли. Используется в adjacency:
   * fullstack-JS → backend_nodejs считается «той же ролью» (adj=100),
   * а fullstack-JS → backend_go — сменой стека (adj ниже).
   * Задан только для ролей, где язык/стек критичен для перехода
   * (backend_*, frontend_*, fullstack, mobile_*, web3_developer,
   * gamedev_unity, 1c_developer). Для infra/data/ML/management
   * оставлен undefined — там работает category-bridge.
   *
   * Возможные значения (open enum, расширяется по мере ролей):
   *   "js" | "python" | "go" | "java" | "dotnet" | "rust" | "ruby" |
   *   "php" | "cpp" | "swift" | "kotlin" | "dart" | "unity_csharp" |
   *   "solidity" | "1c"
   */
  stackFamily: z.string().optional(),
  /**
   * Free-text aliases (RU + EN) used by role-matcher AND probe-ru-market /
   * Title Optimization prompts (hh.ru queries). Источник — `prompts/kb/roles-catalog.json`
   * → поле `aliases`. Содержит и русские, и английские формулировки.
   */
  aliases: z.array(z.string()),

  ru: regionStatsSchema.nullable(),
  uk: regionStatsSchema.nullable(),
  eu: regionStatsSchema.nullable(),
  us: regionStatsSchema.nullable(),

  /** AI-risk bucket for the role (expert tagging, adjustable per feedback). */
  aiRisk: aiRiskEnum,

  /**
   * Competition per 100 specialists - slug-level (не per-region).
   * Раньше хранилось в двух местах: `ru.competitionPer100Specialists`
   * (точная hh.ru метрика) и `uk.competitionPer100Specialists` (оценочное
   * ratio из `competition-eu.md`). Это давало модели два разных числа для
   * одной роли и путаницу в финальном тексте.
   *
   * Теперь одно число на slug (приоритет: RU hh.ru → EU из KB → null),
   * одинаковое для всех рынков. Кач. оценка "низкая/средняя/высокая"
   * вычисляется детерминированно через `competitionLabel()`.
   */
  competitionPer100: z.number().nullable().optional(),

  /**
   * Slug-level динамика спроса (perm-vacancies, 2-year window, ratio = now/twoYearsAgo).
   * Источник приоритета: UK itjobswatch (`uk.trend.ratio`) → RU snapshots
   * (`ru.trend.ratio`) → null. UK-сигнал предпочтительнее, потому что в RU
   * рынок сильно искажён санкциями последних 2 лет и даёт нерепрезентативную
   * картину для глобальной роли.
   *
   * В финал таблицу отдаём как `динамика ±N% YoY` через `trendLabelPct()`.
   */
  trendRatio: z.number().nullable().optional(),
});
export type MarketIndexEntry = z.infer<typeof marketIndexEntrySchema>;

export const marketIndexSchema = z.record(z.string(), marketIndexEntrySchema);
export type MarketIndex = z.infer<typeof marketIndexSchema>;
