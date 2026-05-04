import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Helper: достаёт `marketKeywordsTop5` и `marketKeywords` для roleSlug'а
 * из `prompts/kb/roles-catalog.json`. Эти поля — база топ-скиллов по
 * профессии (hh.ru подборка Алисы + универсализация под международный
 * рынок), которая передаётся в LinkedIn Pack как seed:
 *   - Phase 2 (Headline) складывает из них стек в headline-вариантах.
 *   - Phase 3 (Top Skills) берёт 5 из seed.top5 + дополняет из seed.extended,
 *     если чего-то не хватает.
 *
 * Без seed модель начинает галлюцинировать keyword-ы из того, что
 * случайно стояло в профиле клиента — и промахивается мимо реального
 * рынка (например, не ставит `TypeScript` React-фронтендеру, потому
 * что в его профиле он не указан, хотя рынок без TS его не ищет).
 *
 * Возвращает `null`, если:
 *   - slug не найден в каталоге,
 *   - поля marketKeywordsTop5/marketKeywords отсутствуют (17 slug-ов
 *     пока не заполнены — см. комментарий в `add-market-keywords.ts`).
 */

interface CatalogEntry {
  slug: string;
  marketKeywordsTop5?: string[];
  marketKeywords?: string[];
}

export interface MarketKeywordsSeed {
  slug: string;
  top5: string[];
  /** Расширенный список (включая top5), в порядке частотности. */
  extended: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(
  __dirname,
  "..",
  "..",
  "prompts",
  "kb",
  "roles-catalog.json",
);

let CACHED: CatalogEntry[] | null = null;

function loadCatalog(): CatalogEntry[] {
  if (CACHED) return CACHED;
  const raw = readFileSync(CATALOG_PATH, "utf-8");
  CACHED = JSON.parse(raw) as CatalogEntry[];
  return CACHED;
}

export function getMarketKeywordsForSlug(
  slug: string | null | undefined,
): MarketKeywordsSeed | null {
  if (!slug) return null;
  const entry = loadCatalog().find((e) => e.slug === slug);
  if (!entry) return null;
  if (
    !Array.isArray(entry.marketKeywordsTop5) ||
    !Array.isArray(entry.marketKeywords) ||
    entry.marketKeywordsTop5.length === 0 ||
    entry.marketKeywords.length === 0
  ) {
    return null;
  }
  return {
    slug,
    top5: entry.marketKeywordsTop5,
    extended: entry.marketKeywords,
  };
}
