/**
 * Backfill Phase 0 (clientSummary) для клиентов, чья анкета пришла ДО того,
 * как `runClientSummary` появился в `processResumeAndRunAnalysis` (коммит 719c1d2,
 * 2026-04-21 11:02). Они застряли в `intake_received` / `resume_parsed`
 * без `clientSummary`, поэтому /clients показывает их без имени/локации/таргета.
 *
 * Делает:
 *   1) GET https://career-assistant-w7z3.onrender.com/api/participants
 *   2) фильтрует тех, у кого есть rawQuestionnaire/rawNamedValues, но НЕТ clientSummary
 *   3) для каждого:
 *        - если есть resumeFileUrl и НЕТ analysisInput.resumeText → парсим Drive
 *        - вызываем runClientSummary
 *        - кладём clientSummary, восстанавливаем pipelineInput
 *        - двигаем stage → "awaiting_analysis"
 *   4) POST /api/admin/upsert-states одним заходом со всеми гидрированными state-ами
 *
 * Доп. опции (env):
 *   PROD_URL          — base URL прода (default: https://career-assistant-w7z3.onrender.com)
 *   WEBHOOK_SECRET    — для авторизации в upsert-states
 *   DRY_RUN=1         — только посчитать и собрать summary'и, не пушить
 *   ONLY_NICKS=a,b,c  — ограничить список ник-ами
 */

import "dotenv/config";
import {
  downloadFromGoogleDrive,
  extractResumeText,
} from "../services/file-service.js";
import { runClientSummary } from "../pipeline/run-analysis.js";
import type { PipelineState } from "../schemas/pipeline-state.js";
import type {
  AnalysisInput,
  RawQuestionnaire,
} from "../schemas/participant.js";
import { normalizeNick } from "../services/intake-mapper.js";

const PROD_URL =
  process.env.PROD_URL ?? "https://career-assistant-w7z3.onrender.com";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";
const DRY_RUN = process.env.DRY_RUN === "1";
const ONLY_NICKS = (process.env.ONLY_NICKS ?? "")
  .split(",")
  .map((s) => normalizeNick(s.trim()))
  .filter(Boolean);

interface AnalysisPipelineInput {
  questionnaire: string;
  resumeText: string;
  linkedinUrl: string;
  linkedinSSI: string;
  resumeUrl?: string;
  rawNamedValues?: Record<string, string>;
}

function buildPipelineInput(
  analysisInput: AnalysisInput,
  resumeFileUrl?: string,
  rawNamedValues?: Record<string, string>,
): AnalysisPipelineInput {
  const { resumeText, linkedinUrl, linkedinSSI, ...rest } = analysisInput;
  return {
    questionnaire: JSON.stringify(rest, null, 2),
    resumeText: resumeText || "",
    linkedinUrl: linkedinUrl || "",
    linkedinSSI: linkedinSSI || "",
    resumeUrl: resumeFileUrl,
    ...(rawNamedValues ? { rawNamedValues } : {}),
  };
}

function pickFirstUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  return raw.split(",").map((u) => u.trim()).find(Boolean);
}

