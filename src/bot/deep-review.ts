import crypto from "node:crypto";
import type { Context } from "telegraf";
import { Input, Markup } from "telegraf";
import { marked } from "marked";

type CallbackButton = ReturnType<typeof Markup.button.callback>;
type UrlButton = ReturnType<typeof Markup.button.url>;
type HeaderButton = CallbackButton | UrlButton;
type InlineKeyboardMarkup = ReturnType<typeof Markup.inlineKeyboard>["reply_markup"];

import { getBot } from "./bot-instance.js";
import {
  getPipelineState,
  toggleSelectedTargetRole,
  updatePipelineStage,
} from "../pipeline/intake.js";
import {
  runAnalysisPhase4,
  runDeepFromShortlist,
  resolveEnrichedForDirections,
  type ShortlistResult,
} from "../pipeline/run-analysis.js";
import type { Direction } from "../schemas/analysis-outputs.js";
import {
  formatEnrichedAsMarketData,
  type EnrichedDirection,
} from "../services/direction-enricher.js";
import { createGoogleDoc } from "../services/google-docs-service.js";
import { normalizeNick } from "../services/intake-mapper.js";
import {
  countRecommended,
  escapeHtml,
  hasCoreMarketData,
  isRecommended,
} from "./shortlist-format.js";
import { getShortlistState, toShortlistResult } from "./shortlist-review.js";
import { tryAcquireRunLock, releaseRunLock, RUN_KINDS } from "./run-lock.js";

