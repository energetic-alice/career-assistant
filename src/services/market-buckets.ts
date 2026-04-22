import type { ClientSummary } from "../schemas/client-summary.js";
import type { Region } from "../schemas/analysis-outputs.js";

/**
 * Разбивка на ru / abroad bucket'ы для role-scorer'а.
 *
 * Источник истины — `accessibleMarkets` (вычисляется кодом после Phase 0
 * на основе `citizenships` + `physicalCountry` + `targetMarketRegions`).
 * Если вдруг пусто (старый summary до миграции) — fallback на
 * `targetMarketRegions` как wishlist.
 *
 *   - `ru`: accessibleMarkets содержит "ru" или "cis".
 *   - `abroad`: есть хоть один регион вне RU/CIS — "eu"/"uk"/"us"/
 *     "latam"/"asia-pacific"/"middle-east"/"global".
 *   - Если массив пустой совсем — возвращаем оба (не режем клиенту выбор).
 */

export interface MarketBuckets {
  ru: boolean;
  abroad: boolean;
  reason: string;
}

const RU_LIKE_REGIONS: ReadonlySet<Region> = new Set<Region>(["ru", "cis"]);

function classify(regions: readonly Region[]): { ru: boolean; abroad: boolean } {
  let ru = false;
  let abroad = false;
  for (const r of regions) {
    if (RU_LIKE_REGIONS.has(r)) ru = true;
    else abroad = true;
  }
  return { ru, abroad };
}

export function computeMarketBuckets(summary: ClientSummary | undefined | null): MarketBuckets {
  if (!summary) {
    return { ru: true, abroad: true, reason: "no-summary — показываем оба" };
  }

  const accessible = summary.accessibleMarkets ?? [];
  if (accessible.length > 0) {
    const { ru, abroad } = classify(accessible);
    if (ru || abroad) {
      return {
        ru,
        abroad,
        reason: `по accessibleMarkets [${accessible.join(", ")}]`,
      };
    }
  }

  const targets = summary.targetMarketRegions ?? [];
  if (targets.length > 0) {
    const { ru, abroad } = classify(targets);
    if (ru || abroad) {
      return {
        ru,
        abroad,
        reason: `по targetMarketRegions [${targets.join(", ")}] (accessibleMarkets пусто)`,
      };
    }
  }

  return {
    ru: true,
    abroad: true,
    reason: "targetMarketRegions и accessibleMarkets пусты — показываем оба",
  };
}
