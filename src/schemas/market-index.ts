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
  /** Free-text aliases (RU + EN) used by role-matcher. */
  aliases: z.array(z.string()),

  ru: regionStatsSchema.nullable(),
  uk: regionStatsSchema.nullable(),
  eu: regionStatsSchema.nullable(),
  us: regionStatsSchema.nullable(),

  /** AI-risk bucket for the role (expert tagging, adjustable per feedback). */
  aiRisk: aiRiskEnum,
});
export type MarketIndexEntry = z.infer<typeof marketIndexEntrySchema>;

export const marketIndexSchema = z.record(z.string(), marketIndexEntrySchema);
export type MarketIndex = z.infer<typeof marketIndexSchema>;
