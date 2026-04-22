import type { Telegraf, Context } from "telegraf";
import { Markup } from "telegraf";

type CallbackButton = ReturnType<typeof Markup.button.callback>;
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
 * Gate 1 — админ-ревью shortlist'а направлений.
 *
 * Flow:
 *   1) Кнопка «Предварительный анализ» → `startShortlist(participantId)`
 *      → runShortlist → сохраняем в stageOutputs.shortlist, стадия
 *      `shortlist_ready`, отправляем админу сводку с inline-клавиатурой.
 *   2) Админ жмёт `🗑 Удалить N` → убираем N-е направление, edit_message.
 *   3) Админ жмёт `↻ Заменить N` → regenerateOneDirection (Claude заново
 *      генерит 5–9, берём первое направление с новой (roleSlug|bucket)),
 *      удаляем N-е, append новое.
 *   4) Админ жмёт `✓ Одобрить` (≥ 3 направлений) → стадия
 *      `shortlist_approved`, в stageOutputs.approved сохраняем одобренный
 *      список. Phase 2 (deep analysis) из этого модуля НЕ запускается —
 *      это отдельная задача.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types + store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * То, что сохраняется в `stageOutputs.shortlist` и переживает рестарты.
 * Плоско соответствует `ShortlistResult` + хранит id сообщения, чтобы
 * редактировать его при delete/regen/approve.
 */
export interface ShortlistState {
  profile: CandidateProfile;
  clientSummary?: ClientSummary;
  marketOverview: string;
  scorerTop20?: string;
  regions: Region[];
  directions: Direction[];
  enriched: EnrichedDirection[];
  /** Кто сейчас работает над этим shortlist'ом (anti-race для regen). */
  busy?: boolean;
  /** id сообщения в TG для edit_message_text. */
  messageChatId?: number | string;
  messageId?: number;
}

const STORE_KEY = "shortlist";
const APPROVED_KEY = "approved";

function loadShortlist(participantId: string): ShortlistState | undefined {
  const state = getPipelineState(participantId);
  if (!state) return undefined;
  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  return outputs[STORE_KEY] as ShortlistState | undefined;
}

function saveShortlist(participantId: string, shortlist: ShortlistState): void {
  updatePipelineStage(participantId, getStageForShortlist(participantId), {
    [STORE_KEY]: shortlist,
  });
}

function getStageForShortlist(participantId: string) {
  const state = getPipelineState(participantId);
  // если стадия уже shortlist_ready/approved — сохраним без изменений,
  // иначе остаёмся в текущей.
  return state?.stage ?? "awaiting_analysis";
}

function fromShortlistResult(result: ShortlistResult): ShortlistState {
  return {
    profile: result.profile,
    clientSummary: result.clientSummary,
    marketOverview: result.marketOverview,
    scorerTop20: result.scorerTop20,
    regions: result.regions,
    directions: result.directions.directions,
    enriched: result.enriched,
  };
}

