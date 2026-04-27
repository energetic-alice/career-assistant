/**
 * MarketResearch entry-point. Один selector для всего pipeline.
 *
 * Использование:
 * ```ts
 * import { getMarketResearchProvider } from "../services/market-research/index.js";
 * const provider = getMarketResearchProvider();
 * const enriched = await provider.enrichGaps({ directions, baseline, summary });
 * ```
 *
 * Provider читается из env `MARKET_RESEARCH_PROVIDER`:
 *   - `claude` (default) — Claude Sonnet + web_search.
 *   - `perplexity`        — legacy Sonar Pro.
 *   - `none`              — no-op, baseline without changes.
 *
 * Если выбранный provider недоступен (нет ключа) — fallback на `none` с warning.
 */

import { ClaudeWebSearchProvider } from "./claude-provider.js";
import { NoneProvider } from "./none-provider.js";
import { PerplexityProvider } from "./perplexity-provider.js";
import type {
  MarketResearchProvider,
  MarketResearchProviderName,
} from "./provider.js";

export type {
  MarketResearchProvider,
  MarketResearchProviderName,
} from "./provider.js";

let cached: MarketResearchProvider | null = null;
let cachedFor: MarketResearchProviderName | null = null;

function readEnv(): MarketResearchProviderName {
  const raw = (process.env.MARKET_RESEARCH_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "claude" || raw === "perplexity" || raw === "none") return raw;
  if (raw === "") return "claude";
  console.warn(
    `[MarketResearch] unknown MARKET_RESEARCH_PROVIDER=${raw}, falling back to 'claude'`,
  );
  return "claude";
}

function instantiate(name: MarketResearchProviderName): MarketResearchProvider {
  if (name === "claude") return new ClaudeWebSearchProvider();
  if (name === "perplexity") return new PerplexityProvider();
  return new NoneProvider();
}

/**
 * Returns provider for current env. Cached per-process.
 * If selected provider is unavailable (e.g. no API key), logs a warning and
 * falls back to NoneProvider so pipeline doesn't crash.
 */
export function getMarketResearchProvider(): MarketResearchProvider {
  const name = readEnv();
  if (cached && cachedFor === name) return cached;

  const provider = instantiate(name);
  if (!provider.isAvailable()) {
    console.warn(
      `[MarketResearch] provider '${name}' is not available (missing API key?). Falling back to 'none'.`,
    );
    cached = new NoneProvider();
    cachedFor = "none";
    return cached;
  }
  console.log(`[MarketResearch] provider=${name}`);
  cached = provider;
  cachedFor = name;
  return cached;
}

/** Test helper: drop the cached singleton so the next call re-reads env. */
export function _resetMarketResearchProviderCache(): void {
  cached = null;
  cachedFor = null;
}
