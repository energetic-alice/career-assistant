/**
 * Probe e2e final analysis (Phase 3 + Phase 4 + Google Doc).
 *
 * Имитирует кнопку «📄 Сгенерировать финальный анализ» в боте, но без записи
 * в прод-state и без Telegram.
 *
 * Что делает:
 *   1. GET /api/participants на проде → ищет по nick'у.
 *   2. Восстанавливает ShortlistResult из state (mirror toShortlistResult).
 *   3. approvedDirections =
 *        approved.directions ∪ approved.rejectedDirections (если есть)
 *        иначе все directions с recommended !== false (approve-all имитация).
 *   4. enriched = approved.enriched ∪ rejected.enriched (или из shortlist.slots).
 *   5. marketData = formatEnrichedAsMarketData(enriched).
 *   6. runDeepFromShortlist(shortlist, approved, { marketData, skipPerplexityStep5: true })
 *   7. runAnalysisPhase4(profile, directions, analysis)
 *   8. createGoogleDoc(title, finalDocument)
 *   9. Печатает все ключевые ссылки и сохраняет артефакты в test-output/probe-final.
 *
 * НЕ пишет в прод-state. НЕ дёргает Telegram.
 *
 * Usage:
 *   NICKS=daryarioux npx tsx src/scripts/probe-final-e2e.ts
 *   NICKS=energetic_alice npx tsx src/scripts/probe-final-e2e.ts
 *   NICKS=daryarioux,energetic_alice npx tsx src/scripts/probe-final-e2e.ts
 */

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  runAnalysisPhase4,
  runDeepFromShortlist,
  runDeepResearch,
  type ShortlistResult,
} from "../pipeline/run-analysis.js";
import {
  formatEnrichedAsMarketData,
  type EnrichedDirection,
} from "../services/direction-enricher.js";
import { directionKey } from "../services/deep-research-service.js";
import { createGoogleDoc } from "../services/google-docs-service.js";
import type { Direction, DirectionsOutput, CandidateProfile } from "../schemas/analysis-outputs.js";
import type { ClientSummary } from "../schemas/client-summary.js";

const PROD_URL = process.env.PROD_URL || "https://career-assistant-w7z3.onrender.com";
const NICKS = (process.env.NICKS || "daryarioux,energetic_alice")
  .split(",")
  .map((s) => s.trim().replace(/^@/, ""))
  .filter(Boolean);

const DUMP_DIR = resolve(process.cwd(), "test-output/probe-final");

interface ShortlistSlot {
  slotId?: string;
  direction?: Direction;
  enriched?: EnrichedDirection;
}

interface ShortlistStateOnProd {
  profile?: CandidateProfile;
  clientSummary?: ClientSummary;
  marketOverview?: string;
  scorerTop20?: unknown;
  regions?: ShortlistResult["regions"];
  slots?: ShortlistSlot[];
  reserve?: ShortlistSlot[];
  resumeText?: string;
  questionnaireHuman?: string;
}

interface ApprovedOnProd {
  directions?: Direction[];
  slugs?: string[];
  enriched?: EnrichedDirection[];
  rejectedDirections?: Direction[];
  rejectedSlugs?: string[];
  rejectedEnriched?: EnrichedDirection[];
}

interface PipeStateOutputs {
  clientSummary?: ClientSummary;
  shortlist?: ShortlistStateOnProd;
  approved?: ApprovedOnProd;
}

interface PipeState {
  participantId?: string;
  telegramNick?: string;
  stage?: string;
  stageOutputs?: PipeStateOutputs;
}

