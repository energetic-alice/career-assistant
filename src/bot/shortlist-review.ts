import crypto from "node:crypto";
import type { Telegraf, Context } from "telegraf";
import { Markup } from "telegraf";

type CallbackButton = ReturnType<typeof Markup.button.callback>;
type InlineKeyboardMarkup = ReturnType<typeof Markup.inlineKeyboard>["reply_markup"];
import { getAdminChatId, getBot } from "./bot-instance.js";
import {
  getPipelineState,
  updatePipelineStage,
} from "../pipeline/intake.js";
import {
  runShortlist,
  regenerateOneDirection,
  type ShortlistResult,
  type AnalysisPipelineInput,
} from "../pipeline/run-analysis.js";
import { enrichDirections, type EnrichedDirection } from "../services/direction-enricher.js";
import type {
  CandidateProfile,
  Direction,
  DirectionsOutput,
  Region,
} from "../schemas/analysis-outputs.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import { normalizeNick } from "../services/intake-mapper.js";

/**
 * Gate 1 — интерактивный shortlist в Telegram.
 *
 * UI:
 *   - Header-сообщение: счётчик направлений, распределение по badge'ам,
 *     кнопка "✓ Approve". При любом изменении — edit_message_text.
 *   - По одному сообщению на направление с кнопками [🗑 Удалить] [↻ Заменить].
 *     Каждое сообщение привязано к стабильному `slotId` (8 hex chars), поэтому
 *     при регенерации/удалении номера не «плывут».
 *
 * Регенерация:
 *   1) нажимаем ↻ → запрос на Claude
 *   2) пришло новое направление → старое сообщение удаляется, новое шлём в
 *      конец чата (так проще следить за прогрессом).
 */

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

export interface DirectionSlot {
  /** Стабильный id слота (живёт через регенерации чтобы callback-data не плыла). */
  slotId: string;
  direction: Direction;
  enriched?: EnrichedDirection;
  /** Чат, где висит сообщение направления. */
  messageChatId?: number | string;
  messageId?: number;
}

export interface ShortlistState {
  profile: CandidateProfile;
  clientSummary?: ClientSummary;
  marketOverview: string;
  scorerTop20?: string;
  regions: Region[];
  slots: DirectionSlot[];
  /**
   * Запасные направления (отранжированы по score DESC). При регенерации
   * сначала берём отсюда — это мгновенно и экономит вызов Claude. Если
   * reserve пуст — fallback на `regenerateOneDirection` (новый вызов 02).
   */
  reserve: DirectionSlot[];
  /** Anti-race: одна регенерация за раз. */
  busy?: boolean;
  /** Координаты header-сообщения для edit. */
  headerChatId?: number | string;
  headerMessageId?: number;
}

/**
 * Сколько направлений показываем сразу (остальное уходит в reserve).
 */
const ACTIVE_SLOTS = 10;

const STORE_KEY = "shortlist";
const APPROVED_KEY = "approved";

function loadShortlist(participantId: string): ShortlistState | undefined {
  const state = getPipelineState(participantId);
  if (!state) return undefined;
  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const raw = outputs[STORE_KEY] as (ShortlistState & LegacyShortlistState) | undefined;
  if (!raw) return undefined;
  return migrateLegacy(raw);
}

function saveShortlist(participantId: string, shortlist: ShortlistState): void {
  updatePipelineStage(participantId, getStageForShortlist(participantId), {
    [STORE_KEY]: shortlist,
  });
}

function getStageForShortlist(participantId: string) {
  const state = getPipelineState(participantId);
  return state?.stage ?? "awaiting_analysis";
}

// ── Legacy (pre-slots) state migration ──────────────────────────────────────
//
// Первая версия Gate 1 хранила `directions: Direction[]` + `enriched:
// EnrichedDirection[]` и один общий `messageId`. Чтобы старые state'ы не
// падали при открытии — на лету конвертим их в slot-based.
interface LegacyShortlistState {
  directions?: Direction[];
  enriched?: EnrichedDirection[];
  messageChatId?: number | string;
  messageId?: number;
}

