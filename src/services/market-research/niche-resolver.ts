/**
 * Niche-resolver: для конкретного `direction.title` находит canonical
 * itjobswatch-данные (vacancies, salary GBP, trend) в `uk_<slug>.md`.
 *
 * Мэппинг `direction.title → row.title` живёт в двух слоях:
 *   1. **Committed KB** (`niche-aliases.json` в репо) — стабильные
 *      проверенные mappings (DevSecOps Engineer → DevSecOps и т.д.).
 *   2. **Runtime store** (`/var/data/niche-aliases-runtime.json` через
 *      state-store.saveMap) — per-installation aliases, которые накапливаются
 *      когда resolver встречает unknown niche.
 *      Read order: runtime overrides committed (если бот-flow явно перепинил).
 *
 * Резолвинг (по приоритету):
 *   1. **Alias-lookup**: ищем `(slug, normalized title)` сначала в runtime,
 *      потом в committed. Hit → берём row из `uk_<slug>.md`.
 *   2. **Scoring-fallback**: token-match по основной таблице. Если найден
 *      reasonable match — используем + log warning «add explicit alias».
 *   3. **Live scrape** (UK only, alias+scoring miss):
 *      - scrapeNicheCandidates(query, top=5)
 *      - appendRowsToMain(region, slug, rows) — append-only, существующие
 *        rows не трогаем
 *      - pin top-1 by liveJobs в runtime store как `source: "live-scrape"`
 *      - return top-1 как ResolvedNiche; alternatives логируем для
 *        будущего бот-flow disambiguation.
 *
 * Region: bucket=ru → `ru_<slug>.md` (hh.ru). Остальные (abroad/usa/uk) →
 * `uk_<slug>.md` как UK-proxy.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Direction } from "../../schemas/analysis-outputs.js";
import {
  loadSlugFile,
  appendRowsToMain,
  type ParsedTitleRow,
  type ParsedSlugFile,
} from "./md-parser.js";
import {
  scrapeNicheCandidates,
  computeTrendRatio,
  type ItjobswatchTrend,
  type ItjobswatchRow,
} from "../itjw-scraper.js";
import { loadMap, saveMap } from "../state-store.js";

export type ResolvedNicheSource = "itjw-canonical" | "itjw-live";

export interface ResolvedNiche {
  source: ResolvedNicheSource;
  slugFileUsed: string;
  matchedTitle: string;
  /** Live vacancies count (никогда не null если resolver вернул не null). */
  vacancies: number;
  /** Median salary GBP per year (или null если в файле "N/A"). */
  medianSalaryGbp: number | null;
  /** Salary YoY change in % (positive = grew). */
  salaryYoYPct: number | null;
  /** Demand trend ratio (now / 2yAgo). */
  trendRatio: number | null;
  /** Raw trend для downstream. */
  trend: ItjobswatchTrend | null;
  /** Source URL — itjobswatch search или per-title detail page. */
  sourceUrl: string;
  /**
   * Top-N кандидатов из live-scrape (если он был). Используется будущим
   * TG-бот-flow для disambiguation: показать кнопки «какой канон выбрать?».
   * Пустой массив для alias hits / scoring matches.
   */
  alternatives: NicheCandidate[];
}

export interface NicheCandidate {
  title: string;
  vacancies: number | null;
  medianSalaryGbp: number | null;
  salaryYoYPct: number | null;
}

// ─── Committed aliases (niche-aliases.json в репо) ────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMITTED_ALIASES_PATH = join(__dirname, "niche-aliases.json");

type NicheAliases = Record<string, Record<string, string>>;

