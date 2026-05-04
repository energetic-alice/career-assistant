/**
 * Backfill `stageOutputs.pipelineInput` для всех клиентов на проде, у кого
 * есть `analysisInput`, но нет `pipelineInput`. Без этого кнопка
 * «Предварительный анализ» падает с ошибкой
 *   "Нет pipelineInput для клиента — не могу запустить анализ."
 *
 * Причина: у части клиентов (импорт через backfill-phase0 / legacy intake
 * / обновление резюме до последнего фикса saveResumeVersion) в
 * stageOutputs есть analysisInput, но нет pipelineInput — и shortlist
 * падал вместо того чтобы лениво пересобрать.
 *
 * Фикс в коде (см. src/bot/shortlist-review.ts + src/pipeline/intake.ts)
 * уже чинит новых клиентов и существующих «при первом клике», но этот
 * скрипт прямо сейчас чинит их массово, не дожидаясь, когда куратор нажмёт
 * кнопку на каждом.
 *
 * env:
 *   PROD_URL          base URL прода (default: prod render)
 *   WEBHOOK_SECRET    для /api/admin/upsert-states
 *   DRY_RUN=1         показать список, не пушить
 *   ONLY_PROGRAM=КА2  (опционально) починить только клиентов одной программы
 *   ONLY_NICKS=a,b,c  (опционально) ограничить список ник-ами
 */

import "dotenv/config";
import type { AnalysisPipelineInput } from "../pipeline/run-analysis.js";
import type { AnalysisInput } from "../schemas/participant.js";
import type { PipelineState } from "../schemas/pipeline-state.js";
import { normalizeNick } from "../services/intake-mapper.js";

const PROD_URL =
  process.env.PROD_URL ?? "https://career-assistant-w7z3.onrender.com";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";
const DRY_RUN = process.env.DRY_RUN === "1";
const ONLY_PROGRAM = (process.env.ONLY_PROGRAM ?? "").trim();
const ONLY_NICKS = (process.env.ONLY_NICKS ?? "")
  .split(",")
  .map((s) => normalizeNick(s.trim()))
  .filter(Boolean);

/**
 * Копия логики из src/pipeline/intake.ts → buildPipelineInput.
 * Дублируем специально: скрипт работает с сырым JSON из /api/participants
 * и не должен дёргать fastify-intake side-effects.
 */
function buildPipelineInput(
  analysisInput: AnalysisInput,
  resumeFileUrl?: string,
  rawNamedValues?: Record<string, string>,
): AnalysisPipelineInput {
  const { resumeText, linkedinUrl, linkedinSSI, ...questionnaireFields } =
    analysisInput;
  return {
    questionnaire: JSON.stringify(questionnaireFields, null, 2),
    resumeText: resumeText || "",
    linkedinUrl: linkedinUrl || "",
    linkedinSSI: linkedinSSI || "",
    resumeUrl: resumeFileUrl,
    ...(rawNamedValues ? { rawNamedValues } : {}),
  };
}

interface Diagnosis {
  nick: string;
  program: string;
  stage: string;
  hasAnalysisInput: boolean;
  hasPipelineInput: boolean;
  hasResumeText: boolean;
  reason: string;
}

