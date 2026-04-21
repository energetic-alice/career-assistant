/**
 * Local smoke-test для нового sendClientCard:
 *   - читает state Маргариты из data/pipelineStates.json
 *   - формирует card (HTML caption) и htmlDoc (.html attachment)
 *   - шлёт sendDocument в админ-чат напрямую через Telegram API
 *     (без поднятия polling — прод-бот не страдает)
 */

import { readFileSync } from "node:fs";
import "dotenv/config";
import {
  formatClientCardForTelegram,
  formatQuestionnaireForTelegram,
} from "../services/review-summary.js";
import type { RawQuestionnaire } from "../schemas/participant.js";
import type { PipelineStage } from "../schemas/pipeline-state.js";

interface State {
  telegramNick: string;
  stage: PipelineStage;
  stageOutputs?: {
    rawQuestionnaire?: RawQuestionnaire;
    rawNamedValues?: Record<string, string>;
    unmappedFields?: string[];
  };
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID не заданы");

const TG = `https://api.telegram.org/bot${token}`;

const states = JSON.parse(readFileSync("data/pipelineStates.json", "utf-8")) as Record<string, State>;
const margarita = Object.entries(states).find(
  ([, s]) => (s.telegramNick || "").toLowerCase().includes("margarita"),
);
if (!margarita) throw new Error("Не нашла Маргариту в pipelineStates.json");

const [pid, state] = margarita;
const rq = state.stageOutputs?.rawQuestionnaire;
const rnv = state.stageOutputs?.rawNamedValues;
const unmapped = state.stageOutputs?.unmappedFields ?? [];

const cardHtml = formatClientCardForTelegram({
  telegramNick: state.telegramNick,
  stage: state.stage,
  rawQuestionnaire: rq,
  rawNamedValues: rnv,
});

const nick = (state.telegramNick || "client").replace(/^@/, "");
const safeNick = nick.replace(/[^a-zA-Z0-9_\-]/g, "_");

const htmlDoc = formatQuestionnaireForTelegram(rq, rnv, {
  title: `Анкета @${nick}`,
  unmapped,
});

console.log(`[${state.telegramNick}] participant=${pid}`);
console.log(`  stage=${state.stage}`);
console.log(`  card length=${cardHtml.length}`);
console.log(`  htmlDoc length=${htmlDoc.length}`);
console.log(`  unmapped=${unmapped.length}`);

const form = new FormData();
form.append("chat_id", String(chatId));
form.append("caption", cardHtml);
form.append("parse_mode", "HTML");
form.append(
  "document",
  new Blob([htmlDoc], { type: "text/html" }),
  `Анкета_${safeNick}.html`,
);

const res = await fetch(`${TG}/sendDocument`, { method: "POST", body: form });
const j = (await res.json()) as { ok: boolean; description?: string };
if (!j.ok) throw new Error(`sendDocument failed: ${j.description}`);

console.log("Готово.");
