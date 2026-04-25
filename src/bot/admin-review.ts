import type { Telegraf, Context } from "telegraf";
import { Markup } from "telegraf";
import { Input } from "telegraf";
import { getAdminChatId, getBot } from "./bot-instance.js";
import { getPipelineState } from "../pipeline/intake.js";
import {
  dispatchShortlistCallback,
  resendShortlist,
  startShortlist,
} from "./shortlist-review.js";
import { dispatchDeepCallback, resendDeep } from "./deep-review.js";
import {
  formatQuestionnaireForTelegram,
  formatClientCardForTelegram,
  formatResumeForTelegram,
  type ResumeDocumentVersion,
} from "../services/review-summary.js";
import type { RawQuestionnaire } from "../schemas/participant.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import { normalizeNick } from "../services/intake-mapper.js";

type InlineKeyboardMarkup = ReturnType<typeof Markup.inlineKeyboard>["reply_markup"];

/**
 * Кнопка «Предварительный анализ» всегда доступна на карточке, независимо от
 * стадии: админу полезно уметь перегенерить shortlist с нуля на любом этапе
 * (в том числе после того, как анализ уже готов или завершён).
 *
 * Кнопка «🔬 Глубокий анализ» показывается когда у клиента уже есть одобренный
 * shortlist (`shortlist_approved` и далее). Удобно перезапустить Phase 2 если
 * она упала или если бот рестартовал.
 */
const STAGES_WITH_APPROVED: ReadonlySet<string> = new Set([
  "shortlist_approved",
  "deep_generating",
  "deep_failed",
  "deep_ready",
  "deep_approved",
]);

function buildAnalyzeKeyboard(
  participantId: string,
  stage: string,
  outputs: Record<string, unknown>,
): InlineKeyboardMarkup | undefined {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];

  // Если уже есть сохранённый shortlist — приоритетная кнопка «открыть
  // существующий» (re-render из state, без перезапуска анализа).
  const shortlist = outputs.shortlist as { slots?: unknown[] } | undefined;
  const hasShortlist = !!shortlist?.slots && shortlist.slots.length > 0;
  if (hasShortlist) {
    rows.push([
      Markup.button.callback(
        "📋 Открыть shortlist",
        `show_shortlist:${participantId}`,
      ),
    ]);
  }

  rows.push([
    Markup.button.callback(
      hasShortlist
        ? "🔄 Перезапустить предварительный анализ"
        : "🔍 Предварительный анализ",
      `analyze:${participantId}`,
    ),
  ]);

  // Глубокий анализ: если уже есть готовый Phase 2 — кнопка «открыть»,
  // иначе (но shortlist одобрен) — «запустить Phase 2».
  const deep = outputs.deepReview as { slots?: unknown[] } | undefined;
  const hasDeep = !!deep?.slots && deep.slots.length > 0;
  if (hasDeep) {
    rows.push([
      Markup.button.callback(
        "🔬 Открыть глубокий анализ",
        `show_deep:${participantId}`,
      ),
    ]);
  }
  if (STAGES_WITH_APPROVED.has(stage)) {
    rows.push([
      Markup.button.callback(
        hasDeep
          ? "🔄 Перезапустить глубокий анализ (Phase 2)"
          : "🔬 Глубокий анализ (Phase 2)",
        `analyze_deep:${participantId}`,
      ),
    ]);
  }

  return Markup.inlineKeyboard(rows).reply_markup;
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
  const analysisInput = outputs.analysisInput as { resumeText?: string } | undefined;
  const pipelineInput = outputs.pipelineInput as { resumeText?: string } | undefined;
  const resumeVersions = Array.isArray(outputs.resumeVersions)
    ? (outputs.resumeVersions as ResumeDocumentVersion[])
    : undefined;
  const activeResumeVersionId = outputs.activeResumeVersionId as string | undefined;

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
    options.replyMarkup ?? buildAnalyzeKeyboard(participantId, state.stage, outputs);

  const nick = normalizeNick(state.telegramNick) || "client";
  const safeNick = nick.replace(/[^a-zA-Z0-9_\-]/g, "_");

  const htmlDoc = formatQuestionnaireForTelegram(rawQuestionnaire, rawNamedValues, {
    title: `Анкета @${nick}`,
    unmapped: unmappedFields,
  });
  const resumeHtmlDoc = formatResumeForTelegram({
    title: `Резюме @${nick}`,
    resumeText: analysisInput?.resumeText || pipelineInput?.resumeText,
    resumeVersions,
    activeResumeVersionId,
    rawNamedValues,
    clientSummary,
  });

  const buffer = Buffer.from(htmlDoc, "utf-8");
  const resumeBuffer = resumeHtmlDoc ? Buffer.from(resumeHtmlDoc, "utf-8") : null;

  // Базовый кейс (как раньше): карточка = caption прикреплённого файла, всё
  // приходит одним сообщением. Telegram режет caption на 1024 симв., поэтому
  // только если карточка ВЛЕЗАЕТ — делаем так. Для редких «жирных» карточек
  // фолбэк — два сообщения (карточка + документ с коротким caption).
  // Если есть резюме, отправляем его отдельным HTML-документом рядом с анкетой.
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
    if (resumeBuffer) {
      await bot.telegram.sendDocument(
        chatId,
        Input.fromBuffer(resumeBuffer, `Резюме_${safeNick}.html`),
        {
          caption: `Распознанное резюме @${nick}`,
          parse_mode: "HTML",
        },
      );
    }
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
  if (resumeBuffer) {
    await bot.telegram.sendDocument(
      chatId,
      Input.fromBuffer(resumeBuffer, `Резюме_${safeNick}.html`),
      {
        caption: `Распознанное резюме @${nick}`,
        parse_mode: "HTML",
      },
    );
  }
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

