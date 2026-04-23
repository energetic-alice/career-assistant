import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  enrichDirections,
  type EnrichedDirection,
} from "../services/direction-enricher.js";
import {
  enrichGapsForClient,
  _internals as deepInternals,
} from "../services/deep-research-service.js";
import type { Direction } from "../schemas/analysis-outputs.js";
import type { ClientSummary } from "../schemas/client-summary.js";

/**
 * Phase 2 probe — тест enrichGapsForClient на 2-3 клиентах.
 *
 * Берёт последний successful shortlist клиента с прода (`stageOutputs.shortlist`),
 * имитирует apply approve всех direction'ов (или берёт `shortlistApproved` если уже одобрены),
 * и прогоняет `enrichGapsForClient`. Печатает таблицу "было → стало" + обнаруженные дыры
 * + dataSource по каждой роли.
 *
 * Никаких записей на прод. Никакого Telegram.
 *
 * Usage:
 *   NICKS=rain_nl,energetic_alice,karina_kasik npx tsx src/scripts/probe-phase2.ts
 *   NICKS=rain_nl PERPLEXITY_API_KEY=xxx npx tsx src/scripts/probe-phase2.ts
 */

const PROD_URL = process.env.PROD_URL || "https://career-assistant-w7z3.onrender.com";
const NICKS = (process.env.NICKS || "rain_nl,energetic_alice,karina_kasik")
  .split(",")
  .map((s) => s.trim().replace(/^@/, ""))
  .filter(Boolean);

interface ShortlistSlot {
  slotId?: string;
  direction?: Direction;
  enriched?: EnrichedDirection;
}

interface PipeStateOutputs {
  clientSummary?: ClientSummary;
  shortlist?: {
    slots?: ShortlistSlot[];
    reserve?: ShortlistSlot[];
  };
  approved?: {
    directions?: Direction[];
    slugs?: string[];
  };
}

interface PipeState {
  telegramNick?: string;
  stageOutputs?: PipeStateOutputs;
}