async function main() {
  if (!DRY_RUN && !WEBHOOK_SECRET) {
    throw new Error(
      "WEBHOOK_SECRET not set — нужен для POST /api/admin/upsert-states (или DRY_RUN=1)",
    );
  }

  console.log(`PROD_URL:     ${PROD_URL}`);
  console.log(`DRY_RUN:      ${DRY_RUN}`);
  if (ONLY_PROGRAM) console.log(`ONLY_PROGRAM: ${ONLY_PROGRAM}`);
  if (ONLY_NICKS.length) console.log(`ONLY_NICKS:   ${ONLY_NICKS.join(", ")}`);
  console.log();

  const res = await fetch(`${PROD_URL}/api/participants`);
  if (!res.ok) throw new Error(`GET /api/participants → ${res.status}`);
  const all = (await res.json()) as PipelineState[];
  console.log(`Загружено ${all.length} клиентов с прода.\n`);

  const updated: Record<string, PipelineState> = {};
  const fixed: Diagnosis[] = [];
  const skipped: Diagnosis[] = [];
  const byProgram: Record<string, { total: number; broken: number; fixed: number }> = {};

  for (const s of all) {
    const nick = normalizeNick(s.telegramNick);
    if (ONLY_NICKS.length && !ONLY_NICKS.includes(nick)) continue;

    const outs = (s.stageOutputs ?? {}) as Record<string, unknown>;
    const program = (outs.program as string | undefined) ?? "—";

    if (ONLY_PROGRAM && program !== ONLY_PROGRAM) continue;

    byProgram[program] ??= { total: 0, broken: 0, fixed: 0 };
    byProgram[program].total += 1;

    const hasPipelineInput = !!outs.pipelineInput;
    const analysisInput = outs.analysisInput as AnalysisInput | undefined;
    const hasAnalysisInput = !!analysisInput;
    const hasResumeText = !!(analysisInput?.resumeText ?? "").trim();

    if (hasPipelineInput) continue;

    byProgram[program].broken += 1;

    const diag: Diagnosis = {
      nick,
      program,
      stage: s.stage,
      hasAnalysisInput,
      hasPipelineInput,
      hasResumeText,
      reason: "",
    };

    if (!hasAnalysisInput) {
      diag.reason = "нет analysisInput — анкета не дошла до intake, пропускаем";
      skipped.push(diag);
      continue;
    }

    const rawNamedValues = outs.rawNamedValues as
      | Record<string, string>
      | undefined;
    const resumeUrl = rawNamedValues?.resumeFileUrl;

    const rebuilt = buildPipelineInput(analysisInput, resumeUrl, rawNamedValues);

    const next: PipelineState = JSON.parse(JSON.stringify(s));
    const nextOuts = (next.stageOutputs ?? {}) as Record<string, unknown>;
    nextOuts.pipelineInput = rebuilt;
    next.stageOutputs = nextOuts;
    next.updatedAt = new Date().toISOString();
    updated[next.participantId] = next;

    diag.reason = hasResumeText
      ? "ок — собрали из analysisInput + rawNamedValues"
      : "ок (но резюме пустое — Phase 1 всё равно запустится, просто без resumeText)";
    fixed.push(diag);
    byProgram[program].fixed += 1;
  }

  console.log("=== По программам ===");
  for (const [prog, c] of Object.entries(byProgram).sort()) {
    console.log(
      `  ${prog.padEnd(6)}  total=${String(c.total).padStart(2)}  без pipelineInput=${String(
        c.broken,
      ).padStart(2)}  чиним=${String(c.fixed).padStart(2)}`,
    );
  }
  console.log();

  if (fixed.length) {
    console.log(`=== К починке (${fixed.length}) ===`);
    for (const d of fixed) {
      const resumeMark = d.hasResumeText ? "" : " [резюме пустое]";
      console.log(
        `  • @${d.nick.padEnd(22)} ${d.program.padEnd(5)} stage=${d.stage.padEnd(
          22,
        )} — ${d.reason}${resumeMark}`,
      );
    }
    console.log();
  }

  if (skipped.length) {
    console.log(`=== Пропущены (${skipped.length}) ===`);
    for (const d of skipped) {
      console.log(
        `  • @${d.nick.padEnd(22)} ${d.program.padEnd(5)} stage=${d.stage.padEnd(
          22,
        )} — ${d.reason}`,
      );
    }
    console.log();
  }

  if (DRY_RUN) {
    console.log("DRY_RUN=1 — на прод НЕ заливаем. Убери DRY_RUN и перезапусти.");
    return;
  }

  if (Object.keys(updated).length === 0) {
    console.log("Чинить нечего — у всех pipelineInput уже на месте.");
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
  if (!upsertRes.ok) throw new Error(`upsert failed (${upsertRes.status})`);

  console.log(
    `\n✅ Готово. Починили pipelineInput для ${Object.keys(updated).length} клиентов.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
