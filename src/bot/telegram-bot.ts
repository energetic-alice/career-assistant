import type { FastifyInstance } from "fastify";
import { initBot, getBot } from "./bot-instance.js";
import { registerAdminReview } from "./admin-review.js";

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

  registerAdminReview(bot);

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
