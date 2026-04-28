import crypto from "node:crypto";
import type { Telegraf, Context } from "telegraf";
import { Markup } from "telegraf";

type CallbackButton = ReturnType<typeof Markup.button.callback>;
type InlineKeyboardMarkup = ReturnType<typeof Markup.inlineKeyboard>["reply_markup"];
import { getAdminChatId, getBot } from "./bot-instance.js";
import {
  getPipelineState,
  isSelectedTargetRole,
  toggleSelectedTargetRole,
  updatePipelineStage,
} from "../pipeline/intake.js";
import {
  runShortlist,
  regenerateOneDirection,
  type ShortlistResult,
  type AnalysisPipelineInput,
} from "../pipeline/run-analysis.js";
import { enrichDirections, type EnrichedDirection } from "../services/direction-enricher.js";
import { directionKey } from "../services/deep-research-service.js";
import type {
  CandidateProfile,
  Direction,
  DirectionsOutput,
  Region,
} from "../schemas/analysis-outputs.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import { normalizeNick } from "../services/intake-mapper.js";
import {
  countRecommended,
  escapeHtml,
  formatDirection,
  formatHeader,
  isRecommended,
  scoreBadge,
} from "./shortlist-format.js";
import { registerPendingReply } from "./pending-reply.js";
import { tryAcquireRunLock, releaseRunLock, RUN_KINDS } from "./run-lock.js";

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
  /** Полный текст резюме — кешируется в state для regen, чтобы не
   *  перечитывать Google Drive и промпт не терял первоисточник. */
  resumeText?: string;
  /** Человекочитаемая анкета (Q→A) — для тех же целей. */
  questionnaireHuman?: string;
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
  // Ключ — `directionKey()` (title|bucket), не `slug|bucket`. Иначе direction'ы
  // с одинаковым slug+bucket (`infosecspec|usa` × 3) схлопываются в один.
  const enrichedByKey = new Map<string, EnrichedDirection>();
  for (const row of legacyEnriched) {
    enrichedByKey.set(directionKey(row), row);
  }
  const slots: DirectionSlot[] = legacyDirections.map((d) => ({
    slotId: newSlotId(),
    direction: d,
    enriched: enrichedByKey.get(directionKey(d)),
  }));
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
  // Ключ — `directionKey()` (title|bucket), не `slug|bucket`.
  const enrichedByKey = new Map<string, EnrichedDirection>();
  for (const row of result.enriched) {
    enrichedByKey.set(directionKey(row), row);
  }
  // Directions уже отсортированы runShortlist по score DESC, но на всякий —
  // сортируем здесь ещё раз, чтобы reserve/active были устойчивы к legacy данным.
  const sorted = [...result.directions.directions].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0),
  );
  const allSlots: DirectionSlot[] = sorted.map((d) => ({
    slotId: newSlotId(),
    direction: d,
    enriched: enrichedByKey.get(directionKey(d)),
  }));
  return {
    profile: result.profile,
    clientSummary: result.clientSummary,
    marketOverview: result.marketOverview,
    scorerTop20: result.scorerTop20,
    regions: result.regions,
    slots: allSlots.slice(0, ACTIVE_SLOTS),
    reserve: allSlots.slice(ACTIVE_SLOTS),
    resumeText: result.resumeText,
    questionnaireHuman: result.questionnaireHuman,
  };
}

export function toShortlistResult(state: ShortlistState): ShortlistResult {
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
    resumeText: state.resumeText,
    questionnaireHuman: state.questionnaireHuman,
  };
}

function newSlotId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function findSlotIdx(state: ShortlistState, slotId: string): number {
  return state.slots.findIndex((s) => s.slotId === slotId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting — вынесено в `./shortlist-format` (можно импортить из скриптов).
// ─────────────────────────────────────────────────────────────────────────────

// Переиспользуем общий set функций; лишь `scoreBadge` нужен ещё в бейджах
// header'а, поэтому сразу импортирован выше.
void scoreBadge;

// ─────────────────────────────────────────────────────────────────────────────
// Keyboards
// ─────────────────────────────────────────────────────────────────────────────

function directionKeyboard(
  participantId: string,
  slot: DirectionSlot,
): InlineKeyboardMarkup {
  const slotId = slot.slotId;
  const recommended = isRecommended(slot.direction);
  const selected = isSelectedTargetRole(participantId, slot.direction, slotId);
  const rejectBtn = recommended
    ? Markup.button.callback("🚫 Отклонить", `shortlist:reject:${participantId}:${slotId}`)
    : Markup.button.callback("✅ Вернуть", `shortlist:unreject:${participantId}:${slotId}`);
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🗑 Удалить", `shortlist:del:${participantId}:${slotId}`),
      rejectBtn,
      Markup.button.callback("↻ Заменить", `shortlist:regen:${participantId}:${slotId}`),
    ],
    [
      Markup.button.callback(
        selected ? "🎯 Убрать из упаковки" : "🎯 Выбрать для упаковки",
        `shortlist:target:${participantId}:${slotId}`,
      ),
    ],
  ]).reply_markup;
}

