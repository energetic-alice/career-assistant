/**
 * Slug validator для Phase 2 niche-resolver-а.
 *
 * Проблема: Phase 1 / `postValidateDirections` оставляет slug как есть, если
 * он валидный KNOWN_ROLES. Но Claude может поставить семантически неправильный
 * slug — пример: для "DevSecOps Engineer" Claude часто выбирает `infosecspec`
 * (потому что Security в названии), хотя по нашим aliases DevSecOps живёт в
 * `devops` slug-е (см. `roles-catalog.json` строки 357-360).
 *
 * Это критично для niche-resolver-а: если мы пойдём искать DevSecOps в
 * `uk_infosecspec.md`, мы (а) не найдём, (б) дозапросим scrape под `infosecspec`,
 * (в) при следующем `probe-uk-market all infosecspec` фильтр
 * `cyber|security analyst|...` его отфильтрует.
 *
 * Решение: ПЕРЕД resolver-ом для каждой direction вызываем
 * `matchRoleToSlug(direction.title)` и сравниваем с `direction.roleSlug`.
 * Если matcher выдал ДРУГОЙ slug с confidence ≥ 0.85 — используем его как
 * "corrected slug" для resolver-а. `direction.roleSlug` НЕ мутируем — оставляем
 * Phase 1 slug в state-е, чтобы не сломать downstream Phase 3 / UI.
 */
import type { Direction } from "../../schemas/analysis-outputs.js";
import { matchRoleToSlug } from "../role-matcher.js";

export interface SlugCorrection {
  /** True если matcher предложил другой slug. */
  corrected: boolean;
  /** Slug, который должен использовать resolver (исправленный или original). */
  effectiveSlug: string;
  /** Original slug из Phase 1 (для логов). */
  originalSlug: string;
  /** Confidence от matcher-а (если применимо). */
  matcherConfidence?: number;
  /** Алиас, по которому matcher сматчил. */
  matchedAlias?: string;
}

/**
 * Возвращает effectiveSlug, по которому resolver должен искать данные.
 * Логирует расхождение если есть.
 */
export async function resolveCorrectedSlug(direction: Direction): Promise<SlugCorrection> {
  const original = direction.roleSlug;
  const match = await matchRoleToSlug(direction.title);

  // Threshold 0.85 — Tier 2 substring hit или выше. Tier 3 fuzzy 0.75-0.84
  // не используем, т.к. fuzzy на уровне title слишком ненадёжен (может
  // путать "Penetration Tester" и "Performance Tester").
  if (match && match.confidence >= 0.85 && match.slug !== original) {
    console.log(
      `[slug-fix] "${direction.title}" ${original} → ${match.slug} ` +
        `(matcher conf=${match.confidence}, alias="${match.matchedAlias}")`,
    );
    return {
      corrected: true,
      effectiveSlug: match.slug,
      originalSlug: original,
      matcherConfidence: match.confidence,
      matchedAlias: match.matchedAlias,
    };
  }

  return {
    corrected: false,
    effectiveSlug: original,
    originalSlug: original,
    matcherConfidence: match?.confidence,
    matchedAlias: match?.matchedAlias,
  };
}
