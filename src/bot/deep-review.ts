import crypto from "node:crypto";
import type { Context } from "telegraf";
import { Markup } from "telegraf";

type CallbackButton = ReturnType<typeof Markup.button.callback>;
type InlineKeyboardMarkup = ReturnType<typeof Markup.inlineKeyboard>["reply_markup"];

import { getBot } from "./bot-instance.js";
import {
  getPipelineState,
  updatePipelineStage,
} from "../pipeline/intake.js";
import {
  runDeepResearch,
  type ShortlistResult,
} from "../pipeline/run-analysis.js";
import type { Direction } from "../schemas/analysis-outputs.js";
import type { EnrichedDirection } from "../services/direction-enricher.js";
import { normalizeNick } from "../services/intake-mapper.js";
import {
  countRecommended,
  escapeHtml,
  formatDirection,
  hasCoreMarketData,
  isRecommended,
  scoreBadge,
} from "./shortlist-format.js";
import { registerPendingReply } from "./pending-reply.js";

/**
 * Gate 2 — глубокий анализ (Phase 2).
 *
 * Точно так же как Gate 1, но:
 *   - на вход — approved-список из Gate 1 (`stageOutputs.approved.directions`);
 *   - enrichment дозаполняет дыры через Perplexity (см. `deep-research-service`);
 *   - один message на direction с тем же форматтером, бейдж источника `[m]/[p]/[~]/[?]`;
 *   - кнопки `↻ Заменить` НЕТ — направления уже одобрены в Gate 1, заменять смысла нет;
 *     можно только `🗑 Удалить` и в финале `✓ Approve → финальный анализ`.
 *
 * State хранится в `stageOutputs.deepReview`. Header даёт сводку по
 * количеству direction'ов и распределению источников данных.
 */

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

export interface DeepDirectionSlot {
  slotId: string;
  direction: Direction;
  enriched?: EnrichedDirection;
  messageChatId?: number | string;
  messageId?: number;
}

export interface DeepReviewState {
  slots: DeepDirectionSlot[];
  headerChatId?: number | string;
  headerMessageId?: number;
  startedAt: string;
  perplexityFills: number;
}

const STORE_KEY = "deepReview";
const APPROVED_KEY = "deepApproved";

function loadDeep(participantId: string): DeepReviewState | undefined {
  const state = getPipelineState(participantId);
  if (!state) return undefined;
  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  return outputs[STORE_KEY] as DeepReviewState | undefined;
}

function saveDeep(participantId: string, deep: DeepReviewState): void {
  const ps = getPipelineState(participantId);
  updatePipelineStage(participantId, ps?.stage ?? "deep_ready", {
    [STORE_KEY]: deep,
  });
}

function newSlotId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function findSlotIdx(state: DeepReviewState, slotId: string): number {
  return state.slots.findIndex((s) => s.slotId === slotId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────────────────────

function formatDeepHeader(state: DeepReviewState, nick: string): string {
  const total = state.slots.length;
  const recommended = countRecommended(state.slots);
  const rejected = total - recommended;
  const counts = { m: 0, p: 0, e: 0, n: 0 };
  for (const s of state.slots) {
    const src = s.enriched?.dataSource;
    if (src === "market-index") counts.m += 1;
    else if (src === "perplexity") counts.p += 1;
    else if (src === "perplexity-estimate") counts.e += 1;
    else counts.n += 1;
  }
  const sourceLine = `[m] ${counts.m} · [p] ${counts.p} · [~] ${counts.e} · [?] ${counts.n}`;
  // Количество direction'ов без core-рыночных данных (vac/sal/comp все null) —
  // это критичный пробел, в финал такие идти не должны.
  const noData = state.slots.filter(
    (s) => isRecommended(s.direction) && !hasCoreMarketData(s.enriched),
  ).length;
  const lines = [
    `<b>🔬 Глубокий анализ @${escapeHtml(nick)}</b>`,
    `Направлений: <b>${total}</b> · источники: ${sourceLine}`,
    `Рекомендуем: <b>${recommended}</b>${rejected > 0 ? ` · отклонено: <b>${rejected}</b>` : ""}`,
  ];
  if (noData > 0) {
    lines.push(`⚠ <b>Без данных рынка: ${noData}</b> — финал по ним бесполезен, проверь вручную.`);
  }
  if (recommended < 1) {
    lines.push(`<i>⚠ Нет рекомендуемых — Approve заблокирован.</i>`);
  } else {
    lines.push(`<i>Перепроверь данные и жми ✓ Одобрить → финальный анализ. 🚫 уйдут как «обсудили и отклонили».</i>`);
  }
  if (counts.p > 0 || counts.e > 0) {
    lines.push(`<i>[p]/[~] — дозаполнено через Perplexity, см. источники в карточке.</i>`);
  }
  return lines.join("\n");
}

function deepHeaderKeyboard(
  participantId: string,
  state: DeepReviewState,
): InlineKeyboardMarkup {
  const recommended = countRecommended(state.slots);
  const canApprove = recommended >= 1;
  const rows: CallbackButton[][] = [];
  rows.push([
    Markup.button.callback(
      canApprove
        ? `✓ Одобрить → финальный анализ (${recommended})`
        : `✓ Одобрить (нет рекомендуемых)`,
      canApprove ? `deep:approve:${participantId}` : `deep:noop:${participantId}`,
    ),
  ]);
  return Markup.inlineKeyboard(rows).reply_markup;
}

function deepDirectionKeyboard(
  participantId: string,
  slot: DeepDirectionSlot,
): InlineKeyboardMarkup {
  const slotId = slot.slotId;
  const recommended = isRecommended(slot.direction);
  const rejectBtn = recommended
    ? Markup.button.callback("🚫 Отклонить", `deep:reject:${participantId}:${slotId}`)
    : Markup.button.callback("✅ Вернуть", `deep:unreject:${participantId}:${slotId}`);
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🗑 Удалить", `deep:del:${participantId}:${slotId}`),
      rejectBtn,
    ],
  ]).reply_markup;
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram I/O
// ─────────────────────────────────────────────────────────────────────────────

