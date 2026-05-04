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
 * Запуск полного LinkedIn-pack pipeline (build-inputs → audit → headline →
 * render Markdown) на одном клиенте из локального `pipelineStates*.json`.
 *
 * Результат:
 *   - Markdown пишем в `./probe-output/linkedin-pack-<nick>.md`.
 *   - JSON артефакт пишем рядом в `./probe-output/linkedin-pack-<nick>.json`.
 *
 * Запуск:
 *   npx tsx src/scripts/probe-linkedin-pack.ts @evtitova3005
 *   npx tsx src/scripts/probe-linkedin-pack.ts evtitova3005
 */

interface StatePayload {
  participantId: string;
  telegramNick: string;
  stageOutputs?: {
    clientSummary?: ClientSummary;
    resumeVersions?: ResumeVersion[];
    activeResumeVersionId?: string | null;
  };
}

function findStateFile(): string {
  const dataDir = path.join(process.cwd(), "data");
  for (const name of [
    "pipelineStates.backfilled.json",
    "pipelineStates.migrated.json",
    "pipelineStates.json",
  ]) {
    const fp = path.join(dataDir, name);
    if (fs.existsSync(fp)) return fp;
  }
  throw new Error(`No pipelineStates*.json found in ${dataDir}`);
}

function findByNick(
  all: Record<string, StatePayload>,
  nick: string,
): StatePayload | null {
  const norm = nick.replace(/^@/, "").toLowerCase();
  for (const s of Object.values(all)) {
    if ((s.telegramNick ?? "").replace(/^@/, "").toLowerCase() === norm) {
      return s;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const argNick = process.argv[2];
  if (!argNick) {
    console.error(
      "Usage: npx tsx src/scripts/probe-linkedin-pack.ts <@nick>\n" +
        "Example: npx tsx src/scripts/probe-linkedin-pack.ts @evtitova3005",
    );
    process.exit(1);
  }

  const stateFile = findStateFile();
  const raw = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as Record<
    string,
    StatePayload
  >;
  const state = findByNick(raw, argNick);
  if (!state) {
    console.error(`Client @${argNick} not found in ${stateFile}`);
    process.exit(1);
  }

  const outputs = state.stageOutputs ?? {};
  const clientSummary = outputs.clientSummary;
  if (!clientSummary) {
    console.error(
      `Client @${argNick} has no clientSummary — запусти analysis пайплайн сначала`,
    );
    process.exit(1);
  }

  const resumeVersions = Array.isArray(outputs.resumeVersions)
    ? outputs.resumeVersions
    : [];

  console.log(
    `[probe] client: @${state.telegramNick}  pid=${state.participantId}`,
  );
  console.log(`[probe] linkedinUrl: ${clientSummary.linkedinUrl ?? "(none)"}`);
  console.log(`[probe] resumeVersions: ${resumeVersions.length}`);

  const args: BuildLinkedinPackInputsArgs = {
    participantId: state.participantId,
    nick: state.telegramNick,
    clientSummary,
    resumeVersions,
    activeResumeVersionId: outputs.activeResumeVersionId ?? null,
  };

  const t0 = Date.now();
  console.log(`\n[probe] → buildLinkedinPackInputs()`);
  const input = await buildLinkedinPackInputs(args);
  console.log(
    `[probe] inputs ready · linkedin=${
      input.linkedin ? `${input.linkedin.source} (${input.linkedin.text.length} chars)` : "—"
    } · resume=${input.resume ? `${input.resume.text.length} chars` : "—"}`,
  );

  console.log(`\n[probe] → runLinkedinPack()`);
  const result = await runLinkedinPack(input);
  const ms = Date.now() - t0;
  console.log(
    `\n[probe] pack generated in ${(ms / 1000).toFixed(1)}s ` +
      `(audit=${(result.timings.auditMs / 1000).toFixed(1)}s, ` +
      `headline=${(result.timings.headlineMs / 1000).toFixed(1)}s, ` +
      `profile=${(result.timings.profileMs / 1000).toFixed(1)}s)`,
  );
  const a = result.data.audit;
  console.log(
    `[probe] audit: ${a.passCount} pass · ${a.failCount} fail · ${a.unknownCount} unknown / ${a.totalCount} items  ` +
      `variants=${result.data.headline.variants.length}  ` +
      `profileContent=${result.data.profileContent ? "ok" : "missing"}`,
  );

  const md = renderLinkedinPack(result.data);

  const outDir = path.join(process.cwd(), "probe-output");
  fs.mkdirSync(outDir, { recursive: true });
  const nick = state.telegramNick.replace(/^@/, "");
  const mdPath = path.join(outDir, `linkedin-pack-${nick}.md`);
  const jsonPath = path.join(outDir, `linkedin-pack-${nick}.json`);
  fs.writeFileSync(mdPath, md, "utf-8");
  fs.writeFileSync(jsonPath, JSON.stringify(result.data, null, 2), "utf-8");
  console.log(`\n[probe] saved:\n  ${mdPath}\n  ${jsonPath}`);

  console.log(`\n=== MARKDOWN PREVIEW (first 60 lines) ===\n`);
  console.log(md.split("\n").slice(0, 60).join("\n"));
  console.log(`\n=== (truncated) ===`);
}

main().catch((err) => {
  console.error("[probe] fatal:", err);
  process.exit(1);
});
