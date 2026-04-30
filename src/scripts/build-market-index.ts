import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseHhFile,
  parseItjwFile,
} from "../services/market-data-service.js";
import type {
  AiRisk,
  MarketIndex,
  MarketIndexEntry,
  RegionStats,
} from "../schemas/market-index.js";

/**
 * Build `app/data/market-index.json` — single source of truth for all
 * canonical roles used by the app.
 *
 * Canonical slug style follows habr.com/career `spec_aliases[]=<...>` plus
 * technology suffix where applicable ("spec + skill", flat form):
 *
 *   backend_python, backend_go, ...
 *   frontend_react, frontend_vue, ...
 *   mobileapp_swift, mobileapp_kotlin, mobileapp_flutter, mobileapp_react_native
 *   devops (merged cluster: DevOps + SRE + MLOps + Platform Engineer)
 *   ml_engineer (merged with Data Scientist), data_engineer, data_analyst, product_analyst
 *   qa_engineer (automation), manual_testing
 *   product_manager, project_manager, tech_lead (merged with Engineering Manager), software_architect
 *   business_analyst, systems_analyst
 *   ui_ux_designer, marketing_manager, recruiter, technical_writer
 *   infosecspec, 1c_developer, gamedev_unity, web3_developer, fullstack
 *   system_admin, tech_support_manager  (adjacent — no market data yet)
 *
 * Non-IT roles (doctor, lawyer, manicurist) are intentionally absent:
 * matcher returns null → UI keeps the raw string.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const MARKET_DIR = join(__dirname, "..", "prompts", "market-data");
const KB_DIR = join(__dirname, "..", "prompts", "kb");
const OUT_PATH = join(__dirname, "..", "..", "data", "market-index.json");

interface RoleDef {
  slug: string;
  displayTitle: string;
  category: string;
  aiRisk: AiRisk;
  /** habr.com/career spec_aliases[] value (for future live fetches) */
  habrSpec: string | null;
  /** habr.com/career skills[] filter (optional) */
  habrSkill?: string;
  /**
   * Технологический стек (см. комментарий в `market-index.ts`). Задавать
   * только для ролей, где язык/стек критичен (backend_*, frontend_*,
   * fullstack, mobile_*, web3/gamedev/1c). Для infra/data/ML/management
   * оставлять undefined — там работает category-bridge.
   */
  stackFamily?: string;
  /**
   * File under market-data/ для RU. Default `ru_<slug>.md`. Override только
   * если файл шарится между ролями. `null` — отключить RU данные.
   */
  ruFile?: string | null;
  /** То же для UK (itjobswatch). Default `uk_<slug>.md`. */
  ukFile?: string | null;
  /**
   * Все RU/EN aliases для role-matcher и hh.ru-запросов. Сюда попадает всё
   * что раньше было в `extraAliases` + `RU_TITLE_VARIANTS`.
   */
  aliases?: string[];
  /** Удалить из итогового списка aliases (EM/TL split-кейсы). */
  dropAliases?: string[];
  /**
   * Если true, UK-vacancies = сумма `liveNow` по всем строкам файла (когда
   * один канонический тайтл не покрывает реальный спрос). По умолчанию top-1.
   * skill-page override ("Live total (skill page): N") имеет более высокий приоритет.
   */
  ukSumLive?: boolean;
  /**
   * Если задан regex, RU-vacancies = сумма `vacancies` по строкам, чей title
   * матчит regex (регистр игнорируется). По умолчанию `Math.max` по всем.
   * Нужно для ролей, где keyword слишком широкий (напр. "python" тянет ML/Data).
   */
  ruSumTitles?: string;
}

// ---------------------------------------------------------------------------
// Canonical registry — живёт в `prompts/kb/roles-catalog.json`.
// Чтобы поменять aiRisk / aliases / habrSpec — правь JSON, потом
// `npx tsx src/scripts/build-market-index.ts`.
// ---------------------------------------------------------------------------

const ROLES_CATALOG_FILE = "roles-catalog.json";

interface CatalogEntry extends Partial<RoleDef> {
  slug: string;
  displayTitle: string;
  category: string;
  aiRisk: AiRisk;
  notes?: string;
}

