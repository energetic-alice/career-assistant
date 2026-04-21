import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { runClientSummary } from "../pipeline/run-analysis.js";
import type { PipelineState } from "../schemas/pipeline-state.js";
import type { AnalysisInput } from "../schemas/participant.js";

/**
 * Backfill clientSummary for prod participants missing it.
 *
 * Flow:
 *   1) GET prod /api/participants
 *   2) for each record WITHOUT stageOutputs.clientSummary that has rawNamedValues:
 *        call Phase 0 (runClientSummary) locally against the Anthropic SDK
 *   3) POST the whole map back to /api/admin/import-seed (overwrites store)
 *
 * This script is idempotent: records with an existing clientSummary are left
 * as-is, so re-running only fills the gaps.
 *
 * Env:
 *   PROD_URL        — override prod base URL (default: career-assistant-w7z3.onrender.com)
 *   WEBHOOK_SECRET  — секрет, который охраняет POST /api/admin/import-seed
 *   ANTHROPIC_API_KEY — для Claude
 *   BACKFILL_DRY=1  — только посчитать/напечатать, без записей
 */

const PROD_URL = process.env.PROD_URL || "https://career-assistant-w7z3.onrender.com";
const SECRET = process.env.WEBHOOK_SECRET || "";
const DRY = process.env.BACKFILL_DRY === "1";

if (!DRY && !SECRET) {
  console.error("WEBHOOK_SECRET is required (or set BACKFILL_DRY=1 to preview)");
  process.exit(1);
}

async function fetchProd(): Promise<PipelineState[]> {
  const res = await fetch(`${PROD_URL}/api/participants`);
  if (!res.ok) throw new Error(`GET /api/participants → HTTP ${res.status}`);
  return (await res.json()) as PipelineState[];
}

async function main(): Promise<void> {
  console.log(`[Backfill] Fetching prod from ${PROD_URL}`);
  const states = await fetchProd();
  console.log(`[Backfill] Received ${states.length} records`);

  const targets = states.filter((s) => {
    const outs = (s.stageOutputs ?? {}) as Record<string, unknown>;
    return !outs.clientSummary && outs.rawNamedValues;
  });
  console.log(`[Backfill] Missing clientSummary: ${targets.length}`);

  let filled = 0;
  for (const s of targets) {
    const outs = s.stageOutputs as Record<string, unknown>;
    const rawNamedValues = outs.rawNamedValues as Record<string, string>;
    const analysisInput = (outs.analysisInput ?? {}) as AnalysisInput;

    console.log(`  → @${s.telegramNick}`);
    if (DRY) {
      filled += 1;
      continue;
    }

    try {
      const summary = await runClientSummary({
        rawNamedValues,
        resumeText: analysisInput.resumeText || "",
        linkedinUrl: analysisInput.linkedinUrl || "",
        linkedinSSI: analysisInput.linkedinSSI || "",
      });
      outs.clientSummary = summary;
      s.updatedAt = new Date().toISOString();
      filled += 1;
      console.log(`    ✓ ${summary.firstNameLatin} ${summary.lastNameLatin}`);
    } catch (err) {
      console.error(
        `    ✗ failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(`[Backfill] Filled: ${filled}/${targets.length}`);

  if (DRY) {
    console.log("[Backfill] DRY-run, nothing sent to prod.");
    return;
  }
  if (filled === 0) {
    console.log("[Backfill] Nothing to upload.");
    return;
  }

  const map: Record<string, PipelineState> = {};
  for (const s of states) map[s.participantId] = s;

  const outFile = path.resolve(
    process.cwd(),
    "data/pipelineStates.backfilled.json",
  );
  fs.writeFileSync(outFile, JSON.stringify(map, null, 2), "utf-8");
  console.log(`[Backfill] Wrote ${outFile}`);

  const res = await fetch(`${PROD_URL}/api/admin/import-seed`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-secret": SECRET,
    },
    body: JSON.stringify(map),
  });
  const text = await res.text();
  console.log(`[Backfill] POST /api/admin/import-seed → HTTP ${res.status} ${text}`);
}

main().catch((err) => {
  console.error("[Backfill] Fatal:", err);
  process.exit(1);
});
