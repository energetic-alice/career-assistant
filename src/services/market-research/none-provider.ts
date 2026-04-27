/**
 * NoneProvider — заглушка для `MARKET_RESEARCH_PROVIDER=none`.
 *
 * Возвращает baseline без изменений. Используется для smoke-тестов,
 * локальной разработки без внешних API и для in-index клиентов чтобы
 * явно отключить любые внешние запросы.
 */

import type {
  MarketResearchEnrichArgs,
  MarketResearchProvider,
} from "./provider.js";

export class NoneProvider implements MarketResearchProvider {
  readonly name = "none" as const;

  isAvailable(): boolean {
    return true;
  }

  async enrichGaps(args: MarketResearchEnrichArgs) {
    console.log("[MarketResearch:none] returning baseline as-is (provider=none)");
    return args.baseline.map((b) => ({ ...b }));
  }
}
