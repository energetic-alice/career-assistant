import type { Telegraf, Context } from "telegraf";
import { Markup } from "telegraf";
import type {
  CandidateProfile,
  DirectionsOutput,
  AnalysisOutput,
} from "../schemas/analysis-outputs.js";
import {
  runAnalysisPhase1,
  runAnalysisPhase4,
  type AnalysisPipelineInput,
  type Phase1Result,
} from "../pipeline/run-analysis.js";
import { createGoogleDoc } from "../services/google-docs-service.js";
import { getAdminChatId, getBot } from "./bot-instance.js";

interface PendingReview {
  participantId: string;
  phase1: Phase1Result;
  originalInput: AnalysisPipelineInput;
  awaitingFeedback: boolean;
}

const pendingReviews = new Map<string, PendingReview>();

let activeConversation: string | null = null;

export async function sendReviewToAdmin(
  participantId: string,
  phase1: Phase1Result,
  originalInput: AnalysisPipelineInput,
): Promise<void> {
  const bot = getBot();
  const chatId = getAdminChatId();

  pendingReviews.set(participantId, {
    participantId,
    phase1,
    originalInput,
    awaitingFeedback: false,
  });

  const keyboard = Markup.inlineKeyboard([
    Markup.button.callback("Утвердить", `approve:${participantId}`),
    Markup.button.callback("Правки", `edit:${participantId}`),
  ]);

  const links: string[] = [];
  if (originalInput.linkedinUrl && originalInput.linkedinUrl !== "нет") {
    const url = originalInput.linkedinUrl.startsWith("http")
      ? originalInput.linkedinUrl
      : `https://${originalInput.linkedinUrl}`;
    links.push(`<a href="${url}">LinkedIn</a>`);
  }
  if (originalInput.resumeUrl) {
    links.push(`<a href="${originalInput.resumeUrl}">Резюме</a>`);
  }
  const linksLine = links.length > 0 ? `\n${links.join(" | ")}\n` : "";

  const message = phase1.reviewSummaryText + linksLine;

  await bot.telegram.sendMessage(chatId, message, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...keyboard,
  });
}

async function handleApprove(
  participantId: string,
  ctx: Context,
): Promise<void> {
  const review = pendingReviews.get(participantId);
  if (!review) {
    await ctx.reply("Анализ не найден или уже обработан.");
    return;
  }

  await ctx.editMessageReplyMarkup(undefined);
  await ctx.reply("Собираю финальный документ...");

  try {
    const { finalDocument } = await runAnalysisPhase4(
      review.phase1.profile,
      review.phase1.directions,
      review.phase1.analysis,
    );

    const title = `Карьерный анализ: ${review.phase1.profile.name}`;
    const docUrl = await createGoogleDoc(title, finalDocument);

    pendingReviews.delete(participantId);
    activeConversation = null;

    await ctx.reply(
      `Готово! Документ создан:\n${docUrl}`,
      { link_preview_options: { is_disabled: false } },
    );
  } catch (err) {
    console.error("[Bot] Phase 4 / Google Doc error:", err);
    await ctx.reply(
      `Ошибка при создании документа: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleEdit(
  participantId: string,
  ctx: Context,
): Promise<void> {
  const review = pendingReviews.get(participantId);
  if (!review) {
    await ctx.reply("Анализ не найден или уже обработан.");
    return;
  }

  review.awaitingFeedback = true;
  activeConversation = participantId;
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.reply(
    "Напиши что изменить. Анализ будет пересчитан с учётом твоих замечаний.",
  );
}

async function handleTextFeedback(ctx: Context): Promise<void> {
  if (!activeConversation) return;
  const text = (ctx.message as { text?: string })?.text;
  if (!text) return;

  const review = pendingReviews.get(activeConversation);
  if (!review || !review.awaitingFeedback) return;

  review.awaitingFeedback = false;

  await ctx.reply("Перезапускаю анализ с учётом замечаний...");

  try {
    const newInput: AnalysisPipelineInput = {
      ...review.originalInput,
      expertFeedback: text,
    };
    const newPhase1 = await runAnalysisPhase1(newInput);
    const pid = review.participantId;

    await sendReviewToAdmin(pid, newPhase1, newInput);
  } catch (err) {
    console.error("[Bot] Redo error:", err);
    await ctx.reply(
      `Ошибка при перезапуске: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function registerAdminReview(bot: Telegraf): void {
  bot.on("callback_query", async (ctx) => {
    const data = (ctx.callbackQuery as { data?: string })?.data;
    if (!data) return;

    await ctx.answerCbQuery();

    const [action, participantId] = data.split(":");
    if (!participantId) return;

    switch (action) {
      case "approve":
        await handleApprove(participantId, ctx);
        break;
      case "edit":
        await handleEdit(participantId, ctx);
        break;
    }
  });

  bot.on("text", async (ctx) => {
    const chatId = getAdminChatId();
    if (String(ctx.chat.id) !== chatId) return;
    await handleTextFeedback(ctx);
  });
}
