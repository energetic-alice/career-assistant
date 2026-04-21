import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { initBot } from "../bot/bot-instance.js";
import { sendIntakeNotification } from "../bot/admin-review.js";
import {
  pipelineStates,
  getPipelineState,
  updatePipelineStage,
} from "../pipeline/intake.js";
import { runClientSummary } from "../pipeline/run-analysis.js";
import type { AnalysisInput } from "../schemas/participant.js";
import type { ClientSummary } from "../schemas/client-summary.js";

/**
 * Local smoke-test для нового intake-flow на анкете Маргариты.
 *
 *   tsx src/scripts/test-margarita-intake.ts
 *
 * Что делает:
 *   1. Берёт существующий state @margaritako4 (он уже в data/pipelineStates.json,
 *      stage=resume_parsed).
 *   2. Если нет clientSummary — зовёт Claude (Phase 0), сохраняет.
 *   3. Если нет pipelineInput — строит и сохраняет.
 *   4. Переводит stage в awaiting_analysis.
 *   5. Шлёт sendIntakeNotification: «🆕 Новая анкета» + карточка с кнопкой
 *      «🔍 Предварительный анализ».
 *
 * Heavy Phase 1 НЕ запускается — он стартанёт по клику кнопки в Telegram.
 */

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminChat = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
  if (!adminChat) throw new Error("TELEGRAM_ADMIN_CHAT_ID missing");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");

  initBot(token);

  const target = "margaritako4";
  const match = Array.from(pipelineStates.values()).find(
    (s) => s.telegramNick.replace(/^@/, "").toLowerCase() === target,
  );
  if (!match) {
    console.error(`[Test] @${target} не найден в pipelineStates.json`);
    process.exit(1);
  }

  const participantId = match.participantId;
  console.log(`[Test] participant=${participantId}, stage=${match.stage}`);

  const outputs = (match.stageOutputs ?? {}) as Record<string, unknown>;
  const analysisInput = outputs.analysisInput as AnalysisInput | undefined;
  const rawNamedValues = outputs.rawNamedValues as Record<string, string> | undefined;

  if (!analysisInput) throw new Error("analysisInput missing in state");
  if (!rawNamedValues) throw new Error("rawNamedValues missing in state");

  // ── Phase 0: client summary ────────────────────────────────────────────
  const forceRegen = process.argv.includes("--regen");
  if (forceRegen) {
    console.log("[Test] --regen passed: dropping existing clientSummary");
    delete outputs.clientSummary;
  }
  let clientSummary = outputs.clientSummary as ClientSummary | undefined;
  if (!clientSummary) {
    console.log("[Test] Running Phase 0 (client summary)...");
    clientSummary = await runClientSummary({
      rawNamedValues,
      resumeText: analysisInput.resumeText,
      linkedinUrl: analysisInput.linkedinUrl,
      linkedinSSI: analysisInput.linkedinSSI,
    });
    outputs.clientSummary = clientSummary;
    console.log("[Test] Client summary:");
    console.log(JSON.stringify(clientSummary, null, 2));
  } else {
    console.log("[Test] clientSummary уже есть, переиспользую");
  }

  // ── Подготовка pipelineInput для будущего Phase 1 ──────────────────────
  if (!outputs.pipelineInput) {
    const { resumeText, linkedinUrl, linkedinSSI, ...questionnaireFields } =
      analysisInput;
    outputs.pipelineInput = {
      questionnaire: JSON.stringify(questionnaireFields, null, 2),
      resumeText: resumeText || "",
      linkedinUrl: linkedinUrl || "",
      linkedinSSI: linkedinSSI || "",
      resumeUrl: undefined,
    };
  }

  updatePipelineStage(participantId, "awaiting_analysis", outputs);

  // ── Шлём в Telegram: 2 сообщения + кнопка ──────────────────────────────
  console.log("[Test] Sending intake notification to admin chat...");
  await sendIntakeNotification(participantId);

  const updated = getPipelineState(participantId);
  console.log(`[Test] Done. Final stage: ${updated?.stage}`);
}

main().catch((err) => {
  console.error("[Test] FAILED:", err);
  process.exit(1);
});
