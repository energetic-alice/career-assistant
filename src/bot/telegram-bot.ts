import type { FastifyInstance } from "fastify";
import type { Context as TelegrafContext } from "telegraf";
import { Markup as MarkupNs } from "telegraf";
import { initBot, getBot } from "./bot-instance.js";
import { registerAdminReview } from "./admin-review.js";
import { handleResumeUpdateMessage, registerResumeUpdate } from "./resume-update.js";
import { registerNotesCommands } from "./notes-commands.js";
import { STAGE_LABELS } from "../services/review-summary.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import type { PipelineState } from "../schemas/pipeline-state.js";
import { PROGRAM_LABELS, type ProgramLabel } from "../schemas/pipeline-state.js";
import { normalizeNick } from "../services/intake-mapper.js";
import { formatRegions } from "../services/market-access.js";

function escapeHtml(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Фильтр /clients-списка по метке программы. "all" — без фильтра, показываем
 * всех. Остальные значения — конкретная ProgramLabel.
 */
type ClientsFilter = "all" | ProgramLabel;

/**
 * Возвращает program-метку из stageOutputs. Безопасно к отсутствию поля.
 */
function getProgramLabel(state: PipelineState): string | undefined {
  return (state.stageOutputs as { program?: string } | undefined)?.program;
}

/**
 * Рендерит ОДНУ строку клиента в /clients-списке. Вынесено из inline-цикла,
 * чтобы переиспользовать при фильтрации.
 */
function renderClientLine(state: PipelineState): string[] {
  const nick = normalizeNick(state.telegramNick) || "—";
  const cs = (state.stageOutputs as { clientSummary?: ClientSummary } | undefined)?.clientSummary;
  const name = cs
    ? [cs.firstName, cs.lastName].filter((x) => x && x !== "—").join(" ") ||
      [cs.firstNameLatin, cs.lastNameLatin].filter((x) => x && x !== "—").join(" ")
    : "";

  const contextParts: string[] = [];
  const professionLabel = cs?.currentProfessionSlug
    ? cs.currentProfessionSlug
    : cs?.currentProfession && cs.currentProfession !== "—"
      ? cs.currentProfession
      : "";
  if (professionLabel) {
    contextParts.push(escapeHtml(professionLabel));
  }
  const loc = cs?.location && cs.location !== "—" ? cs.location : "";
  const regions = cs?.targetMarketRegions ?? [];
  const market = regions.length > 0 ? formatRegions(regions) : "";
  if (loc && market) contextParts.push(`${escapeHtml(loc)} → ${market}`);
  else if (loc) contextParts.push(escapeHtml(loc));
  else if (market) contextParts.push(`→ ${market}`);
  if (cs?.englishLevel && cs.englishLevel !== "—") {
    contextParts.push(`англ ${escapeHtml(cs.englishLevel)}`);
  }
  const context = contextParts.length ? ` (${contextParts.join(", ")})` : "";

  const nameStr = name ? ` <b>${escapeHtml(name)}</b>` : "";
  const stageLabel = STAGE_LABELS[state.stage] ?? state.stage;
  const program = getProgramLabel(state);
  const programTag = program ? `[${escapeHtml(program)}] ` : "";

  return [
    `${programTag}<b>@${escapeHtml(nick)}</b>${nameStr}${context}`,
    `  ${escapeHtml(stageLabel)} — /client_${nick}`,
    "",
  ];
}

/**
 * Режет длинный список строк на куски по `chunkLimit` символов, аккуратно
 * разрывая по двойному переводу строки (границы между клиентами).
 */
function splitToChunks(text: string, chunkLimit = 3500): string[] {
  if (text.length <= chunkLimit) return [text];
  const chunks: string[] = [];
  let buf = "";
  for (const block of text.split("\n\n")) {
    const withBlock = buf ? `${buf}\n\n${block}` : block;
    if (withBlock.length > chunkLimit && buf) {
      chunks.push(buf);
      buf = block;
    } else {
      buf = withBlock;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/**
 * Inline-кнопки фильтра под /clients. Активный фильтр выделяется галочкой
 * («✓ КА2»), чтобы куратор сразу видел, какой срез на экране сейчас.
 *
 * callback_data формата `clients_filter:<filter>`. Хендлер живёт в этом же
 * файле (см. `bot.action(/^clients_filter:/, ...)` ниже).
 */
function clientsKeyboard(active: ClientsFilter): ReturnType<typeof MarkupNs.inlineKeyboard> {
  const items: { id: ClientsFilter; label: string }[] = [
    { id: "all", label: "Все" },
    ...PROGRAM_LABELS.map((p) => ({ id: p, label: p }) as { id: ClientsFilter; label: string }),
  ];
  const buttons = items.map((it) =>
    MarkupNs.button.callback(
      it.id === active ? `✓ ${it.label}` : it.label,
      `clients_filter:${it.id}`,
    ),
  );
  // Один ряд: компактно (5 кнопок ~25 символов суммарно), хорошо помещается
  // на любой ширине экрана.
  return MarkupNs.inlineKeyboard([buttons]);
}

/**
 * Собирает текст /clients-ответа с учётом фильтра. Возвращает массив chunks
 * (Telegram режет сообщения 4096 символов).
 */
function renderClientsResponse(states: PipelineState[], filter: ClientsFilter): string[] {
  const filtered =
    filter === "all"
      ? states
      : states.filter((s) => getProgramLabel(s) === filter);

  const sorted = [...filtered].sort((a, b) =>
    normalizeNick(a.telegramNick).localeCompare(normalizeNick(b.telegramNick), "ru"),
  );

  const filterLabel = filter === "all" ? "все программы" : `программа ${filter}`;
  const lines: string[] = [
    `<b>Клиенты (${sorted.length}):</b> <i>${escapeHtml(filterLabel)}</i>`,
    "",
  ];
  if (sorted.length === 0) {
    lines.push("<i>В этой программе пока никого нет.</i>");
  } else {
    for (const s of sorted) lines.push(...renderClientLine(s));
  }
  return splitToChunks(lines.join("\n"));
}

let webhookMode = false;

export async function startBot(app?: FastifyInstance): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token === "your-bot-token") {
    console.warn("[Bot] TELEGRAM_BOT_TOKEN not configured, skipping bot start");
    return;
  }

  const bot = initBot(token);

  bot.command("start", (ctx) => {
    ctx.reply(
      "Career Accelerator Bot\n\n" +
        "Бот для ревью карьерных анализов.\n" +
        "Новые анализы приходят автоматически после заполнения анкеты.\n\n" +
        "/status — текущее состояние очереди",
    );
  });

  bot.command("status", async (ctx) => {
    const { getAllPipelineStates } = await import("../pipeline/intake.js");
    const states = getAllPipelineStates();
    if (states.length === 0) {
      ctx.reply("Очередь пуста, анализов нет.");
      return;
    }

    const byStage: Record<string, number> = {};
    for (const s of states) {
      byStage[s.stage] = (byStage[s.stage] || 0) + 1;
    }

    const lines = [`Всего участников: ${states.length}`, ""];
    for (const [stage, count] of Object.entries(byStage)) {
      lines.push(`  ${stage}: ${count}`);
    }
    ctx.reply(lines.join("\n"));
  });

  /**
   * Отправляет список клиентов с фильтром по программе. Используется и из
   * /clients-команды, и из callback-обработчика фильтра. Кнопки фильтра
   * прикрепляются к ПОСЛЕДНЕМУ сообщению — так куратор всегда видит их под
   * актуальным "хвостом" списка, какие бы chunks выше ни висели в истории
   * чата от предыдущих кликов.
   */
  async function sendClientsList(
    ctx: TelegrafContext,
    filter: ClientsFilter,
  ): Promise<void> {
    const { getAllPipelineStates } = await import("../pipeline/intake.js");
    const states = getAllPipelineStates();
    if (states.length === 0) {
      await ctx.reply("Клиентов пока нет.");
      return;
    }

    const chunks = renderClientsResponse(states, filter);
    const keyboard = clientsKeyboard(filter);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await ctx.reply(chunks[i]!, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(isLast ? { reply_markup: keyboard.reply_markup } : {}),
      });
    }
  }

  bot.command("clients", async (ctx) => {
    await sendClientsList(ctx, "all");
  });

  /**
   * Callback от inline-кнопок фильтра. Вместо редактирования предыдущего
   * сообщения отправляем НОВУЮ серию сообщений с отфильтрованным списком —
   * проще, надёжнее и понятнее в истории чата (старые состояния остаются
   * как лог "что куратор смотрел"). На редактирование тоже было бы плохо
   * масштабировать, потому что число chunks меняется от фильтра к фильтру.
   */
  bot.action(/^clients_filter:(.+)$/, async (ctx) => {
    const match = (ctx.match as RegExpMatchArray | undefined)?.[1];
    const filter: ClientsFilter =
      match === "all" || (PROGRAM_LABELS as readonly string[]).includes(match ?? "")
        ? (match as ClientsFilter)
        : "all";
    const filterLabel = filter === "all" ? "все" : filter;
    await ctx.answerCbQuery(`Фильтр: ${filterLabel}`).catch(() => undefined);
    await sendClientsList(ctx, filter);
  });

  // Поддержка коротких команд /client_<nick>, выпадающих из /clients.
  // Telegraf `bot.hears(regex)` не матчит сообщения с bot-command entity,
  // а каждую команду /client_<ник> статически регистрировать нельзя — ники
  // приходят и уходят. Поэтому ловим через общий text-хэндлер и диспатчим
  // сами (если не совпало — передаём дальше через next()).
  bot.on("text", async (ctx, next) => {
    const text = (ctx.message as { text?: string })?.text ?? "";

    // 0) Свободный ввод «направления для упаковки» из карточки клиента
    //    (prog:target_custom → текст в том же чате админа без reply).
    //    Если pending нет — просто возвращаем управление дальше.
    if (ctx.chat?.id != null && text.trim().length > 0 && !text.startsWith("/")) {
      const { handleTargetCustomReply } = await import("./admin-review.js");
      const handled = await handleTargetCustomReply(ctx.chat.id, text);
      if (handled) return;
    }

    // 1) Reject-reason reply (ForceReply из shortlist/deep review).
    const reply = (ctx.message as {
      reply_to_message?: { message_id?: number };
    } | undefined)?.reply_to_message;
    if (reply?.message_id != null && ctx.chat?.id != null) {
      const { takePendingReply } = await import("./pending-reply.js");
      const pending = takePendingReply(ctx.chat.id, reply.message_id);
      if (pending) {
        try {
          if (pending.kind === "shortlist:reject") {
            const { applyShortlistRejectReason } = await import("./shortlist-review.js");
            const ok = await applyShortlistRejectReason(
              pending.participantId,
              pending.slotId,
              text,
            );
            if (ok) await ctx.reply("✓ Причина отклонения сохранена.");
            else await ctx.reply("⚠ Не нашёл слот — возможно был удалён.");
          } else if (pending.kind === "deep:reject") {
            const { applyDeepRejectReason } = await import("./deep-review.js");
            const ok = await applyDeepRejectReason(
              pending.participantId,
              pending.slotId,
              text,
            );
            if (ok) await ctx.reply("✓ Причина отклонения сохранена.");
            else await ctx.reply("⚠ Не нашёл слот — возможно был удалён.");
          } else if (pending.kind === "resume:update") {
            await handleResumeUpdateMessage(ctx, {
              participantId: pending.participantId,
            });
          }
        } catch (err) {
          console.error("[Bot] reject reason apply failed:", err);
          await ctx.reply(
            `⚠ Ошибка сохранения причины: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }
    }

    const m = /^\/client_([\w\d]+)(@\w+)?\s*$/i.exec(text);
    if (!m) {
      return next();
    }

    const target = normalizeNick(m[1]);
    console.log(`[Bot] /client_${target} from chat=${ctx.chat?.id}`);

    const { getAllPipelineStates } = await import("../pipeline/intake.js");
    const { sendClientCard } = await import("./admin-review.js");

    const matches = getAllPipelineStates().filter(
      (s) => normalizeNick(s.telegramNick) === target,
    );
    if (matches.length === 0) {
      await ctx.reply(`Клиент @${target} не найден.`);
      return;
    }
    matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    try {
      await sendClientCard(ctx.chat!.id, matches[0].participantId);
    } catch (err) {
      console.error("[Bot] /client_X failed:", err);
      await ctx.reply(
        `Ошибка при отправке карточки: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  bot.command("client", async (ctx) => {
    const text = (ctx.message as { text?: string })?.text ?? "";
    const arg = text.replace(/^\/client(@\w+)?\s*/i, "").trim();
    if (!arg) {
      await ctx.reply(
        "Использование: /client <ник>\nНапример: /client @margaritako4 или /client margaritako4",
      );
      return;
    }

    const target = normalizeNick(arg);
    const { getAllPipelineStates } = await import("../pipeline/intake.js");
    const { sendClientCard } = await import("./admin-review.js");

    const matches = getAllPipelineStates().filter(
      (s) => normalizeNick(s.telegramNick) === target,
    );

    if (matches.length === 0) {
      await ctx.reply(`Клиент @${target} не найден.`);
      return;
    }

    matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (matches.length > 1) {
      await ctx.reply(
        `Найдено ${matches.length} записей с ником @${target}. Показываю самую свежую.`,
      );
    }

    await sendClientCard(ctx.chat!.id, matches[0].participantId);
  });

  registerResumeUpdate(bot);
  registerNotesCommands(bot);
  registerAdminReview(bot);

  try {
    await bot.telegram.setMyCommands([
      { command: "start", description: "Информация о боте" },
      { command: "clients", description: "Список клиентов со статусами" },
      { command: "client", description: "Карточка клиента: /client <ник>" },
      { command: "resume", description: "Обновить резюме: /resume <ник>" },
      { command: "status", description: "Сводка очереди по стейджам" },
    ]);
    await bot.telegram.setChatMenuButton({
      menuButton: { type: "commands" },
    });
    console.log("[Bot] Menu commands and button registered");
  } catch (err) {
    console.error("[Bot] Failed to set menu commands:", err);
  }

  const appUrl = process.env.APP_URL;

  if (appUrl && app) {
    webhookMode = true;
    const webhookPath = `/api/telegram-webhook`;
    const fullUrl = `${appUrl.replace(/\/$/, "")}${webhookPath}`;

    app.post(webhookPath, async (req, reply) => {
      try {
        await bot.handleUpdate(req.body as Parameters<typeof bot.handleUpdate>[0]);
        reply.send({ ok: true });
      } catch (err) {
        console.error("[Bot] Webhook update error:", err);
        reply.status(500).send({ error: "update processing failed" });
      }
    });

    await bot.telegram.setWebhook(fullUrl);
    console.log(`[Bot] Telegram webhook set: ${fullUrl}`);
  } else {
    bot.launch().then(() => {
      console.log("[Bot] Telegram bot polling started");
    }).catch((err) => {
      console.error("[Bot] Telegram bot launch failed:", err);
    });
    console.log("[Bot] Telegram bot starting (polling mode)...");
  }
}

export function stopBot(): void {
  try {
    const bot = getBot();
    if (webhookMode) {
      bot.telegram.deleteWebhook().catch(() => {});
    }
    bot.stop("SIGTERM");
    console.log("[Bot] Telegram bot stopped");
  } catch {
    // bot not initialized
  }
}