async function loadRolesCatalog(): Promise<RoleDef[]> {
  const path = join(KB_DIR, ROLES_CATALOG_FILE);
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as CatalogEntry[];
  if (!Array.isArray(parsed)) {
    throw new Error(`[roles-catalog] ${path}: expected JSON array, got ${typeof parsed}`);
  }
  const roles: RoleDef[] = [];
  for (const e of parsed) {
    if (!e.slug) throw new Error(`[roles-catalog] entry missing 'slug': ${JSON.stringify(e)}`);
    for (const required of ["displayTitle", "category", "aiRisk"] as const) {
      if (!e[required]) throw new Error(`[roles-catalog] ${e.slug}: missing required '${required}'`);
    }
    const { notes: _ignored, ...rest } = e;
    roles.push({
      ...rest,
      habrSpec: rest.habrSpec ?? null,
    });
  }
  if (roles.length === 0) throw new Error(`[roles-catalog] no roles parsed from ${path}`);
  return roles;
}

// ---------------------------------------------------------------------------
// Alias collection — displayTitle + slug + catalog aliases - dropAliases
// ---------------------------------------------------------------------------

function collectAliases(def: RoleDef): string[] {
  const aliases = new Set<string>();

  const title = def.displayTitle;
  aliases.add(title);
  aliases.add(title.replace(/\s*\(.*\)\s*/g, "").trim());
  aliases.add(def.slug.replace(/_/g, " "));

  for (const a of def.aliases ?? []) aliases.add(a);
  for (const d of def.dropAliases ?? []) aliases.delete(d);

  return [...aliases];
}

// ---------------------------------------------------------------------------
// Market data loaders
// ---------------------------------------------------------------------------

async function readOpt(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/** Default RU data file path: `ru_<slug>.md`. Override via `def.ruFile`. */
function resolveRuFile(def: RoleDef): string | null {
  if (def.ruFile === null) return null;
  return def.ruFile ?? `ru_${def.slug}.md`;
}

/** Default UK data file path: `uk_<slug>.md`. Override via `def.ukFile`. */
function resolveUkFile(def: RoleDef): string | null {
  if (def.ukFile === null) return null;
  return def.ukFile ?? `uk_${def.slug}.md`;
}

async function buildRu(def: RoleDef): Promise<RegionStats | null> {
  const file = resolveRuFile(def);
  if (!file) return null;
  const content = await readOpt(join(MARKET_DIR, file));
  if (!content) return null;
  const parsed = parseHhFile(content);
  if (!parsed) return null;

  const aggregate = (rows: { title: string; vacancies: number }[]): number => {
    if (def.ruSumTitles) {
      const re = new RegExp(def.ruSumTitles, "i");
      const sum = rows.filter((r) => re.test(r.title)).reduce((s, r) => s + r.vacancies, 0);
      if (sum > 0) return sum;
    }
    return rows.length > 0 ? Math.max(...rows.map((r) => r.vacancies)) : 0;
  };

  const vacancies = aggregate(parsed.rows.map((r) => ({
    title: r.title,
    vacancies: r.vacancies ?? 0,
  }))) || null;

  const trend = await buildRuTrend(def, aggregate);

  return {
    vacancies,
    medianSalaryMid: parsed.topMedianSalary,
    trend,
    source: `hh.ru (${file})`,
  };
}

interface RuSnapshot {
  date: string; // ISO YYYY-MM-DD
  slug: string;
  topMedianSalary: number | null;
  rows: { title: string; vacancies: number }[];
}

/**
 * Собираем trend для RU из JSON-снапшотов в `market-data/snapshots/`.
 * now = последний snapshot, yearAgo/twoYearsAgo = ближайшие snapshots в
 * окнах ±60 дней от (now - 365d) / (now - 730d). Если нет подходящих —
 * соответствующее поле = 0 (buildTrend отдаст null если нет базы).
 */
async function buildRuTrend(
  def: RoleDef,
  aggregate: (rows: { title: string; vacancies: number }[]) => number,
): Promise<RegionStats["trend"]> {
  const snapDir = join(MARKET_DIR, "snapshots");
  let files: string[];
  try {
    files = await readdir(snapDir);
  } catch {
    return null;
  }
  const prefix = `ru_${def.slug}_`;
  const snaps: RuSnapshot[] = [];
  for (const name of files) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const raw = await readOpt(join(snapDir, name));
    if (!raw) continue;
    try {
      snaps.push(JSON.parse(raw) as RuSnapshot);
    } catch {
      /* ignore broken snapshot */
    }
  }
  if (snaps.length < 2) return null;
  snaps.sort((a, b) => a.date.localeCompare(b.date));
  const latest = snaps[snaps.length - 1]!;
  const latestDate = new Date(latest.date);

  const WINDOW_DAYS = 60;
  const DAY = 24 * 60 * 60 * 1000;
  const findClosest = (targetDaysAgo: number): number => {
    const targetMs = latestDate.getTime() - targetDaysAgo * DAY;
    let best: RuSnapshot | null = null;
    let bestDiff = Infinity;
    for (const s of snaps) {
      const diff = Math.abs(new Date(s.date).getTime() - targetMs);
      if (diff > WINDOW_DAYS * DAY) continue;
      if (diff < bestDiff) {
        bestDiff = diff;
        best = s;
      }
    }
    return best ? aggregate(best.rows) : 0;
  };

  return buildTrend({
    now: aggregate(latest.rows),
    yearAgo: findClosest(365),
    twoYearsAgo: findClosest(730),
  });
}