async function fetchAll(): Promise<PipeState[]> {
  const res = await fetch(`${PROD_URL}/api/participants`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PipeState[];
}

function findByNick(states: PipeState[], nick: string): PipeState | undefined {
  const n = nick.toLowerCase();
  return states.find((s) => (s.telegramNick || "").replace(/^@/, "").toLowerCase() === n);
}

function header(title: string): string {
  const bar = "═".repeat(78);
  return `\n${bar}\n  ${title}\n${bar}`;
}

function padRight(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
  return s + " ".repeat(len - s.length);
}

function padLeft(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
  return " ".repeat(len - s.length) + s;
}

function fmtNum(n: number | null): string {
  return n === null ? "—" : String(n);
}

function fmtSourceBadge(src: EnrichedDirection["dataSource"]): string {
  switch (src) {
    case "market-index":
      return "[m]";
    case "perplexity":
      return "[p]";
    case "perplexity-estimate":
      return "[~]";
    case "none":
      return "[?]";
    default:
      return "[ ]";
  }
}

function diffRow(before: EnrichedDirection, after: EnrichedDirection): string {
  const fields = ["vacancies", "medianSalaryMid", "competitionPer100", "aiRisk", "trendRatio"] as const;
  const diffs: string[] = [];
  for (const f of fields) {
    const b = before[f];
    const a = after[f];
    if (b === null && a !== null) {
      diffs.push(`${f}: null → ${a}`);
    } else if (b !== null && a !== null && b !== a) {
      diffs.push(`${f}: ${b} → ${a}`);
    }
  }
  return diffs.join(", ") || "(no changes)";
}

function renderTable(
  baseline: EnrichedDirection[],
  after: EnrichedDirection[],
): string {
  const cols = [
    { h: "src", w: 4 },
    { h: "slug", w: 24 },
    { h: "vac (b→a)", w: 18 },
    { h: "median (b→a)", w: 22 },
    { h: "comp (b→a)", w: 14 },
    { h: "ai (b→a)", w: 16 },
  ];
  const fmtRow = (cells: string[]): string =>
    cells.map((c, i) => padRight(c, cols[i].w)).join("  ");

  const lines: string[] = [];
  lines.push(fmtRow(cols.map((c) => c.h)));
  lines.push(fmtRow(cols.map((c) => "-".repeat(c.w))));

  for (let i = 0; i < baseline.length; i++) {
    const b = baseline[i];
    const a = after[i];
    if (!b || !a) continue;

    const vac = b.vacancies === a.vacancies ? fmtNum(b.vacancies) : `${fmtNum(b.vacancies)} → ${fmtNum(a.vacancies)}`;
    const med = b.medianSalaryMid === a.medianSalaryMid
      ? fmtNum(b.medianSalaryMid)
      : `${fmtNum(b.medianSalaryMid)} → ${fmtNum(a.medianSalaryMid)}`;
    const comp = (() => {
      const fb = b.competitionPer100 !== null ? b.competitionPer100.toFixed(1) : "—";
      const fa = a.competitionPer100 !== null ? a.competitionPer100.toFixed(1) : "—";
      return fb === fa ? fb : `${fb} → ${fa}`;
    })();
    const ai = (() => {
      const fb = b.aiRisk ?? "—";
      const fa = a.aiRisk ?? "—";
      return fb === fa ? fb : `${fb} → ${fa}`;
    })();

    lines.push(fmtRow([
      fmtSourceBadge(a.dataSource),
      b.roleSlug.slice(0, cols[1].w),
      vac.slice(0, cols[2].w),
      med.slice(0, cols[3].w),
      comp.slice(0, cols[4].w),
      ai.slice(0, cols[5].w),
    ]));
  }

  return lines.join("\n");
}

const DUMP_DIR = resolve(process.cwd(), "test-output/probe-phase2");

async function dumpJson(path: string, data: unknown): Promise<void> {
  await mkdir(DUMP_DIR, { recursive: true });
  const full = resolve(DUMP_DIR, path);
  await writeFile(full, JSON.stringify(data, null, 2), "utf-8");
}

async function probeOne(state: PipeState): Promise<void> {
  const nick = (state.telegramNick || "").replace(/^@/, "");
  const cs = state.stageOutputs?.clientSummary;
  const shortlist = state.stageOutputs?.shortlist;

  if (!cs) {
    console.log(`\n@${nick}: НЕТ clientSummary — skip`);
    return;
  }
  if (!shortlist) {
    console.log(`\n@${nick}: НЕТ shortlist — skip (запусти Phase 1 на проде)`);
    return;
  }

  console.log(header(`@${nick}  ·  ${cs.firstNameLatin} ${cs.lastNameLatin}`));
  console.log(`  target:  [${(cs.targetMarketRegions ?? []).join(", ") || "—"}]`);
  console.log(`  ru/cis-only target: ${deepInternals.allTargetsAreRuProxy(cs)}`);

  // Структура state: shortlist.slots = [{ slotId, direction, enriched, ... }],
  // shortlist.reserve тоже массив таких же объектов. Approve хранится отдельно.
  const slots = shortlist.slots ?? [];
  const directions = slots
    .map((s) => s.direction)
    .filter((d): d is Direction => Boolean(d));
  const baselineFromState = slots
    .map((s) => s.enriched)
    .filter((e): e is EnrichedDirection => Boolean(e));

  if (directions.length === 0) {
    console.log("  ⚠ shortlist.slots пуст");
    return;
  }

  // Phase 2 работает с одобренными после Gate 1. Если на проде уже есть
  // approved.slugs — фильтруем по ним; иначе берём все слоты с
  // recommended !== false (имитируем "approve all").
  const approvedSlugs = state.stageOutputs?.approved?.slugs ?? [];
  const approvedDirections = approvedSlugs.length > 0
    ? directions.filter((d) => approvedSlugs.includes(d.roleSlug))
    : directions.filter((d) => d.recommended !== false);

  console.log(`  approved: ${approvedDirections.length} directions ${approvedSlugs.length > 0 ? "(from approved.slugs)" : "(approve-all imitation)"}`);
  console.log(`  approved slugs: ${approvedDirections.map((d) => d.roleSlug).join(", ")}`);

  // Baseline по slug+bucket из enriched. Если что-то не нашлось — пересчитываем
  // отдельно и кладём в нужное место (enrichGapsForClient требует длину = directions.length).
  const enrichedMap = new Map<string, EnrichedDirection>();
  for (const e of baselineFromState) {
    enrichedMap.set(`${e.roleSlug}|${e.bucket ?? "abroad"}`, e);
  }
  const missingIdx: number[] = [];
  const missingDirs: Direction[] = [];
  approvedDirections.forEach((d, i) => {
    const key = `${d.roleSlug}|${d.bucket === "ru" ? "ru" : "abroad"}`;
    if (!enrichedMap.has(key)) {
      missingIdx.push(i);
      missingDirs.push(d);
    }
  });
  if (missingDirs.length > 0) {
    console.log(`  (recomputing baseline for ${missingDirs.length} missing direction(s))`);
    const fresh = await enrichDirections(missingDirs, cs);
    fresh.forEach((e, j) => {
      const dir = missingDirs[j];
      const key = `${dir.roleSlug}|${dir.bucket === "ru" ? "ru" : "abroad"}`;
      enrichedMap.set(key, e);
    });
  }
  const baselineRaw: EnrichedDirection[] = approvedDirections.map((d) => {
    const key = `${d.roleSlug}|${d.bucket === "ru" ? "ru" : "abroad"}`;
    return enrichedMap.get(key) as EnrichedDirection;
  });

  // Migration patch: если baseline пришёл из старого state без `dataSource`,
  // выставляем market-index/none на лету.
  const baseline: EnrichedDirection[] = baselineRaw.map((e) => {
    if ((e as Partial<EnrichedDirection>).dataSource) return e;
    const hasAny = e.vacancies !== null || e.medianSalaryMid !== null || e.aiRisk !== null;
    return { ...e, dataSource: hasAny ? "market-index" : "none" };
  });

  // Detect gaps (только информативно — то же сделает enrichGapsForClient внутри)
  const gaps = deepInternals.detectGaps(approvedDirections, baseline, cs);
  console.log(`\n  gaps detected: ${gaps.length}`);
  for (const g of gaps) {
    console.log(
      `    - ${g.direction.roleSlug} [${g.reason}]: missing ${g.missingFields.join("/")}`,
    );
  }

  // Если есть gaps и есть Perplexity — покажем промпт
  if (gaps.length > 0 && process.env.PERPLEXITY_API_KEY) {
    const prompt = deepInternals.buildBatchPrompt(gaps, baseline, cs);
    await dumpJson(`${nick}.prompt.txt`, prompt);
    console.log(`  prompt saved: test-output/probe-phase2/${nick}.prompt.txt (${prompt.length} chars)`);
  }

  // Запускаем enrichment
  console.log(`\n  Running enrichGapsForClient...`);
  const t0 = Date.now();
  const after = await enrichGapsForClient(approvedDirections, baseline, cs);
  const ms = Date.now() - t0;
  console.log(`  done in ${ms}ms`);

  // Выводим diff-таблицу
  console.log("");
  console.log(renderTable(baseline, after).split("\n").map((l) => "  " + l).join("\n"));

  // Подробный лог по каждой роли
  console.log("");
  for (let i = 0; i < after.length; i++) {
    const a = after[i];
    const b = baseline[i];
    if (!a || !b) continue;

    if (a.dataSource === "perplexity" || a.dataSource === "perplexity-estimate") {
      console.log(`  ${fmtSourceBadge(a.dataSource)} ${a.roleSlug}:`);
      console.log(`     diff: ${diffRow(b, a)}`);
      if (a.perplexityCitations && a.perplexityCitations.length > 0) {
        console.log(`     citations:`);
        for (const c of a.perplexityCitations.slice(0, 5)) {
          console.log(`       - ${c}`);
        }
      } else {
        console.log(`     citations: (none)`);
      }
      if (a.perplexityReasoning) {
        console.log(`     reasoning: ${a.perplexityReasoning.slice(0, 160)}`);
      }
    }
  }

  await dumpJson(`${nick}.result.json`, {
    nick,
    targetMarketRegions: cs.targetMarketRegions,
    gapsDetected: gaps.length,
    perplexityFills: after.filter((e) => e.dataSource === "perplexity" || e.dataSource === "perplexity-estimate").length,
    durationMs: ms,
    baseline: baseline.map((e) => ({
      slug: e.roleSlug,
      vac: e.vacancies,
      med: e.medianSalaryMid,
      comp: e.competitionPer100,
      ai: e.aiRisk,
      source: e.dataSource,
    })),
    after: after.map((e) => ({
      slug: e.roleSlug,
      vac: e.vacancies,
      med: e.medianSalaryMid,
      comp: e.competitionPer100,
      ai: e.aiRisk,
      source: e.dataSource,
      citations: e.perplexityCitations,
      reasoning: e.perplexityReasoning,
    })),
  });
}

async function main(): Promise<void> {
  const states = await fetchAll();
  console.log(`Загружено ${states.length} клиентов с прода. Probe для: ${NICKS.join(", ")}`);
  console.log(`PERPLEXITY_API_KEY: ${process.env.PERPLEXITY_API_KEY ? "set" : "NOT SET (enrichment skipped)"}`);

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