async function sendDeepHeader(
  chatId: number | string,
  participantId: string,
  state: DeepReviewState,
): Promise<{ chatId: number | string; messageId: number }> {
  const bot = getBot();
  const nick = normalizeNick(getPipelineState(participantId)?.telegramNick ?? "");
  const msg = await bot.telegram.sendMessage(chatId, formatDeepHeader(state, nick), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: deepHeaderKeyboard(participantId, state),
  });
  return { chatId, messageId: msg.message_id };
}

async function editDeepHeader(
  participantId: string,
  state: DeepReviewState,
): Promise<void> {
  if (state.headerChatId == null || state.headerMessageId == null) return;
  const bot = getBot();
  const nick = normalizeNick(getPipelineState(participantId)?.telegramNick ?? "");
  try {
    await bot.telegram.editMessageText(
      state.headerChatId,
      state.headerMessageId,
      undefined,
      formatDeepHeader(state, nick),
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: deepHeaderKeyboard(participantId, state),
      },
    );
  } catch (err) {
    console.error("[Deep] editHeader failed:", err);
  }
}

async function sendDeepDirection(
  chatId: number | string,
  participantId: string,
  state: DeepReviewState,
  slot: DeepDirectionSlot,
): Promise<void> {
  const bot = getBot();
  const idx = findSlotIdx(state, slot.slotId);
  const msg = await bot.telegram.sendMessage(
    chatId,
    formatDirection(
      { direction: slot.direction, enriched: slot.enriched },
      idx >= 0 ? idx : 0,
      state.slots.length,
    ),
    {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: deepDirectionKeyboard(participantId, slot),
    },
  );
  slot.messageChatId = chatId;
  slot.messageId = msg.message_id;
}

async function deleteDeepMessage(slot: DeepDirectionSlot): Promise<void> {
  if (slot.messageChatId == null || slot.messageId == null) return;
  try {
    await getBot().telegram.deleteMessage(slot.messageChatId, slot.messageId);
  } catch (err) {
    console.error("[Deep] deleteMessage failed:", err);
  }
  slot.messageChatId = undefined;
  slot.messageId = undefined;
}

