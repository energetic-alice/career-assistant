import type { ClientSummary } from "../schemas/client-summary.js";
import type { MarketIndexEntry, RegionStats } from "../schemas/market-index.js";

/**
 * Уровень клиента и уровни ролей используют единый четырёхступенчатый enum.
 * `middle+` в title направлений — это промежуточное значение между middle и
 * senior: в `roleSalaryAt` оно маппится в собственный множитель, но в
 * `clientGrade` всегда хранится как `middle` или `senior` (не `middle+`),
 * потому что seniorityCurve из рыночного индекса тоже содержит только
 * 4 точки — `junior`, `middle`, `senior`, `lead`.
 */
export type ClientGrade = "junior" | "middle" | "senior" | "lead";

/** Уровни, встречающиеся в title направлений (включая middle+). */
export type RoleGrade = ClientGrade | "middle+";

/**
 * Fallback-множители к `medianSalaryMid` (рыночная медиана для middle+).
 * Используются когда в `seniorityCurve` соответствующая точка не заполнена.
 */
export const GRADE_MULTIPLIERS: Record<RoleGrade, number> = {
  junior: 0.75,
  middle: 1.0,
  "middle+": 1.15,
  senior: 1.3,
  lead: 1.6,
};

/**
 * Пытается аккуратно вытащить число лет опыта из свободной строки.
 * `"5+ лет"` → 5, `"2 года опыта"` → 2, `"6 месяцев"` → 0.5,
 * `"год пет-проектов"` → 1, `"0 лет опыта"` → 0. Возвращает null, если
 * не удалось распознать.
 */
export function parseYearsExperience(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const s = raw.toLowerCase().trim();
  if (/^0\s*(лет|год)/.test(s)) return 0;

  // Месяцы отдельно: «6 месяцев», «8 мес».
  const m = s.match(/(\d+)\s*(?:месяц|мес)/);
  if (m) return Number(m[1]) / 12;

  // Годы: «5+ лет», «2 года», «1 год», «3-5 лет».
  const y = s.match(/(\d+)(?:[-–]\d+)?\s*(?:год|года|лет)/);
  if (y) return Number(y[1]);

  if (/^год\b/.test(s)) return 1; // «год пет-проектов»
  return null;
}

/**
 * Определяет текущий грейд клиента.
 *
 * Приоритет:
 *  1. `summary.currentGrade` заполнено Клодом в Phase 0 → используем напрямую.
 *  2. Non-IT (`currentProfessionSlug === null`) → `middle`.
 *     Вход в IT с нуля независимо от стажа в не-IT-сфере (правило Phase 1A).
 *     Lead-тайтлы (Art Director, CEO, Head of) Клод проставляет сама в Phase 0,
 *     сюда они дойдут через п.1. Fallback для non-IT — всегда middle.
 *  3. IT без поля — fallback по опыту: `≤ 3 лет → middle`, `> 3 лет → senior`.
 *     Junior и lead через fallback не назначаем (только через п.1).
 *  4. Если опыт не распарсился — `middle` (безопасный дефолт).
 */
export function resolveClientGrade(summary: ClientSummary): ClientGrade {
  if (summary.currentGrade) return summary.currentGrade;

  // Non-IT fallback: Phase 1A правило «вход в IT с нуля = middle».
  if (summary.currentProfessionSlug === null) return "middle";

  const years = parseYearsExperience(summary.yearsExperience);
  if (years === null) return "middle";
  if (years > 3) return "senior";
  return "middle";
}

/**
 * Возвращает зп (в локальной валюте bucket-а) для указанного грейда.
 *   - Если в `seniorityCurve` точка заполнена — берём её.
 *   - Иначе fallback: `medianSalaryMid × GRADE_MULTIPLIERS[grade]`.
 *   - Если и `medianSalaryMid` пустой — возвращаем null.
 */
export function roleSalaryAtGrade(
  stats: RegionStats | null | undefined,
  grade: RoleGrade,
): number | null {
  if (!stats) return null;

  const curve = stats.seniorityCurve;
  if (curve) {
    if (grade === "middle+") {
      // Нет такой точки в кривой — усредняем middle и senior.
      const mid = curve.middle ?? null;
      const sen = curve.senior ?? null;
      if (mid != null && sen != null) return Math.round((mid + sen) / 2);
      if (sen != null) return sen;
      if (mid != null) return Math.round(mid * 1.15);
    } else {
      const point = curve[grade];
      if (point != null) return point;
    }
  }

  const mid = stats.medianSalaryMid;
  if (mid == null) return null;
  return Math.round(mid * GRADE_MULTIPLIERS[grade]);
}

/**
 * Abroad-зарплата в EUR/мес для указанного грейда. Переводит UK-кривую
 * из годового GBP в ежемесячные EUR (× GBP_TO_EUR / 12), EU/US уже в
 * локальной валюте — берём as-is.
 *
 * NB: GBP_TO_EUR дублируется из `role-scorer.ts`, чтобы избежать
 * циклического импорта. Обновлять парой.
 */
const GBP_TO_EUR = 1.17;

export function roleSalaryAbroadEur(
  entry: MarketIndexEntry,
  grade: RoleGrade,
): number | null {
  if (entry.uk) {
    const ukAnnualGbp = roleSalaryAtGrade(entry.uk, grade);
    if (ukAnnualGbp != null && ukAnnualGbp > 0) {
      return Math.round((ukAnnualGbp * GBP_TO_EUR) / 12);
    }
  }
  // EU/US — трактуем как monthly EUR/USD, без конверсии.
  const eu = roleSalaryAtGrade(entry.eu, grade);
  if (eu != null) return eu;
  const us = roleSalaryAtGrade(entry.us, grade);
  if (us != null) return us;
  return null;
}

/**
 * Универсальный лукап зп роли для bucket-а и грейда в нужной валюте:
 *   - `ru`     → RUB/мес
 *   - `abroad` → EUR/мес
 * Возвращает null, если данных нет ни в кривой, ни в медиане.
 */
export function roleSalaryForBucket(
  entry: MarketIndexEntry,
  bucket: "ru" | "abroad",
  grade: RoleGrade,
): number | null {
  if (bucket === "ru") return roleSalaryAtGrade(entry.ru, grade);
  return roleSalaryAbroadEur(entry, grade);
}

/**
 * Человекочитаемое описание грейда для логов. Например "senior · опыт 5+ лет".
 */
export function describeClientGrade(summary: ClientSummary): string {
  const g = resolveClientGrade(summary);
  const src = summary.currentGrade ? "из summary" : "fallback";
  return `${g} (${src}, опыт: ${summary.yearsExperience || "—"})`;
}