function migrateLegacy(raw: ShortlistState & LegacyShortlistState): ShortlistState {
  if (Array.isArray(raw.slots)) return raw;
  const legacyDirections = raw.directions ?? [];
  const legacyEnriched = raw.enriched ?? [];
  const enrichedByKey = new Map<string, EnrichedDirection>();
  for (const row of legacyEnriched) {
    enrichedByKey.set(`${row.roleSlug}|${row.bucket}`, row);
  }
  const slots: DirectionSlot[] = legacyDirections.map((d) => {
    const bucketKey = d.bucket === "ru" ? "ru" : "abroad";
    return {
      slotId: newSlotId(),
      direction: d,
      enriched: enrichedByKey.get(`${d.roleSlug}|${bucketKey}`),
    };
  });
  return {
    profile: raw.profile,
    clientSummary: raw.clientSummary,
    marketOverview: raw.marketOverview,
    scorerTop20: raw.scorerTop20,
    regions: raw.regions,
    slots,
    reserve: [],
    busy: raw.busy,
  };
}

function fromShortlistResult(result: ShortlistResult): ShortlistState {
  const enrichedByKey = new Map<string, EnrichedDirection>();
  for (const row of result.enriched) {
    enrichedByKey.set(`${row.roleSlug}|${row.bucket}`, row);
  }
  // Directions уже отсортированы runShortlist по score DESC, но на всякий —
  // сортируем здесь ещё раз, чтобы reserve/active были устойчивы к legacy данным.
  const sorted = [...result.directions.directions].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0),
  );
  const allSlots: DirectionSlot[] = sorted.map((d) => {
    const bucketKey = d.bucket === "ru" ? "ru" : "abroad";
    return {
      slotId: newSlotId(),
      direction: d,
      enriched: enrichedByKey.get(`${d.roleSlug}|${bucketKey}`),
    };
  });
  return {
    profile: result.profile,
    clientSummary: result.clientSummary,
    marketOverview: result.marketOverview,
    scorerTop20: result.scorerTop20,
    regions: result.regions,
    slots: allSlots.slice(0, ACTIVE_SLOTS),
    reserve: allSlots.slice(ACTIVE_SLOTS),
  };
}

function toShortlistResult(state: ShortlistState): ShortlistResult {
  const directions: Direction[] = state.slots.map((s) => s.direction);
  const enriched: EnrichedDirection[] = state.slots
    .map((s) => s.enriched)
    .filter((x): x is EnrichedDirection => !!x);
  const output: DirectionsOutput = { directions };
  return {
    profile: state.profile,
    clientSummary: state.clientSummary,
    marketOverview: state.marketOverview,
    scorerTop20: state.scorerTop20,
    regions: state.regions,
    directions: output,
    enriched,
    timings: {},
  };
}