async function processOne(state: PipelineState): Promise<{
  state: PipelineState;
  changed: boolean;
  notes: string[];
}> {
  const notes: string[] = [];
  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const rawQuestionnaire = outputs.rawQuestionnaire as RawQuestionnaire | undefined;
  const rawNamedValues = outputs.rawNamedValues as
    | Record<string, string>
    | undefined;
  const analysisInput = outputs.analysisInput as AnalysisInput | undefined;

  if (!rawQuestionnaire || !rawNamedValues || !analysisInput) {
    notes.push("missing rawQuestionnaire/rawNamedValues/analysisInput — skip");
    return { state, changed: false, notes };
  }

  // 1) Резюме: если есть resumeFileUrl и нет текста — пробуем дотянуть.
  const resumeFileUrl = pickFirstUrl(rawQuestionnaire.resumeFileUrl);
  if (resumeFileUrl && !analysisInput.resumeText) {
    try {
      const { buffer, mimeType } = await downloadFromGoogleDrive(resumeFileUrl);
      const text = await extractResumeText(buffer, mimeType);
      (analysisInput as Record<string, unknown>).resumeText = text;
      notes.push(`resume parsed (${text.length}c)`);
      if (state.stage === "intake_received") {
        state.stage = "resume_parsed";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outputs.resumeError = msg;
      notes.push(`resume failed: ${msg.slice(0, 120)}`);
    }
  } else if (analysisInput.resumeText) {
    notes.push(`resume already present (${analysisInput.resumeText.length}c)`);
  } else {
    notes.push("no resumeFileUrl");
  }

  // 2) Phase 0: client summary
  if (!outputs.clientSummary) {
    try {
      const summary = await runClientSummary({
        rawNamedValues,
        resumeText: analysisInput.resumeText,
        linkedinUrl: analysisInput.linkedinUrl,
        linkedinSSI: analysisInput.linkedinSSI,
      });
      outputs.clientSummary = summary;
      notes.push(
        `summary OK (${summary.firstNameLatin} ${summary.lastNameLatin}, ` +
          `${summary.currentProfessionSlug ?? "non-IT"})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notes.push(`summary FAILED: ${msg.slice(0, 200)}`);
      return { state, changed: false, notes };
    }
  } else {
    notes.push("clientSummary already present");
  }

  // 3) pipelineInput
  if (!outputs.pipelineInput) {
    outputs.pipelineInput = buildPipelineInput(
      analysisInput,
      resumeFileUrl,
      rawNamedValues,
    );
    notes.push("pipelineInput built");
  }

  // 4) Двигаем stage в awaiting_analysis (если ниже).
  if (state.stage === "intake_received" || state.stage === "resume_parsed") {
    state.stage = "awaiting_analysis";
    notes.push("stage → awaiting_analysis");
  }

  state.updatedAt = new Date().toISOString();
  return { state, changed: true, notes };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set — нужен для runClientSummary");
  }
  if (!DRY_RUN && !WEBHOOK_SECRET) {
    throw new Error(
      "WEBHOOK_SECRET not set — нужен для POST /api/admin/upsert-states (или DRY_RUN=1)",
    );
  }

  console.log(`PROD_URL: ${PROD_URL}`);
  console.log(`DRY_RUN:  ${DRY_RUN}`);
  if (ONLY_NICKS.length) console.log(`ONLY_NICKS: ${ONLY_NICKS.join(", ")}`);
  console.log();

  const res = await fetch(`${PROD_URL}/api/participants`);
  if (!res.ok) throw new Error(`GET /api/participants → ${res.status}`);
  const all = (await res.json()) as PipelineState[];
  console.log(`Загружено ${all.length} клиентов с прода.`);

  const candidates = all.filter((s) => {
    const so = (s.stageOutputs ?? {}) as Record<string, unknown>;
    const hasRq = !!so.rawQuestionnaire && !!so.rawNamedValues;
    const hasCs = !!so.clientSummary;
    if (!hasRq || hasCs) return false;
    if (ONLY_NICKS.length > 0) {
      return ONLY_NICKS.includes(normalizeNick(s.telegramNick));
    }
    return true;
  });

  console.log(
    `Кандидатов на бэкфилл (rawQuestionnaire ✓, clientSummary ✗): ${candidates.length}`,
  );
  for (const s of candidates) {
    console.log(
      `  • @${normalizeNick(s.telegramNick)}  stage=${s.stage}  created=${s.createdAt.slice(0, 10)}`,
    );
  }
  if (candidates.length === 0) {
    console.log("\nНечего бэкфилить. Выходим.");
    return;
  }

  const updated: Record<string, PipelineState> = {};
  for (const s of candidates) {
    const nick = normalizeNick(s.telegramNick);
    console.log(`\n──── @${nick} ────`);
    const { state, changed, notes } = await processOne(
      JSON.parse(JSON.stringify(s)) as PipelineState,
    );
    for (const n of notes) console.log(`   • ${n}`);
    if (changed) {
      updated[state.participantId] = state;
    }
  }

  console.log(`\nГотово к заливке: ${Object.keys(updated).length}`);

  if (DRY_RUN) {
    console.log("\nDRY_RUN=1 — не пушим. Снимите DRY_RUN и перезапустите.");
    return;
  }

  if (Object.keys(updated).length === 0) {
    console.log("Заливать нечего.");
    return;
  }

  const upsertRes = await fetch(`${PROD_URL}/api/admin/upsert-states`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-secret": WEBHOOK_SECRET,
    },
    body: JSON.stringify({ states: updated }),
  });
  const body = await upsertRes.text();
  console.log(`\nupsert-states → ${upsertRes.status}: ${body}`);
  if (!upsertRes.ok) {
    throw new Error(`upsert failed (${upsertRes.status})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
