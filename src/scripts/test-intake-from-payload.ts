import "dotenv/config";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { initBot } from "../bot/bot-instance.js";
import { sendIntakeNotification } from "../bot/admin-review.js";
import {
  pipelineStates,
  parseNamedValues,
  getPipelineState,
  updatePipelineStage,
} from "../pipeline/intake.js";
import { runClientSummary } from "../pipeline/run-analysis.js";
import {
  rawQuestionnaireSchema,
  toAnalysisInput,
} from "../schemas/participant.js";
import {
  downloadFromGoogleDrive,
  extractResumeText,
} from "../services/file-service.js";
import { saveMap } from "../services/state-store.js";
import type { PipelineState } from "../schemas/pipeline-state.js";

/**
 * Локальная имитация полного intake-flow от Google Forms webhook.
 *
 *   tsx src/scripts/test-intake-from-payload.ts <payloadFile> [--regen]
 *
 * Что делает (один в один как fastify webhook handler):
 *   1) parseNamedValues → mapped/rawValues/unmapped
 *   2) собирает PipelineState и сохраняет (или находит существующий по нику и переписывает)
 *   3) грузит и парсит резюме
 *   4) runClientSummary (Phase 0)
 *   5) sendIntakeNotification (карточка + кнопка «Предварительный анализ»)
 *
 * Phase 1 НЕ запускается — стейдж остаётся awaiting_analysis.
 */

async function main() {
  const args = process.argv.slice(2);
  const payloadPath = args.find((a) => !a.startsWith("--"));
  const forceRegen = args.includes("--regen");
  if (!payloadPath) {
    console.error("Usage: tsx test-intake-from-payload.ts <payloadFile> [--regen]");
    process.exit(1);
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminChat = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
  if (!adminChat) throw new Error("TELEGRAM_ADMIN_CHAT_ID missing");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");

  initBot(token);

  const raw = await readFile(path.resolve(payloadPath), "utf-8");
  const body = JSON.parse(raw) as { namedValues: Record<string, string[]> };
  if (!body.namedValues) throw new Error("payload должен содержать namedValues");

  const parsed = parseNamedValues(body.namedValues);
  const questionnaire = rawQuestionnaireSchema.parse(parsed.mapped);
  const analysisInput = toAnalysisInput(questionnaire);

  console.log(`[Test] nick=${questionnaire.telegramNick}`);
  if (parsed.unmapped.length) {
    console.log(`[Test] ⚠ unmapped headers (${parsed.unmapped.length}):`);
    for (const h of parsed.unmapped) console.log(`         · ${h}`);
  }

  const nick = questionnaire.telegramNick.replace(/^@/, "").toLowerCase();
  const existing = Array.from(pipelineStates.values()).find(
    (s) => s.telegramNick.replace(/^@/, "").toLowerCase() === nick,
  );
  const participantId = existing?.participantId ?? crypto.randomUUID();
  const now = new Date().toISOString();

  const state: PipelineState = {
    participantId,
    telegramNick: questionnaire.telegramNick,
    stage: existing?.stage ?? "intake_received",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    stageOutputs: {
      ...(existing?.stageOutputs ?? {}),
      rawQuestionnaire: questionnaire,
      analysisInput,
      rawNamedValues: parsed.rawValues,
      ...(parsed.unmapped.length ? { unmappedFields: parsed.unmapped } : {}),
    },
  };
  pipelineStates.set(participantId, state);
  saveMap("pipelineStates", pipelineStates);
  console.log(`[Test] participant=${participantId}, stage=${state.stage}`);

  // ── Резюме (если URL есть и текста ещё нет) ──────────────────────────
  if (questionnaire.resumeFileUrl && !analysisInput.resumeText) {
    try {
      console.log("[Test] Downloading resume...");
      const url = questionnaire.resumeFileUrl.split(",")[0].trim();
      const { buffer, mimeType } = await downloadFromGoogleDrive(url);
      const resumeText = await extractResumeText(buffer, mimeType);
      (analysisInput as Record<string, unknown>).resumeText = resumeText;
      (state.stageOutputs as Record<string, unknown>).analysisInput = analysisInput;
      state.stage = "resume_parsed";
      saveMap("pipelineStates", pipelineStates);
      console.log(`[Test] Resume parsed (${resumeText.length} chars)`);
    } catch (err) {
      console.warn(
        `[Test] Resume parse FAILED, продолжаю без резюме: ${err instanceof Error ? err.message : err}`,
      );
    }
  } else if (!questionnaire.resumeFileUrl) {
    console.log("[Test] Резюме не приложено в анкете");
  }

  // ── Phase 0: client summary ──────────────────────────────────────────
  const outputs = state.stageOutputs as Record<string, unknown>;
  if (forceRegen) {
    console.log("[Test] --regen: dropping existing clientSummary");
    delete outputs.clientSummary;
  }
  if (!outputs.clientSummary) {
    console.log("[Test] Running Phase 0 (client summary)...");
    const summary = await runClientSummary({
      rawNamedValues: parsed.rawValues,
      resumeText: analysisInput.resumeText,
      linkedinUrl: analysisInput.linkedinUrl,
      linkedinSSI: analysisInput.linkedinSSI,
    });
    outputs.clientSummary = summary;
    console.log("[Test] Client summary:");
    console.log(JSON.stringify(summary, null, 2));
  }

  if (!outputs.pipelineInput) {
    const { resumeText, linkedinUrl, linkedinSSI, ...questionnaireFields } =
      analysisInput;
    outputs.pipelineInput = {
      questionnaire: JSON.stringify(questionnaireFields, null, 2),
      resumeText: resumeText || "",
      linkedinUrl: linkedinUrl || "",
      linkedinSSI: linkedinSSI || "",
      resumeUrl: questionnaire.resumeFileUrl,
    };
  }

  updatePipelineStage(participantId, "awaiting_analysis", outputs);

  // ── Шлём в Telegram ───────────────────────────────────────────────────
  console.log("[Test] Sending intake notification to admin chat...");
  await sendIntakeNotification(participantId);
  const updated = getPipelineState(participantId);
  console.log(`[Test] Done. Final stage: ${updated?.stage}`);
}

main().catch((err) => {
  console.error("[Test] FAILED:", err);
  process.exit(1);
});