/**
 * Перерисовать сохранённый shortlist в чате — без перезапуска анализа.
 * Используется когда админ повторно открывает карточку: старые сообщения
 * уехали наверх / >48ч — кнопки на них не работают.
 */
async function handleShowShortlist(
  participantId: string,
  ctx: Context,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  const ok = await resendShortlist(participantId, chatId);
  if (!ok) {
    await ctx.reply(
      "Сохранённого shortlist нет — нажми «🔍 Предварительный анализ», чтобы построить.",
    );
  }
}

/** То же самое для Phase 2. */
async function handleShowDeep(
  participantId: string,
  ctx: Context,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  const ok = await resendDeep(participantId, chatId);
  if (!ok) {
    await ctx.reply(
      "Сохранённого глубокого анализа нет — запусти Phase 2 кнопкой выше.",
    );
  }
}

/**
 * Перезапуск Phase 2 поверх уже одобренного shortlist'а.
 * Используется когда Phase 2 упал, бот рестартанулся, или просто
 * понадобилось переобогатить (Perplexity TTL = 14 дней, дальше — свежий запрос).
 */
async function handleAnalyzeDeep(participantId: string, ctx: Context): Promise<void> {
  const state = getPipelineState(participantId);
  if (!state) {
    await ctx.reply("Клиент не найден.");
    return;
  }
  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const shortlist = outputs.shortlist as
    | {
        slots?: Array<{ direction: unknown; enriched?: unknown }>;
        profile?: unknown;
        clientSummary?: unknown;
        marketOverview?: unknown;
        regions?: unknown;
        scorerTop20?: unknown;
        resumeText?: string;
        questionnaireHuman?: string;
      }
    | undefined;
  const approved = outputs.approved as
    | { directions?: unknown[]; rejectedDirections?: unknown[] }
    | undefined;

  if (!shortlist?.slots || shortlist.slots.length === 0) {
    await ctx.reply("Нет shortlist'а — сначала запусти предварительный анализ.");
    return;
  }
  if (!approved?.directions || approved.directions.length === 0) {
    await ctx.reply(
      "Shortlist ещё не одобрен. Открой Phase 1 и нажми «✓ Одобрить» там.",
    );
    return;
  }

  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  await ctx.reply(`🔬 Перезапускаю глубокий анализ для @${normalizeNick(state.telegramNick)}…`);

  void (async () => {
    try {
      const { startDeepReview } = await import("./deep-review.js");
      const slots = shortlist.slots ?? [];
      // Восстанавливаем ShortlistResult из state (зеркало toShortlistResult).
      const shortlistResult = {
        profile: shortlist.profile as never,
        clientSummary: shortlist.clientSummary as never,
        marketOverview: (shortlist.marketOverview ?? "") as string,
        scorerTop20: shortlist.scorerTop20 as string | undefined,
        regions: (shortlist.regions ?? []) as never,
        directions: {
          directions: slots.map((s) => s.direction as never),
        },
        enriched: slots
          .map((s) => s.enriched as never)
          .filter((x) => !!x),
        timings: {},
        resumeText: shortlist.resumeText,
        questionnaireHuman: shortlist.questionnaireHuman,
      };
      // В Phase 2 идут все одобренные + отклонённые (как и в shortlist:approve).
      const allDirections = [
        ...(approved.directions as never[]),
        ...((approved.rejectedDirections as never[]) ?? []),
      ];
      await startDeepReview(participantId, chatId, shortlistResult as never, allDirections);
    } catch (err) {
      console.error("[admin-review] handleAnalyzeDeep failed:", err);
      await getBot().telegram.sendMessage(
        chatId,
        `❌ Глубокий анализ упал: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
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
    if (data.startsWith("deep:")) {
      const handled = await dispatchDeepCallback(data, ctx);
      if (handled) return;
    }

    const [action, participantId] = data.split(":");
    if (!participantId) return;

    switch (action) {
      case "analyze":
        await handleAnalyze(participantId, ctx);
        break;
      case "analyze_deep":
        await handleAnalyzeDeep(participantId, ctx);
        break;
      case "show_shortlist":
        await handleShowShortlist(participantId, ctx);
        break;
      case "show_deep":
        await handleShowDeep(participantId, ctx);
        break;
      default:
        break;
    }
  });
}