function headerKeyboard(
  participantId: string,
  state: ShortlistState,
): InlineKeyboardMarkup {
  const recommended = countRecommended(state.slots);
  const canApprove = recommended >= 3;
  const rows: CallbackButton[][] = [];
  rows.push([
    Markup.button.callback(
      canApprove
        ? `✓ Одобрить → глубокий анализ (${recommended})`
        : `✓ Одобрить (нужно ≥ 3 рекоменд., сейчас ${recommended})`,
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
      reply_markup: directionKeyboard(participantId, slot),
    },
  );
  slot.messageChatId = chatId;
  slot.messageId = msg.message_id;
}

async function deleteDirectionMessage(slot: DirectionSlot): Promise<void> {
  if (slot.messageChatId == null || slot.messageId == null) return;
  const bot = getBot();
  const chatId = slot.messageChatId;
  const messageId = slot.messageId;
  try {
    await bot.telegram.deleteMessage(chatId, messageId);
  } catch (err) {
    // Telegram bots не могут удалять сообщения старше 48ч (или иногда удаление
    // запрещено настройками чата). В этом случае помечаем карточку как удалённую
    // через editMessageText + снимаем клавиатуру — иначе админу кажется что
    // «кнопка не работает» (стейт обновлён, но сообщение в чате осталось).
    console.warn("[Shortlist] deleteMessage failed, fallback to edit:", err);
    try {
      await bot.telegram.editMessageText(
        chatId,
        messageId,
        undefined,
        "🗑 <i>Удалено куратором.</i>",
        { parse_mode: "HTML" },
      );
    } catch (editErr) {
      console.error("[Shortlist] edit-fallback also failed:", editErr);
    }
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
          reply_markup: directionKeyboard(participantId, slot),
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
 * Перерисовать сохранённый shortlist в чате (без перезапуска анализа).
 * Используется когда админ повторно открывает карточку клиента после рестарта
 * бота / навигации по чату — старые сообщения уехали наверх или Telegram
 * больше не даёт их редактировать (>48 ч). Шлём свежий header + по сообщению
 * на каждый активный слот; обновляем `messageChatId/messageId` чтобы кнопки
 * delete/reject снова попадали по живым карточкам.
 *
 * Возвращает true если что-то отрисовали, false если нет сохранённого стейта.
 */
export async function resendShortlist(
  participantId: string,
  chatId: number | string,
): Promise<boolean> {
  const shortlist = loadShortlist(participantId);
  if (!shortlist || shortlist.slots.length === 0) return false;

  const header = await sendHeader(chatId, participantId, shortlist);
  shortlist.headerChatId = header.chatId;
  shortlist.headerMessageId = header.messageId;

  for (const slot of shortlist.slots) {
    // sendDirection обновляет slot.messageChatId/messageId по месту
    await sendDirection(chatId, participantId, shortlist, slot);
  }

  saveShortlist(participantId, shortlist);
  return true;
}

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

  // U3: anti-double-click lock. Если уже идёт shortlist для этого
  // participantId — отвечаем reply'ем и не стартуем второй параллельный
  // прогон (он бы перезаписал stageOutputs.shortlist в гонке).
  if (!tryAcquireRunLock(participantId, "shortlist")) {
    await ctx.reply(
      `⏳ ${RUN_KINDS.shortlist} уже идёт для этого клиента. Подожди завершения и попробуй снова, если нужно перезапустить.`,
    );
    return;
  }

  updatePipelineStage(participantId, "shortlist_generating");
  await ctx.reply("⚙️ Запускаю предварительный анализ… обычно 30–60 секунд.");

  void (async () => {
    try {
      // Если outputs.clientSummary нет — не затираем тот, что лежит в
      // pipelineInput (иначе enrichDirections уйдёт без clientSummary и вернёт
      // пусто → «рынок: нет данных» в UI).
      const fallbackSummary = pipelineInput.clientSummary;
      // rawNamedValues хранится на уровне outputs (не в pipelineInput),
      // потому что он поступает в intake раньше чем мы собираем pipelineInput.
      // Для старых клиентов в pipelineInput поля нет — забираем из outputs.
      const fallbackRawNamedValues = outputs.rawNamedValues as
        | Record<string, string>
        | undefined;
      const inputForRun: AnalysisPipelineInput = {
        ...pipelineInput,
        clientSummary:
          (outputs.clientSummary as ClientSummary | undefined) ?? fallbackSummary,
        rawNamedValues: pipelineInput.rawNamedValues ?? fallbackRawNamedValues,
      };
      if (!inputForRun.clientSummary) {
        console.warn(
          `[Shortlist] ${participantId}: clientSummary отсутствует и в outputs, и в pipelineInput — enrichment будет пустым`,
        );
      }
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
    } finally {
      releaseRunLock(participantId, "shortlist");
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
  try {
    await ctx.answerCbQuery("🗑 Удалено.");
  } catch {
    // already answered by upstream dispatcher — ok
  }
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
  const recommendedSlots = shortlist.slots.filter((s) => isRecommended(s.direction));
  const rejectedSlots = shortlist.slots.filter((s) => !isRecommended(s.direction));
  if (recommendedSlots.length < 3) {
    await ctx.answerCbQuery("Нужно ≥ 3 рекомендуемых (не 🚫).");
    return;
  }

  const recommendedDirections = recommendedSlots.map((s) => s.direction);
  const rejectedDirections = rejectedSlots.map((s) => s.direction);
  updatePipelineStage(participantId, "shortlist_approved", {
    [APPROVED_KEY]: {
      directions: recommendedDirections,
      slugs: recommendedDirections.map((d) => d.roleSlug),
      rejectedDirections,
      rejectedSlugs: rejectedDirections.map((d) => d.roleSlug),
      approvedAt: new Date().toISOString(),
    },
  });

  const slugs = recommendedDirections.map((d) => d.roleSlug).join(", ");
  const rejSlugs = rejectedDirections.map((d) => d.roleSlug).join(", ");
  console.log(
    `[Shortlist] ${participantId}: approved ${recommendedDirections.length} (${slugs})` +
      (rejectedDirections.length > 0 ? ` · rejected ${rejectedDirections.length} (${rejSlugs})` : ""),
  );

  await ctx.answerCbQuery("Запускаю глубокий анализ…");
  const ackMsg = await ctx.reply(
    `✅ Shortlist одобрен.\n` +
      `Рекомендованы (${recommendedDirections.length}): <code>${escapeHtml(slugs)}</code>` +
      (rejectedDirections.length > 0
        ? `\n🚫 Отклонено (${rejectedDirections.length}): <code>${escapeHtml(rejSlugs)}</code>`
        : "") +
      `\n\n🔬 Запускаю Phase 2 (дозаполнение данных по дырам)…`,
    { parse_mode: "HTML" },
  );

  try {
    const { startDeepReview } = await import("./deep-review.js");
    const chatId = ctx.chat?.id;
    if (chatId == null) throw new Error("ctx.chat.id missing");
    // В Phase 2 передаём ВСЕ slots (включая rejected) — они нужны для UI и
    // финального документа; сам enrichment пропустит rejected, не дёргая Perplexity.
    const allDirections = shortlist.slots.map((s) => s.direction);
    await startDeepReview(participantId, chatId, toShortlistResult(shortlist), allDirections);
    // Удаляем "запускаю..." после того как deep-review нарисовал свои сообщения
    try {
      await getBot().telegram.deleteMessage(chatId, ackMsg.message_id);
    } catch {
      // ignore
    }
  } catch (err) {
    console.error(`[Shortlist] handleApprove → deepReview failed:`, err);
    updatePipelineStage(participantId, "deep_failed", {
      deepError: err instanceof Error ? err.message : String(err),
    });
    await ctx.reply(
      `❌ Глубокий анализ упал: <code>${escapeHtml(String(err))}</code>`,
      { parse_mode: "HTML" },
    );
  }
}

/**
 * 🚫 Reject: помечаем direction как `recommended=false` и просим у админа
 * причину через ForceReply. Сама причина приходит позже в `applyRejectReason`
 * (см. text-handler в telegram-bot.ts → onShortlistRejectReply).
 */
async function handleReject(
  participantId: string,
  slotId: string,
  ctx: Context,
): Promise<void> {
  if (!isAdminCtx(ctx)) return;
  const shortlist = loadShortlist(participantId);
  if (!shortlist) {
    await ctx.answerCbQuery("Shortlist не найден.");
    return;
  }
  const idx = findSlotIdx(shortlist, slotId);
  if (idx < 0) {
    await ctx.answerCbQuery("Слот пропал.");
    return;
  }
  const slot = shortlist.slots[idx];
  slot.direction.recommended = false;
  if (!slot.direction.rejectionReason?.trim()) {
    slot.direction.rejectionReason = "Отклонено куратором при ревью.";
  }
  saveShortlist(participantId, shortlist);

  await refreshDirectionNumbers(participantId, shortlist);
  await editHeader(participantId, shortlist);

  const chatId = ctx.chat?.id;
  if (chatId != null) {
    const promptMsg = await getBot().telegram.sendMessage(
      chatId,
      `✏️ Причина отклонения «${escapeHtml(slot.direction.title)}»?\n` +
        `Ответь на это сообщение коротким текстом (1–2 предложения). Если нужна дефолтная — напиши «-» или просто пропусти.`,
      {
        parse_mode: "HTML",
        reply_markup: { force_reply: true, selective: true },
      },
    );
    registerPendingReply(chatId, promptMsg.message_id, {
      kind: "shortlist:reject",
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
  const shortlist = loadShortlist(participantId);
  if (!shortlist) {
    await ctx.answerCbQuery("Shortlist не найден.");
    return;
  }
  const idx = findSlotIdx(shortlist, slotId);
  if (idx < 0) {
    await ctx.answerCbQuery("Слот пропал.");
    return;
  }
  const slot = shortlist.slots[idx];
  slot.direction.recommended = true;
  slot.direction.rejectionReason = undefined;
  saveShortlist(participantId, shortlist);
  await refreshDirectionNumbers(participantId, shortlist);
  await editHeader(participantId, shortlist);
  await ctx.answerCbQuery("✅ Возвращено в рекомендуемые.");
}

async function handleTarget(
  participantId: string,
  slotId: string,
  ctx: Context,
): Promise<void> {
  if (!isAdminCtx(ctx)) return;
  const shortlist = loadShortlist(participantId);
  if (!shortlist) {
    await ctx.answerCbQuery("Shortlist не найден.");
    return;
  }
  const idx = findSlotIdx(shortlist, slotId);
  if (idx < 0) {
    await ctx.answerCbQuery("Слот пропал.");
    return;
  }
  const slot = shortlist.slots[idx];
  let result: ReturnType<typeof toggleSelectedTargetRole>;
  try {
    result = toggleSelectedTargetRole(participantId, slot.direction, "shortlist", slot.slotId);
  } catch (err) {
    await ctx.answerCbQuery("Нельзя выбрать slug без marketEvidence.");
    await ctx.reply(
      `Не могу выбрать <code>${escapeHtml(slot.direction.roleSlug)}</code>: ${
        err instanceof Error ? escapeHtml(err.message) : "некорректный slug"
      }`,
      { parse_mode: "HTML" },
    );
    return;
  }
  if (!result) {
    await ctx.answerCbQuery("Клиент не найден.");
    return;
  }
  await refreshDirectionNumbers(participantId, shortlist);
  await ctx.answerCbQuery(
    result.selected
      ? `Добавлено в упаковку: ${slot.direction.roleSlug}`
      : `Убрано из упаковки: ${slot.direction.roleSlug}`,
  );
  await ctx.reply(
    `${result.selected ? "🎯 Выбрано" : "Убрано"} для упаковки: <b>${escapeHtml(slot.direction.title)}</b>\n` +
      `Всего выбранных направлений: <b>${result.roles.length}</b>.\n` +
      `Открой /client_${normalizeNick(getPipelineState(participantId)?.telegramNick ?? "")}, чтобы увидеть это в карточке.`,
    { parse_mode: "HTML" },
  );
}

/**
 * Применить введённую админом причину reject (из text-handler).
 * Возвращает true если что-то изменилось.
 */
export async function applyShortlistRejectReason(
  participantId: string,
  slotId: string,
  reason: string,
): Promise<boolean> {
  const shortlist = loadShortlist(participantId);
  if (!shortlist) return false;
  const idx = findSlotIdx(shortlist, slotId);
  if (idx < 0) return false;
  const slot = shortlist.slots[idx];
  const cleaned = reason.trim();
  // "-" или пустая строка → оставляем дефолтную причину.
  if (cleaned && cleaned !== "-") {
    slot.direction.rejectionReason = cleaned.slice(0, 400);
  }
  slot.direction.recommended = false;
  saveShortlist(participantId, shortlist);
  await refreshDirectionNumbers(participantId, shortlist);
  await editHeader(participantId, shortlist);
  return true;
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
    case "reject":
      if (!slotOrIdx) return false;
      await handleReject(participantId, slotOrIdx, ctx);
      return true;
    case "unreject":
      if (!slotOrIdx) return false;
      await handleUnreject(participantId, slotOrIdx, ctx);
      return true;
    case "target":
      if (!slotOrIdx) return false;
      await handleTarget(participantId, slotOrIdx, ctx);
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
/**
 * Public read-only accessor for shortlist state (for code outside this file).
 * Returns undefined if shortlist hasn't been generated for the participant.
 */
export function getShortlistState(
  participantId: string,
): ShortlistState | undefined {
  return loadShortlist(participantId);
}

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