function newSlotId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function findSlotIdx(state: ShortlistState, slotId: string): number {
  return state.slots.findIndex((s) => s.slotId === slotId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(s: unknown): string {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const BUCKET_LABEL: Record<Direction["bucket"], string> = {
  ru: "🇷🇺 RU",
  abroad: "🌍 abroad",
  usa: "🇺🇸 USA",
};

/**
 * Цветной бейдж по adjacencyScorePercent: наш proxy для "хорошо/средне/плохо
 * подходит" на уровне shortlist'а. На deep-анализе появится более серьёзный
 * scoring, а пока это самый понятный клиенту сигнал.
 */
function scoreBadge(d: Direction): string {
  // Клиент сам попросил, но мы не рекомендуем — особый бейдж.
  if (d.recommended === false) return "🚫";
  // Клод проставляет `score` (0-100) как интегральную оценку направления;
  // для legacy данных без score — fallback на adjacencyScorePercent.
  const raw = d.score ?? d.adjacencyScorePercent ?? 0;
  if (raw >= 80) return "🟢";
  if (raw >= 55) return "🟡";
  return "🔴";
}

function formatMoney(n: number | null, bucket: Direction["bucket"]): string {
  if (n == null) return "—";
  // RU — RUB в месяц, abroad/usa — EUR в год (enriched возвращает UK/EU).
  if (bucket === "ru") {
    return `${Math.round(n / 1000)}k ₽/мес`;
  }
  return `€${Math.round(n / 1000)}k/год`;
}

function formatMarketLine(d: Direction, enriched?: EnrichedDirection): string {
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
    if (enriched.trendRatio != null && enriched.trendRatio !== 0) {
      const pct = Math.round(enriched.trendRatio * 100);
      const sign = pct > 0 ? "+" : "";
      parts.push(`тренд ${sign}${pct}%`);
    }
  } else {
    parts.push("рынок: нет данных");
  }
  return parts.join(" · ");
}

function formatDirection(
  slot: DirectionSlot,
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

  // whyFits по-прежнему режем (~600 символов хватает, чтобы не упереться в
  // лимит сообщения вместе с markup/хвостом).
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

function formatHeader(state: ShortlistState, nick: string): string {
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

// ─────────────────────────────────────────────────────────────────────────────
// Keyboards
// ─────────────────────────────────────────────────────────────────────────────

function directionKeyboard(
  participantId: string,
  slotId: string,
): InlineKeyboardMarkup {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🗑 Удалить", `shortlist:del:${participantId}:${slotId}`),
      Markup.button.callback("↻ Заменить", `shortlist:regen:${participantId}:${slotId}`),
    ],
  ]).reply_markup;
}

function headerKeyboard(
  participantId: string,
  state: ShortlistState,
): InlineKeyboardMarkup {
  const canApprove = state.slots.length >= 3;
  const rows: CallbackButton[][] = [];
  rows.push([
    Markup.button.callback(
      canApprove
        ? `✓ Одобрить → глубокий анализ (${state.slots.length})`
        : `✓ Одобрить (нужно ≥ 3, сейчас ${state.slots.length})`,
      canApprove ? `shortlist:approve:${participantId}` : `shortlist:noop:${participantId}`,
    ),
  ]);
  return Markup.inlineKeyboard(rows).reply_markup;
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram helpers
// ─────────────────────────────────────────────────────────────────────────────

async function sendHeader(
  chatId: number | string,
  participantId: string,
  state: ShortlistState,
): Promise<{ chatId: number | string; messageId: number }> {
  const bot = getBot();
  const nick = normalizeNick(getPipelineState(participantId)?.telegramNick ?? "");
  const msg = await bot.telegram.sendMessage(chatId, formatHeader(state, nick), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: headerKeyboard(participantId, state),
  });
  return { chatId, messageId: msg.message_id };
}

async function editHeader(
  participantId: string,
  state: ShortlistState,
): Promise<void> {
  if (state.headerChatId == null || state.headerMessageId == null) return;
  const bot = getBot();
  const nick = normalizeNick(getPipelineState(participantId)?.telegramNick ?? "");
  try {
    await bot.telegram.editMessageText(
      state.headerChatId,
      state.headerMessageId,
      undefined,
      formatHeader(state, nick),
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: headerKeyboard(participantId, state),
      },
    );
  } catch (err) {
    console.error("[Shortlist] editHeader failed:", err);
  }
}

async function sendDirection(
  chatId: number | string,
  participantId: string,
  state: ShortlistState,
  slot: DirectionSlot,
): Promise<void> {
  const bot = getBot();
  const idx = findSlotIdx(state, slot.slotId);
  const msg = await bot.telegram.sendMessage(
    chatId,
    formatDirection(slot, idx >= 0 ? idx : 0, state.slots.length),
    {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: directionKeyboard(participantId, slot.slotId),
    },
  );
  slot.messageChatId = chatId;
  slot.messageId = msg.message_id;
}

async function deleteDirectionMessage(slot: DirectionSlot): Promise<void> {
  if (slot.messageChatId == null || slot.messageId == null) return;
  try {
    await getBot().telegram.deleteMessage(slot.messageChatId, slot.messageId);
  } catch (err) {
    console.error("[Shortlist] deleteMessage failed:", err);
  }
  slot.messageChatId = undefined;
  slot.messageId = undefined;
}