/**
 * Финальный гейт.
 *
 * Раньше тут был отдельный Gate 2 (Phase 2 / deep review): повторный список
 * направлений + Perplexity-дозаполнение + второй tap «Одобрить». Это убрано —
 * Perplexity фантазировал, а обогащение и так детерминированно считается в
 * Phase 1 (`runShortlist`). Теперь куратор ревьюит рыночные данные прямо на
 * Gate 1 (shortlist), а его «✓ Одобрить» сразу готовит финальный гейт:
 *   - `startFinalGate` детерминированно сопоставляет approved → enriched,
 *     сохраняет `stageOutputs.deepApproved` и рисует ОДИН компактный header
 *     с кнопкой «📄 Сгенерировать финальный анализ» (без карточек направлений).
 *   - `handleFinal` (Phase 3 + Phase 4 + HTML + Google Doc) не изменился.
 *
 * `stageOutputs.deepReview` по-прежнему хранит слоты (нужны меню упаковки
 * `prog:target_menu` после финала), но это уже не интерактивный review.
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
  updatePipelineStage(participantId, ps?.stage ?? "deep_approved", {
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

function formatDeepHeader(
  state: DeepReviewState,
  nick: string,
  participantId: string,
): string {
  const total = state.slots.length;
  const recommended = countRecommended(state.slots);
  const rejected = total - recommended;
  let withData = 0;
  let noDataCount = 0;
  for (const s of state.slots) {
    if (hasCoreMarketData(s.enriched)) withData += 1;
    else noDataCount += 1;
  }
  const sourceLine = `[m] ${withData} · [?] ${noDataCount}`;
  // Количество рекомендуемых direction'ов без core-рыночных данных
  // (vac/sal/comp все null) — критичный пробел, в финал такие идти не должны.
  const noData = state.slots.filter(
    (s) => isRecommended(s.direction) && !hasCoreMarketData(s.enriched),
  ).length;
  const lines = [
    `<b>📄 Финальный анализ @${escapeHtml(nick)}</b>`,
    `Направлений: <b>${total}</b> · данные: ${sourceLine}`,
    `Рекомендуем: <b>${recommended}</b>${rejected > 0 ? ` · отклонено: <b>${rejected}</b>` : ""}`,
  ];
  if (noData > 0) {
    lines.push(`⚠ <b>Без данных рынка: ${noData}</b> — финал по ним бесполезен, проверь shortlist вручную.`);
  }

  // Блок финала: показываем ссылку на Doc и/или статус, как только Phase 4
  // отработал. Если doc не создался — отдельно подсветим ошибку, чтобы
  // куратор знал, что HTML уже в чате, а Doc можно перегенерировать.
  const ps = getPipelineState(participantId);
  const stage = ps?.stage;
  const finalAnalysis = (ps?.stageOutputs as Record<string, unknown> | undefined)
    ?.finalAnalysis as
    | { docUrl?: string; docError?: string; generatedAt?: string }
    | undefined;
  const finalErr = (ps?.stageOutputs as Record<string, unknown> | undefined)
    ?.finalAnalysisError as string | undefined;

  if (stage === "final_ready" || stage === "final_sent") {
    const date = (finalAnalysis?.generatedAt || "").slice(0, 10);
    const dateLabel = date ? ` · ${escapeHtml(date)}` : "";
    const sentBadge = stage === "final_sent" ? " · 📤 отправлен клиенту" : "";
    if (finalAnalysis?.docUrl) {
      lines.push(
        `\n<b>📄 Карьерный анализ:</b> ` +
          `<a href="${escapeHtml(finalAnalysis.docUrl)}">Google Doc</a>${dateLabel} · HTML — выше в чате${sentBadge}`,
      );
    } else {
      const err = finalAnalysis?.docError
        ? ` · ⚠ Doc не создан (${escapeHtml(finalAnalysis.docError.slice(0, 120))})`
        : ` · ⚠ Doc не создан`;
      lines.push(
        `\n<b>📄 Карьерный анализ:</b> 🟢 готов · HTML — выше в чате${dateLabel}${err}${sentBadge}`,
      );
    }
  } else if (stage === "final_generating") {
    lines.push(`\n<b>📄 Карьерный анализ:</b> ⚙️ собирается…`);
  } else if (stage === "final_failed" && finalErr) {
    lines.push(
      `\n<b>📄 Карьерный анализ:</b> ❌ упал — ` +
        `<code>${escapeHtml(finalErr.slice(0, 200))}</code>`,
    );
  }

  // Начальный финальный гейт (deep_approved, финал ещё не собран): списки
  // направлений и инструкция — прямо в шапке. Кнопка «📄 Сгенерировать
  // финальный анализ» в клавиатуре встаёт сразу под этим текстом, поэтому
  // отдельное сообщение «✅ Shortlist одобрен …» больше не нужно.
  if (stage === "deep_approved") {
    const recSlugs = state.slots
      .filter((s) => isRecommended(s.direction))
      .map((s) => s.direction.roleSlug)
      .join(", ");
    const rejSlugs = state.slots
      .filter((s) => !isRecommended(s.direction))
      .map((s) => s.direction.roleSlug)
      .join(", ");
    lines.push(
      `\n✅ <b>Рекомендованы (${recommended}):</b> <code>${escapeHtml(recSlugs)}</code>`,
    );
    if (rejected > 0) {
      lines.push(
        `🚫 <b>Отклонено (${rejected}):</b> <code>${escapeHtml(rejSlugs)}</code>`,
      );
    }
    lines.push(
      `\nЖми <b>📄 Сгенерировать финальный анализ</b> — соберём top-3 + документ в Google Docs.`,
    );
  }

  return lines.join("\n");
}

function deepHeaderKeyboard(
  participantId: string,
  _state: DeepReviewState,
): InlineKeyboardMarkup {
  const rows: HeaderButton[][] = [];

  // Финальный гейт: одобрение уже произошло на Gate 1, поэтому тут только
  // кнопка генерации/перегенерации финала (Phase 3 + Phase 4 + Google Doc).
  const ps = getPipelineState(participantId);
  const stage = ps?.stage;
  const finalAnalysis = (ps?.stageOutputs as Record<string, unknown> | undefined)
    ?.finalAnalysis as { docUrl?: string } | undefined;
  const isGenerating = stage === "final_generating";

  // Если уже есть Google Doc — отдельная URL-кнопка сверху, чтобы куратор
  // мог открыть финал прямо из шапки, не листая чат.
  if (
    (stage === "final_ready" || stage === "final_sent") &&
    finalAnalysis?.docUrl
  ) {
    rows.push([Markup.button.url("📄 Открыть Google Doc", finalAnalysis.docUrl)]);
  }

  if (isGenerating) {
    rows.push([
      Markup.button.callback("⚙️ Финальный анализ собирается…", `deep:noop:${participantId}`),
    ]);
  } else {
    const label = stage === "final_ready" || stage === "final_sent"
      ? "🔁 Перегенерировать финальный анализ"
      : stage === "final_failed"
      ? "🔁 Повторить финальный анализ"
      : "📄 Сгенерировать финальный анализ";
    rows.push([Markup.button.callback(label, `deep:final:${participantId}`)]);
  }
  return Markup.inlineKeyboard(rows).reply_markup;
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
  const msg = await bot.telegram.sendMessage(
    chatId,
    formatDeepHeader(state, nick, participantId),
    {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: deepHeaderKeyboard(participantId, state),
    },
  );
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
      formatDeepHeader(state, nick, participantId),
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

// ─────────────────────────────────────────────────────────────────────────────
// Public entry: финальный гейт (после Gate 1 approve)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Готовит финальный гейт поверх одобренного на Gate 1 shortlist'а.
 *
 * Детерминированно (без Perplexity) сопоставляет approved + rejected
 * направления с их `EnrichedDirection` (из `shortlist.enriched`), сохраняет
 * `stageOutputs.deepApproved` (что читает `handleFinal`) + `deepReview`
 * (слоты нужны меню упаковки), ставит стадию `deep_approved` и рисует ОДИН
 * компактный header с кнопкой «📄 Сгенерировать финальный анализ».
 *
 * Карточки направлений НЕ шлёт — куратор уже видел и отредактировал рынок на
 * Gate 1 (shortlist). Это убирает второе ревью и второй tap «Одобрить».
 */
