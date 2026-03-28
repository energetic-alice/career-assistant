import { Telegraf } from "telegraf";

let bot: Telegraf | null = null;

export function initBot(token: string): Telegraf {
  bot = new Telegraf(token);
  return bot;
}

export function getBot(): Telegraf {
  if (!bot) {
    throw new Error("Bot not initialized. Call startBot() first.");
  }
  return bot;
}

export function getAdminChatId(): string {
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!chatId) {
    throw new Error("TELEGRAM_ADMIN_CHAT_ID is not set");
  }
  return chatId;
}