let _committedCache: NicheAliases | null = null;
function loadCommittedAliases(): NicheAliases {
  if (_committedCache) return _committedCache;
  try {
    const raw = readFileSync(COMMITTED_ALIASES_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: NicheAliases = {};
    for (const [slug, mapping] of Object.entries(parsed)) {
      if (slug.startsWith("$") || typeof mapping !== "object" || mapping === null) {
        continue;
      }
      const slugMap: Record<string, string> = {};
      for (const [from, to] of Object.entries(mapping as Record<string, unknown>)) {
        if (typeof to !== "string") continue;
        slugMap[from.toLowerCase()] = to;
      }
      out[slug] = slugMap;
    }
    _committedCache = out;
    return out;
  } catch (err) {
    console.warn(`[niche-resolver] failed to load niche-aliases.json:`, err);
    _committedCache = {};
    return {};
  }
}

// ─── Runtime aliases (state-store /var/data) ──────────────────────────────

const RUNTIME_STORE_NAME = "niche-aliases-runtime";

interface RuntimeAlias {
  rowTitle: string;
  /** Когда создан (для debug/cleanup). */
  createdAt: string;
  /**
   * Как заполнен:
   *   - "live-scrape": resolver сам пин-ит top-1 после live scrape.
   *   - "user-pin":    бот / CLI явно пинит выбор пользователя.
   */
  source: "live-scrape" | "user-pin";
}

let _runtimeCache: Map<string, RuntimeAlias> | null = null;
function loadRuntime(): Map<string, RuntimeAlias> {
  if (_runtimeCache) return _runtimeCache;
  _runtimeCache = loadMap<RuntimeAlias>(RUNTIME_STORE_NAME);
  return _runtimeCache;
}

function runtimeKey(slug: string, normalized: string): string {
  return `${slug}::${normalized}`;
}

function setRuntimeAlias(
  slug: string,
  normalizedTitle: string,
  rowTitle: string,
  source: RuntimeAlias["source"],
): void {
  const map = loadRuntime();
  map.set(runtimeKey(slug, normalizedTitle), {
    rowTitle,
    createdAt: new Date().toISOString(),
    source,
  });
  saveMap(RUNTIME_STORE_NAME, map);
}

/** Public API для CLI / бот-flow: явно закрепить alias. */
export function pinNicheAlias(
  slug: string,
  directionTitle: string,
  rowTitle: string,
  source: RuntimeAlias["source"] = "user-pin",
): void {
  const normalized = normalizeTitleForAlias(directionTitle);
  setRuntimeAlias(slug, normalized, rowTitle, source);
}

/** Public API: список runtime-pinned aliases (debug / migrate to committed). */
export function listRuntimeAliases(): Array<{ key: string; alias: RuntimeAlias }> {
  const out: Array<{ key: string; alias: RuntimeAlias }> = [];
  for (const [key, alias] of loadRuntime().entries()) {
    out.push({ key, alias });
  }
  return out;
}

// ─── Title normalization ─────────────────────────────────────────────────

/**
 * Нормализует direction.title для лукапа в aliases:
 *   - lower-case
 *   - убирает grade-маркер в скобках "(senior)", "(staff+)"
 *   - схлопывает множественные пробелы
 */
export function normalizeTitleForAlias(title: string): string {
  return title
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Main resolver ───────────────────────────────────────────────────────

export async function resolveNiche(
  direction: Direction,
  effectiveSlug: string,
): Promise<ResolvedNiche | null> {
  const region = direction.bucket === "ru" ? "ru" : "uk";
  const file = await loadSlugFile(region, effectiveSlug);
  const normalized = normalizeTitleForAlias(direction.title);

  // 1. Alias lookup (runtime → committed)
  if (file) {
    const aliasResolved = resolveViaAlias(normalized, effectiveSlug, file);
    if (aliasResolved) {
      return buildFromRow(aliasResolved.row, file, effectiveSlug, "itjw-canonical");
    }
  }

  // 2. Scoring fallback (best-effort token match)
  if (file) {
    const scored = matchRowInTable(direction.title, file.rows);
    if (scored) {
      console.warn(
        `[niche-resolver] no alias for "${direction.title}" in ${region}_${effectiveSlug}.md, ` +
          `best-effort scoring match → "${scored.row.title}" (score=${scored.score.toFixed(1)}). ` +
          `Pin via TG bot or: tsx src/scripts/add-niche-alias.ts ${effectiveSlug} "${normalized}" "${scored.row.title}"`,
      );
      return buildFromRow(scored.row, file, effectiveSlug, "itjw-canonical");
    }
  }

  // 3. Live scrape (UK only)
  if (region !== "uk") return null;

  console.log(
    `[niche-resolver] no match for "${direction.title}" in ${region}_${effectiveSlug}.md, scraping live...`,
  );

  let candidates: ItjobswatchRow[] = [];
  let sourceUrl = `https://www.itjobswatch.co.uk/default.aspx?q=${encodeURIComponent(direction.title)}`;
  try {
    const result = await scrapeNicheCandidates(direction.title, 5);
    candidates = result.rows;
    sourceUrl = result.sourceUrl;
  } catch (err) {
    console.warn(`[niche-resolver] live scrape failed for "${direction.title}":`, err);
    return null;
  }

  if (candidates.length === 0) {
    console.warn(`[niche-resolver] live scrape returned 0 candidates for "${direction.title}"`);
    return null;
  }

  // Append candidates в md (append-only, существующие rows не трогаем).
  try {
    const appended = await appendRowsToMain(region, effectiveSlug, candidates);
    if (appended.length > 0) {
      console.log(
        `[niche-resolver] appended ${appended.length} new row(s) to ${region}_${effectiveSlug}.md: ${appended.join(", ")}`,
      );
    }
  } catch (err) {
    console.warn(`[niche-resolver] failed to append rows:`, err);
  }

  // Pin top-1 by liveJobs в runtime store (auto-pin, может перезаписаться
  // позже user-pin-ом из бот-flow).
  const top1 = candidates[0]!;
  setRuntimeAlias(effectiveSlug, normalized, top1.title, "live-scrape");

  const altLines = candidates
    .map((c) => `${c.title} · vac=${c.liveJobs ?? "?"} · ${c.medianSalary}`)
    .join(" | ");
  console.warn(
    `[niche-resolver] live-scraped "${top1.title}" (auto-pinned top-1). ` +
      `Alternatives: ${altLines}. ` +
      `User can re-pin via TG bot.`,
  );

  return {
    source: "itjw-live",
    slugFileUsed: `${region}_${effectiveSlug}.md`,
    matchedTitle: top1.title,
    vacancies: top1.liveJobs ?? 0,
    medianSalaryGbp: parseGbp(top1.medianSalary),
    salaryYoYPct: parsePct(top1.salaryYoYChange),
    trendRatio: null,
    trend: null,
    sourceUrl,
    alternatives: candidates.map((c) => ({
      title: c.title,
      vacancies: c.liveJobs,
      medianSalaryGbp: parseGbp(c.medianSalary),
      salaryYoYPct: parsePct(c.salaryYoYChange),
    })),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function resolveViaAlias(
  normalized: string,
  slug: string,
  file: ParsedSlugFile,
): { row: ParsedTitleRow } | null {
  // 1. Runtime store
  const runtime = loadRuntime();
  const runtimeHit = runtime.get(runtimeKey(slug, normalized));
  if (runtimeHit) {
    const row = file.rows.find(
      (r) => r.title.toLowerCase() === runtimeHit.rowTitle.toLowerCase(),
    );
    if (row) return { row };
    console.warn(
      `[niche-resolver] runtime alias "${normalized}" → "${runtimeHit.rowTitle}" but row missing in ${file.filePath}. Falling back.`,
    );
  }

  // 2. Committed JSON
  const committed = loadCommittedAliases();
  const slugMap = committed[slug];
  if (!slugMap) return null;
  const targetTitle = slugMap[normalized];
  if (!targetTitle) return null;

  const row = file.rows.find((r) => r.title.toLowerCase() === targetTitle.toLowerCase());
  if (!row) {
    console.warn(
      `[niche-resolver] committed alias "${normalized}" → "${targetTitle}" but row missing in ${file.filePath}. Refresh md via probe-uk-market.`,
    );
    return null;
  }
  return { row };
}

function buildFromRow(
  row: ParsedTitleRow,
  file: ParsedSlugFile,
  slug: string,
  source: ResolvedNicheSource,
): ResolvedNiche | null {
  const vacancies = row.liveJobs;
  if (vacancies === null) return null;

  const trendRatio = file.topTrend ? computeTrendRatio(file.topTrend) : null;

  return {
    source,
    slugFileUsed: file.filePath,
    matchedTitle: row.title,
    vacancies,
    medianSalaryGbp: row.medianSalaryGbp,
    salaryYoYPct: row.salaryYoYPct,
    trendRatio,
    trend: file.topTrend,
    sourceUrl: `https://www.itjobswatch.co.uk/default.aspx?q=${encodeURIComponent(slug)}`,
    alternatives: [],
  };
}

function parseGbp(raw: string): number | null {
  const m = raw.replace(/[\s,]/g, "").match(/£?(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  return Number.isFinite(n) ? n : null;
}

function parsePct(raw: string): number | null {
  if (!raw || raw === "-") return null;
  const m = raw.replace(/\s/g, "").match(/([+-]?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  return Number.isFinite(n) ? n : null;
}

// ─── Scoring fallback (best-effort) ──────────────────────────────────────

/**
 * Token-based fuzzy match. Используется как FALLBACK когда alias не нашёлся.
 * При срабатывании логируем warning с подсказкой добавить alias.
 *
 * Score = matchedCore × 10 + matchedDisc × 8 - row.title.length / 100.
 *
 * НЕ предназначен для тонких case-ов вроде DevSecOps vs DevSecOps Engineer —
 * для них нужен явный alias (committed JSON или runtime pin).
 */
function matchRowInTable(
  title: string,
  rows: ParsedTitleRow[],
): { row: ParsedTitleRow; score: number } | null {
  if (rows.length === 0) return null;

  const wantCore = expandAbbreviations(coreTokens(title));
  const wantDisc = discriminatorTokens(title);
  if (wantCore.length === 0 && wantDisc.length === 0) return null;

  let best: { row: ParsedTitleRow; score: number } | null = null;

  for (const row of rows) {
    const rowLower = row.title.toLowerCase();
    const matchedCore = new Set(wantCore.filter((t) => rowLower.includes(t)));
    const matchedDisc = new Set(wantDisc.filter((t) => rowLower.includes(t)));

    if (matchedCore.size === 0) continue;

    const score = matchedCore.size * 10 + matchedDisc.size * 8 - row.title.length / 100;

    if (!best || score > best.score) {
      best = { row, score };
    }
  }

  return best;
}

const STOPWORDS = new Set<string>([
  "developer",
  "specialist",
  "lead",
  "leader",
  "senior",
  "junior",
  "middle",
  "intern",
  "the",
  "and",
  "with",
  "of",
]);

const DISCRIMINATORS = new Set<string>([
  "engineer",
  "analyst",
  "manager",
  "consultant",
  "architect",
  "researcher",
  "scientist",
  "designer",
]);

function coreTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !DISCRIMINATORS.has(t));
}

function discriminatorTokens(s: string): string[] {
  const tokens = s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => DISCRIMINATORS.has(t));
  return [...new Set(tokens)];
}

function expandAbbreviations(tokens: string[]): string[] {
  const expansions: Record<string, string[]> = {
    appsec: ["application", "security"],
    soc: ["operations"],
    devsecops: ["devops", "security"],
    sre: ["reliability"],
    ml: ["machine", "learning"],
    mle: ["machine", "learning"],
    nlp: ["language"],
    qa: ["quality"],
    pm: ["product"],
    se: ["software"],
  };
  const out = new Set<string>();
  for (const t of tokens) {
    out.add(t);
    for (const ext of expansions[t] ?? []) out.add(ext);
  }
  return [...out];
}

/** Reset internal caches (для тестов). */
export function _clearAliasCaches(): void {
  _committedCache = null;
  _runtimeCache = null;
}
