import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { PipelineState } from "../schemas/pipeline-state.js";
import { normalizeNick } from "../services/intake-mapper.js";

/**
 * Точечная заливка state'ов из локального `pipelineStates.backfilled.json`
 * (или любого другого файла с форматом { [participantId]: PipelineState })
 * на прод через `POST /api/admin/upsert-states` — БЕЗ вызова Claude, БЕЗ
 * затирания прочих клиентов. Для случаев «поправить профиль одного юзера»
 * когда локально он уже в нужной форме, а на проде — устаревший.
 *
 * Env:
 *   PROD_URL         — прод-хост (default: career-assistant-w7z3.onrender.com)
 *   WEBHOOK_SECRET   — секрет для /api/admin/upsert-states
 *   SOURCE_FILE      — путь к JSON-у (default: data/pipelineStates.backfilled.json)
 *   ONLY_NICKS       — CSV ников (например "rain_nl,emilylogin"). Если не задано —
 *                       заливаем ВЕСЬ файл. Регистр/@ не важны.
 *   ONLY_IDS         — CSV participantId. Альтернатива ONLY_NICKS.
 *   DRY=1            — показать что будет залито, но не отправлять.
 */
const PROD_URL = process.env.PROD_URL || "https://career-assistant-w7z3.onrender.com";
const SECRET = process.env.WEBHOOK_SECRET || "";
const SOURCE_FILE = process.env.SOURCE_FILE || "data/pipelineStates.backfilled.json";
const DRY = process.env.DRY === "1";

const ONLY_NICKS: Set<string> | null = process.env.ONLY_NICKS
  ? new Set(
      process.env.ONLY_NICKS
        .split(",")
        .map((n) => normalizeNick(n.trim()))
        .filter(Boolean),
    )
  : null;

const ONLY_IDS: Set<string> | null = process.env.ONLY_IDS
  ? new Set(
      process.env.ONLY_IDS
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
  : null;

if (!DRY && !SECRET) {
  console.error("WEBHOOK_SECRET is required (or set DRY=1 to preview)");
  process.exit(1);
}

function loadSource(): Record<string, PipelineState> {
  const filePath = path.resolve(process.cwd(), SOURCE_FILE);
  if (!fs.existsSync(filePath)) {
    console.error(`Source file not found: ${filePath}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as Record<string, PipelineState>;
}

async function main(): Promise<void> {
  const src = loadSource();
  const srcEntries = Object.entries(src);
  console.log(`[Upsert] Source: ${SOURCE_FILE} (${srcEntries.length} states)`);

  let selected: Array<[string, PipelineState]> = srcEntries;
  if (ONLY_IDS) {
    selected = selected.filter(([id]) => ONLY_IDS!.has(id));
  }
  if (ONLY_NICKS) {
    selected = selected.filter(([, s]) => {
      const n = normalizeNick(s.telegramNick || "");
      return n && ONLY_NICKS!.has(n);
    });
  }

  if (selected.length === 0) {
    console.error("[Upsert] No states match the filter — nothing to do.");
    if (ONLY_NICKS) console.error(`  ONLY_NICKS=${[...ONLY_NICKS].join(",")}`);
    if (ONLY_IDS) console.error(`  ONLY_IDS=${[...ONLY_IDS].join(",")}`);
    process.exit(1);
  }

  console.log(`[Upsert] Will upsert ${selected.length} state(s):`);
  for (const [id, s] of selected) {
    const outs = (s.stageOutputs ?? {}) as Record<string, unknown>;
    const hasSummary = !!outs.clientSummary;
    const hasRaw = !!outs.rawNamedValues;
    console.log(
      `  - @${s.telegramNick || "(no-nick)"} ${id} stage=${s.stage} summary=${hasSummary ? "✓" : "∅"} raw=${hasRaw ? "✓" : "∅"}`,
    );
  }

  if (DRY) {
    console.log("[Upsert] DRY-run, nothing sent.");
    return;
  }

  const body = {
    states: Object.fromEntries(selected),
  };

  const res = await fetch(`${PROD_URL}/api/admin/upsert-states`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-secret": SECRET },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`[Upsert] POST /api/admin/upsert-states → HTTP ${res.status}`);
  console.log(`[Upsert] Response: ${text.slice(0, 400)}`);
  if (!res.ok) process.exit(1);
}

main().catch((err) => {
  console.error("[Upsert] Fatal:", err);
  process.exit(1);
});
