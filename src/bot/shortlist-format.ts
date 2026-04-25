/**
 * Чистые форматтеры для Gate 1 shortlist UI. Выделены из `shortlist-review.ts`
 * специально чтобы можно было импортировать их в probe-скриптах, тестах и
 * любых местах, где не нужен telegraf/bot-instance.
 *
 * Здесь:
 *   - `scoreBadge` — цветной бейдж по score (с fallback на adjacency для legacy).
 *   - `formatDirection` — HTML-тело одного направления (сообщение в TG).
 *   - `formatHeader` — HTML-тело header-сообщения.
 *   - `BUCKET_LABEL` — флажки по bucket'у.
 */

import type { Direction } from "../schemas/analysis-outputs.js";
import type { EnrichedDirection } from "../services/direction-enricher.js";

export interface DirectionSlotLike {
  direction: Direction;
  enriched?: EnrichedDirection;
}

export interface ShortlistStateLike {
  slots: DirectionSlotLike[];
  reserve: DirectionSlotLike[];
}

export function escapeHtml(s: unknown): string {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const BUCKET_LABEL: Record<Direction["bucket"], string> = {
  ru: "🇷🇺 RU",
  abroad: "🌍 abroad",
  usa: "🇺🇸 USA",
};

/**
 * 🟢 / 🟡 / 🔴 / 🚫 по score (0-100). Fallback на adjacencyScorePercent
 * нужен только для старых состояний без score.
 */
export function scoreBadge(d: Direction): string {
  if (d.recommended === false) return "🚫";
  const raw = d.score ?? d.adjacencyScorePercent ?? 0;
  if (raw >= 80) return "🟢";
  if (raw >= 55) return "🟡";
  return "🔴";
}

/**
 * Медианная зарплата по конвенциям источников:
 *   - ru     → hh.ru, RUB/месяц (рисуем как есть)
 *   - abroad → itjobswatch.co.uk, GBP/год (конвертим в EUR/мес × 1.17 / 12,
 *              чтобы UI был в одном масштабе с RU и совпадал с тем, что
 *              реально считает scorer для ранжирования. Раньше показывали
 *              сырой £70k/год как `~€70k/мес` — все senior-роли становились
 *              «одинаковыми» евромиллионерами).
 *   - usa    → US-источники, USD/год → USD/мес (÷12).
 *
 * GBP→EUR курс синхронизирован с `role-scorer.GBP_TO_EUR` (1.17), специально
 * не импортим оттуда чтобы не таскать жирный модуль в bot-форматтер.
 */
const GBP_TO_EUR_DISPLAY = 1.17;

function formatMoney(n: number | null, bucket: Direction["bucket"]): string {
  if (n == null) return "—";
  if (bucket === "ru") {
    const k = Math.round(n / 1000);
    return `~${k}k ₽/мес`;
  }
  if (bucket === "usa") {
    const monthlyUsd = n / 12;
    const k = Math.round(monthlyUsd / 1000);
    return `~$${k}k/мес`;
  }
  // abroad: GBP/год из UK → EUR/мес для отображения.
  const monthlyEur = (n * GBP_TO_EUR_DISPLAY) / 12;
  const k = Math.round(monthlyEur / 1000);
  return `~€${k}k/мес`;
}

/**
 * Префикс-бейдж источника данных (Phase 2 enrichment).
 *   `[m]` — market-index (наша KB, надёжно)
 *   `[p]` — perplexity (дозаполнено через ИИ-поиск, есть URL-citations)
 *   `[~]` — perplexity-estimate (оценка по аналогии — низкая уверенность)
 *   `[?]` — none (данных нет; Phase 3 разберётся)
 *
 * Возвращает пустую строку для baseline без явного `dataSource`
 * (старые состояния до Phase 2) — чтобы не ломать обратную совместимость.
 */
export function dataSourceBadge(enriched?: EnrichedDirection): string {
  if (!enriched) return "";
  const src = enriched.dataSource;
  if (!src) return "";
  switch (src) {
    case "market-index": return "[m]";
    case "perplexity": return "[p]";
    case "perplexity-estimate": return "[~]";
    case "none": return "[?]";
    default: return "";
  }
}

export function hasCoreMarketData(enriched?: EnrichedDirection): boolean {
  if (!enriched) return false;
  return (
    enriched.vacancies != null ||
    enriched.medianSalaryMid != null ||
    enriched.competitionPer100 != null
  );
}

export function formatMarketLine(d: Direction, enriched?: EnrichedDirection): string {
  const parts: string[] = [];
  const badge = dataSourceBadge(enriched);
  if (badge) parts.push(badge);

  if (enriched) {
    if (enriched.vacancies != null) parts.push(`${enriched.vacancies} вак`);
    if (enriched.medianSalaryMid != null) {
      parts.push(formatMoney(enriched.medianSalaryMid, d.bucket));
    }
    if (enriched.aiRisk) parts.push(`AI ${enriched.aiRisk}`);
    if (enriched.competitionPer100 != null) {
      const c = enriched.competitionPer100;
      const label = c >= 10 ? "низк" : c >= 3 ? "средн" : "высок";
      parts.push(`конк ${c.toFixed(1)}/100 (${label})`);
    }
    if (enriched.trendRatio != null && enriched.trendRatio > 0) {
      // trendRatio = now / twoYearsAgo (например 1.75 = +75%, 0.75 = -25%).
      // В UI показываем именно изменение, а не абсолютный коэффициент.
      const pctChange = Math.round((enriched.trendRatio - 1) * 100);
      if (Math.abs(pctChange) >= 5) {
        const arrow = pctChange > 0 ? "↑" : "↓";
        const sign = pctChange > 0 ? "+" : "";
        parts.push(`тренд ${arrow} ${sign}${pctChange}%`);
      }
    }
    // Если ни vacancies/salary/competition нет — это критичный пробел,
    // финал без них бесполезен. Явно сигналим вместо неинформативного "[m] AI high".
    if (!hasCoreMarketData(enriched)) {
      parts.push("⚠ нет данных рынка — обсудить вручную");
    }
  } else {
    parts.push("рынок: нет данных");
  }
  return parts.join(" · ");
}

export function formatDirection(
  slot: DirectionSlotLike,
  idx: number,
  total: number,
): string {
  const d = slot.direction;
  const enriched = slot.enriched;
  const badge = scoreBadge(d);
  const bucket = BUCKET_LABEL[d.bucket] ?? d.bucket;

  const header = `<b>${badge} ${idx + 1}/${total}. ${escapeHtml(d.title)}</b>`;
  const scoreStr = d.score != null ? `score ${d.score}` : null;
  const metaParts: string[] = [bucket];
  if (scoreStr) metaParts.push(scoreStr);
  metaParts.push(`adj ${d.adjacencyScorePercent}%`);
  const metaLine = metaParts.map(escapeHtml).join(" · ");

  const whyRaw = d.whyFits ?? "";
  const why = whyRaw.length > 600 ? whyRaw.slice(0, 597) + "…" : whyRaw;

  const marketLine = `💼 ${formatMarketLine(d, enriched)}`;

  const footer: string[] = [];
  if (d.recommended === false) {
    const reason = d.rejectionReason?.trim()
      ? d.rejectionReason
      : "Клиент попросил, но объективно не подходит — обсудить на созвоне.";
    footer.push(`🚫 <b>Не рекомендуем:</b> ${escapeHtml(reason)}`);
  }
  if (d.offIndex) {
    footer.push(`⚠ off-index slug <code>${escapeHtml(d.roleSlug)}</code>`);
  }
  // Phase 2: если данные дозаполнены через Perplexity — даём проверяемые
  // источники в подвале, чтобы можно было ткнуть и убедиться.
  if (
    enriched?.dataSource === "perplexity" ||
    enriched?.dataSource === "perplexity-estimate"
  ) {
    if (enriched.perplexityReasoning) {
      footer.push(`<i>~ ${escapeHtml(enriched.perplexityReasoning.slice(0, 200))}</i>`);
    }
    const cites = (enriched.perplexityCitations ?? []).slice(0, 3);
    if (cites.length > 0) {
      const lines = cites.map((c) => `  · ${escapeHtml(c)}`).join("\n");
      footer.push(`<i>источники:</i>\n${lines}`);
    }
  }

  return [
    header,
    `<i>${metaLine}</i>`,
    "",
    escapeHtml(why),
    "",
    marketLine,
    ...footer,
  ].join("\n");
}

export function isRecommended(d: Direction): boolean {
  return d.recommended !== false;
}

export function countRecommended(slots: DirectionSlotLike[]): number {
  return slots.filter((s) => isRecommended(s.direction)).length;
}

export function formatHeader(state: ShortlistStateLike, nick: string): string {
  const total = state.slots.length;
  let green = 0;
  let yellow = 0;
  let red = 0;
  let rejected = 0;
  for (const s of state.slots) {
    const b = scoreBadge(s.direction);
    if (b === "🟢") green += 1;
    else if (b === "🟡") yellow += 1;
    else if (b === "🚫") rejected += 1;
    else red += 1;
  }
  const recommended = countRecommended(state.slots);
  const counterParts = [`🟢 ${green}`, `🟡 ${yellow}`, `🔴 ${red}`];
  if (rejected > 0) counterParts.push(`🚫 ${rejected}`);
  const lines: string[] = [
    `<b>📋 Shortlist @${escapeHtml(nick)}</b>`,
    `Направлений: <b>${total}</b> · ${counterParts.join(" · ")} · в запасе ${state.reserve.length}`,
    `Рекомендуем: <b>${recommended}</b>${rejected > 0 ? ` · отклонено: <b>${rejected}</b>` : ""}`,
  ];
  if (recommended < 3) {
    lines.push(
      `<i>⚠ Рекомендуемых меньше 3 (нужно ≥ 3 не-🚫) — Approve заблокирован.</i>`,
    );
  } else {
    lines.push(
      "<i>Проверь направления ниже и жми ✓ Одобрить. 🚫 — попадут в финальный анализ как «обсудили и отклонили».</i>",
    );
  }
  return lines.join("\n");
}
