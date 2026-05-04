import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import {
  buildLinkedinPackInputs,
  type BuildLinkedinPackInputsArgs,
} from "../services/linkedin-pack/build-inputs.js";
import { runLinkedinPack } from "../services/linkedin-pack/run-pack.js";
import { renderLinkedinPack } from "../services/linkedin-pack/renderer.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import type { ResumeVersion } from "../pipeline/intake.js";

/**
 * Запуск полного LinkedIn-pack pipeline на клиенте, взятом ИЗ ПРОДА.
 * Отличается от `probe-linkedin-pack.ts` (который читает локальный
 * `data/pipelineStates.json`) тем, что делает GET на `/api/participants`
 * и получает **актуальный** stateOutputs с последними версиями резюме,
 * client summary и т.д. Это то, что хочет куратор для быстрой проверки
 * «а если клиент обновил резюме / анкету, пак теперь подтянет?».
 *
 * Запуск:
 *   npx tsx src/scripts/probe-linkedin-from-prod.ts @olenka_kravchenko
 *
 * Результат:
 *   - Markdown: `./probe-output/linkedin-pack-prod-<nick>.md`
 *   - JSON:     `./probe-output/linkedin-pack-prod-<nick>.json`
 *
 * Кеш LinkedIn-профиля пишется в `data/documents/<participantId>/linkedin-profile.json`
 * (ровно в то же место, что использует прод-бот), так что если тот же клиент
 * уже скрапался за последние 180 дней — Apify повторно не дёргаем.
 */

const PROD_URL =
  process.env.PROD_URL ?? "https://career-assistant-w7z3.onrender.com";

interface PipelineStateFromProd {
  participantId: string;
  telegramNick: string;
  stage: string;
  stageOutputs?: {
    clientSummary?: ClientSummary;
    resumeVersions?: ResumeVersion[];
    activeResumeVersionId?: string | null;
  };
}

async function fetchProdState(
  nick: string,
): Promise<PipelineStateFromProd | null> {
  const res = await fetch(`${PROD_URL}/api/participants`);
  if (!res.ok) throw new Error(`GET /api/participants → ${res.status}`);
  const all = (await res.json()) as PipelineStateFromProd[];
  const norm = nick.replace(/^@/, "").toLowerCase();
  return (
    all.find(
      (s) =>
        (s.telegramNick ?? "").replace(/^@/, "").toLowerCase() === norm,
    ) ?? null
  );
}

async function main(): Promise<void> {
  const argNick = process.argv[2];
  if (!argNick) {
    console.error(
      "Usage: npx tsx src/scripts/probe-linkedin-from-prod.ts <@nick>\n" +
        "Example: npx tsx src/scripts/probe-linkedin-from-prod.ts @olenka_kravchenko",
    );
    process.exit(1);
  }

  console.log(`[probe-prod] fetching state from ${PROD_URL}…`);
  const state = await fetchProdState(argNick);
  if (!state) {
    console.error(`Client @${argNick} not found on prod`);
    process.exit(1);
  }

  const outputs = state.stageOutputs ?? {};
  const clientSummary = outputs.clientSummary ?? null;
  const resumeVersions = Array.isArray(outputs.resumeVersions)
    ? outputs.resumeVersions
    : [];

  console.log(
    `[probe-prod] client: @${state.telegramNick}  pid=${state.participantId}  stage=${state.stage}`,
  );
  console.log(
    `[probe-prod] clientSummary: ${clientSummary ? "present" : "—"}  resumeVersions: ${resumeVersions.length}  activeResumeId: ${outputs.activeResumeVersionId ?? "—"}`,
  );

  const args: BuildLinkedinPackInputsArgs = {
    participantId: state.participantId,
    nick: state.telegramNick,
    clientSummary,
    resumeVersions,
    activeResumeVersionId: outputs.activeResumeVersionId ?? null,
  };

  const t0 = Date.now();
  console.log(`\n[probe-prod] → buildLinkedinPackInputs()`);
  const input = await buildLinkedinPackInputs(args);
  console.log(
    `[probe-prod] inputs ready · linkedin=${
      input.linkedin
        ? `${input.linkedin.source} (${input.linkedin.text.length} chars)`
        : "—"
    } · resume=${input.resume ? `${input.resume.text.length} chars` : "—"}`,
  );

  console.log(`\n[probe-prod] → runLinkedinPack()`);
  const result = await runLinkedinPack(input);
  const ms = Date.now() - t0;
  console.log(
    `\n[probe-prod] pack generated in ${(ms / 1000).toFixed(1)}s ` +
      `(audit=${(result.timings.auditMs / 1000).toFixed(1)}s, ` +
      `headline=${(result.timings.headlineMs / 1000).toFixed(1)}s, ` +
      `profile=${(result.timings.profileMs / 1000).toFixed(1)}s)`,
  );
  const a = result.data.audit;
  const h = result.data.headline;
  console.log(
    `[probe-prod] audit: ${a.passCount} pass · ${a.failCount} fail · ${a.unknownCount} unknown / ${a.totalCount} items  ` +
      `variants=${h.variants.length}  marketKw=${h.marketKeywords.length}  gaps=${h.clientGaps.length}  ` +
      `profileContent=${result.data.profileContent ? "ok" : "missing"}`,
  );

  const md = renderLinkedinPack(result.data);

  const outDir = path.join(process.cwd(), "probe-output");
  fs.mkdirSync(outDir, { recursive: true });
  const nick = state.telegramNick.replace(/^@/, "");
  const mdPath = path.join(outDir, `linkedin-pack-prod-${nick}.md`);
  const jsonPath = path.join(outDir, `linkedin-pack-prod-${nick}.json`);
  fs.writeFileSync(mdPath, md, "utf-8");
  fs.writeFileSync(jsonPath, JSON.stringify(result.data, null, 2), "utf-8");
  console.log(`\n[probe-prod] saved:\n  ${mdPath}\n  ${jsonPath}`);

  console.log(`\n=== MARKDOWN PREVIEW (first 60 lines) ===\n`);
  console.log(md.split("\n").slice(0, 60).join("\n"));
  console.log(`\n=== (truncated) ===`);
}

main().catch((err) => {
  console.error("[probe-prod] fatal:", err);
  process.exit(1);
});
