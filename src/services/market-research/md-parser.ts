/**
 * Parser для `app/src/prompts/market-data/<region>_<slug>.md`.
 *
 * Каждый файл имеет:
 *   - заголовок + meta-line ("Дата: ... | Источник: ...")
 *   - **основная таблица** (Title | Rank | Rank YoY | Median £ | Salary YoY | Jobs 6m | Live Now)
 *   - "Топ-3 тайтла:" блок (информативный, для людей)
 *   - "Динамика (perm vacancies):" блок (общая динамика топ-row-а)
 *
 * Все per-niche записи живут в основной таблице. Маппинг
 * `direction.title → row.title` хранится в `niche-aliases.json`.
 * Bulk re-scrape (probe-uk-market.ts) полностью перезаписывает файл.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSalaryGbp,
  parseYoYPct,
  parseIntSafe,
  type ItjobswatchRow,
  type ItjobswatchTrend,
} from "../itjw-scraper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MARKET_DATA_DIR = join(__dirname, "..", "..", "prompts", "market-data");

export interface ParsedTitleRow {
  title: string;
  rank: number | null;
  rankYoYChange: number | null;
  medianSalaryGbp: number | null;
  salaryYoYPct: number | null;
  permJobs6m: number | null;
  liveJobs: number | null;
}

export interface ParsedSlugFile {
  /** Path to the file we read. */
  filePath: string;
  /** Все rows из основной таблицы. */
  rows: ParsedTitleRow[];
  /** Trend для top-row из main-section (общая динамика slug-а). */
  topTrend: ItjobswatchTrend | null;
  /** Raw content (для re-write при необходимости). */
  rawContent: string;
}

export async function loadSlugFile(
  region: "uk" | "ru",
  slug: string,
): Promise<ParsedSlugFile | null> {
  const filePath = join(MARKET_DATA_DIR, `${region}_${slug}.md`);
  if (!existsSync(filePath)) return null;
  const content = await readFile(filePath, "utf-8");
  return parseSlugFileContent(filePath, content);
}

export function parseSlugFileContent(
  filePath: string,
  content: string,
): ParsedSlugFile {
  return {
    filePath,
    rows: parseTableRows(content),
    topTrend: parseDynamicsBlock(content),
    rawContent: content,
  };
}

/**
 * Парсит markdown-таблицу с заголовками
 *   `Title | Rank | Rank YoY | Median £ | Salary YoY | Jobs 6m | Live Now`
 * (берёт ПЕРВУЮ найденную таблицу с такими колонками).
 */
function parseTableRows(content: string): ParsedTitleRow[] {
  const lines = content.split("\n");
  const rows: ParsedTitleRow[] = [];

  let inTable = false;
  let headers: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!inTable) {
      if (
        trimmed.startsWith("|") &&
        /title/i.test(trimmed) &&
        /(median|salary|live)/i.test(trimmed)
      ) {
        headers = splitMdRow(trimmed).map((h) => h.toLowerCase());
        inTable = true;
        continue;
      }
      continue;
    }

    if (inTable) {
      if (trimmed === "" || !trimmed.startsWith("|")) {
        inTable = false;
        headers = [];
        continue;
      }
      if (/^\|[-:\s|]+\|$/.test(trimmed)) continue;

      const cells = splitMdRow(trimmed);
      const row = mapRow(cells, headers);
      if (row) rows.push(row);
    }
  }

  return rows;
}

function splitMdRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

