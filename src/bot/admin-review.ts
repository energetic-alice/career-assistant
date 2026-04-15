import type { Telegraf, Context } from "telegraf";
import { Markup } from "telegraf";
import { Input } from "telegraf";
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
import { marked } from "marked";
import { getPipelineState, updatePipelineStage } from "../pipeline/intake.js";
import { saveMap, loadMap, saveDocument } from "../services/state-store.js";

type ReviewStatus = "pending" | "awaiting_feedback" | "approved" | "completed";

interface PendingReview {
  participantId: string;
  phase1: Phase1Result;
  originalInput: AnalysisPipelineInput;
  awaitingFeedback: boolean;
  status: ReviewStatus;
  approvedAt?: string;
  completedAt?: string;
  docUrl?: string;
  docError?: string;
}

const STORE_NAME = "pendingReviews";
const pendingReviews: Map<string, PendingReview> = loadMap<PendingReview>(STORE_NAME);

console.log(`[Bot] Loaded ${pendingReviews.size} pending reviews from disk`);

function persistPendingReviews(): void {
  saveMap(STORE_NAME, pendingReviews);
}

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
    status: "pending",
  });
  persistPendingReviews();

  const keyboard = Markup.inlineKeyboard([
    Markup.button.callback("Утвердить", `approve:${participantId}`),
    Markup.button.callback("Правки", `edit:${participantId}`),
  ]);

  const links: string[] = [];
  const tgNick = phase1.profile.telegramNick;
  if (tgNick) {
    const username = tgNick.replace(/^@/, "");
    links.push(`<a href="https://t.me/${username}">Telegram</a>`);
  }
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

function recoverReview(participantId: string): PendingReview | null {
  const state = getPipelineState(participantId);
  if (!state) return null;
  if (state.stage === "completed") return null;
  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const phase1 = outputs.phase1Result as Phase1Result | undefined;
  if (!phase1) return null;
  const originalInput = outputs.pipelineInput as AnalysisPipelineInput | undefined;
  if (!originalInput) {
    const analysisInput = outputs.analysisInput as Record<string, unknown> | undefined;
    if (!analysisInput) return null;
    return {
      participantId,
      phase1,
      originalInput: {
        questionnaire: JSON.stringify(analysisInput, null, 2),
        resumeText: (analysisInput.resumeText as string) || "",
        linkedinUrl: (analysisInput.linkedinUrl as string) || "",
        linkedinSSI: (analysisInput.linkedinSSI as string) || "",
      },
      awaitingFeedback: false,
      status: "pending",
    };
  }
  return { participantId, phase1, originalInput, awaitingFeedback: false, status: "pending" };
}

async function handleApprove(
  participantId: string,
  ctx: Context,
): Promise<void> {
  let review = pendingReviews.get(participantId);
  if (!review) {
    review = recoverReview(participantId) ?? undefined;
    if (review) {
      pendingReviews.set(participantId, review);
      console.log(`[Bot] Recovered review for ${participantId} from pipelineStates`);
    }
  }
  if (!review) {
    await ctx.reply("Анализ не найден или уже обработан.");
    return;
  }

  await ctx.reply("Собираю финальный документ...");

  try {
    updatePipelineStage(participantId, "admin_reviewed");

    const { finalDocument } = await runAnalysisPhase4(
      review.phase1.profile,
      review.phase1.directions,
      review.phase1.analysis,
    );

    const title = `Карьерный анализ: ${review.phase1.profile.name}`;
    const safeTitle = title.replace(/[^a-zA-Zа-яА-ЯёЁ0-9_\- ]/g, "_");

    const htmlBody = await marked(finalDocument);
    const htmlFile = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6}
h1,h2,h3{margin-top:1.5em}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:8px;text-align:left}</style>
</head><body>${htmlBody}</body></html>`;

    saveDocument(participantId, `${safeTitle}.html`, htmlFile);
    saveDocument(participantId, `${safeTitle}.md`, finalDocument);

    const fileBuffer = Buffer.from(htmlFile, "utf-8");
    await ctx.replyWithDocument(
      Input.fromBuffer(fileBuffer, `${safeTitle}.html`),
      { caption: "Финальный анализ (HTML). Можно открыть в браузере." },
    );

    review.status = "approved";
    review.approvedAt = new Date().toISOString();
    persistPendingReviews();

    let docUrl: string | null = null;
    let docError: string | null = null;
    try {
      docUrl = await createGoogleDoc(title, finalDocument);
    } catch (docErr) {
      docError = docErr instanceof Error ? docErr.message : String(docErr);
      console.warn("[Bot] Google Doc creation failed:", docError);
    }

    review.status = "completed";
    review.completedAt = new Date().toISOString();
    review.awaitingFeedback = false;
    if (docUrl) review.docUrl = docUrl;
    if (docError) review.docError = docError;
    persistPendingReviews();
    activeConversation = null;

    updatePipelineStage(participantId, "completed", {
      finalDocumentMd: finalDocument,
      docUrl: docUrl ?? undefined,
      docError: docError ?? undefined,
      completedAt: review.completedAt,
    });

    await ctx.editMessageReplyMarkup(undefined);

    if (docUrl) {
      await ctx.reply(`Google Doc: ${docUrl}`, {
        link_preview_options: { is_disabled: false },
      });
    } else {
      const method = process.env.APPS_SCRIPT_DOC_URL ? "Apps Script" : "Drive API";
      await ctx.reply(
        `Google Doc не удалось создать (${method}): ${docError}\nHTML-файл выше содержит полный анализ.`,
      );
    }
  } catch (err) {
    console.error("[Bot] Phase 4 error:", err);
    await ctx.reply(
      `Ошибка при создании документа: ${err instanceof Error ? err.message : String(err)}\n\nНажми «Утвердить» ещё раз, чтобы повторить.`,
    );
  }
}

async function handleEdit(
  participantId: string,
  ctx: Context,
): Promise<void> {
  let review = pendingReviews.get(participantId);
  if (!review) {
    review = recoverReview(participantId) ?? undefined;
    if (review) {
      pendingReviews.set(participantId, review);
      console.log(`[Bot] Recovered review for ${participantId} from pipelineStates (edit)`);
    }
  }
  if (!review) {
    await ctx.reply("Анализ не найден или уже обработан.");
    return;
  }

  review.awaitingFeedback = true;
  persistPendingReviews();
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
  persistPendingReviews();

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