/**
 * Перерисовать все direction-сообщения (нужно чтобы нумерация "N/total"
 * не устаревала). Редактируем in-place, id сообщений не меняются.
 */
async function refreshDirectionNumbers(
  participantId: string,
  state: ShortlistState,
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
        formatDirection(slot, i, total),
        {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: directionKeyboard(participantId, slot.slotId),
        },
      );
    } catch (err) {
      // если сообщение удалено вручную — ок, просто очищаем
      console.error("[Shortlist] editDirection failed:", err);
      slot.messageChatId = undefined;
      slot.messageId = undefined;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

function isAdminCtx(ctx: Context): boolean {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (chatId == null) return false;
  try {
    const adminId = getAdminChatId();
    return String(chatId) === String(adminId);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Запуск Phase 1 (shortlist) по клику "Предварительный анализ".
 * Долгая операция — callback отвечаем сразу, запускаем в фоне.
 */
export async function startShortlist(
  participantId: string,
  ctx: Context,
): Promise<void> {
  if (!isAdminCtx(ctx)) {
    await ctx.reply("⛔ Только для админа.");
    return;
  }

  const state = getPipelineState(participantId);
  if (!state) {
    await ctx.reply("Клиент не найден.");
    return;
  }
  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const pipelineInput = outputs.pipelineInput as AnalysisPipelineInput | undefined;
  if (!pipelineInput) {
    await ctx.reply("Нет pipelineInput для клиента — не могу запустить анализ.");
    return;
  }

  const chatId = ctx.chat!.id;
  updatePipelineStage(participantId, "shortlist_generating");
  await ctx.reply("⚙️ Запускаю предварительный анализ… обычно 30–60 секунд.");

  void (async () => {
    try {
      const inputForRun: AnalysisPipelineInput = {
        ...pipelineInput,
        clientSummary: outputs.clientSummary as ClientSummary | undefined,
      };
      const result = await runShortlist(inputForRun);
      const shortlistState = fromShortlistResult(result);
      updatePipelineStage(participantId, "shortlist_ready", {
        [STORE_KEY]: shortlistState,
      });

      const header = await sendHeader(chatId, participantId, shortlistState);
      shortlistState.headerChatId = header.chatId;
      shortlistState.headerMessageId = header.messageId;

      for (const slot of shortlistState.slots) {
        await sendDirection(chatId, participantId, shortlistState, slot);
      }

      updatePipelineStage(participantId, "shortlist_ready", {
        [STORE_KEY]: shortlistState,
      });
    } catch (err) {
      console.error("[Shortlist] runShortlist failed:", err);
      updatePipelineStage(participantId, "shortlist_failed", {
        shortlistError: err instanceof Error ? err.message : String(err),
      });
      try {
        await getBot().telegram.sendMessage(
          chatId,
          `❌ Предварительный анализ упал:\n<code>${escapeHtml(
            err instanceof Error ? err.message : String(err),
          )}</code>`,
          { parse_mode: "HTML" },
        );
      } catch {
        // ignore
      }
    }
  })();
}

async function handleDelete(
  participantId: string,
  slotId: string,
  ctx: Context,
): Promise<void> {
  if (!isAdminCtx(ctx)) return;
  const shortlist = loadShortlist(participantId);
  if (!shortlist) {
    await ctx.reply("Shortlist не найден — возможно был сброшен. Запусти анализ заново.");
    return;
  }
  const idx = findSlotIdx(shortlist, slotId);
  if (idx < 0) {
    await ctx.answerCbQuery("Уже удалено.");
    return;
  }
  const [removed] = shortlist.slots.splice(idx, 1);
  saveShortlist(participantId, shortlist);
  console.log(
    `[Shortlist] ${participantId}: deleted slot=${slotId} "${removed.direction.title}" (${shortlist.slots.length} left)`,
  );
  await deleteDirectionMessage(removed);
  await refreshDirectionNumbers(participantId, shortlist);
  await editHeader(participantId, shortlist);
  saveShortlist(participantId, shortlist);
}

/**
 * Ищем в `reserve` ближайшую подходящую замену для удаляемого слота.
 *
 * Правило: пара `(roleSlug, bucket)` замены не должна совпадать ни с одним
 * уже активным слотом в `slots` (включая удаляемый — его тоже заменяем, а
 * возвращать "то же самое" бессмысленно). Reserve уже отсортирован по score
 * DESC, поэтому берём первый подходящий.
 */
function pickReserveReplacement(
  shortlist: ShortlistState,
  slotIdBeingReplaced: string,
): DirectionSlot | undefined {
  const activeKeys = new Set(
    shortlist.slots.map((s) => `${s.direction.roleSlug}|${s.direction.bucket}`),
  );
  for (let i = 0; i < shortlist.reserve.length; i += 1) {
    const candidate = shortlist.reserve[i];
    const key = `${candidate.direction.roleSlug}|${candidate.direction.bucket}`;
    if (activeKeys.has(key)) continue;
    // Забираем из reserve.
    shortlist.reserve.splice(i, 1);
    return candidate;
  }
  void slotIdBeingReplaced;
  return undefined;
}

async function handleRegen(
  participantId: string,
  slotId: string,
  ctx: Context,
): Promise<void> {
  if (!isAdminCtx(ctx)) return;
  const shortlist = loadShortlist(participantId);
  if (!shortlist) {
    await ctx.reply("Shortlist не найден — запусти анализ заново.");
    return;
  }
  const idx = findSlotIdx(shortlist, slotId);
  if (idx < 0) {
    await ctx.answerCbQuery("Слот пропал — обнови.");
    return;
  }
  if (shortlist.busy) {
    await ctx.answerCbQuery("Уже идёт регенерация, подожди…");
    return;
  }

  const removedSlot = shortlist.slots[idx];
  const chatId = ctx.chat!.id;

  // Fast path: замена лежит в reserve — мгновенно подставляем, без Claude.
  const fromReserve = pickReserveReplacement(shortlist, slotId);
  if (fromReserve) {
    try {
      await ctx.answerCbQuery(
        `↻ Заменяю «${removedSlot.direction.title}» из запаса…`,
      );
    } catch {
      // ignore
    }
    try {
      const currentIdx = findSlotIdx(shortlist, slotId);
      if (currentIdx >= 0) {
        const [rm] = shortlist.slots.splice(currentIdx, 1);
        await deleteDirectionMessage(rm);
      }
      // Сохраняем slotId свежий, чтобы callback_data была уникальной.
      const newSlot: DirectionSlot = {
        slotId: newSlotId(),
        direction: fromReserve.direction,
        enriched: fromReserve.enriched,
      };
      shortlist.slots.push(newSlot);
      await sendDirection(chatId, participantId, shortlist, newSlot);
      await refreshDirectionNumbers(participantId, shortlist);
      await editHeader(participantId, shortlist);
      saveShortlist(participantId, shortlist);
      console.log(
        `[Shortlist] ${participantId}: regen slot=${slotId} → from reserve "${newSlot.direction.title}" (reserve left: ${shortlist.reserve.length})`,
      );
    } catch (err) {
      console.error("[Shortlist] reserve regen failed:", err);
      await getBot().telegram.sendMessage(
        chatId,
        `❌ Замена из запаса упала: ${escapeHtml(
          err instanceof Error ? err.message : String(err),
        )}`,
        { parse_mode: "HTML" },
      );
    }
    return;
  }

  // Slow path: reserve пустой или все слоты overlap — вызываем Claude заново.
  shortlist.busy = true;
  saveShortlist(participantId, shortlist);

  try {
    await ctx.answerCbQuery(
      `↻ Запас пуст, генерирую замену «${removedSlot.direction.title}»… ~20 сек.`,
    );
  } catch {
    // ignore
  }

  void (async () => {
    try {
      const result = toShortlistResult(shortlist);
      const existing = shortlist.slots.map((s) => s.direction);
      const replacement = await regenerateOneDirection(result, existing);
      if (!replacement) {
        shortlist.busy = false;
        saveShortlist(participantId, shortlist);
        await getBot().telegram.sendMessage(
          chatId,
          `⚠ Не удалось подобрать замену для «${escapeHtml(
            removedSlot.direction.title,
          )}» (новый прогон дал те же slug'и). Попробуй ещё раз или удали вручную.`,
          { parse_mode: "HTML" },
        );
        return;
      }

      const currentIdx = findSlotIdx(shortlist, slotId);
      if (currentIdx >= 0) {
        const [rm] = shortlist.slots.splice(currentIdx, 1);
        await deleteDirectionMessage(rm);
      }

      const newSlot: DirectionSlot = {
        slotId: newSlotId(),
        direction: replacement.direction,
        enriched: replacement.enriched,
      };
      shortlist.slots.push(newSlot);

      await sendDirection(chatId, participantId, shortlist, newSlot);
      await refreshDirectionNumbers(participantId, shortlist);
      await editHeader(participantId, shortlist);

      shortlist.busy = false;
      saveShortlist(participantId, shortlist);
    } catch (err) {
      console.error("[Shortlist] regen failed:", err);
      shortlist.busy = false;
      saveShortlist(participantId, shortlist);
      try {
        await getBot().telegram.sendMessage(
          chatId,
          `❌ Регенерация упала: ${escapeHtml(
            err instanceof Error ? err.message : String(err),
          )}`,
          { parse_mode: "HTML" },
        );
      } catch {
        // ignore
      }
    }
  })();
}

async function handleApprove(
  participantId: string,
  ctx: Context,
): Promise<void> {
  if (!isAdminCtx(ctx)) return;
  const shortlist = loadShortlist(participantId);
  if (!shortlist) {
    await ctx.reply("Shortlist не найден — запусти анализ заново.");
    return;
  }
  if (shortlist.slots.length < 3) {
    await ctx.answerCbQuery("Нужно ≥ 3 направлений.");
    return;
  }

  const directions = shortlist.slots.map((s) => s.direction);
  updatePipelineStage(participantId, "shortlist_approved", {
    [APPROVED_KEY]: {
      directions,
      slugs: directions.map((d) => d.roleSlug),
      approvedAt: new Date().toISOString(),
    },
  });

  const slugs = directions.map((d) => d.roleSlug).join(", ");
  console.log(
    `[Shortlist] ${participantId}: approved ${directions.length} directions (${slugs})`,
  );

  await ctx.reply(
    `✅ Shortlist одобрен (${directions.length} направлений: <code>${escapeHtml(slugs)}</code>).\n\n` +
      `Глубокий анализ (Phase 2) будет запущен отдельно — этот шаг ещё в разработке.`,
    { parse_mode: "HTML" },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Диспетчер `shortlist:<action>:<pid>[:<slotId>]` callback'ов.
 * Возвращает true, если обработал.
 */
export async function dispatchShortlistCallback(
  data: string,
  ctx: Context,
): Promise<boolean> {
  const [ns, action, participantId, slotOrIdx] = data.split(":");
  if (ns !== "shortlist" || !action || !participantId) return false;

  if (action === "noop") {
    await ctx.answerCbQuery();
    return true;
  }

  switch (action) {
    case "del":
      if (!slotOrIdx) return false;
      await handleDelete(participantId, slotOrIdx, ctx);
      return true;
    case "regen":
      if (!slotOrIdx) return false;
      await handleRegen(participantId, slotOrIdx, ctx);
      return true;
    case "approve":
      await handleApprove(participantId, ctx);
      return true;
    default:
      return false;
  }
}

export function registerShortlistCallbacks(_bot: Telegraf): void {
  // No-op: реальный dispatch живёт в admin-review.ts → callback_query.
}

// Debug utility (для тестов).
export function _debugShortlistState(participantId: string): ShortlistState | undefined {
  return loadShortlist(participantId);
}

export async function _debugEnrich(
  shortlist: ShortlistState,
): Promise<EnrichedDirection[]> {
  if (!shortlist.clientSummary) return [];
  return enrichDirections(
    shortlist.slots.map((s) => s.direction),
    shortlist.clientSummary,
  );
}