export async function startFinalGate(
  participantId: string,
  chatId: number | string,
  shortlist: ShortlistResult,
  recommendedDirections: Direction[],
  rejectedDirections: Direction[],
): Promise<DeepReviewState> {
  const allDirections = [...recommendedDirections, ...rejectedDirections];
  const enrichedAligned = await resolveEnrichedForDirections(shortlist, allDirections);

  const slots: DeepDirectionSlot[] = allDirections.map((direction, i) => ({
    slotId: newSlotId(),
    direction,
    enriched: enrichedAligned[i],
  }));
  // Стабильный порядок: рекомендуемые по score DESC, отклонённые в конце.
  slots.sort((a, b) => {
    const ra = isRecommended(a.direction) ? 1 : 0;
    const rb = isRecommended(b.direction) ? 1 : 0;
    if (ra !== rb) return rb - ra;
    return (b.direction.score ?? 0) - (a.direction.score ?? 0);
  });

  const recommendedEnriched: EnrichedDirection[] = [];
  const rejectedEnriched: EnrichedDirection[] = [];
  for (let i = 0; i < allDirections.length; i++) {
    const e = enrichedAligned[i];
    if (!e) continue;
    if (isRecommended(allDirections[i])) recommendedEnriched.push(e);
    else rejectedEnriched.push(e);
  }

  const state: DeepReviewState = {
    slots,
    startedAt: new Date().toISOString(),
  };

  updatePipelineStage(participantId, "deep_approved", {
    [STORE_KEY]: state,
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

  const header = await sendDeepHeader(chatId, participantId, state);
  state.headerChatId = header.chatId;
  state.headerMessageId = header.messageId;
  // Перезаписываем deepReview с координатами header'а для последующих edit.
  saveDeep(participantId, state);

  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// Callbacks
// ─────────────────────────────────────────────────────────────────────────────

function isAdminCtx(ctx: Context): boolean {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (chatId == null) return false;
  // Канонический env var — TELEGRAM_ADMIN_CHAT_ID (см. bot-instance.ts).
  // ADMIN_CHAT_ID оставлен как fallback для совместимости со старой
  // конфигурацией (Render env), но новый код должен ставить именно
  // TELEGRAM_ADMIN_CHAT_ID.
  const adminId =
    process.env.TELEGRAM_ADMIN_CHAT_ID ?? process.env.ADMIN_CHAT_ID ?? null;
  if (adminId == null) return true;
  return String(chatId) === String(adminId);
}

interface FinalAnalysisOutput {
  docUrl?: string;
  docError?: string;
  generatedAt: string;
  top3Titles: string[];
  rejectedTitles: string[];
  markdownLength: number;
  markdown?: string;
}

async function handleFinal(
  participantId: string,
  ctx: Context,
): Promise<void> {
  if (!isAdminCtx(ctx)) return;
  // U3: anti-double-click lock на финальный анализ. Захватываем здесь, чтобы
  // даже короткие preconditions-проверки внутри не успели бы пустить второй
  // параллельный запуск Phase 3+4 (одновременные клики).
  if (!tryAcquireRunLock(participantId, "final")) {
    await ctx.answerCbQuery(
      `⏳ ${RUN_KINDS.final} уже идёт, подожди до завершения.`,
    );
    return;
  }
  try {
    await handleFinalLocked(participantId, ctx);
  } finally {
    releaseRunLock(participantId, "final");
  }
}

async function handleFinalLocked(
  participantId: string,
  ctx: Context,
): Promise<void> {
  const state = loadDeep(participantId);
  if (!state) {
    await ctx.answerCbQuery("Deep state не найден.");
    return;
  }
  const ps = getPipelineState(participantId);
  if (!ps) {
    await ctx.answerCbQuery("Клиент не найден.");
    return;
  }
  const outputs = (ps.stageOutputs ?? {}) as Record<string, unknown>;
  const approved = outputs[APPROVED_KEY] as
    | {
        directions?: Direction[];
        rejectedDirections?: Direction[];
        enriched?: EnrichedDirection[];
        rejectedEnriched?: EnrichedDirection[];
      }
    | undefined;
  if (!approved?.directions || approved.directions.length === 0) {
    await ctx.answerCbQuery("Нет одобренных направлений (нужно сначала Approve).");
    return;
  }

  const shortlistState = getShortlistState(participantId);
  if (!shortlistState) {
    await ctx.answerCbQuery("Shortlist state не найден.");
    return;
  }

  await ctx.answerCbQuery("⚙️ Запустила финальный анализ. Это займёт пару минут.");

  updatePipelineStage(participantId, "final_generating", {
    finalAnalysisError: undefined,
  });
  // Перерисуем header — теперь покажет «Финальный анализ собирается…»
  await editDeepHeader(participantId, state);

  const chatId = ctx.chat?.id;
  const bot = getBot();
  const replyText = (text: string) =>
    chatId != null
      ? bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" })
      : Promise.resolve();

  // ── Phase 3+4: считаем markdown. Если уж это упало — финал реально
  //    не получился, ставим final_failed.
  let phase1: Awaited<ReturnType<typeof runDeepFromShortlist>>;
  let phase4: Awaited<ReturnType<typeof runAnalysisPhase4>>;
  const t0 = Date.now();
  try {
    // approvedDirections для prompt-03 = recommended ∪ rejected (отклонённые
    // тоже надо упомянуть в финале как «обсудили и отклонили»).
    const approvedAll: Direction[] = [
      ...approved.directions,
      ...(approved.rejectedDirections ?? []),
    ];

    // marketData по approved направлениям — детерминированно из enriched
    // (посчитано на Gate 1), без внешних запросов.
    const enrichedAll: EnrichedDirection[] = [
      ...(approved.enriched ?? []),
      ...(approved.rejectedEnriched ?? []),
    ];
    const marketData = enrichedAll.length > 0
      ? formatEnrichedAsMarketData(enrichedAll)
      : undefined;

    const shortlistResult = toShortlistResult(shortlistState);

    console.log(
      `[Final] ${participantId}: starting Phase 3+4. ` +
        `approved=${approved.directions.length} rejected=${approved.rejectedDirections?.length ?? 0} ` +
        `marketData=${marketData ? `${marketData.length}c` : "none"}`,
    );

    phase1 = await runDeepFromShortlist(shortlistResult, approvedAll, {
      marketData,
    });

    phase4 = await runAnalysisPhase4(
      phase1.profile,
      phase1.directions,
      phase1.analysis,
      undefined,
      {
        enriched: phase1.enrichedTop3,
        clientSummary: phase1.clientSummary,
      },
    );
  } catch (err) {
    console.error(`[Final] ${participantId}: phase3/4 failed`, err);
    updatePipelineStage(participantId, "final_failed", {
      finalAnalysisError: err instanceof Error ? err.message : String(err),
    });
    const refreshed = loadDeep(participantId);
    if (refreshed) {
      await editDeepHeader(participantId, refreshed);
    }
    await replyText(
      `❌ <b>Финальный анализ упал</b>\n` +
        `<code>${escapeHtml(
          err instanceof Error ? err.message : String(err),
        ).slice(0, 500)}</code>\n\n` +
        `Можно нажать «Повторить» в шапке.`,
    );
    return;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const candidateName =
    phase1.profile.name || ps.telegramNick || participantId;
  const top3Titles = phase1.analysis.directions.map((d) => d.title);
  const rejectedTitles =
    phase1.analysis.rejectedDirections?.map((r) => r.originalTitle) ?? [];
  const markdown = phase4.finalDocument;

  // ── HTML-файл в чат как первый шаг. Buffer/caption — буква-в-букву как
  //    было в commit 47be0b3 (13 апреля): "Финальный анализ (HTML). Можно
  //    открыть в браузере." Тот же markdown идёт и в Google Doc ниже,
  //    чтобы редактирование оставалось согласованным.
  console.log(
    `[Final] ${participantId}: phase3/4 done in ${elapsed}s ` +
      `(md=${markdown.length}c), sending HTML to TG…`,
  );

  const { htmlFile, safeTitle, title } = await renderFinalAnalysisHtml(markdown, candidateName);

  const out: FinalAnalysisOutput = {
    generatedAt: new Date().toISOString(),
    top3Titles,
    rejectedTitles,
    markdownLength: markdown.length,
    markdown,
  };
  updatePipelineStage(participantId, "final_ready", {
    finalAnalysis: out,
    finalAnalysisError: undefined,
  });
  const refreshed = loadDeep(participantId);
  if (refreshed) {
    await editDeepHeader(participantId, refreshed);
  }

  if (chatId != null) {
    try {
      await bot.telegram.sendDocument(
        chatId,
        Input.fromBuffer(Buffer.from(htmlFile, "utf-8"), `${safeTitle}.html`),
        { caption: "Финальный анализ (HTML). Можно открыть в браузере." },
      );
    } catch (sendErr) {
      console.error(
        `[Final] ${participantId}: sendDocument failed`,
        sendErr,
      );
      await replyText(
        `⚠ Не смогла отправить HTML-файл: <code>${escapeHtml(
          sendErr instanceof Error ? sendErr.message : String(sendErr),
        ).slice(0, 200)}</code>`,
      );
    }
  }

  // ── Google Doc — попытка из ровно того же markdown, как раньше.
  //    Падение (квоты Drive, Apps Script bandwidth и пр.) не теряет
  //    финал — HTML уже у куратора в чате.
  try {
    const docUrl = await createGoogleDoc(title, markdown);
    out.docUrl = docUrl;
    out.docError = undefined;
    updatePipelineStage(participantId, "final_ready", {
      finalAnalysis: out,
      finalAnalysisError: undefined,
    });
    // refresh шапки — теперь там URL-кнопка «📄 Открыть Google Doc».
    const refreshedDeep = loadDeep(participantId);
    if (refreshedDeep) {
      await editDeepHeader(participantId, refreshedDeep);
    }
    console.log(`[Final] ${participantId}: doc created → ${docUrl}`);
    if (chatId != null) {
      await bot.telegram.sendMessage(chatId, `Google Doc: ${docUrl}`, {
        link_preview_options: { is_disabled: false },
      });
    }
  } catch (docErr) {
    const msg = docErr instanceof Error ? docErr.message : String(docErr);
    console.error(`[Final] ${participantId}: createGoogleDoc failed`, docErr);
    out.docError = msg;
    updatePipelineStage(participantId, "final_ready", {
      finalAnalysis: out,
      finalAnalysisError: undefined,
    });
    const refreshedDeep = loadDeep(participantId);
    if (refreshedDeep) {
      await editDeepHeader(participantId, refreshedDeep);
    }
    await replyText(
      `Google Doc не удалось создать (квота/Apps Script). HTML-файл выше содержит полный анализ.\n` +
        `<code>${escapeHtml(msg).slice(0, 400)}</code>`,
    );
  }
}

/**
 * Рендер финального markdown в самодостаточный HTML-файл (тот же шаблон что
 * шлёт `handleFinalLocked` сразу после генерации). Вынесен отдельно чтобы
 * `handleResendHtml` мог переиспользовать формат без перегенерации анализа.
 */
async function renderFinalAnalysisHtml(
  markdown: string,
  candidateName: string,
): Promise<{ htmlFile: string; safeTitle: string; title: string }> {
  const title = `Карьерный анализ: ${candidateName}`;
  const safeTitle = title.replace(/[^a-zA-Zа-яА-ЯёЁ0-9_\- ]/g, "_");
  const htmlBody = await marked(markdown);
  const htmlFile = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6}
h1,h2,h3{margin-top:1.5em}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:8px;text-align:left}</style>
</head><body>${htmlBody}</body></html>`;
  return { htmlFile, safeTitle, title };
}

/**
 * Достаёт сохранённый markdown из state (поле `finalAnalysis.markdown`,
 * добавлено в commit 038fde3) и присылает его как HTML-файл в чат.
 * Если markdown'а нет (старые клиенты, сгенерённые до 038fde3) — отвечает
 * подсказкой нажать «Перегенерировать».
 */
async function handleResendHtml(
  participantId: string,
  ctx: Context,
): Promise<void> {
  if (!isAdminCtx(ctx)) return;

  const ps = getPipelineState(participantId);
  const finalAnalysis = (ps?.stageOutputs as Record<string, unknown> | undefined)
    ?.finalAnalysis as
    | { markdown?: string; generatedAt?: string }
    | undefined;
  const markdown = finalAnalysis?.markdown;

  const chatId = ctx.chat?.id;
  if (chatId == null) return;

  if (!markdown) {
    await ctx.answerCbQuery(
      "HTML недоступен (старый анализ без сохранённого markdown). Перегенерируй.",
      { show_alert: true },
    );
    return;
  }

  await ctx.answerCbQuery("Отправляю HTML…");

  const cs = (ps?.stageOutputs as Record<string, unknown> | undefined)
    ?.clientSummary as { firstNameLatin?: string; lastNameLatin?: string } | undefined;
  const nameFromSummary = cs?.firstNameLatin
    ? `${cs.firstNameLatin}${cs.lastNameLatin ? ` ${cs.lastNameLatin}` : ""}`.trim()
    : null;
  const nickName = ps?.telegramNick ? normalizeNick(ps.telegramNick) : null;
  const candidateName = nameFromSummary ?? nickName ?? participantId;

  try {
    const { htmlFile, safeTitle } = await renderFinalAnalysisHtml(markdown, candidateName);
    const date = (finalAnalysis?.generatedAt || "").slice(0, 10);
    const caption = date
      ? `Карьерный анализ (HTML) · сгенерён ${date}`
      : `Карьерный анализ (HTML)`;
    await getBot().telegram.sendDocument(
      chatId,
      Input.fromBuffer(Buffer.from(htmlFile, "utf-8"), `${safeTitle}.html`),
      { caption },
    );
  } catch (err) {
    console.error(`[deep:html] ${participantId}: failed`, err);
    await getBot().telegram.sendMessage(
      chatId,
      `⚠ Не получилось отправить HTML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Отметить анализ как отправленный клиенту. Ручное действие куратора —
 * после того, как она переслала файл/ссылку клиенту лично, жмёт кнопку и
 * статус клиента в списке становится "📤 Анализ отправлен клиенту". Stage
 * меняется с `final_ready` на `final_sent`, `updatePipelineStage` сам
 * перерисует карточку клиента в чате.
 *
 * Разрешаем только из стадии `final_ready` — из `final_sent` уже ничего не
 * делаем (для возврата есть отдельная `handleUnmarkSent`).
 */
async function handleMarkSent(
  participantId: string,
  ctx: Context,
): Promise<void> {
  if (!isAdminCtx(ctx)) return;
  const ps = getPipelineState(participantId);
  if (!ps) {
    await ctx.answerCbQuery("Клиент не найден.");
    return;
  }
  if (ps.stage !== "final_ready") {
    await ctx.answerCbQuery(
      `Неподходящий статус: ${ps.stage}. Кнопка работает только из final_ready.`,
      { show_alert: true },
    );
    return;
  }
  updatePipelineStage(participantId, "final_sent");
  await ctx.answerCbQuery("✅ Отмечено как отправлено клиенту.");
}

async function handleTarget(
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
  let result: ReturnType<typeof toggleSelectedTargetRole>;
  try {
    result = toggleSelectedTargetRole(participantId, slot.direction, "deep", slot.slotId);
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
  await ctx.answerCbQuery(
    result.selected
      ? `Добавлено в упаковку: ${slot.direction.roleSlug}`
      : `Убрано из упаковки: ${slot.direction.roleSlug}`,
  ).catch(() => undefined);
  // Обновляем основную карточку клиента, чтобы галочка на кнопке "🎯 ..."
  // сразу отобразилась. Динамический импорт из-за цикла admin-review ↔ deep-review.
  try {
    const { refreshClientCard } = await import("./admin-review.js");
    await refreshClientCard(participantId);
  } catch (err) {
    console.warn(
      `[deep:target] refreshClientCard failed for ${participantId}:`,
      err,
    );
  }
  await ctx.reply(
    `${result.selected ? "🎯 Выбрано" : "Убрано"} для упаковки: <b>${escapeHtml(slot.direction.title)}</b>\n` +
      `Всего выбранных направлений: <b>${result.roles.length}</b>.`,
    { parse_mode: "HTML" },
  );
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
    case "target":
      if (!slotOrIdx) return false;
      await handleTarget(participantId, slotOrIdx, ctx);
      return true;
    case "final":
      await handleFinal(participantId, ctx);
      return true;
    case "html":
      await handleResendHtml(participantId, ctx);
      return true;
    case "mark_sent":
      await handleMarkSent(participantId, ctx);
      return true;
    default:
      return false;
  }
}

// for tests
export function _debugDeepState(participantId: string): DeepReviewState | undefined {
  return loadDeep(participantId);
}
