import type { Telegraf, Context } from "telegraf";
import { Markup } from "telegraf";
import { Input } from "telegraf";
import { getAdminChatId, getBot } from "./bot-instance.js";
import {
  getPipelineState,
  persistPipelineStatesPublic,
  updatePipelineStage,
} from "../pipeline/intake.js";
import { PROGRAM_LABELS, type ProgramLabel } from "../schemas/pipeline-state.js";
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
import {
  tryAcquireRunLock,
  releaseRunLock,
  RUN_KINDS,
} from "./run-lock.js";

type InlineKeyboardMarkup = ReturnType<typeof Markup.inlineKeyboard>["reply_markup"];

/**
 * Сохранённая ссылка на карточку клиента в чате админа — нужна, чтобы
 * после смены stage перерисовать caption и кнопки на месте, а не плодить
 * новые сообщения.
 *
 * - mode = "caption": одно сообщение sendDocument с captionом-карточкой и
 *   кнопками. Редактируем caption + reply_markup на нём.
 * - mode = "separate": карточка не влезла в caption (>1024 символов), ушло
 *   2 сообщения: текст карточки + sendDocument с короткой подписью и
 *   кнопками. Редактируем text-message и reply_markup на document'е.
 */
interface ClientCardRef {
  chatId: number | string;
  /** message_id того сообщения, к которому прикреплены reply_markup кнопки. */
  documentMessageId: number;
  mode: "caption" | "separate";
  /** Только для mode="separate": message_id отдельного текстового сообщения с карточкой. */
  textMessageId?: number;
  savedAt: string;
}

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
  type CallbackBtn = ReturnType<typeof Markup.button.callback>;
  type UrlBtn = ReturnType<typeof Markup.button.url>;
  const rows: Array<Array<CallbackBtn | UrlBtn>> = [];

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

  // Финальный анализ: на стадиях final_ready / final_sent / final_failed /
  // final_generating / deep_approved дать прямой доступ к "перегенерировать
  // финал", "переслать HTML" и "отметить отправленным клиенту" прямо из
  // карточки, не заставляя открывать deep-обзор.
  const finalAnalysis = outputs.finalAnalysis as
    | { docUrl?: string; markdown?: string; generatedAt?: string }
    | undefined;
  const hasFinalMarkdown = !!finalAnalysis?.markdown;
  const isFinalStage =
    stage === "final_ready" ||
    stage === "final_sent" ||
    stage === "final_failed" ||
    stage === "final_generating" ||
    stage === "deep_approved";

  if (isFinalStage) {
    if (stage === "final_generating") {
      rows.push([
        Markup.button.callback("⚙️ Финальный анализ собирается…", `deep:noop:${participantId}`),
      ]);
    } else {
      const label =
        stage === "final_ready" || stage === "final_sent"
          ? "🔁 Перегенерировать финальный анализ"
          : stage === "final_failed"
            ? "🔁 Повторить финальный анализ"
            : "📄 Сгенерировать финальный анализ";
      rows.push([Markup.button.callback(label, `deep:final:${participantId}`)]);
    }
    if (hasFinalMarkdown) {
      rows.push([
        Markup.button.callback("📝 Прислать HTML с анализом", `deep:html:${participantId}`),
      ]);
    }
    if (finalAnalysis?.docUrl) {
      rows.push([Markup.button.url("📄 Открыть Google Doc", finalAnalysis.docUrl)]);
    }
    // Маркер "отправлено клиенту" - ручное действие куратора, необратимое.
    // После sent кнопка убирается; если анализ надо перегенерировать, куратор
    // всё равно может нажать "🔁 Перегенерировать" из той же карточки.
    if (stage === "final_ready") {
      rows.push([
        Markup.button.callback(
          "✅ Отметить как отправлен клиенту",
          `deep:mark_sent:${participantId}`,
        ),
      ]);
    }
  }

  // Выбор направления для упаковки: одна кнопка → подменю с top-N + "Своё".
  // Клики по направлениям идут в существующий `deep:target:<slotId>`.
  // Показываем ТОЛЬКО когда финал реально готов (markdown существует),
  // а не просто "стадия финальная" - на generating/failed/deep_approved
  // упаковывать нечего.
  const hasFinalTop3 =
    Array.isArray((finalAnalysis as { top3Titles?: unknown })?.top3Titles) &&
    ((finalAnalysis as { top3Titles?: unknown }).top3Titles as unknown[])
      .some((t) => typeof t === "string" && t.length > 0);
  const finalReady = hasFinalMarkdown && (stage === "final_ready" || stage === "final_sent");
  if (finalReady && hasFinalTop3 && deep?.slots && deep.slots.length > 0) {
    rows.push([
      Markup.button.callback(
        "🎯 Выбрать направление для упаковки",
        `prog:target_menu:${participantId}`,
      ),
    ]);
  }

  // Программа: 4 маленькие кнопки в ряду, у активной стоит галочка.
  // Всегда видимый ряд, чтобы куратор мог как назначить, так и поменять
  // метку на любом этапе (кроме intake, где карточка минимальная).
  const currentProgram = outputs.program as string | undefined;
  const programRow = PROGRAM_LABELS.map((label) =>
    Markup.button.callback(
      currentProgram === label ? `✅ ${label}` : label,
      `prog:set:${participantId}:${label}`,
    ),
  );
  rows.push(programRow);

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
  const selectedTargetRoles =
    clientSummary?.selectedTargetRoles ??
    (Array.isArray(outputs.selectedTargetRoles)
      ? (outputs.selectedTargetRoles as Parameters<typeof formatClientCardForTelegram>[0]["selectedTargetRoles"])
      : undefined);

  const clientNotes = (await import("../pipeline/client-notes.js")).listClientNotes(
    participantId,
  );

  const finalAnalysis = outputs.finalAnalysis as
    | { docUrl?: string; docError?: string; generatedAt?: string }
    | undefined;
  const finalAnalysisError = outputs.finalAnalysisError as string | undefined;
  // Для карточки: при final_failed → ошибка Phase 3/4, при final_ready/final_sent
  // без doc → ошибка createGoogleDoc (квоты Drive и т.п.).
  const cardAnalysisError =
    state.stage === "final_failed"
      ? finalAnalysisError
      : (state.stage === "final_ready" || state.stage === "final_sent") &&
          !finalAnalysis?.docUrl
        ? finalAnalysis?.docError
        : undefined;

  const cardHtml = formatClientCardForTelegram({
    telegramNick: state.telegramNick,
    stage: state.stage,
    clientSummary,
    profileName: options.profileName,
    rawQuestionnaire,
    rawNamedValues,
    legacyDocUrl,
    legacyTariff,
    selectedTargetRoles,
    clientNotes,
    analysisDocUrl: finalAnalysis?.docUrl,
    analysisGeneratedAt: finalAnalysis?.generatedAt,
    analysisError: cardAnalysisError,
    program: outputs.program as string | undefined,
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
    const docMsg = await bot.telegram.sendDocument(
      chatId,
      Input.fromBuffer(buffer, `Анкета_${safeNick}.html`),
      {
        caption: cardHtml,
        parse_mode: "HTML",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      },
    );
    saveClientCardRef(participantId, {
      chatId,
      documentMessageId: docMsg.message_id,
      mode: "caption",
      savedAt: new Date().toISOString(),
    });
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

  const textMsg = await bot.telegram.sendMessage(chatId, cardHtml, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  const docMsg = await bot.telegram.sendDocument(
    chatId,
    Input.fromBuffer(buffer, `Анкета_${safeNick}.html`),
    {
      caption: `Анкета @${nick}`,
      parse_mode: "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    },
  );
  saveClientCardRef(participantId, {
    chatId,
    documentMessageId: docMsg.message_id,
    textMessageId: textMsg.message_id,
    mode: "separate",
    savedAt: new Date().toISOString(),
  });
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

function saveClientCardRef(participantId: string, ref: ClientCardRef): void {
  const state = getPipelineState(participantId);
  if (!state) return;
  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  outputs.cardRef = ref;
  state.stageOutputs = outputs;
  persistPipelineStatesPublic();
}

/**
 * Перерисовывает caption и клавиатуру у уже отправленной карточки клиента
 * (см. `cardRef` в stageOutputs). Используется из `updatePipelineStage`,
 * чтобы при смене stage админ-чате карточка обновлялась сама — без новых
 * сообщений и без повторной кнопки "Предварительный анализ" вместо
 * "🔬 Глубокий анализ".
 *
 * Если ref отсутствует, карточка ещё не отправлялась (например, /clients
 * с фильтром, который её не открывал) — молча выходим. Если редактирование
 * упало (>48ч, message deleted, network), логируем варнинг и не падаем —
 * карточку можно пересоздать через /client <nick>.
 */
export async function refreshClientCard(participantId: string): Promise<void> {
  const bot = getBot();
  const state = getPipelineState(participantId);
  if (!state) return;
  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const ref = outputs.cardRef as ClientCardRef | undefined;
  if (!ref) return;

  const rawQuestionnaire = outputs.rawQuestionnaire as RawQuestionnaire | undefined;
  const rawNamedValues = outputs.rawNamedValues as Record<string, string> | undefined;
  const clientSummary = outputs.clientSummary as ClientSummary | undefined;
  const legacyDocUrl = outputs.legacyDocUrl as string | undefined;
  const legacyTariff = outputs.legacyTariff as string | undefined;
  const selectedTargetRoles =
    clientSummary?.selectedTargetRoles ??
    (Array.isArray(outputs.selectedTargetRoles)
      ? (outputs.selectedTargetRoles as Parameters<typeof formatClientCardForTelegram>[0]["selectedTargetRoles"])
      : undefined);

  const clientNotes = (await import("../pipeline/client-notes.js")).listClientNotes(
    participantId,
  );

  const finalAnalysis = outputs.finalAnalysis as
    | { docUrl?: string; docError?: string; generatedAt?: string }
    | undefined;
  const finalAnalysisError = outputs.finalAnalysisError as string | undefined;
  const cardAnalysisError =
    state.stage === "final_failed"
      ? finalAnalysisError
      : (state.stage === "final_ready" || state.stage === "final_sent") &&
          !finalAnalysis?.docUrl
        ? finalAnalysis?.docError
        : undefined;

  const cardHtml = formatClientCardForTelegram({
    telegramNick: state.telegramNick,
    stage: state.stage,
    clientSummary,
    rawQuestionnaire,
    rawNamedValues,
    legacyDocUrl,
    legacyTariff,
    selectedTargetRoles,
    clientNotes,
    analysisDocUrl: finalAnalysis?.docUrl,
    analysisGeneratedAt: finalAnalysis?.generatedAt,
    analysisError: cardAnalysisError,
    program: outputs.program as string | undefined,
  });

  const replyMarkup = buildAnalyzeKeyboard(participantId, state.stage, outputs);

  try {
    if (ref.mode === "caption") {
      // У document'а с caption — редактируем caption (включая reply_markup).
      // Telegram режет caption на 1024 — если карточка распухла после старта
      // анализа, fallback: заменяем caption на короткий и шлём отдельный
      // message с полным HTML рядом (новое сообщение, но кнопки на месте).
      const CAPTION_LIMIT = 1024;
      if (cardHtml.length <= CAPTION_LIMIT) {
        await bot.telegram.editMessageCaption(
          ref.chatId,
          ref.documentMessageId,
          undefined,
          cardHtml,
          {
            parse_mode: "HTML",
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          },
        );
      } else {
        // Карточка переросла caption — оставляем кнопки на document'е,
        // а полный текст шлём новым сообщением. Запоминаем его как
        // textMessageId, переключая mode на "separate" — следующие refresh'и
        // пойдут уже по text-message пути.
        const nick = normalizeNick(state.telegramNick) || "client";
        await bot.telegram.editMessageCaption(
          ref.chatId,
          ref.documentMessageId,
          undefined,
          `Анкета @${nick} (карточка ниже ⬇️)`,
          {
            parse_mode: "HTML",
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          },
        );
        const newTextMsg = await bot.telegram.sendMessage(
          ref.chatId,
          cardHtml,
          {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          },
        );
        saveClientCardRef(participantId, {
          ...ref,
          mode: "separate",
          textMessageId: newTextMsg.message_id,
          savedAt: new Date().toISOString(),
        });
      }
    } else {
      if (ref.textMessageId) {
        await bot.telegram.editMessageText(
          ref.chatId,
          ref.textMessageId,
          undefined,
          cardHtml,
          {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          },
        );
      }
      if (replyMarkup) {
        await bot.telegram.editMessageReplyMarkup(
          ref.chatId,
          ref.documentMessageId,
          undefined,
          replyMarkup,
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "message is not modified" — это нормально, контент карточки не изменился.
    if (/message is not modified/i.test(msg)) return;
    console.warn(
      `[admin-review] refreshClientCard failed for ${participantId}: ${msg}`,
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
  // U3: anti-double-click lock переехал внутрь startShortlist — он покрывает
  // весь background try/finally, включая Phase 1 enrichment. Здесь только ack.
  await ctx.answerCbQuery().catch(() => undefined);
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
  await ctx.answerCbQuery("Открываю shortlist…").catch(() => undefined);
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
  await ctx.answerCbQuery("Открываю глубокий анализ…").catch(() => undefined);
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
  // U3: тяжёлый Phase 2 уезжает в fire-and-forget — захватываем lock здесь
  // и отпускаем внутри background task'а в finally. Если уже захвачен —
  // отвечаем toast'ом и не стартуем.
  if (!tryAcquireRunLock(participantId, "deep")) {
    await ctx
      .answerCbQuery(`⏳ Уже идёт ${RUN_KINDS.deep}, подожди до завершения.`)
      .catch(() => undefined);
    return;
  }
  await ctx.answerCbQuery().catch(() => undefined);
  const state = getPipelineState(participantId);
  if (!state) {
    releaseRunLock(participantId, "deep");
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
    releaseRunLock(participantId, "deep");
    await ctx.reply("Нет shortlist'а — сначала запусти предварительный анализ.");
    return;
  }
  if (!approved?.directions || approved.directions.length === 0) {
    releaseRunLock(participantId, "deep");
    await ctx.reply(
      "Shortlist ещё не одобрен. Открой Phase 1 и нажми «✓ Одобрить» там.",
    );
    return;
  }

  const chatId = ctx.chat?.id;
  if (chatId == null) {
    releaseRunLock(participantId, "deep");
    return;
  }
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
    } finally {
      releaseRunLock(participantId, "deep");
    }
  })();
}

// ─── Program & Target-role callbacks (prog:…) ──────────────────────────────
//
//   prog:set:<id>:<label>    — выставить/сменить метку программы
//   prog:target_menu:<id>    — открыть подменю с top-N + "Своё"
//   prog:target_custom:<id>  — запросить ввод своего направления реплаем
//
// Клики по самим direction'ам в подменю идут в `deep:target:<slotId>`
// (тот же toggle что работает внутри deep-review).

const PROG_TARGET_PROMPT = new Map<string, { chatId: number | string; participantId: string }>();

async function dispatchProgramCallback(
  data: string,
  ctx: Context,
): Promise<boolean> {
  const [ns, action, participantId, payload] = data.split(":");
  if (ns !== "prog" || !action || !participantId) return false;

  switch (action) {
    case "set":
      if (!payload) return false;
      await handleSetProgram(participantId, payload, ctx);
      return true;
    case "target_menu":
      await handleTargetMenu(participantId, ctx);
      return true;
    case "target_custom":
      await handleTargetCustomPrompt(participantId, ctx);
      return true;
    default:
      return false;
  }
}

async function handleSetProgram(
  participantId: string,
  rawLabel: string,
  ctx: Context,
): Promise<void> {
  const state = getPipelineState(participantId);
  if (!state) {
    await ctx.answerCbQuery("Клиент не найден.");
    return;
  }
  const allowed: readonly string[] = PROGRAM_LABELS;
  if (!allowed.includes(rawLabel)) {
    await ctx.answerCbQuery(`Неизвестная метка: ${rawLabel}`);
    return;
  }
  const label = rawLabel as ProgramLabel;
  const currentProgram = (state.stageOutputs as { program?: string } | undefined)?.program;
  // Toggle: повторный клик по уже активной метке снимает её (на случай когда
  // куратор проставил случайно).
  const nextValue: string | undefined = currentProgram === label ? undefined : label;
  updatePipelineStage(participantId, state.stage, { program: nextValue });
  await ctx.answerCbQuery(
    nextValue ? `📚 Программа: ${nextValue}` : "Метка программы снята",
  );
  await refreshClientCard(participantId);
}

async function handleTargetMenu(participantId: string, ctx: Context): Promise<void> {
  const state = getPipelineState(participantId);
  if (!state) {
    await ctx.answerCbQuery("Клиент не найден.");
    return;
  }
  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const final = outputs.finalAnalysis as { top3Titles?: unknown[] } | undefined;
  const slots = (outputs.deepReview as { slots?: Array<{ slotId?: string; direction?: { title?: string; roleSlug?: string } }> } | undefined)?.slots ?? [];
  const titles = Array.isArray(final?.top3Titles)
    ? (final.top3Titles as unknown[]).filter((t): t is string => typeof t === "string")
    : [];

  // Название роли берём из market-index.displayTitle по roleSlug (чистое
  // "Data Engineer" без "(Senior)" / "долгосрочная ставка" - эти суффиксы
  // Phase 3 дописывает в title для прозы финала).
  const { loadMarketIndex } = await import("../services/role-scorer.js");
  const index = await loadMarketIndex();
  const norm = (s: string) => s.toLowerCase();

  const rows = titles
    .map((title) => {
      const slot = slots.find((s) => {
        if (!s.direction?.title) return false;
        const a = norm(s.direction.title);
        const b = norm(title);
        return a === b || a.startsWith(b) || b.startsWith(a) || a.includes(b.split(" ")[0] ?? "");
      });
      if (!slot?.slotId) return null;
      const slug = slot.direction?.roleSlug ?? "";
      const cleanTitle = index[slug]?.displayTitle ?? slot.direction?.title ?? title;
      return [
        Markup.button.callback(
          `🎯 ${cleanTitle}`,
          `deep:target:${participantId}:${slot.slotId}`,
        ),
      ];
    })
    .filter((r): r is [ReturnType<typeof Markup.button.callback>] => r !== null);

  rows.push([Markup.button.callback("✨ Своё направление", `prog:target_custom:${participantId}`)]);

  await ctx.answerCbQuery();
  const chatId = ctx.chat?.id ?? getAdminChatId();
  if (!chatId) return;
  await getBot().telegram.sendMessage(
    chatId,
    "Выбери направление для упаковки:",
    { reply_markup: Markup.inlineKeyboard(rows).reply_markup },
  );
}

async function handleTargetCustomPrompt(
  participantId: string,
  ctx: Context,
): Promise<void> {
  const chatId = ctx.chat?.id ?? getAdminChatId();
  if (!chatId) {
    await ctx.answerCbQuery("Нет admin-чата.");
    return;
  }
  PROG_TARGET_PROMPT.set(String(chatId), { chatId, participantId });
  await ctx.answerCbQuery();
  await getBot().telegram.sendMessage(
    chatId,
    "Ответь <b>реплаем</b> на это сообщение свободным текстом с названием направления.\n" +
      "Формат: <code>slug | Title</code> (например <code>ml_engineer | ML Engineer (CV)</code>).\n" +
      "Если slug не знаешь — можно одной строкой название, и я попытаюсь сама.",
    { parse_mode: "HTML" },
  );
}

/**
 * Обрабатывает реплай-текст с свободным названием направления после
 * `prog:target_custom`. Вызывается из `admin-review` message-хендлера.
 * Возвращает true если сообщение было нашим реплаем и обработано.
 */
export async function handleTargetCustomReply(
  chatId: number | string,
  text: string,
): Promise<boolean> {
  const key = String(chatId);
  const pending = PROG_TARGET_PROMPT.get(key);
  if (!pending) return false;
  PROG_TARGET_PROMPT.delete(key);

  const bot = getBot();
  const trimmed = text.trim();
  let roleSlug: string | undefined;
  let title: string | undefined;
  if (trimmed.includes("|")) {
    const [slugPart, titlePart] = trimmed.split("|").map((s) => s.trim());
    roleSlug = slugPart;
    title = titlePart || slugPart;
  } else {
    // Пытаемся смапить в канонический slug по тексту. matchRoleToSlug живёт
    // в services, берём через динамический импорт - чтобы не тащить в топ
    // admin-review.
    const { matchRoleToSlug } = await import("../services/role-matcher.js");
    const hit = await matchRoleToSlug(trimmed);
    if (hit && hit.confidence >= 0.7) {
      roleSlug = hit.slug;
      title = trimmed;
    }
  }

  if (!roleSlug) {
    await bot.telegram.sendMessage(
      chatId,
      "Не поняла направление. Попробуй формат <code>slug | Title</code> (slug из KNOWN_ROLES).",
      { parse_mode: "HTML" },
    );
    return true;
  }

  const { addSelectedTargetRole } = await import("../pipeline/intake.js");
  try {
    const result = addSelectedTargetRole({
      participantId: pending.participantId,
      roleSlug,
      title: title || roleSlug,
      source: "deep",
    });
    if (!result) {
      await bot.telegram.sendMessage(chatId, "Клиент не найден.");
      return true;
    }
    await bot.telegram.sendMessage(
      chatId,
      `${result.added ? "🎯 Добавлено" : "Уже было выбрано"} для упаковки: <code>${roleSlug}</code>`,
      { parse_mode: "HTML" },
    );
    await refreshClientCard(pending.participantId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await bot.telegram.sendMessage(
      chatId,
      `❌ Не получилось добавить: ${msg}\nДля off-index slug нужно markentEvidence - сделай это через meню deep-review.`,
    );
  }
  return true;
}

export function registerAdminReview(bot: Telegraf): void {
  bot.on("callback_query", async (ctx) => {
    const data = (ctx.callbackQuery as { data?: string })?.data;
    if (!data) return;

    // НЕ дёргаем ctx.answerCbQuery() здесь — каждый дочерний хендлер сам
    // отвечает информативным тостом ("🚫 Отклонено", "Запускаю…" и т.д.).
    // Двойной answer ломает Telegram-логику: первый ответ доходит, второй
    // уходит в "callback_query is too old" и информативный текст теряется.

    if (data.startsWith("shortlist:")) {
      const handled = await dispatchShortlistCallback(data, ctx);
      if (handled) return;
    }
    if (data.startsWith("deep:")) {
      const handled = await dispatchDeepCallback(data, ctx);
      if (handled) return;
    }
    if (data.startsWith("prog:")) {
      const handled = await dispatchProgramCallback(data, ctx);
      if (handled) return;
    }

    const [action, participantId] = data.split(":");
    if (!participantId) {
      // Неизвестный callback — пустой ответ чтобы Telegram убрал loading-индикатор.
      await ctx.answerCbQuery().catch(() => undefined);
      return;
    }

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
        // Неизвестный action — гасим loading-индикатор.
        await ctx.answerCbQuery().catch(() => undefined);
        break;
    }
  });
}