async function refreshDeepNumbers(
  participantId: string,
  state: DeepReviewState,
): Promise<void> {
  const bot = getBot();
  const total = state.slots.length;
  for (let i = 0; i < state.slots.length; i += 1) {
    const slot = state.slots[i];
    if (slot.messageChatId == null || slot.messageId == null) continue;
    try {
      await bot.telegram.editMessageText(
        slot.messageChatId,
        slot.messageId,
        undefined,
        formatDirection(
          { direction: slot.direction, enriched: slot.enriched },
          i,
          total,
        ),
        {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: deepDirectionKeyboard(participantId, slot),
        },
      );
    } catch {
      // ignore "message is not modified"
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry: запуск Phase 2
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Запускает Phase 2 поверх готового Gate 1 shortlist + approved.
 * Рисует header + по одному сообщению на direction.
 */
export async function startDeepReview(
  participantId: string,
  chatId: number | string,
  shortlist: ShortlistResult,
  approvedDirections: Direction[],
): Promise<DeepReviewState> {
  // Mark stage as generating, чтобы UI было видно что процесс идёт
  updatePipelineStage(participantId, "deep_generating", {});

  if (!process.env.PERPLEXITY_API_KEY) {
    try {
      await getBot().telegram.sendMessage(
        chatId,
        `⚠ <b>PERPLEXITY_API_KEY не задан</b> — Phase 2 покажет только baseline из market-index.\n` +
          `Roles без KB-данных останутся с пометкой «нет данных рынка».`,
        { parse_mode: "HTML" },
      );
    } catch {
      // ignore
    }
  }

  const t0 = Date.now();
  const result = await runDeepResearch(shortlist, approvedDirections);
  console.log(
    `[Deep] ${participantId}: enrichment done in ${Date.now() - t0}ms, ` +
    `perplexityFills=${result.perplexityFills}/${result.enriched.length}`,
  );

  // Сортируем по score DESC (Phase 2 не пересчитывает score, но порядок
  // мог поменяться если approved пришёл не из ожидаемого order'а).
  const indices = result.directions.map((_, i) => i);
  indices.sort((a, b) => {
    const sa = result.directions[a].score ?? 0;
    const sb = result.directions[b].score ?? 0;
    return sb - sa;
  });

  const slots: DeepDirectionSlot[] = indices.map((i) => ({
    slotId: newSlotId(),
    direction: result.directions[i],
    enriched: result.enriched[i],
  }));

  const state: DeepReviewState = {
    slots,
    startedAt: new Date().toISOString(),
    perplexityFills: result.perplexityFills,
  };

  const header = await sendDeepHeader(chatId, participantId, state);
  state.headerChatId = header.chatId;
  state.headerMessageId = header.messageId;

  for (const slot of state.slots) {
    await sendDeepDirection(chatId, participantId, state, slot);
  }

  updatePipelineStage(participantId, "deep_ready", {
    [STORE_KEY]: state,
  });

  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// Callbacks
// ─────────────────────────────────────────────────────────────────────────────

function isAdminCtx(ctx: Context): boolean {
  // Same logic as shortlist-review — повторять не хочется, но импорт
  // лишний; chat обычно === admin chat. Ленивая проверка:
  const adminChat = process.env.ADMIN_CHAT_ID
    ? Number(process.env.ADMIN_CHAT_ID)
    : null;
  if (adminChat == null) return true;
  return ctx.chat?.id === adminChat;
}

async function handleDelete(
  participantId: string,
  slotId: string,
  ctx: Context,
): Promise<void> {
  if (!isAdminCtx(ctx)) return;
  const state = loadDeep(participantId);
  if (!state) {
    await ctx.answerCbQuery("Deep state не найден.");
    return;
  }
  const idx = findSlotIdx(state, slotId);
  if (idx < 0) {
    await ctx.answerCbQuery("Слот не найден.");
    return;
  }
  const slot = state.slots[idx];
  await deleteDeepMessage(slot);
  state.slots.splice(idx, 1);
  saveDeep(participantId, state);
  await refreshDeepNumbers(participantId, state);
  await editDeepHeader(participantId, state);
  await ctx.answerCbQuery("Удалено.");
}

async function handleApprove(
  participantId: string,
  ctx: Context,
): Promise<void> {
  if (!isAdminCtx(ctx)) return;
  const state = loadDeep(participantId);
  if (!state) {
    await ctx.answerCbQuery("Deep state не найден.");
    return;
  }
  const recommendedSlots = state.slots.filter((s) => isRecommended(s.direction));
  const rejectedSlots = state.slots.filter((s) => !isRecommended(s.direction));
  if (recommendedSlots.length === 0) {
    await ctx.answerCbQuery("Нет рекомендуемых направлений.");
    return;
  }

  const recommendedDirections = recommendedSlots.map((s) => s.direction);
  const rejectedDirections = rejectedSlots.map((s) => s.direction);
  const recommendedEnriched = recommendedSlots.map((s) => s.enriched).filter((x): x is EnrichedDirection => !!x);
  const rejectedEnriched = rejectedSlots.map((s) => s.enriched).filter((x): x is EnrichedDirection => !!x);

  updatePipelineStage(participantId, "deep_approved", {
    [APPROVED_KEY]: {
      directions: recommendedDirections,
      slugs: recommendedDirections.map((d) => d.roleSlug),
      enriched: recommendedEnriched,
      rejectedDirections,
      rejectedSlugs: rejectedDirections.map((d) => d.roleSlug),
      rejectedEnriched,
      approvedAt: new Date().toISOString(),
    },
  });

  await ctx.reply(
    `✅ Глубокий анализ одобрен.\n` +
      `Рекомендованы: <b>${recommendedDirections.length}</b>` +
      (rejectedDirections.length > 0
        ? `\n🚫 Отклонены (попадут в финал как «обсудили»): <b>${rejectedDirections.length}</b>`
        : "") +
      `\n\nФинальный анализ (Phase 3) будет запущен отдельно — этот шаг ещё в разработке.`,
    { parse_mode: "HTML" },
  );
}

async function handleReject(
  participantId: string,
  slotId: string,
  ctx: Context,
): Promise<void> {
  if (!isAdminCtx(ctx)) return;
  const state = loadDeep(participantId);
  if (!state) {
    await ctx.answerCbQuery("Deep state не найден.");
    return;
  }
  const idx = findSlotIdx(state, slotId);
  if (idx < 0) {
    await ctx.answerCbQuery("Слот пропал.");
    return;
  }
  const slot = state.slots[idx];
  slot.direction.recommended = false;
  if (!slot.direction.rejectionReason?.trim()) {
    slot.direction.rejectionReason = "Отклонено куратором при ревью.";
  }
  saveDeep(participantId, state);
  await refreshDeepNumbers(participantId, state);
  await editDeepHeader(participantId, state);

  const chatId = ctx.chat?.id;
  if (chatId != null) {
    const promptMsg = await getBot().telegram.sendMessage(
      chatId,
      `✏️ Причина отклонения «${escapeHtml(slot.direction.title)}»?\n` +
        `Ответь на это сообщение коротким текстом (1–2 предложения). Если нужна дефолтная — напиши «-».`,
      {
        parse_mode: "HTML",
        reply_markup: { force_reply: true, selective: true },
      },
    );
    registerPendingReply(chatId, promptMsg.message_id, {
      kind: "deep:reject",
      participantId,
      slotId,
    });
  }
  await ctx.answerCbQuery("🚫 Отклонено. Введи причину в ответ.");
}

async function handleUnreject(
  participantId: string,
  slotId: string,
  ctx: Context,
): Promise<void> {
  if (!isAdminCtx(ctx)) return;
  const state = loadDeep(participantId);
  if (!state) {
    await ctx.answerCbQuery("Deep state не найден.");
    return;
  }
  const idx = findSlotIdx(state, slotId);
  if (idx < 0) {
    await ctx.answerCbQuery("Слот пропал.");
    return;
  }
  const slot = state.slots[idx];
  slot.direction.recommended = true;
  slot.direction.rejectionReason = undefined;
  saveDeep(participantId, state);
  await refreshDeepNumbers(participantId, state);
  await editDeepHeader(participantId, state);
  await ctx.answerCbQuery("✅ Возвращено в рекомендуемые.");
}

export async function applyDeepRejectReason(
  participantId: string,
  slotId: string,
  reason: string,
): Promise<boolean> {
  const state = loadDeep(participantId);
  if (!state) return false;
  const idx = findSlotIdx(state, slotId);
  if (idx < 0) return false;
  const slot = state.slots[idx];
  const cleaned = reason.trim();
  if (cleaned && cleaned !== "-") {
    slot.direction.rejectionReason = cleaned.slice(0, 400);
  }
  slot.direction.recommended = false;
  saveDeep(participantId, state);
  await refreshDeepNumbers(participantId, state);
  await editDeepHeader(participantId, state);
  return true;
}

export async function dispatchDeepCallback(
  data: string,
  ctx: Context,
): Promise<boolean> {
  const [ns, action, participantId, slotOrIdx] = data.split(":");
  if (ns !== "deep" || !action || !participantId) return false;

  if (action === "noop") {
    await ctx.answerCbQuery();
    return true;
  }

  switch (action) {
    case "del":
      if (!slotOrIdx) return false;
      await handleDelete(participantId, slotOrIdx, ctx);
      return true;
    case "reject":
      if (!slotOrIdx) return false;
      await handleReject(participantId, slotOrIdx, ctx);
      return true;
    case "unreject":
      if (!slotOrIdx) return false;
      await handleUnreject(participantId, slotOrIdx, ctx);
      return true;
    case "approve":
      await handleApprove(participantId, ctx);
      return true;
    default:
      return false;
  }
}

// for tests
export function _debugDeepState(participantId: string): DeepReviewState | undefined {
  return loadDeep(participantId);
}

void scoreBadge; // re-export to keep lint quiet, used by formatDirection internally