function toShortlistResult(state: ShortlistState): ShortlistResult {
  const directionsOutput: DirectionsOutput = { directions: state.directions };
  return {
    profile: state.profile,
    clientSummary: state.clientSummary,
    marketOverview: state.marketOverview,
    scorerTop20: state.scorerTop20,
    regions: state.regions,
    directions: directionsOutput,
    enriched: state.enriched,
    timings: {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting + keyboard
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

const TYPE_LABEL: Record<Direction["type"], string> = {
  "основной трек": "основной",
  "запасной вариант": "запасной",
  "краткосрочный мост": "мост",
  "долгосрочная ставка": "долгая ставка",
};

function formatMoney(n: number | null, bucket: Direction["bucket"]): string {
  if (n === null) return "—";
  // RU — RUB в месяц, abroad/usa — EUR в год (как в enriched).
  if (bucket === "ru") {
    return `${Math.round(n / 1000)}k ₽/мес`;
  }
  return `€${Math.round(n / 1000)}k/год`;
}

/**
 * Короткое саммари одного направления в HTML для Telegram.
 */
function formatDirectionLine(
  d: Direction,
  enrichedRow: EnrichedDirection | undefined,
  idx: number,
): string {
  const bucketLabel = BUCKET_LABEL[d.bucket] ?? d.bucket;
  const typeLabel = TYPE_LABEL[d.type] ?? d.type;
  const parts: string[] = [];
  parts.push(`<b>${idx + 1}. ${escapeHtml(d.title)}</b>`);

  const meta: string[] = [bucketLabel, typeLabel];
  if (enrichedRow) {
    if (enrichedRow.vacancies !== null) meta.push(`${enrichedRow.vacancies} вак`);
    meta.push(formatMoney(enrichedRow.medianSalaryMid, d.bucket));
    if (enrichedRow.aiRisk) meta.push(`AI: ${enrichedRow.aiRisk}`);
  }
  meta.push(`adj ${d.adjacencyScorePercent}%`);
  parts.push(`<i>${meta.map(escapeHtml).join(" · ")}</i>`);
  // Ограничение: 9 направлений × ~400 симв. + клавиатура уложимся в 4096.
  const whyFits = d.whyFits.length > 250 ? d.whyFits.slice(0, 247) + "…" : d.whyFits;
  parts.push(escapeHtml(whyFits));
  return parts.join("\n");
}

function formatShortlistMessage(state: ShortlistState, nick: string): string {
  const lines: string[] = [];
  lines.push(`<b>📋 Shortlist @${escapeHtml(nick)}</b> — ${state.directions.length} направлений`);
  lines.push("");
  const enrichedByIdx = new Map<string, EnrichedDirection>();
  for (const row of state.enriched) {
    enrichedByIdx.set(`${row.roleSlug}|${row.bucket}`, row);
  }
  state.directions.forEach((d, i) => {
    const key = `${d.roleSlug}|${d.bucket === "ru" ? "ru" : "abroad"}`;
    const row = enrichedByIdx.get(key);
    lines.push(formatDirectionLine(d, row, i));
    lines.push("");
  });
  if (state.directions.length < 3) {
    lines.push("<i>⚠ Меньше 3 направлений — Approve заблокирован.</i>");
  }
  return lines.join("\n");
}

function buildKeyboard(participantId: string, state: ShortlistState) {
  const rows: CallbackButton[][] = [];
  state.directions.forEach((_d, i) => {
    rows.push([
      Markup.button.callback(`🗑 Удалить ${i + 1}`, `shortlist:del:${participantId}:${i}`),
      Markup.button.callback(`↻ Заменить ${i + 1}`, `shortlist:regen:${participantId}:${i}`),
    ]);
  });
  const canApprove = state.directions.length >= 3;
  rows.push([
    Markup.button.callback(
      canApprove
        ? "✓ Одобрить → глубокий анализ"
        : `✓ Одобрить (нужно ≥ 3, сейчас ${state.directions.length})`,
      canApprove ? `shortlist:approve:${participantId}` : `shortlist:noop:${participantId}`,
    ),
  ]);
  return Markup.inlineKeyboard(rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// Message send / edit
// ─────────────────────────────────────────────────────────────────────────────

async function sendShortlistMessage(
  chatId: number | string,
  participantId: string,
  state: ShortlistState,
): Promise<{ messageId: number; chatId: number | string }> {
  const bot = getBot();
  const nick = normalizeNick(getPipelineState(participantId)?.telegramNick ?? "");
  const text = formatShortlistMessage(state, nick);
  const kb = buildKeyboard(participantId, state);
  const msg = await bot.telegram.sendMessage(chatId, text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: kb.reply_markup,
  });
  return { messageId: msg.message_id, chatId };
}

async function editShortlistMessage(
  state: ShortlistState,
  participantId: string,
): Promise<void> {
  if (state.messageChatId == null || state.messageId == null) return;
  const bot = getBot();
  const nick = normalizeNick(getPipelineState(participantId)?.telegramNick ?? "");
  const text = formatShortlistMessage(state, nick);
  const kb = buildKeyboard(participantId, state);
  try {
    await bot.telegram.editMessageText(
      state.messageChatId,
      state.messageId,
      undefined,
      text,
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: kb.reply_markup,
      },
    );
  } catch (err) {
    console.error("[Shortlist] editMessageText failed:", err);
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
 * Запуск Phase 1 (shortlist) по клику «Предварительный анализ».
 * Долгая операция — отвечаем на callback сразу, запускаем в фоне,
 * потом шлём отдельным сообщением результат или ошибку.
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
  await ctx.reply(
    "⚙️ Запускаю предварительный анализ… обычно 30–60 секунд.",
  );

  // Фон — не блокируем обработчик callback'а.
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

      const { messageId, chatId: sentChat } = await sendShortlistMessage(
        chatId,
        participantId,
        shortlistState,
      );
      shortlistState.messageChatId = sentChat;
      shortlistState.messageId = messageId;
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
  idx: number,
  ctx: Context,
): Promise<void> {
  if (!isAdminCtx(ctx)) return;
  const shortlist = loadShortlist(participantId);
  if (!shortlist) {
    await ctx.reply("Shortlist не найден — возможно был сброшен. Запусти анализ заново.");
    return;
  }
  if (idx < 0 || idx >= shortlist.directions.length) {
    await ctx.reply(`Индекс ${idx + 1} вне диапазона.`);
    return;
  }
  const removed = shortlist.directions.splice(idx, 1)[0];
  shortlist.enriched = shortlist.enriched.filter(
    (r) => !(r.roleSlug === removed.roleSlug && r.bucket === (removed.bucket === "ru" ? "ru" : "abroad")),
  );
  saveShortlist(participantId, shortlist);
  console.log(
    `[Shortlist] ${participantId}: deleted #${idx + 1} "${removed.title}" (${shortlist.directions.length} left)`,
  );
  await editShortlistMessage(shortlist, participantId);
}

async function handleRegen(
  participantId: string,
  idx: number,
  ctx: Context,
): Promise<void> {
  if (!isAdminCtx(ctx)) return;
  const shortlist = loadShortlist(participantId);
  if (!shortlist) {
    await ctx.reply("Shortlist не найден — запусти анализ заново.");
    return;
  }
  if (idx < 0 || idx >= shortlist.directions.length) {
    await ctx.reply(`Индекс ${idx + 1} вне диапазона.`);
    return;
  }
  if (shortlist.busy) {
    await ctx.answerCbQuery("Уже идёт регенерация, подожди…");
    return;
  }
  shortlist.busy = true;
  saveShortlist(participantId, shortlist);

  const removed = shortlist.directions[idx];
  await ctx.reply(
    `↻ Регенерирую направление ${idx + 1} «${removed.title}»… ~30 сек.`,
  );

  void (async () => {
    try {
      const result = toShortlistResult(shortlist);
      // Ищем замену среди (current \ removed) — т.е. новое направление
      // должно отличаться от всех оставшихся И от только что удалённого.
      const replacement = await regenerateOneDirection(
        result,
        shortlist.directions,
      );
      if (!replacement) {
        shortlist.busy = false;
        saveShortlist(participantId, shortlist);
        await getBot().telegram.sendMessage(
          shortlist.messageChatId ?? ctx.chat!.id,
          `⚠ Не удалось подобрать замену для «${escapeHtml(
            removed.title,
          )}» (новый прогон дал те же слаги). Попробуй ещё раз или удали вручную.`,
          { parse_mode: "HTML" },
        );
        return;
      }
      shortlist.directions.splice(idx, 1, replacement.direction);
      if (replacement.enriched) {
        shortlist.enriched = [
          ...shortlist.enriched.filter(
            (r) => !(r.roleSlug === removed.roleSlug && r.bucket === (removed.bucket === "ru" ? "ru" : "abroad")),
          ),
          replacement.enriched,
        ];
      }
      shortlist.busy = false;
      saveShortlist(participantId, shortlist);
      await editShortlistMessage(shortlist, participantId);
    } catch (err) {
      console.error("[Shortlist] regen failed:", err);
      shortlist.busy = false;
      saveShortlist(participantId, shortlist);
      try {
        await getBot().telegram.sendMessage(
          shortlist.messageChatId ?? ctx.chat!.id,
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
  if (shortlist.directions.length < 3) {
    await ctx.answerCbQuery("Нужно ≥ 3 направлений.");
    return;
  }

  updatePipelineStage(participantId, "shortlist_approved", {
    [APPROVED_KEY]: {
      directions: shortlist.directions,
      slugs: shortlist.directions.map((d) => d.roleSlug),
      approvedAt: new Date().toISOString(),
    },
  });

  const slugs = shortlist.directions.map((d) => d.roleSlug).join(", ");
  console.log(
    `[Shortlist] ${participantId}: approved ${shortlist.directions.length} directions (${slugs})`,
  );

  await ctx.reply(
    `✅ Shortlist одобрен (${shortlist.directions.length} направлений: <code>${escapeHtml(slugs)}</code>).\n\n` +
      `Глубокий анализ (Phase 2) будет запущен отдельно — этот шаг ещё в разработке.`,
    { parse_mode: "HTML" },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Диспетчер для callback-запросов вида `shortlist:<action>:<pid>[:<idx>]`.
 * Вызывается из общего callback_query handler в admin-review.ts.
 * Возвращает true, если callback был обработан.
 */
export async function dispatchShortlistCallback(
  data: string,
  ctx: Context,
): Promise<boolean> {
  const [ns, action, participantId, rawIdx] = data.split(":");
  if (ns !== "shortlist" || !action || !participantId) return false;

  if (action === "noop") {
    await ctx.answerCbQuery();
    return true;
  }

  const idx = rawIdx != null ? Number(rawIdx) : NaN;

  switch (action) {
    case "del":
      await handleDelete(participantId, idx, ctx);
      return true;
    case "regen":
      await handleRegen(participantId, idx, ctx);
      return true;
    case "approve":
      await handleApprove(participantId, ctx);
      return true;
    default:
      return false;
  }
}

export function registerShortlistCallbacks(_bot: Telegraf): void {
  // No-op: актуальный dispatch живёт в admin-review.ts → callback_query.
  // Экспорт оставлен на случай если в будущем зарегистрируем отдельный
  // роутер (например, через bot.action(/^shortlist:/, ...)).
}

// Debug utility, используется в тестах / ручной проверке state.
export function _debugShortlistState(participantId: string): ShortlistState | undefined {
  return loadShortlist(participantId);
}

/** Дополнительный enrich (если нужно пересобрать после вмешательства в state). */
export async function _debugEnrich(
  shortlist: ShortlistState,
): Promise<EnrichedDirection[]> {
  if (!shortlist.clientSummary) return [];
  return enrichDirections(shortlist.directions, shortlist.clientSummary);
}
