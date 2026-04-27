/**
 * Perplexity-провайдер — обёртка над legacy `enrichGapsForClient` из
 * `deep-research-service.ts`. Сохраняем как fallback под флагом
 * `MARKET_RESEARCH_PROVIDER=perplexity` для A/B-сравнений.
 */

import { enrichGapsForClient } from "../deep-research-service.js";
import type {
  MarketResearchEnrichArgs,
  MarketResearchProvider,
} from "./provider.js";

export class PerplexityProvider implements MarketResearchProvider {
  readonly name = "perplexity" as const;

  isAvailable(): boolean {
    return Boolean(process.env.PERPLEXITY_API_KEY);
  }

  async enrichGaps(args: MarketResearchEnrichArgs) {
    return enrichGapsForClient(args.directions, args.baseline, args.summary);
  }
}