async function fetchAll(): Promise<PipeState[]> {
  const res = await fetch(`${PROD_URL}/api/participants`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PipeState[];
}

function findByNick(states: PipeState[], nick: string): PipeState | undefined {
  const n = nick.toLowerCase();
  return states.find(
    (s) => (s.telegramNick || "").replace(/^@/, "").toLowerCase() === n,
  );
}

function header(title: string): string {
  const bar = "═".repeat(78);
  return `\n${bar}\n  ${title}\n${bar}`;
}

async function dumpFile(name: string, contents: string): Promise<string> {
  await mkdir(DUMP_DIR, { recursive: true });
  const full = resolve(DUMP_DIR, name);
  await writeFile(full, contents, "utf-8");
  return full;
}

function rebuildShortlistResult(state: PipeState): ShortlistResult | null {
  const sl = state.stageOutputs?.shortlist;
  const cs = state.stageOutputs?.clientSummary;
  if (!sl) return null;
  if (!sl.profile || !cs) return null;

  const slots = sl.slots ?? [];
  const directionsArr: Direction[] = slots
    .map((s) => s.direction)
    .filter((d): d is Direction => Boolean(d));
  const enriched: EnrichedDirection[] = slots
    .map((s) => s.enriched)
    .filter((e): e is EnrichedDirection => Boolean(e));

  const directions: DirectionsOutput = { directions: directionsArr };
  return {
    profile: sl.profile,
    clientSummary: cs,
    marketOverview: sl.marketOverview ?? "",
    scorerTop20: sl.scorerTop20 as ShortlistResult["scorerTop20"],
    regions: sl.regions ?? [],
    directions,
    enriched,
    timings: {},
    resumeText: sl.resumeText,
    questionnaireHuman: sl.questionnaireHuman,
  };
}

async function probeOne(state: PipeState): Promise<void> {
  const nick = (state.telegramNick || "").replace(/^@/, "");
  const t0 = Date.now();

  console.log(header(`@${nick}  ·  stage=${state.stage}`));

  const shortlistResult = rebuildShortlistResult(state);
  if (!shortlistResult) {
    console.log("  ⚠ нет shortlist/profile/clientSummary в state — skip");
    return;
  }

  const cs = shortlistResult.clientSummary;
  console.log(`  name:    ${cs?.firstNameLatin ?? "?"} ${cs?.lastNameLatin ?? "?"}`);
  console.log(`  target:  [${(cs?.targetMarketRegions ?? []).join(", ") || "—"}]`);

  const approvedOnProd = state.stageOutputs?.approved;
  const allDirections = shortlistResult.directions.directions;

  let approvedDirections: Direction[];
  let rejectedDirections: Direction[] = [];
  let approvedEnriched: EnrichedDirection[] = [];
  let rejectedEnriched: EnrichedDirection[] = [];

  if (approvedOnProd?.directions && approvedOnProd.directions.length > 0) {
    approvedDirections = approvedOnProd.directions;
    rejectedDirections = approvedOnProd.rejectedDirections ?? [];
    approvedEnriched = approvedOnProd.enriched ?? [];
    rejectedEnriched = approvedOnProd.rejectedEnriched ?? [];
    console.log(
      `  approved (from state): ${approvedDirections.length} recommended + ${rejectedDirections.length} rejected`,
    );
  } else {
    approvedDirections = allDirections.filter((d) => d.recommended !== false);
    rejectedDirections = allDirections.filter((d) => d.recommended === false);
    approvedEnriched = shortlistResult.enriched.filter((e) =>
      approvedDirections.some(
        (d) => d.roleSlug === e.roleSlug && d.bucket === e.bucket,
      ),
    );
    rejectedEnriched = shortlistResult.enriched.filter((e) =>
      rejectedDirections.some(
        (d) => d.roleSlug === e.roleSlug && d.bucket === e.bucket,
      ),
    );
    console.log(
      `  approved (approve-all imitation): ${approvedDirections.length} recommended + ${rejectedDirections.length} rejected`,
    );
  }

  // Свежий enrichment локально (Phase 2 заново на approved+rejected),
  // чтобы Phase 3 видел актуальные числа (после v5-niche-aliases / latest
  // resolver), а не закэшированные на проде.
  if (process.env.REFRESH_PHASE2 === "1") {
    console.log(`\n  [REFRESH_PHASE2] re-running Phase 2 enrichment locally...`);
    const t = Date.now();
    const allApproved = [...approvedDirections, ...rejectedDirections];
    const dr = await runDeepResearch(
      { ...shortlistResult, enriched: [] },
      allApproved,
    );
    // `runDeepResearch` сохраняет порядок approvedDirections в `dr.enriched`
    // (1:1). Используем позиционный slice вместо Map по slug|bucket — иначе
    // 3 approved direction'а с одинаковым slug+bucket (Daria — AppSec /
    // DevSecOps / SOC, все `infosecspec|usa`) схлопываются в один. Альтернативный
    // ключ — `directionKey(title|bucket)`, но позиционный надёжнее.
    if (dr.enriched.length !== allApproved.length) {
      console.warn(
        `  [REFRESH_PHASE2] WARN: enriched length mismatch ${dr.enriched.length} vs approved ${allApproved.length}`,
      );
    }
    approvedEnriched = dr.enriched.slice(0, approvedDirections.length);
    rejectedEnriched = dr.enriched.slice(approvedDirections.length);
    console.log(
      `  [REFRESH_PHASE2] done in ${((Date.now() - t) / 1000).toFixed(1)}s · enriched=${approvedEnriched.length}+${rejectedEnriched.length}`,
    );
    // Cross-check: log unique direction keys to confirm we kept all rows.
    const dirKeys = approvedEnriched.map((e) => directionKey(e));
    console.log(`  [REFRESH_PHASE2] enriched direction keys: ${dirKeys.join(" | ")}`);
  }

  if (approvedDirections.length === 0) {
    console.log("  ⚠ approved пусто — нечего финализировать");
    return;
  }

  const approvedAll = [...approvedDirections, ...rejectedDirections];
  const enrichedAll = [...approvedEnriched, ...rejectedEnriched];

  console.log(
    `  approved slugs: ${approvedDirections.map((d) => `${d.roleSlug}|${d.bucket}`).join(", ")}`,
  );
  if (rejectedDirections.length > 0) {
    console.log(
      `  rejected slugs: ${rejectedDirections.map((d) => `${d.roleSlug}|${d.bucket}`).join(", ")}`,
    );
  }
  console.log(`  enriched count: ${enrichedAll.length}`);

  // marketData из Phase 2 enriched (skip Step 5 в Phase 3).
  const marketData =
    enrichedAll.length > 0 ? formatEnrichedAsMarketData(enrichedAll) : undefined;
  if (marketData) {
    console.log(`  marketData: ${marketData.length} chars (skipPerplexityStep5=true)`);
    await dumpFile(`${nick}.market-data.md`, marketData);
  } else {
    console.log("  marketData: NONE — Phase 3 будет дёргать Perplexity Step 5");
  }

  // Phase 3 — runDeepFromShortlist
  console.log("\n  [Phase 3] runDeepFromShortlist...");
  const t3 = Date.now();
  const phase1 = await runDeepFromShortlist(shortlistResult, approvedAll, {
    marketData,
    skipPerplexityStep5: marketData !== undefined,
  });
  const ms3 = Date.now() - t3;
  console.log(`  [Phase 3] done in ${(ms3 / 1000).toFixed(1)}s`);
  console.log(
    `  top-3 directions: ${phase1.analysis.directions.map((d) => d.title).join(" · ")}`,
  );
  if (phase1.analysis.rejectedDirections && phase1.analysis.rejectedDirections.length > 0) {
    console.log(
      `  rejected: ${phase1.analysis.rejectedDirections
        .map((r) => r.originalTitle)
        .join(", ")}`,
    );
  }

  // Phase 4 — runAnalysisPhase4
  console.log("\n  [Phase 4] runAnalysisPhase4 (compile final markdown)...");
  const t4 = Date.now();
  const phase4 = await runAnalysisPhase4(
    phase1.profile,
    phase1.directions,
    phase1.analysis,
    undefined,
    {
      enriched: phase1.enrichedTop3,
      clientSummary: phase1.clientSummary,
    },
  );
  const ms4 = Date.now() - t4;
  console.log(`  [Phase 4] done in ${(ms4 / 1000).toFixed(1)}s, markdown=${phase4.finalDocument.length} chars`);
  const mdPath = await dumpFile(`${nick}.final.md`, phase4.finalDocument);
  console.log(`  saved markdown → ${mdPath}`);

  // Google Doc (skip when SKIP_DOC=1 или нет APPS_SCRIPT_DOC_URL)
  const skipDoc = process.env.SKIP_DOC === "1" || !process.env.APPS_SCRIPT_DOC_URL;
  let docUrl: string | null = null;
  let msDoc = 0;
  if (skipDoc) {
    console.log("\n  [Doc] SKIPPED (SKIP_DOC=1 или APPS_SCRIPT_DOC_URL not set)");
  } else {
    console.log("\n  [Doc] createGoogleDoc...");
    const tDoc = Date.now();
    const candidateName = phase1.profile.name || nick;
    const docTitle = `Карьерный анализ — ${candidateName} (probe)`;
    try {
      docUrl = await createGoogleDoc(docTitle, phase4.finalDocument);
      msDoc = Date.now() - tDoc;
      console.log(`  [Doc] created in ${(msDoc / 1000).toFixed(1)}s`);
    } catch (err) {
      msDoc = Date.now() - tDoc;
      console.warn(`  [Doc] failed in ${(msDoc / 1000).toFixed(1)}s:`, err);
    }
  }

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\n  ✅ TOTAL: ${totalSec}s · phase3=${(ms3 / 1000).toFixed(1)}s · phase4=${(ms4 / 1000).toFixed(1)}s · doc=${(msDoc / 1000).toFixed(1)}s`,
  );
  if (docUrl) console.log(`\n  📄 Google Doc: ${docUrl}`);
  console.log(`  📝 Markdown:   ${mdPath}`);
}

async function main(): Promise<void> {
  console.log(`PROD_URL: ${PROD_URL}`);
  console.log(`Probe for: ${NICKS.join(", ")}`);
  console.log(`ANTHROPIC_API_KEY:  ${process.env.ANTHROPIC_API_KEY ? "set" : "NOT SET"}`);
  console.log(`PERPLEXITY_API_KEY: ${process.env.PERPLEXITY_API_KEY ? "set" : "NOT SET"}`);
  console.log(`APPS_SCRIPT_DOC_URL: ${process.env.APPS_SCRIPT_DOC_URL ? "set" : "NOT SET"}`);
  console.log(`MARKET_RESEARCH_PROVIDER: ${process.env.MARKET_RESEARCH_PROVIDER ?? "(default: claude)"}`);

  const states = await fetchAll();
  console.log(`Загружено ${states.length} клиентов с прода.`);

  for (const nick of NICKS) {
    const s = findByNick(states, nick);
    if (!s) {
      console.log(`\n@${nick}: НЕ НАЙДЕН на проде`);
      continue;
    }
    try {
      await probeOne(s);
    } catch (err) {
      console.error(`@${nick}: probe failed:`, err);
    }
  }

  console.log(`\n\nDone. Артефакты в: ${DUMP_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