async function buildUk(def: RoleDef): Promise<RegionStats | null> {
  const file = resolveUkFile(def);
  if (!file) return null;
  const content = await readOpt(join(MARKET_DIR, file));
  if (!content) return null;
  const parsed = parseItjwFile(content);
  if (!parsed) return null;
  const top = parsed.top3[0];

  // Источник числа вакансий — ТОЛЬКО live (текущие активные). Никогда
  // не падаем на `trend.now` (perm jobs 6m) или `permJobs6m` — это
  // накопленный поток за период и путает клиента (1597 "вакансий"
  // frontend_react на деле были 634 live + прошедшие за 6 месяцев).
  // Приоритет:
  //   1. skill-page live (hardcoded "Live total (skill page): N" строка в md)
  //   2. def.ukSumLive = true → сумма `liveNow` по родственным тайтлам
  //   3. top-1 `liveJobs` из поиска (по умолчанию)
  let vacancies: number | null = top?.liveJobs ?? null;
  const skillPageMatch = content.match(/Live total \(skill page[^)]*\):\s*([\d,]+)/i);
  if (skillPageMatch) {
    vacancies = parseInt(skillPageMatch[1]!.replace(/,/g, ""), 10) || vacancies;
  } else if (def.ukSumLive) {
    const totalLive = parsed.rows.reduce((s, r) => s + (r.liveNow ?? 0), 0);
    if (totalLive > 0) vacancies = totalLive;
  }

  return {
    vacancies,
    medianSalaryMid: top?.salary ?? null,
    trend: buildTrend(parsed.trend),
    source: `itjobswatch.co.uk (${file})`,
  };
}

/**
 * Преобразовать parsed.trend → RegionStats.trend с посчитанным ratio.
 * Приоритет базы: twoYearsAgo → yearAgo. Если now отсутствует / 0 → null.
 */
function buildTrend(
  raw: { now: number; yearAgo: number; twoYearsAgo: number } | null | undefined,
): RegionStats["trend"] {
  if (!raw || !raw.now) return null;
  const base = raw.twoYearsAgo > 0 ? raw.twoYearsAgo : raw.yearAgo > 0 ? raw.yearAgo : 0;
  if (base === 0) return null;
  const ratio = Math.round((raw.now / base) * 100) / 100;
  return {
    now: raw.now,
    yearAgo: raw.yearAgo,
    twoYearsAgo: raw.twoYearsAgo,
    ratio,
  };
}

// ---------------------------------------------------------------------------
// Competition KB loaders (vacancies per 100 specialists)
// ---------------------------------------------------------------------------

