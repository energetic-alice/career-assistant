/**
 * Восстановить ровно тот prompt-02, который Claude получил при генерации
 * shortlist для конкретного клиента (берём данные из state.stageOutputs.shortlist
 * без обращения к LLM).
 *
 * Usage:
 *   NICK=daryarioux npx tsx src/scripts/dump-shortlist-prompt.ts
 */

import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  loadPrompt02,
  renderPhase0SlugsHint,
  renderQuestionnaireForPrompt,
} from "../pipeline/prompt-loader.js";

const NICK = (process.env.NICK || "daryarioux").replace(/^@/, "");
const STATE_FILE = resolve(
  process.cwd(),
  `test-output/probe-final/${NICK}/state.json`,
);
const OUT_FILE = resolve(
  process.cwd(),
  `test-output/probe-final/${NICK}/01-prompt02.md`,
);

async function main(): Promise<void> {
  const raw = await readFile(STATE_FILE, "utf-8");
  const state = JSON.parse(raw) as {
    stageOutputs?: {
      shortlist?: {
        profile?: unknown;
        clientSummary?: Parameters<typeof renderPhase0SlugsHint>[0];
        marketOverview?: string;
        scorerTop20?: string;
        resumeText?: string;
      };
      rawNamedValues?: Record<string, string>;
    };
  };
  const sl = state.stageOutputs?.shortlist;
  if (!sl) throw new Error("no shortlist in state");

  const phase0SlugsHint = sl.clientSummary
    ? renderPhase0SlugsHint(sl.clientSummary)
    : "";
  const questionnaireHuman = renderQuestionnaireForPrompt(
    state.stageOutputs?.rawNamedValues,
  );

  const prompt = await loadPrompt02({
    candidateProfile: JSON.stringify(sl.profile ?? {}, null, 2),
    marketOverview: sl.marketOverview ?? "",
    scorerTop20: sl.scorerTop20,
    resumeText: sl.resumeText,
    questionnaireHuman,
    phase0SlugsHint,
  });

  await mkdir(resolve(OUT_FILE, ".."), { recursive: true });
  await writeFile(OUT_FILE, prompt, "utf-8");
  console.log(`prompt-02 reconstructed: ${prompt.length} chars`);
  console.log(`saved → ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