function mapRow(cells: string[], headers: string[]): ParsedTitleRow | null {
  const get = (key: string): string | undefined => {
    const idx = headers.findIndex((h) => h.includes(key));
    return idx === -1 ? undefined : cells[idx];
  };

  const title = get("title");
  if (!title) return null;

  return {
    title,
    rank: parseIntSafe(get("rank") ?? "N/A"),
    rankYoYChange: (() => {
      const raw = get("rank yoy");
      if (!raw) return null;
      const m = raw.match(/[+-]?\d+/);
      return m ? parseInt(m[0], 10) : null;
    })(),
    medianSalaryGbp: parseSalaryGbp(get("median") ?? get("salary £") ?? "N/A"),
    salaryYoYPct: parseYoYPct(get("salary yoy") ?? "-"),
    permJobs6m: parseIntSafe(get("jobs 6m") ?? "N/A"),
    liveJobs: parseIntSafe(get("live now") ?? get("live") ?? "N/A"),
  };
}

/**
 * Append-only дозапись scraped rows в основную таблицу `<region>_<slug>.md`.
 *
 * Используется niche-resolver-ом при alias miss + scoring miss: live-scrape
 * вернул кандидатов, которых нет в md → дописываем как новые rows ПЕРЕД
 * блоком "**Топ-3 тайтла:**". Не трогаем уже существующие rows
 * (case-insensitive по title).
 *
 * @returns массив реально дописанных titles (для лога). Если все rows уже
 * были — пустой массив, файл не переписан.
 */
export async function appendRowsToMain(
  region: "uk" | "ru",
  slug: string,
  rows: ItjobswatchRow[],
): Promise<string[]> {
  const filePath = join(MARKET_DATA_DIR, `${region}_${slug}.md`);
  if (!existsSync(filePath)) return [];

  const content = await readFile(filePath, "utf-8");
  const existing = parseTableRows(content);
  const existingTitles = new Set(existing.map((r) => r.title.toLowerCase()));

  const toAppend = rows.filter((r) => !existingTitles.has(r.title.toLowerCase()));
  if (toAppend.length === 0) return [];

  const lines = content.split("\n");

  // Найти конец таблицы: первая пустая строка после header-и + ≥1 row-а.
  let tableHeaderIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (
      t.startsWith("|") &&
      /title/i.test(t) &&
      /(median|salary|live)/i.test(t)
    ) {
      tableHeaderIdx = i;
      break;
    }
  }
  if (tableHeaderIdx === -1) return [];

  // Сепаратор `|---|---|...` идёт сразу после header-а. Rows — после него
  // до первой строки которая не начинается с `|` (или конец файла).
  let tableEndIdx = tableHeaderIdx + 2;
  while (tableEndIdx < lines.length && lines[tableEndIdx]!.trim().startsWith("|")) {
    tableEndIdx++;
  }

  const newRowLines = toAppend.map(formatRowAsMd);
  const newLines = [
    ...lines.slice(0, tableEndIdx),
    ...newRowLines,
    ...lines.slice(tableEndIdx),
  ];

  await writeFile(filePath, newLines.join("\n"), "utf-8");
  return toAppend.map((r) => r.title);
}

function formatRowAsMd(r: ItjobswatchRow): string {
  const rankChg = r.rankYoYChange
    ? r.rankYoYChange > 0
      ? `+${r.rankYoYChange}`
      : `${r.rankYoYChange}`
    : "-";
  return `| ${r.title} | ${r.rank ?? "N/A"} | ${rankChg} | ${r.medianSalary} | ${r.salaryYoYChange} | ${r.permJobs} | ${r.liveJobs ?? "N/A"} |`;
}

/**
 * Парсит блок `**Динамика (perm vacancies):**` в main-section.
 * Возвращает один общий ItjobswatchTrend (для top-row slug-а).
 */
function parseDynamicsBlock(content: string): ItjobswatchTrend | null {
  const m = content.match(
    /Сейчас:\s*([\d,N/A]+)\s*\|\s*Год назад:\s*([\d,N/A]+)\s*\|\s*2 года назад:\s*([\d,N/A]+)/,
  );
  if (!m) return null;
  return {
    jobsNow: m[1]!.trim(),
    jobs1yAgo: m[2]!.trim(),
    jobs2yAgo: m[3]!.trim(),
    medianSalary: "",
  };
}
