import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { toAnalysisInput } from "../schemas/participant.js";
import type { PipelineState } from "../schemas/pipeline-state.js";
import { runClientSummary } from "../pipeline/run-analysis.js";
import {
  normalizeNick,
  parseLegacyRow,
  parseNewRow,
  readXlsxRows,
  type ParsedXlsxRow,
} from "../services/xlsx-mapper.js";

const OLD_XLSX =
  process.env.SEED_OLD_XLSX ??
  path.resolve(process.cwd(), "../Анкета старая.xlsx");
const NEW_XLSX =
  process.env.SEED_NEW_XLSX ??
  path.resolve(process.cwd(), "../Анкета новая.xlsx");
const OUT =
  process.env.SEED_OUT ??
  path.resolve(process.cwd(), "data/pipelineStates.seed.json");

async function buildState(
  parsed: ParsedXlsxRow,
  stage: "awaiting_analysis" | "completed_legacy",
  extras: Record<string, unknown> = {},
): Promise<PipelineState> {
  const nickFromRow = parsed.raw["Твой ник в телеграм"]?.trim() ?? "";
  const telegramNick = nickFromRow.startsWith("@")
    ? nickFromRow
    : nickFromRow.startsWith("https://")
      ? `@${normalizeNick(nickFromRow)}`
      : `@${nickFromRow}`;

  const analysisInput = toAnalysisInput(parsed.questionnaire);

  let clientSummary: unknown | undefined;
  if (process.env.SEED_SKIP_SUMMARY === "1") {
    console.log(`  [Phase 0] skipped for ${telegramNick}`);
  } else {
    console.log(`  [Phase 0] summary for ${telegramNick}...`);
    try {
      clientSummary = await runClientSummary({
        rawNamedValues: parsed.rawNamedValues,
        resumeText: "",
        linkedinUrl: analysisInput.linkedinUrl,
        linkedinSSI: analysisInput.linkedinSSI,
      });
    } catch (err) {
      console.error(
        `  [Phase 0] failed for ${telegramNick}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const now = new Date().toISOString();
  return {
    participantId: crypto.randomUUID(),
    telegramNick,
    stage,
    createdAt: now,
    updatedAt: now,
    stageOutputs: {
      rawQuestionnaire: parsed.questionnaire,
      analysisInput,
      rawNamedValues: parsed.rawNamedValues,
      ...(parsed.unmapped.length > 0 ? { unmappedFields: parsed.unmapped } : {}),
      ...(clientSummary ? { clientSummary } : {}),
      ...extras,
    },
  };
}

async function main(): Promise<void> {
  if (!fs.existsSync(OLD_XLSX)) throw new Error(`Missing ${OLD_XLSX}`);
  if (!fs.existsSync(NEW_XLSX)) throw new Error(`Missing ${NEW_XLSX}`);

  console.log(`[Seed] Old XLSX: ${OLD_XLSX}`);
  console.log(`[Seed] New XLSX: ${NEW_XLSX}`);

  const limit = process.env.SEED_LIMIT
    ? Number(process.env.SEED_LIMIT)
    : undefined;

  const allOldRows = readXlsxRows(OLD_XLSX);
  const allNewRows = readXlsxRows(NEW_XLSX);
  const oldRows = limit ? allOldRows.slice(0, limit) : allOldRows;
  const newRows = limit ? allNewRows.slice(0, limit) : allNewRows;
  console.log(
    `[Seed] Legacy rows: ${oldRows.length}${limit ? ` (of ${allOldRows.length}, limited)` : ""}`,
  );
  console.log(
    `[Seed] New rows:    ${newRows.length}${limit ? ` (of ${allNewRows.length}, limited)` : ""}`,
  );

  const byNick = new Map<string, PipelineState>();

  console.log("\n[Seed] Processing legacy rows (stage=completed_legacy)");
  for (const row of oldRows) {
    const nick = normalizeNick(row["Твой ник в телеграм"] ?? "");
    if (!nick) {
      console.warn("  (skip) legacy row without nick");
      continue;
    }
    try {
      const parsed = parseLegacyRow(row);
      const legacyDocUrl = (row["Готовый анализ"] ?? "").trim() || undefined;
      const legacyTariff = (row["Тариф"] ?? "").trim() || undefined;
      const state = await buildState(parsed, "completed_legacy", {
        ...(legacyDocUrl ? { legacyDocUrl } : {}),
        ...(legacyTariff ? { legacyTariff } : {}),
      });
      byNick.set(nick, state);
      console.log(
        `  ✓ legacy ${state.telegramNick}${legacyDocUrl ? " + doc" : ""}${legacyTariff ? ` [${legacyTariff}]` : ""}`,
      );
    } catch (err) {
      console.error(
        `  ✗ legacy @${nick} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  console.log("\n[Seed] Processing NEW rows (stage=awaiting_analysis, new_wins)");
  for (const row of newRows) {
    const nick = normalizeNick(row["Твой ник в телеграм"] ?? "");
    if (!nick) {
      console.warn("  (skip) new row without nick");
      continue;
    }
    try {
      const parsed = parseNewRow(row);
      const state = await buildState(parsed, "awaiting_analysis");
      const override = byNick.has(nick);
      byNick.set(nick, state);
      console.log(
        `  ✓ new ${state.telegramNick}${override ? " (overrode legacy)" : ""}`,
      );
    } catch (err) {
      console.error(
        `  ✗ new @${nick} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const outObj: Record<string, PipelineState> = {};
  for (const state of byNick.values()) outObj[state.participantId] = state;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(outObj, null, 2), "utf-8");

  const byStage: Record<string, number> = {};
  for (const s of byNick.values()) byStage[s.stage] = (byStage[s.stage] || 0) + 1;

  console.log("\n[Seed] Done");
  console.log(`  Total: ${byNick.size}`);
  for (const [stage, count] of Object.entries(byStage)) {
    console.log(`  ${stage}: ${count}`);
  }
  console.log(`  → ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
