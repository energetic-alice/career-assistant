import type { FastifyInstance } from "fastify";
import { initBot, getBot } from "./bot-instance.js";
import { registerAdminReview } from "./admin-review.js";
import { STAGE_LABELS } from "../services/review-summary.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import { normalizeNick } from "../services/intake-mapper.js";
import { formatRegions } from "../services/market-access.js";

function escapeHtml(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

  bot.command("clients", async (ctx) => {
    const { getAllPipelineStates } = await import("../pipeline/intake.js");
    const states = getAllPipelineStates();
    if (states.length === 0) {
      await ctx.reply("Клиентов пока нет.");
      return;
    }

    const sorted = [...states].sort((a, b) =>
      normalizeNick(a.telegramNick).localeCompare(
        normalizeNick(b.telegramNick),
        "ru",
      ),
    );

    const lines: string[] = [`<b>Клиенты (${sorted.length}):</b>`, ""];
    for (const s of sorted) {
      const nick = normalizeNick(s.telegramNick) || "—";
      const cs = (s.stageOutputs as { clientSummary?: ClientSummary } | undefined)?.clientSummary;
      const name = cs
        ? [cs.firstName, cs.lastName].filter((x) => x && x !== "—").join(" ") ||
          [cs.firstNameLatin, cs.lastNameLatin].filter((x) => x && x !== "—").join(" ")
        : "";

      // Компактная инфо-строка рядом с ником: что делает + где живёт → на какой рынок метит + англ.
      // Все значения прогоняем через escapeHtml, чтобы "&" / "<" / ">" в полях
      // (например "R&D", "C++ & Python") не ломали parse_mode=HTML.
      const contextParts: string[] = [];
      // Если Клод классифицировал текущую профессию в canonical slug — показываем
      // его (стабильнее, короче, читаемее чем raw). Иначе fallback на raw текст.
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
      const stageLabel = STAGE_LABELS[s.stage] ?? s.stage;

      lines.push(`<b>@${escapeHtml(nick)}</b>${nameStr}${context}`);
      lines.push(`  ${escapeHtml(stageLabel)} — /client_${nick}`);
      lines.push("");
    }

    // Telegram режет тело сообщения 4096 симв. Чтобы /clients не терялся при
    // больших списках, аккуратно режем по двойному переводу строки (границы
    // между клиентами) и отправляем несколько сообщений.
    const CHUNK_LIMIT = 3500;
    const text = lines.join("\n");
    const chunks: string[] = [];
    if (text.length <= CHUNK_LIMIT) {
      chunks.push(text);
    } else {
      let buf = "";
      for (const block of text.split("\n\n")) {
        const withBlock = buf ? `${buf}\n\n${block}` : block;
        if (withBlock.length > CHUNK_LIMIT && buf) {
          chunks.push(buf);
          buf = block;
        } else {
          buf = withBlock;
        }
      }
      if (buf) chunks.push(buf);
    }

    for (const chunk of chunks) {
      await ctx.reply(chunk, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    }
  });

  // Поддержка коротких команд /client_<nick>, выпадающих из /clients.
  // Telegraf `bot.hears(regex)` не матчит сообщения с bot-command entity,
  // а каждую команду /client_<ник> статически регистрировать нельзя — ники
  // приходят и уходят. Поэтому ловим через общий text-хэндлер и диспатчим
  // сами (если не совпало — передаём дальше через next()).
  bot.on("text", async (ctx, next) => {
    const text = (ctx.message as { text?: string })?.text ?? "";
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

  registerAdminReview(bot);

  try {
    await bot.telegram.setMyCommands([
      { command: "start", description: "Информация о боте" },
      { command: "clients", description: "Список клиентов со статусами" },
      { command: "client", description: "Карточка клиента: /client <ник>" },
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
