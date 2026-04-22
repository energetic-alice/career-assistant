import type { Telegraf, Context } from "telegraf";
import { Markup } from "telegraf";
import { Input } from "telegraf";
import { getAdminChatId, getBot } from "./bot-instance.js";
import { getPipelineState } from "../pipeline/intake.js";
import { dispatchShortlistCallback, startShortlist } from "./shortlist-review.js";
import {
  formatQuestionnaireForTelegram,
  formatClientCardForTelegram,
} from "../services/review-summary.js";
import type { RawQuestionnaire } from "../schemas/participant.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import { normalizeNick } from "../services/intake-mapper.js";

type InlineKeyboardMarkup = ReturnType<typeof Markup.inlineKeyboard>["reply_markup"];

/**
 * Кнопка «Предварительный анализ» всегда доступна на карточке, независимо от
 * стадии: админу полезно уметь перегенерить shortlist с нуля на любом этапе
 * (в том числе после того, как анализ уже готов или завершён).
 */
function buildAnalyzeKeyboard(
  participantId: string,
  _stage: string,
): InlineKeyboardMarkup | undefined {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔍 Предварительный анализ", `analyze:${participantId}`)],
  ]).reply_markup;
}

/**
 * Reusable: send the client card together with the questionnaire as an .html
 * attachment (caption = the card itself in HTML).
 * Used both as intake notification and as response to /client <nick>.
 *
 * Если `options.replyMarkup` не передан, функция сама подставляет кнопку
 * "🔍 Предварительный анализ" для подходящих стадий — чтобы карточка,
 * открытая через /client, была интерактивной точно так же, как intake-карточка.
 */
export async function sendClientCard(
  chatId: string | number,
  participantId: string,
  options: {
    profileName?: string;
    /** Inline keyboard to attach to the document (e.g. "Предварительный анализ"). */
    replyMarkup?: InlineKeyboardMarkup;
  } = {},
): Promise<void> {
  const bot = getBot();
  const state = getPipelineState(participantId);
  if (!state) {
    await bot.telegram.sendMessage(chatId, "Клиент не найден.");
    return;
  }
  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const rawQuestionnaire = outputs.rawQuestionnaire as RawQuestionnaire | undefined;
  const rawNamedValues = outputs.rawNamedValues as Record<string, string> | undefined;
  const unmappedFields = (outputs.unmappedFields as string[] | undefined) ?? [];
  const clientSummary = outputs.clientSummary as ClientSummary | undefined;
  const legacyDocUrl = outputs.legacyDocUrl as string | undefined;
  const legacyTariff = outputs.legacyTariff as string | undefined;

  const cardHtml = formatClientCardForTelegram({
    telegramNick: state.telegramNick,
    stage: state.stage,
    clientSummary,
    profileName: options.profileName,
    rawQuestionnaire,
    rawNamedValues,
    legacyDocUrl,
    legacyTariff,
  });

  const replyMarkup =
    options.replyMarkup ?? buildAnalyzeKeyboard(participantId, state.stage);

  const nick = normalizeNick(state.telegramNick) || "client";
  const safeNick = nick.replace(/[^a-zA-Z0-9_\-]/g, "_");

  const htmlDoc = formatQuestionnaireForTelegram(rawQuestionnaire, rawNamedValues, {
    title: `Анкета @${nick}`,
    unmapped: unmappedFields,
  });

  const buffer = Buffer.from(htmlDoc, "utf-8");

  // Базовый кейс (как раньше): карточка = caption прикреплённого файла, всё
  // приходит одним сообщением. Telegram режет caption на 1024 симв., поэтому
  // только если карточка ВЛЕЗАЕТ — делаем так. Для редких «жирных» карточек
  // фолбэк — два сообщения (карточка + документ с коротким caption).
  const CAPTION_LIMIT = 1024;
  if (cardHtml.length <= CAPTION_LIMIT) {
    await bot.telegram.sendDocument(
      chatId,
      Input.fromBuffer(buffer, `Анкета_${safeNick}.html`),
      {
        caption: cardHtml,
        parse_mode: "HTML",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      },
    );
    return;
  }

  await bot.telegram.sendMessage(chatId, cardHtml, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  await bot.telegram.sendDocument(
    chatId,
    Input.fromBuffer(buffer, `Анкета_${safeNick}.html`),
    {
      caption: `Анкета @${nick}`,
      parse_mode: "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    },
  );
}

/**
 * Called from intake right after Phase 0 (client summary) is ready.
 * Sends:
 *   1. brief "🆕 New form filled @nick" message
 *   2. client card (with questionnaire attached) + button "Предварительный анализ"
 *
 * Heavy analysis (Phase 1/4) is currently DISABLED — см. TODO(phase1a) ниже.
 */
export async function sendIntakeNotification(participantId: string): Promise<void> {
  const bot = getBot();
  const chatId = getAdminChatId();
  const state = getPipelineState(participantId);
  if (!state) return;

  const nick = normalizeNick(state.telegramNick) || "client";

  await bot.telegram.sendMessage(
    chatId,
    `🆕 Новая анкета заполнена: <a href="https://t.me/${nick}">@${nick}</a>`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );

  // Кнопку "Предварительный анализ" подставит sendClientCard автоматически
  // на основании state.stage (см. buildAnalyzeKeyboard).
  await sendClientCard(chatId, participantId);
}

/**
 * Диспетчер callback_query для всего админ-бота.
 *
 * Поддерживаемые префиксы:
 *   - `analyze:<pid>`                     → запуск Phase 1 shortlist
 *   - `shortlist:<action>:<pid>[:<idx>]`  → управление shortlist'ом
 *     (см. `shortlist-review.ts`)
 */
async function handleAnalyze(participantId: string, ctx: Context): Promise<void> {
  await startShortlist(participantId, ctx);
}

export function registerAdminReview(bot: Telegraf): void {
  bot.on("callback_query", async (ctx) => {
    const data = (ctx.callbackQuery as { data?: string })?.data;
    if (!data) return;

    await ctx.answerCbQuery();

    if (data.startsWith("shortlist:")) {
      const handled = await dispatchShortlistCallback(data, ctx);
      if (handled) return;
    }

    const [action, participantId] = data.split(":");
    if (!participantId) return;

    switch (action) {
      case "analyze":
        await handleAnalyze(participantId, ctx);
        break;
      default:
        break;
    }
  });
}
