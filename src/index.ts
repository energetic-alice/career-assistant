import "dotenv/config";
import Fastify from "fastify";
import { registerIntakeRoutes } from "./pipeline/intake.js";
import { startBot, stopBot } from "./bot/telegram-bot.js";

const app = Fastify({ logger: true });

registerIntakeRoutes(app);

app.get("/health", async () => ({
  status: "ok",
  docMethod: process.env.APPS_SCRIPT_DOC_URL ? "apps-script" : "drive-api",
}));

const port = Number(process.env.PORT) || 3000;

async function main() {
  try {
    await startBot(app);
  } catch (err) {
    console.error("[Main] Failed to start Telegram bot:", err);
  }

  try {
    const address = await app.listen({ port, host: "0.0.0.0" });
    app.log.info(`Server listening at ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

function shutdown() {
  console.log("[Main] Shutting down...");
  stopBot();
  app.close().then(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main();
