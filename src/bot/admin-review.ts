import type { Telegraf, Context } from "telegraf";
import { Markup } from "telegraf";
import { Input } from "telegraf";
import { getAdminChatId, getBot } from "./bot-instance.js";
import { getPipelineState } from "../pipeline/intake.js";
import {
  formatQuestionnaireForTelegram,
  formatClientCardForTelegram,
} from "../services/review-summary.js";
import type { RawQuestionnaire } from "../schemas/participant.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import { normalizeNick } from "../services/intake-mapper.js";

type InlineKeyboardMarkup = ReturnType<typeof Markup.inlineKeyboard>["reply_markup"];

/**
 * Reusable: send the client card together with the questionnaire as an .html
 * attachment (caption = the card itself in HTML).
 * Used both as intake notification and as response to /client <nick>.
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

  const nick = normalizeNick(state.telegramNick) || "client";
  const safeNick = nick.replace(/[^a-zA-Z0-9_\-]/g, "_");

  const htmlDoc = formatQuestionnaireForTelegram(rawQuestionnaire, rawNamedValues, {
    title: `Анкета @${nick}`,
    unmapped: unmappedFields,
  });

  const buffer = Buffer.from(htmlDoc, "utf-8");
  await bot.telegram.sendDocument(
    chatId,
    Input.fromBuffer(buffer, `Анкета_${safeNick}.html`),
    {
      caption: cardHtml,
      parse_mode: "HTML",
      ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
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

  const keyboard =
    state.stage === "completed_legacy"
      ? undefined
      : Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🔍 Предварительный анализ",
              `analyze:${participantId}`,
            ),
          ],
        ]);

  await sendClientCard(chatId, participantId, {
    replyMarkup: keyboard?.reply_markup,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO(phase1a): re-enable Phase 1 (directions + market) and Phase 4 (final doc)
// after the interactive Phase 1A/1B flow is shipped. For now the "Предварительный
// анализ" button answers with a stub, and the old approve/edit/redo review
// sub-flow is disabled so we don't break on a changed schema.
// ─────────────────────────────────────────────────────────────────────────────

async function handleAnalyze(_participantId: string, ctx: Context): Promise<void> {
  await ctx.reply(
    "🚧 Предварительный анализ временно отключён — собираем обновлённый flow. " +
      "Клиент в списке, анкета сохранена.",
  );
}

export function registerAdminReview(bot: Telegraf): void {
  bot.on("callback_query", async (ctx) => {
    const data = (ctx.callbackQuery as { data?: string })?.data;
    if (!data) return;

    await ctx.answerCbQuery();

    const [action, participantId] = data.split(":");
    if (!participantId) return;

    switch (action) {
      case "analyze":
        await handleAnalyze(participantId, ctx);
        break;
      default:
        // TODO(phase1a): wire up approve/edit/redo/phase1a_* callbacks
        break;
    }
  });

  // TODO(phase1a): re-enable text feedback handler when the review flow is back.
  // bot.on("text", async (ctx) => { ... });
}
