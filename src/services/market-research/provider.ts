/**
 * MarketResearchProvider — единый интерфейс Phase 2 enrichment.
 *
 * Phase 2 заполняет дыры в `EnrichedDirection` (vacancies, salary,
 * competition, aiRisk, trend) для off-index ролей и экзотических регионов.
 * Поверх этого строится финальный анализ (Phase 3 prompt-03).
 *
 * Реализации:
 *   - `none`        — заглушка, возвращает baseline as-is (для smoke / тех
 *                     случаев когда внешние запросы выключены).
 *   - `perplexity`  — legacy-путь через Sonar Pro
 *                     (`./perplexity-provider.ts`).
 *   - `claude`      — Claude Sonnet + server-side `web_search_20250305`,
 *                     per-direction параллельные вызовы
 *                     (`./claude-provider.ts`).
 *
 * Выбор провайдера — env `MARKET_RESEARCH_PROVIDER` (`getProvider()` в
 * `./index.ts`). По умолчанию `claude` (см. план).
 */

import type { Direction } from "../../schemas/analysis-outputs.js";
import type { ClientSummary } from "../../schemas/client-summary.js";
import type { EnrichedDirection } from "../direction-enricher.js";

export type MarketResearchProviderName = "claude" | "perplexity" | "none";

export interface MarketResearchEnrichArgs {
  directions: Direction[];
  baseline: EnrichedDirection[];
  summary: ClientSummary;
}

export interface MarketResearchProvider {
  readonly name: MarketResearchProviderName;
  /**
   * Доступен ли провайдер прямо сейчас (например, проверка ENV-ключей).
   * `false` — `enrichGaps` всё равно работает, но фактически возвращает
   * baseline без обогащения. Используется для логов и smoke.
   */
  isAvailable(): boolean;
  /**
   * Дозаполняет дыры. Должен:
   *   - вернуть массив той же длины что `baseline`;
   *   - НИКОГДА не бросать (логировать и возвращать baseline);
   *   - не перезаписывать поля которые уже не null в baseline.
   */
  enrichGaps(args: MarketResearchEnrichArgs): Promise<EnrichedDirection[]>;
}
