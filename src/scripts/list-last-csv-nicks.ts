import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { normalizeNick } from "../services/intake-mapper.js";

/**
 * Read-only helper: читает CSV-анкету, берёт последние N строк (CSV уже
 * отсортирован по Timestamp), нормализует колонку «Твой ник в телеграм» через
 * normalizeNick и печатает их в stdout через запятую — готово для подстановки
 * в BACKFILL_ONLY_NICKS.
 *
 * Usage:
 *   CSV_PATH=/path/to/form.csv N=15 npx tsx app/src/scripts/list-last-csv-nicks.ts
 */

const CSV_PATH = process.env.CSV_PATH;
if (!CSV_PATH) {
  console.error("CSV_PATH env var is required");
  process.exit(1);
}
const N = Number(process.env.N ?? 15);

function main(): void {
  const raw = fs.readFileSync(path.resolve(CSV_PATH!), "utf-8");
  const rows: Record<string, string>[] = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  if (rows.length === 0) {
    console.error(`[ListNicks] CSV empty: ${CSV_PATH}`);
    process.exit(1);
  }

  const nickHeader = Object.keys(rows[0]).find((h) =>
    h.toLowerCase().includes("ник в телеграм"),
  );
  if (!nickHeader) {
    console.error(`[ListNicks] Column with "ник в телеграм" not found in CSV`);
    process.exit(1);
  }

  const tail = rows.slice(-N);
  const nicks = tail
    .map((row) => normalizeNick(row[nickHeader] ?? ""))
    .filter(Boolean);

  const unique = Array.from(new Set(nicks));
  console.error(`[ListNicks] Read ${rows.length} rows, took last ${tail.length}, unique=${unique.length}`);
  process.stdout.write(unique.join(","));
}

main();
