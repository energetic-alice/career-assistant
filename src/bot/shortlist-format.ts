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
 * `medianSalaryMid` в market-index — месячная зарплата в локальной валюте
 * bucket'а (RUB для ru, EUR для abroad-буката — enricher уже приводит
 * UK→EUR при выборке). Для `usa` — USD. Раньше для `abroad` рисовали
 * голое `~Xk/мес` без символа, из-за чего €348k читались глазом как ₽.
 */
function formatMoney(n: number | null, bucket: Direction["bucket"]): string {
  if (n == null) return "—";
  const k = Math.round(n / 1000);
  if (bucket === "ru") return `~${k}k ₽/мес`;
  if (bucket === "usa") return `~$${k}k/мес`;
  return `~€${k}k/мес`;
}

export function formatMarketLine(d: Direction, enriched?: EnrichedDirection): string {
  const parts: string[] = [];
  if (enriched) {
    if (enriched.vacancies != null) parts.push(`${enriched.vacancies} вак`);
    parts.push(formatMoney(enriched.medianSalaryMid, d.bucket));
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
  const counterParts = [`🟢 ${green}`, `🟡 ${yellow}`, `🔴 ${red}`];
  if (rejected > 0) counterParts.push(`🚫 ${rejected}`);
  const lines: string[] = [
    `<b>📋 Shortlist @${escapeHtml(nick)}</b>`,
    `Направлений: <b>${total}</b> · ${counterParts.join(" · ")} · в запасе ${state.reserve.length}`,
  ];
  if (total < 3) {
    lines.push("<i>⚠ Меньше 3 направлений — Approve заблокирован.</i>");
  } else {
    lines.push("<i>Проверь направления ниже и жми ✓ Одобрить, либо заменяй/удаляй отдельные.</i>");
  }
  return lines.join("\n");
}
