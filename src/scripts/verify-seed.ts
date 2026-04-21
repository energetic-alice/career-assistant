import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { PipelineState } from "../schemas/pipeline-state.js";
import type { RawQuestionnaire } from "../schemas/participant.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import {
  formatClientCardForTelegram,
  STAGE_LABELS,
} from "../services/review-summary.js";

const SEED =
  process.env.SEED_IN ??
  path.resolve(process.cwd(), "data/pipelineStates.seed.json");

function loadStates(): PipelineState[] {
  const raw = fs.readFileSync(SEED, "utf-8");
  const obj = JSON.parse(raw) as Record<string, PipelineState>;
  return Object.values(obj);
}

function renderClientsList(all: PipelineState[]): string {
  const sorted = [...all].sort((a, b) =>
    a.telegramNick.replace(/^@/, "").toLowerCase().localeCompare(
      b.telegramNick.replace(/^@/, "").toLowerCase(),
      "ru",
    ),
  );

  const lines: string[] = [`<b>Клиенты (${sorted.length}):</b>`, ""];
  for (const s of sorted) {
    const nick = s.telegramNick.replace(/^@/, "") || "—";
    const cs = (s.stageOutputs as { clientSummary?: ClientSummary } | undefined)
      ?.clientSummary;
    const name = cs
      ? [cs.firstName, cs.lastName].filter((x) => x && x !== "—").join(" ") ||
        [cs.firstNameLatin, cs.lastNameLatin]
          .filter((x) => x && x !== "—")
          .join(" ")
      : "";
    const stageLabel = STAGE_LABELS[s.stage] ?? s.stage;
    const head = name ? `<b>${name}</b> @${nick}` : `@${nick}`;
    lines.push(`${head}\n  ${stageLabel}\n  /client_${nick}`);
    lines.push("");
  }
  return lines.join("\n");
}

function renderClientCard(s: PipelineState): string {
  const outputs = (s.stageOutputs ?? {}) as Record<string, unknown>;
  return formatClientCardForTelegram({
    telegramNick: s.telegramNick,
    stage: s.stage,
    clientSummary: outputs.clientSummary as ClientSummary | undefined,
    rawQuestionnaire: outputs.rawQuestionnaire as RawQuestionnaire | undefined,
    rawNamedValues: outputs.rawNamedValues as Record<string, string> | undefined,
    legacyDocUrl: outputs.legacyDocUrl as string | undefined,
    legacyTariff: outputs.legacyTariff as string | undefined,
  });
}

function main(): void {
  const all = loadStates();
  console.log("========== /clients ==========");
  console.log(renderClientsList(all));

  const legacyWithDoc = all.find(
    (s) =>
      s.stage === "completed_legacy" &&
      (s.stageOutputs as { legacyDocUrl?: string }).legacyDocUrl,
  );
  const legacyNoDoc = all.find(
    (s) =>
      s.stage === "completed_legacy" &&
      !(s.stageOutputs as { legacyDocUrl?: string }).legacyDocUrl,
  );
  const newOne = all.find((s) => s.stage === "awaiting_analysis");

  for (const picked of [legacyWithDoc, legacyNoDoc, newOne]) {
    if (!picked) continue;
    console.log(
      `\n========== /client ${picked.telegramNick} (${picked.stage}) ==========`,
    );
    console.log(renderClientCard(picked));
  }
}

main();
