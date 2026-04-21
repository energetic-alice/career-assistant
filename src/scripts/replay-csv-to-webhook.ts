import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

/**
 * Replay a Google Forms CSV export into the production webhook as if each row
 * were just submitted. Uses exactly the same payload shape that Apps Script
 * sends: `{ namedValues: { [header]: [value] } }`.
 *
 * Usage:
 *   CSV_PATH=/path/to/form.csv \
 *   PROD_URL=https://career-assistant-w7z3.onrender.com \
 *   WEBHOOK_SECRET=xxx \
 *   REPLAY_DELAY_MS=4000 \
 *   REPLAY_DRY_RUN=1 \
 *   npx tsx src/scripts/replay-csv-to-webhook.ts
 */

const CSV_PATH = process.env.CSV_PATH;
if (!CSV_PATH) {
  console.error("CSV_PATH env var is required");
  process.exit(1);
}
const PROD_URL = process.env.PROD_URL || "https://career-assistant-w7z3.onrender.com";
const SECRET = process.env.WEBHOOK_SECRET || "ca-webhook-2025-secret";
const DELAY_MS = Number(process.env.REPLAY_DELAY_MS ?? 4000);
const DRY_RUN = process.env.REPLAY_DRY_RUN === "1";
const ONLY_NICKS = (process.env.REPLAY_ONLY ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const raw = fs.readFileSync(path.resolve(CSV_PATH!), "utf-8");
  const rows: Record<string, string>[] = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  console.log(`[Replay] Read ${rows.length} rows from ${CSV_PATH}`);

  const nickHeader = Object.keys(rows[0] ?? {}).find((h) =>
    h.toLowerCase().includes("ник в телеграм"),
  );
  if (!nickHeader) {
    throw new Error("CSV has no column matching 'ник в телеграм'");
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const nick = (row[nickHeader] ?? "").trim();
    if (!nick) {
      console.warn("[Replay] skip row with empty nick");
      skipped += 1;
      continue;
    }
    if (ONLY_NICKS.length > 0) {
      const normalized = nick.replace(/^https?:\/\//i, "").replace(/^t\.me\//i, "").replace(/^@/, "").toLowerCase();
      if (!ONLY_NICKS.includes(normalized)) {
        skipped += 1;
        continue;
      }
    }

    // Apps Script передаёт namedValues как { [header]: [value] }; даже для
    // single-value ответов это массив. Форма убирает пустые колонки, но для
    // простоты оставляем все — webhook игнорирует пустые строки.
    const namedValues: Record<string, string[]> = {};
    for (const [header, value] of Object.entries(row)) {
      namedValues[header] = [value ?? ""];
    }

    const payload = JSON.stringify({ namedValues });
    const url = `${PROD_URL}/api/webhook/new-participant`;

    console.log(
      `[Replay] → ${nick}  ts=${row.Timestamp ?? row.timestamp ?? "?"}  bytes=${payload.length}${DRY_RUN ? "  DRY" : ""}`,
    );

    if (DRY_RUN) {
      sent += 1;
      continue;
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-secret": SECRET,
        },
        body: payload,
      });
      const text = await res.text();
      if (res.ok) {
        console.log(`    ${res.status} ${text.slice(0, 200)}`);
        sent += 1;
      } else {
        console.error(`    ${res.status} ${text.slice(0, 400)}`);
        failed += 1;
      }
    } catch (err) {
      console.error(`    network error: ${err instanceof Error ? err.message : err}`);
      failed += 1;
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n[Replay] Done. sent=${sent} skipped=${skipped} failed=${failed}`);
}

main().catch((err) => {
  console.error("[Replay] Fatal:", err);
  process.exit(1);
});
