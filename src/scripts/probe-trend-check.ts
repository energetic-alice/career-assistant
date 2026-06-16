/**
 * Probe: проверка новой динамики (trendVsMarket → бакет) на реальных клиентах.
 *
 * Берёт направления клиента с прода, ПЕРЕОБОГАЩАЕТ их свежим market-index
 * (детерминированно, без LLM и без затрат) и печатает, какой бакет динамики
 * увидит клиент по каждому направлению. Нужно чтобы убедиться, что метрика
 * «относительно рынка» даёт осмысленный ранжир (PM слабеет, fullstack слабеет,
 * devops на уровне и т.п.).
 *
 * Usage:
 *   NICKS=energetic_alice,cyber_gremlin,olenka_kravchenko \
 *   npx tsx src/scripts/probe-trend-check.ts
 */

import "dotenv/config";
import { enrichDirections, type EnrichedDirection } from "../services/direction-enricher.js";
import { trendBucket } from "../schemas/market-index.js";
import {
  runShortlist,
  setAnalysisModel,
  type AnalysisPipelineInput,
} from "../pipeline/run-analysis.js";
import type { Direction } from "../schemas/analysis-outputs.js";
import type { ClientSummary } from "../schemas/client-summary.js";

const SHORTLIST_MODEL = process.env.SHORTLIST_MODEL || "claude-sonnet-4-6";

const PROD_URL = process.env.PROD_URL || "https://career-assistant-w7z3.onrender.com";
const NICKS = (process.env.NICKS || "energetic_alice,cyber_gremlin,olenka_kravchenko")
  .split(",")
  .map((s) => s.trim().replace(/^@/, ""))
  .filter(Boolean);

interface Slot {
  direction?: Direction;
}
interface PipeState {
  telegramNick?: string;
  stageOutputs?: {
    clientSummary?: ClientSummary;
    shortlist?: { clientSummary?: ClientSummary; slots?: Slot[] };
    approved?: { directions?: Direction[]; rejectedDirections?: Direction[] };
    pipelineInput?: AnalysisPipelineInput;
  };
}

function findByNick(states: PipeState[], nick: string): PipeState | undefined {
  const n = nick.toLowerCase();
  return states.find(
    (s) => (s.telegramNick || "").replace(/^@/, "").toLowerCase() === n,
  );
}

function collectDirections(state: PipeState): Direction[] {
  const so = state.stageOutputs ?? {};
  const approved = so.approved?.directions ?? [];
  const rejected = so.approved?.rejectedDirections ?? [];
  if (approved.length > 0) return [...approved, ...rejected];
  const slots = so.shortlist?.slots ?? [];
  return slots.map((s) => s.direction).filter((d): d is Direction => Boolean(d));
}

function arrow(v: number | null): string {
  if (v == null) return " ";
  if (v >= 1.2) return "↑";
  if (v < 0.85) return "↓";
  return "→";
}

async function main(): Promise<void> {
  console.log(`PROD_URL: ${PROD_URL}`);
  console.log(`NICKS:    ${NICKS.join(", ")}\n`);

  const res = await fetch(`${PROD_URL}/api/participants`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const states = (await res.json()) as PipeState[];
  console.log(`Загружено ${states.length} клиентов с прода.\n`);

  for (const nick of NICKS) {
    const bar = "═".repeat(72);
    console.log(`${bar}\n  @${nick}\n${bar}`);
    const s = findByNick(states, nick);
    if (!s) {
      console.log("  НЕ НАЙДЕН на проде\n");
      continue;
    }
    const cs = (s.stageOutputs?.clientSummary ??
      s.stageOutputs?.shortlist?.clientSummary ??
      {}) as ClientSummary;

    let enriched: EnrichedDirection[];
    let recommendedFlags: (boolean | undefined)[];
    const directions = collectDirections(s);

    if (directions.length > 0) {
      enriched = await enrichDirections(directions, cs);
      recommendedFlags = enriched.map((e) => directions[e.index]?.recommended);
    } else {
      const pi = s.stageOutputs?.pipelineInput;
      if (!pi) {
        console.log("  нет ни shortlist, ни pipelineInput — skip\n");
        continue;
      }
      console.log(`  [Phase 1] нет shortlist → runShortlist (model=${SHORTLIST_MODEL})...`);
      setAnalysisModel(SHORTLIST_MODEL);
      const shortlist = await runShortlist({ ...pi, clientSummary: s.stageOutputs?.clientSummary });
      enriched = shortlist.enriched;
      recommendedFlags = enriched.map(
        (e) =>
          shortlist.directions.directions.find(
            (d) => d.roleSlug === e.roleSlug && d.bucket === e.bucket,
          )?.recommended,
      );
    }

    enriched.forEach((e, i) => {
      const v = e.trendVsMarket;
      const bucket = trendBucket(v) ?? "— (нет данных)";
      const vStr = v == null ? " n/a" : v.toFixed(2);
      const flag = recommendedFlags[i] === false ? " (отклонено)" : "";
      console.log(
        `  ${arrow(v)} ${vStr}  ${bucket.padEnd(26)} ${e.roleSlug.padEnd(22)} ${e.title}${flag}`,
      );
    });
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
