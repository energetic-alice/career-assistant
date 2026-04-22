import type { Region } from "../schemas/analysis-outputs.js";

/**
 * UI-рендер региона: эмодзи-флаг для одно-страновых + короткий код для
 * мульти-страновых / remote. Используется во всех карточках и CLI-выводах.
 */
const REGION_DISPLAY: Record<Region, string> = {
  ru: "🇷🇺",
  eu: "🇪🇺",
  uk: "🇬🇧",
  us: "🇺🇸",
  cis: "СНГ",
  latam: "LATAM",
  "asia-pacific": "APAC",
  "middle-east": "MENA",
  global: "🌐",
};

export function formatRegion(r: Region): string {
  return REGION_DISPLAY[r];
}

export function formatRegions(regions: readonly Region[]): string {
  if (!regions || regions.length === 0) return "—";
  return regions.map(formatRegion).join(" ");
}

/**
 * USA-primary клиент = целится в США (target) или физически там живёт.
 * Используется в scorer'е: abroad-медианы у нас из UK-источников, а USA-зп
 * в среднем выше. Чтобы не отсеивать USA-клиента по заниженным ожиданиям,
 * умножаем UK-медиану на `USA_SALARY_MULTIPLIER` при сравнении.
 *
 * Полумера до введения отдельного `usa`-bucket'а в `market-index.json`.
 */
export function isUsaPrimaryClient(args: {
  targetMarketRegions: readonly Region[];
  physicalCountry: string;
}): boolean {
  if (args.targetMarketRegions.includes("us")) return true;
  if (US_COUNTRIES.has(args.physicalCountry)) return true;
  return false;
}

/** Множитель US зп относительно EU/UK медиан. */
export const USA_SALARY_MULTIPLIER = 1.5;

/**
 * Country→region tables used by both Phase 0 (ClientSummary.accessibleMarkets)
 * and Phase 1 (CandidateProfile.barriers.accessibleMarkets).
 *
 * Страны в таблицах — на английском (как их возвращает Клод или как они
 * стандартизованы в Wikipedia). Клод в Phase 0 должен нормализовать
 * citizenship/location в эти названия.
 */

export const EU_COUNTRIES = new Set<string>([
  "Austria", "Belgium", "Bulgaria", "Croatia", "Cyprus", "Czech Republic",
  "Czechia", "Denmark", "Estonia", "Finland", "France", "Germany", "Greece",
  "Hungary", "Ireland", "Italy", "Latvia", "Lithuania", "Luxembourg", "Malta",
  "Netherlands", "Poland", "Portugal", "Romania", "Slovakia", "Slovenia",
  "Spain", "Sweden", "Norway", "Switzerland", "Iceland",
]);

export const UK_COUNTRIES = new Set<string>(["United Kingdom", "UK"]);

export const US_COUNTRIES = new Set<string>([
  "United States", "USA", "US", "United States of America",
]);

export const RU_COUNTRIES = new Set<string>(["Russia", "Russian Federation"]);

/** Страны с безвизовым / упрощённым доступом к найму в РФ. */
export const RU_WORK_PERMIT_COUNTRIES = new Set<string>(["Russia", "Belarus"]);

/** Страны СНГ (без РФ). */
export const CIS_COUNTRIES = new Set<string>([
  "Kazakhstan", "Belarus", "Armenia", "Kyrgyzstan", "Uzbekistan",
  "Tajikistan", "Moldova", "Azerbaijan", "Georgia", "Turkmenistan",
]);

export const LATAM_COUNTRIES = new Set<string>([
  "Brazil", "Mexico", "Argentina", "Colombia", "Chile", "Peru",
  "Ecuador", "Venezuela", "Uruguay", "Paraguay", "Bolivia",
  "Costa Rica", "Panama", "Dominican Republic",
]);

export const APAC_COUNTRIES = new Set<string>([
  "Singapore", "Australia", "Japan", "India", "South Korea",
  "Malaysia", "Thailand", "Indonesia", "Vietnam", "Philippines",
  "New Zealand", "Hong Kong", "Taiwan", "China",
]);

export const ME_COUNTRIES = new Set<string>([
  "UAE", "United Arab Emirates", "Saudi Arabia", "Qatar",
  "Bahrain", "Kuwait", "Oman", "Israel", "Turkey",
]);

export function isPhysicallyInRU(physicalCountry: string): boolean {
  return RU_COUNTRIES.has(physicalCountry);
}

export function isPhysicallyInEU(physicalCountry: string): boolean {
  return EU_COUNTRIES.has(physicalCountry);
}

export function hasRuWorkPermit(
  physicalCountry: string,
  citizenships: readonly string[],
): boolean {
  return (
    RU_WORK_PERMIT_COUNTRIES.has(physicalCountry) ||
    citizenships.some((c) => RU_WORK_PERMIT_COUNTRIES.has(c))
  );
}

export function hasEUWorkPermit(
  physicalCountry: string,
  citizenships: readonly string[],
): boolean {
  return (
    isPhysicallyInEU(physicalCountry) ||
    citizenships.some((c) => EU_COUNTRIES.has(c))
  );
}

/**
 * Вычисляет рынки, на которых клиент реально может работать.
 *
 * Логика:
 *   - RU: физически в РФ/Беларуси ИЛИ паспорт РФ/Беларуси (легальный найм).
 *   - CIS: паспорт или физически в стране СНГ.
 *   - EU/UK: физически в ЕС/UK ИЛИ паспорт ЕС (свобода передвижения).
 *   - LATAM/APAC/ME: физически там ИЛИ паспорт оттуда.
 *   - Для USA не делаем автоматический вывод (L-1/H-1B — особая тема);
 *     добавляется только если явно в `targetMarketRegions` (B2B remote).
 *   - Remote B2B доступен везде, куда клиент сам нацелен — потому
 *     `targetMarketRegions` всегда вливается в итог.
 *
 * Результат — пересечение accessible + wished (объединение), без дублей.
 */
export function computeAccessibleMarkets(args: {
  citizenships: readonly string[];
  physicalCountry: string;
  targetMarketRegions: readonly Region[];
}): Region[] {
  const { citizenships, physicalCountry, targetMarketRegions } = args;
  const accessible = new Set<Region>();

  if (isPhysicallyInRU(physicalCountry) || hasRuWorkPermit(physicalCountry, citizenships)) {
    accessible.add("ru");
  }
  if (
    citizenships.some((c) => CIS_COUNTRIES.has(c)) ||
    CIS_COUNTRIES.has(physicalCountry)
  ) {
    accessible.add("cis");
  }
  if (isPhysicallyInEU(physicalCountry) || hasEUWorkPermit(physicalCountry, citizenships)) {
    accessible.add("eu");
    accessible.add("uk");
  }
  if (
    LATAM_COUNTRIES.has(physicalCountry) ||
    citizenships.some((c) => LATAM_COUNTRIES.has(c))
  ) {
    accessible.add("latam");
  }
  if (
    APAC_COUNTRIES.has(physicalCountry) ||
    citizenships.some((c) => APAC_COUNTRIES.has(c))
  ) {
    accessible.add("asia-pacific");
  }
  if (
    ME_COUNTRIES.has(physicalCountry) ||
    citizenships.some((c) => ME_COUNTRIES.has(c))
  ) {
    accessible.add("middle-east");
  }
  // Remote B2B: куда клиент сам нацелен — тоже считаем доступным.
  for (const r of targetMarketRegions) accessible.add(r);

  return [...accessible];
}
