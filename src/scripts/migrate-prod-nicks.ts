import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { normalizeNick } from "../services/intake-mapper.js";
import type { PipelineState } from "../schemas/pipeline-state.js";

/**
 * One-off migration: download prod pipelineStates, normalize `telegramNick`
 * for every record (strip "@", "t.me/", lowercase), merge duplicates that
 * collapse under normalization (keep the most recently updated, but preserve
 * `legacyDocUrl`/`legacyTariff` from the legacy twin), and write the result
 * to data/pipelineStates.migrated.json — ready to be POSTed to
 * /api/admin/import-seed.
 *
 * Нужен потому, что раньше seed хранил ники в виде "@foo", а webhook матчил
 * по `strip @ + lowercase`, не срезая `t.me/`. После перехода на единую
 * normalizeNick хранимые значения должны быть уже канонизированы.
 */

const PROD_URL = process.env.PROD_URL || "https://career-assistant-w7z3.onrender.com";
const SECRET = process.env.WEBHOOK_SECRET || "ca-webhook-2025-secret";
const OUT_PATH = path.resolve(process.cwd(), "data/pipelineStates.migrated.json");

async function fetchProdStates(): Promise<PipelineState[]> {
  const res = await fetch(`${PROD_URL}/api/participants`, {
    headers: { "x-webhook-secret": SECRET },
  });
  if (!res.ok) {
    throw new Error(`GET /api/participants failed: HTTP ${res.status}`);
  }
  return (await res.json()) as PipelineState[];
}

function mergeOutputs(
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  // Приоритет у `base` (это state-победитель по свежести updatedAt),
  // но legacy-хвост из более старого оставляем, если в base его нет.
  const merged: Record<string, unknown> = { ...base };
  for (const key of ["legacyDocUrl", "legacyTariff"] as const) {
    if (!merged[key] && extra[key]) merged[key] = extra[key];
  }
  return merged;
}

async function main(): Promise<void> {
  console.log(`[Migrate] Fetching prod states from ${PROD_URL}`);
  const states = await fetchProdStates();
  console.log(`[Migrate] Received ${states.length} records`);

  const byNick = new Map<string, PipelineState>();
  let collisions = 0;

  for (const s of states) {
    const nick = normalizeNick(s.telegramNick ?? "");
    if (!nick) {
      console.warn(`[Migrate] Skip empty nick for ${s.participantId}`);
      continue;
    }
    const normalized: PipelineState = { ...s, telegramNick: nick };

    const existing = byNick.get(nick);
    if (!existing) {
      byNick.set(nick, normalized);
      continue;
    }

    collisions += 1;
    const [winner, loser] =
      existing.updatedAt >= normalized.updatedAt
        ? [existing, normalized]
        : [normalized, existing];
    const baseOutputs = (winner.stageOutputs ?? {}) as Record<string, unknown>;
    const extraOutputs = (loser.stageOutputs ?? {}) as Record<string, unknown>;
    winner.stageOutputs = mergeOutputs(baseOutputs, extraOutputs);
    byNick.set(nick, winner);
    console.log(
      `[Migrate] dedup @${nick}: kept ${winner.participantId} (stage=${winner.stage}), dropped ${loser.participantId}`,
    );
  }

  const map: Record<string, PipelineState> = {};
  const byStage: Record<string, number> = {};
  for (const s of byNick.values()) {
    map[s.participantId] = s;
    byStage[s.stage] = (byStage[s.stage] || 0) + 1;
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(map, null, 2), "utf-8");

  console.log(
    `[Migrate] Done. Input=${states.length}, output=${Object.keys(map).length}, collisions=${collisions}`,
  );
  console.log("[Migrate] byStage:", byStage);
  console.log(`[Migrate] Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("[Migrate] Failed:", err);
  process.exit(1);
});