/**
 * Parse a markdown table from `app/src/prompts/kb/competition-*.md`.
 *
 * Expected columns:
 *   RU: `Направление | Slug(s) | Вакансий | Резюме | Ratio | ... | ...`  (ratio at idx 4)
 *   EU: `Направление | Slug(s) | Вакансий | Ratio | ... | ...`          (ratio at idx 3)
 *
 * Returns Map<slug, vacanciesPer100Specialists>. Rows with slug column "—"
 * or without any backticked slug are skipped (direction not in our catalog).
 */
async function loadCompetitionMap(
  file: string,
  ratioColIdx: number,
): Promise<Map<string, number>> {
  const content = await readOpt(join(KB_DIR, file));
  const map = new Map<string, number>();
  if (!content) {
    console.warn(`[market-index] competition KB missing: ${file}`);
    return map;
  }

  for (const line of content.split("\n")) {
    if (!line.startsWith("|")) continue;
    if (/^\|[\s:-]+\|/.test(line)) continue; // separator row `|---|---|...`

    // Drop leading/trailing pipes, split, trim.
    const cells = line
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.length < ratioColIdx + 1) continue;

    const slugCell = cells[1];
    if (!slugCell || slugCell === "—" || !slugCell.includes("`")) continue;

    const slugs = slugCell
      .replace(/`/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (slugs.length === 0) continue;

    const ratioMatch = cells[ratioColIdx].match(/~?\s*(\d+(?:\.\d+)?)/);
    if (!ratioMatch) continue;
    const ratio = parseFloat(ratioMatch[1]);
    if (!Number.isFinite(ratio)) continue;

    for (const s of slugs) {
      if (!map.has(s)) map.set(s, ratio);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function withCompetition(
  stats: RegionStats | null,
  ratio: number | undefined,
): RegionStats | null {
  if (!stats) return stats;
  if (ratio === undefined) return stats;
  return { ...stats, competitionPer100Specialists: ratio };
}

async function main(): Promise<void> {
  const registry = await loadRolesCatalog();
  console.log(
    `[market-index] Building from ${registry.length} roles (loaded from kb/${ROLES_CATALOG_FILE})…`,
  );

  const seen = new Set<string>();
  for (const def of registry) {
    if (seen.has(def.slug)) throw new Error(`Duplicate slug: ${def.slug}`);
    seen.add(def.slug);
  }

  // Columns in competition-ru.md: Направление | Slug(s) | Вакансий | Резюме | Ratio | Динамика | Конкуренция
  const competitionRu = await loadCompetitionMap("competition-ru.md", 4);
  // Columns in competition-eu.md: Направление | Slug(s) | Вакансий | Ratio | Динамика | Конкуренция
  const competitionEu = await loadCompetitionMap("competition-eu.md", 3);
  console.log(
    `[market-index] Competition KB: ${competitionRu.size} RU slugs, ${competitionEu.size} EU slugs`,
  );

  const index: MarketIndex = {};
  for (const def of registry) {
    const ruRatio = competitionRu.get(def.slug);
    const euRatio = competitionEu.get(def.slug);

    const entry: MarketIndexEntry = {
      slug: def.slug,
      displayTitle: def.displayTitle,
      category: def.category,
      ...(def.stackFamily ? { stackFamily: def.stackFamily } : {}),
      aliases: collectAliases(def),
      ru: withCompetition(await buildRu(def), ruRatio),
      uk: withCompetition(await buildUk(def), euRatio),
      eu: null,
      us: null,
      aiRisk: def.aiRisk,
    };
    index[def.slug] = entry;
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(index, null, 2), "utf-8");

  const entries = Object.values(index);
  const stats = {
    total: registry.length,
    withRu: entries.filter((e) => e.ru).length,
    withUk: entries.filter((e) => e.uk).length,
    withRuCompetition: entries.filter(
      (e) => e.ru?.competitionPer100Specialists !== undefined,
    ).length,
    withEuCompetition: entries.filter(
      (e) => e.uk?.competitionPer100Specialists !== undefined,
    ).length,
  };
  console.log(
    `[market-index] Wrote ${OUT_PATH} (${stats.total} roles; ${stats.withRu} RU, ${stats.withUk} UK; competition: ${stats.withRuCompetition} RU, ${stats.withEuCompetition} EU)`,
  );
}

main().catch((err) => {
  console.error("[market-index] Fatal:", err);
  process.exit(1);
});
