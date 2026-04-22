import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientSummary } from "../schemas/client-summary.js";
import type { MarketIndex, MarketIndexEntry } from "../schemas/market-index.js";
import { computeMarketBuckets, type MarketBuckets } from "./market-buckets.js";
import { isUsaPrimaryClient, USA_SALARY_MULTIPLIER } from "./market-access.js";
import {
  type ClientGrade,
  resolveClientGrade,
  roleSalaryForBucket,
} from "./client-grade.js";

/**
 * Deterministic two-stage role ranker for Phase 1A.
 *
 * Stage 1 — hard filters (per bucket, ru / abroad):
 *   1. Role must have stats in this bucket (vacancies > 0)
 *   2. vacancies >= 100 (we don't suggest niche markets)
 *   3. aiRisk !== "extreme"
 *   4. roleMedianSalary >= clientCurrentSalary  (нет смысла менять в минус)
 *
 * Current slug клиента и его desired slugs пропускают ВСЕ фильтры —
 * всегда включаются с флагом `guaranteed: true`.
 *
 * Stage 2 — weighted score (0..100):
 *   market (25) + competition (15, optional) + salary (20) + aiRisk (15) + adjacency (25)
 *   Competition пропускается если нет данных → вес размазывается пропорционально.
 *
 * Возвращает два независимых топ-N: ru-рынок и abroad-рынок (uk+eu+us).
 * Каждый рынок считается в своей валюте:
 *   ru:     RUB/мес напрямую
 *   abroad: EUR/мес (uk.medianSalaryMid annual GBP × 1.17 / 12)
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX_PATH = join(__dirname, "..", "..", "data", "market-index.json");

// Fixed ad-hoc FX rate (doc-only; updated once per quarter with competition KB).
export const GBP_TO_EUR = 1.17;

let cachedIndex: MarketIndex | null = null;

export async function loadMarketIndex(): Promise<MarketIndex> {
  if (cachedIndex) return cachedIndex;
  const content = await readFile(DEFAULT_INDEX_PATH, "utf-8");
  cachedIndex = JSON.parse(content) as MarketIndex;
  return cachedIndex;
}

export function _resetScorerCache(): void {
  cachedIndex = null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BucketKey = "ru" | "abroad";

export interface ScoredRoleComponents {
  /** 0..100 log-normalised vacancies */
  market: number;
  /** 0..100 by vacancies per 100 specialists; null if KB data missing */
  competition: number | null;
  /** 0..100 by role median vs client desired */
  salary: number;
  /** 0..100 inverse of AI-risk bucket */
  aiRisk: number;
  /** 0..100 by role category distance from client current/desired */
  adjacency: number;
  /**
   * 0..100 по динамике спроса (now/twoYearsAgo). null если истории нет
   * (типично для RU до накопления snapshot-ов — компонент скипается).
   */
  trend: number | null;
}

export interface ScoredRole {
  slug: string;
  displayTitle: string;
  market: BucketKey;
  score: number;
  components: ScoredRoleComponents;
  reasons: string[];
  /** true — role survived as current/desired regardless of filters. */
  guaranteed?: boolean;
  /** Debug: was the role filtered but forced in because guaranteed? */
  wouldFilter?: { reason: string };
}

export interface RankResult {
  ru: ScoredRole[];
  abroad: ScoredRole[];
  buckets: MarketBuckets;
  /** Грейд, на котором считались зарплаты роли (для hard-filter и salary-компонента). */
  clientGrade: ClientGrade;
}

// ---------------------------------------------------------------------------
// Weights (percent; sum can differ from 100 — we renormalise on missing parts).
// ---------------------------------------------------------------------------

// Главный KPI проекта — привести клиента к зарплате, которую он хочет
// (`desiredSalary` на сейчас, `desiredSalary3to5y` на горизонт 3–5 лет).
// Поэтому salary — самый тяжёлый компонент. adjacency/market вторичны:
// близость перехода и размер рынка важны, но роль, которая не закрывает
// ожидания клиента, не решает его задачу.
const WEIGHTS = {
  salary: 30,
  adjacency: 22,
  market: 22,
  aiRisk: 15,
  competition: 10,
  // Trend — мягкий tie-breaker между близкими ролями.
  trend: 5,
} as const;

// ---------------------------------------------------------------------------
// Component scorers (0..100)
// ---------------------------------------------------------------------------

export function marketComponent(vacancies: number | null | undefined): number {
  if (!vacancies || vacancies <= 0) return 0;
  return Math.round(Math.min(100, 15 * Math.log10(vacancies + 1)));
}

export function competitionComponent(ratio: number | null | undefined): number | null {
  if (ratio === null || ratio === undefined) return null;
  if (ratio >= 10) return 100;
  if (ratio >= 5) return 70;
  if (ratio >= 3) return 45;
  if (ratio >= 1) return 25;
  return 5;
}

/**
 * Meet expectations: роль должна быть НЕ НИЖЕ желаемой клиентом зп.
 * Верхний cap НЕ применяем — если рынок платит больше ожиданий,
 * это нормально (Клод на Phase 1B решит по whyFits/характеру, подходит
 * ли клиенту такая роль — например, готов ли он к высокой нагрузке).
 *
 * Шкала по ratio = roleSalary@grade / desiredSalary:
 *   - ≥ 0.95  → 100 (meeting или выше — идеально)
 *   - 0.85..0.95 → 80 (чуть ниже, но реалистично для быстрого оффера)
 *   - 0.70..0.85 → 55 (ощутимая просадка относительно ожиданий)
 *   - 0.50..0.70 → 30 (далеко от ожиданий, только как мост)
 *   - < 0.50  → 10 (мимо цели)
 */
export function salaryComponent(
  roleMedian: number | null | undefined,
  clientDesired: number | null | undefined,
): number {
  if (!roleMedian || !clientDesired) return 50; // neutral when data missing
  const ratio = roleMedian / clientDesired;
  if (ratio >= 0.95) return 100;
  if (ratio >= 0.85) return 80;
  if (ratio >= 0.70) return 55;
  if (ratio >= 0.50) return 30;
  return 10;
}

/**
 * 0..100 по динамике спроса. ratio = now / twoYearsAgo (или yearAgo-fallback).
 * `null` → данных нет, компонент скипается (вес размазывается).
 */
export function trendComponent(ratio: number | null | undefined): number | null {
  if (ratio === null || ratio === undefined) return null;
  if (ratio >= 1.2) return 85;
  if (ratio >= 1.0) return 70;
  if (ratio >= 0.85) return 60;
  if (ratio >= 0.6) return 45;
  if (ratio >= 0.4) return 30;
  return 20;
}

export function aiRiskComponent(risk: MarketIndexEntry["aiRisk"]): number {
  switch (risk) {
    case "low":
      return 100;
    case "medium":
      return 75;
    case "high":
      return 35;
    case "extreme":
      return 5; // hard-filtered but kept for guaranteed roles
    default:
      return 60;
  }
}

// Category-to-category affinity. 75 = same category bonus (handled directly
// in adjacencyComponent, not stored here).
//
// CATEGORY_BRIDGE is generated by `pnpm tsx app/src/scripts/mine-transitions.ts`
// from expert-reviewed client cases in `app/src/prompts/training-examples.md`,
// smoothed with Bayesian k=3 over hand-tuned priors kept inside the mining
// script (PRIOR_BRIDGE). Re-run the script whenever the matrix or priors change.
import { CATEGORY_BRIDGE } from "../data/category-bridge.generated.js";

export function adjacencyComponent(
  role: MarketIndexEntry,
  currentSlug: string | null | undefined,
  desiredSlugs: Set<string>,
  currentEntry: MarketIndexEntry | null,
): number {
  if (currentSlug && role.slug === currentSlug) return 100;
  if (desiredSlugs.has(role.slug)) return 95;
  if (!currentEntry) return 40; // non-IT current — everything equally far
  if (currentEntry.category === role.category) return 75;
  const bridge = CATEGORY_BRIDGE[currentEntry.category]?.[role.category];
  if (bridge !== undefined) return bridge;
  return 25;
}

// ---------------------------------------------------------------------------
// Bucket adapters
// ---------------------------------------------------------------------------

function pickBucketStats(entry: MarketIndexEntry, bucket: BucketKey) {
  if (bucket === "ru") return entry.ru;
  return entry.uk ?? entry.eu ?? entry.us;
}

function totalAbroadVacancies(entry: MarketIndexEntry): number {
  return (
    (entry.uk?.vacancies ?? 0) +
    (entry.eu?.vacancies ?? 0) +
    (entry.us?.vacancies ?? 0)
  );
}

function totalVacancies(entry: MarketIndexEntry, bucket: BucketKey): number {
  if (bucket === "ru") return entry.ru?.vacancies ?? 0;
  return totalAbroadVacancies(entry);
}

/**
 * Role salary in bucket's comparison unit (RUB/month for ru, EUR/month for
 * abroad) НА ГРЕЙДЕ КЛИЕНТА. Источник — `seniorityCurve[clientGrade]`
 * если заполнен, иначе `medianSalaryMid × GRADE_MULTIPLIERS[clientGrade]`
 * (см. `client-grade.ts`).
 *
 * Раньше возвращали `medianSalaryMid` напрямую (это middle+ рынка),
 * из-за чего senior-клиенты получали заниженные зарплатные сигналы:
 * например UK Backend Go median=£85k выглядел как €8285/мес, а для
 * senior-а по curve это €10770/мес → роль ошибочно дропалась по floor.
 */
function roleSalaryForClient(
  entry: MarketIndexEntry,
  bucket: BucketKey,
  grade: ClientGrade,
  summary: ClientSummary,
): number | null {
  const base = roleSalaryForBucket(entry, bucket, grade);
  if (base === null) return null;
  // USA-adjust: наши abroad-медианы из UK-источников; для USA-клиентов
  // (target us / физически в США) умножаем, чтобы compare с их ожиданиями
  // не отсекал адекватные senior-роли.
  if (
    bucket === "abroad" &&
    isUsaPrimaryClient({
      targetMarketRegions: summary.targetMarketRegions ?? [],
      physicalCountry: summary.physicalCountry ?? "",
    })
  ) {
    return Math.round(base * USA_SALARY_MULTIPLIER);
  }
  return base;
}

/** Client salary in bucket's comparison unit, or null if not provided in that currency. */
function clientSalary(summary: ClientSummary, bucket: BucketKey): {
  current: number | null;
  desired: number | null;
} {
  if (bucket === "ru") {
    return {
      current: summary.currentSalaryRub ?? null,
      desired: summary.desiredSalaryRub ?? null,
    };
  }
  return {
    current: summary.currentSalaryEur ?? null,
    desired: summary.desiredSalaryEur ?? null,
  };
}

// ---------------------------------------------------------------------------
// Hard filters
// ---------------------------------------------------------------------------

export interface HardFilterResult {
  ok: boolean;
  reason: string;
}

export function passesHardFilters(
  entry: MarketIndexEntry,
  bucket: BucketKey,
  summary: ClientSummary,
  clientGrade: ClientGrade,
): HardFilterResult {
  const stats = pickBucketStats(entry, bucket);
  if (!stats || !stats.vacancies || stats.vacancies <= 0) {
    return { ok: false, reason: `нет данных рынка (${bucket})` };
  }
  const vacancies = totalVacancies(entry, bucket);
  if (vacancies < 100) return { ok: false, reason: `${vacancies} вакансий < 100` };
  if (entry.aiRisk === "extreme") return { ok: false, reason: "AI-risk extreme" };

  const { current, desired } = clientSalary(summary, bucket);
  const roleSalary = roleSalaryForClient(entry, bucket, clientGrade, summary);
  // Salary floor = максимум из:
  //   - `desired × 0.85`  — роль не должна быть сильно ниже ожиданий
  //     (15% допуск, если рынок чуть-чуть не дотягивает).
  //   - `current × 1.10`  — роль должна давать хотя бы +10% к текущей зп
  //     (горизонтальный переход без плюса к зп клиенту не интересен).
  //
  // Если desired нет — floor = current × 1.10.
  // Если current нет — floor = desired × 0.85.
  // Если оба null — фильтр не применяется (salary остаётся soft-компонентом).
  //
  // Верхнего cap НЕТ: перерасход над ожиданиями не режем (Клод на Phase 1B
  // сам решит по характеру клиента, подходит ли ему high-expectation роль).
  //
  // Сравнение идёт на ГРЕЙДЕ КЛИЕНТА (senior vs senior, а не senior vs middle),
  // иначе senior-клиентов отсекает по заниженной middle-медиане.
  const desiredFloor = desired && desired > 0 ? desired * 0.85 : 0;
  const currentFloor = current && current > 0 ? current * 1.1 : 0;
  const floor = Math.max(desiredFloor, currentFloor);
  if (floor > 0 && roleSalary && roleSalary < floor) {
    const cur = bucket === "ru" ? "₽" : "€";
    const label =
      desiredFloor >= currentFloor && desiredFloor > 0
        ? `desired×0.85 ${cur}${Math.round(desiredFloor)}`
        : `current×1.10 ${cur}${Math.round(currentFloor)}`;
    return {
      ok: false,
      reason: `зп@${clientGrade} ${cur}${roleSalary} < ${label}`,
    };
  }
  return { ok: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Weighted score
// ---------------------------------------------------------------------------

function computeScore(c: ScoredRoleComponents): number {
  let sum = 0;
  let total = 0;
  const add = (v: number | null, w: number) => {
    if (v === null) return;
    sum += v * w;
    total += w;
  };
  add(c.market, WEIGHTS.market);
  add(c.competition, WEIGHTS.competition);
  add(c.salary, WEIGHTS.salary);
  add(c.aiRisk, WEIGHTS.aiRisk);
  add(c.adjacency, WEIGHTS.adjacency);
  add(c.trend, WEIGHTS.trend);
  return total > 0 ? Math.round(sum / total) : 0;
}

// ---------------------------------------------------------------------------
// Scoring one role
// ---------------------------------------------------------------------------

function scoreOneRole(
  entry: MarketIndexEntry,
  bucket: BucketKey,
  summary: ClientSummary,
  currentSlug: string | null,
  desiredSlugs: Set<string>,
  currentEntry: MarketIndexEntry | null,
  clientGrade: ClientGrade,
): { components: ScoredRoleComponents; reasons: string[] } {
  const stats = pickBucketStats(entry, bucket);
  const vacancies = totalVacancies(entry, bucket);
  const { desired } = clientSalary(summary, bucket);

  const roleSalary = roleSalaryForClient(entry, bucket, clientGrade, summary);
  const isUsaAdjusted =
    bucket === "abroad" &&
    isUsaPrimaryClient({
      targetMarketRegions: summary.targetMarketRegions ?? [],
      physicalCountry: summary.physicalCountry ?? "",
    });

  const components: ScoredRoleComponents = {
    market: marketComponent(vacancies),
    competition: competitionComponent(stats?.competitionPer100Specialists),
    salary: salaryComponent(roleSalary, desired),
    aiRisk: aiRiskComponent(entry.aiRisk),
    adjacency: adjacencyComponent(entry, currentSlug, desiredSlugs, currentEntry),
    trend: trendComponent(stats?.trend?.ratio),
  };

  const reasons: string[] = [];
  reasons.push(`${vacancies} вак`);
  if (stats?.competitionPer100Specialists !== undefined && stats.competitionPer100Specialists !== null) {
    reasons.push(`${stats.competitionPer100Specialists}/100`);
  }
  if (roleSalary) {
    // Показываем зп на грейде клиента. Для мостов/даунгрейдов Клод может
    // взять меньшее значение сама — это подсказка.
    // Для USA-клиента помечаем «USA×1.5», чтобы Клод не путался — это
    // скорректированная под USA-рынок медиана, а не прямые EU-данные.
    const suffix = isUsaAdjusted ? ` USA×${USA_SALARY_MULTIPLIER}` : "";
    reasons.push(
      bucket === "ru"
        ? `${Math.round(roleSalary / 1000)}k₽@${clientGrade}${suffix}`
        : `€${Math.round(roleSalary)}@${clientGrade}${suffix}`,
    );
  }
  reasons.push(`AI=${entry.aiRisk}`);
  if (stats?.trend?.ratio) {
    const r = stats.trend.ratio;
    const arrow = r >= 1.0 ? "↑" : "↓";
    reasons.push(`${arrow} ×${r.toFixed(2)}`);
  }
  if (currentSlug && entry.slug === currentSlug) {
    reasons.push("текущая");
  } else if (desiredSlugs.has(entry.slug)) {
    reasons.push("desired");
  } else if (currentEntry && entry.category === currentEntry.category) {
    reasons.push(`та же кат. (${entry.category})`);
  }

  return { components, reasons };
}

// ---------------------------------------------------------------------------
// Bucket-level ranking
// ---------------------------------------------------------------------------

async function rankBucket(
  summary: ClientSummary,
  bucket: BucketKey,
  topN: number,
  clientGrade: ClientGrade,
): Promise<ScoredRole[]> {
  const index = await loadMarketIndex();
  const currentSlug = summary.currentProfessionSlug ?? null;
  const desiredSlugs = new Set<string>(
    (summary.desiredDirectionSlugs ?? []).map((d) => d.slug),
  );
  const guaranteed = new Set<string>(desiredSlugs);
  if (currentSlug) guaranteed.add(currentSlug);

  const currentEntry: MarketIndexEntry | null =
    currentSlug && index[currentSlug] ? index[currentSlug] : null;

  const scored: ScoredRole[] = [];
  for (const entry of Object.values(index)) {
    const isGuaranteed = guaranteed.has(entry.slug);
    const filter = passesHardFilters(entry, bucket, summary, clientGrade);
    if (!isGuaranteed && !filter.ok) continue;

    const { components, reasons } = scoreOneRole(
      entry,
      bucket,
      summary,
      currentSlug,
      desiredSlugs,
      currentEntry,
      clientGrade,
    );
    const score = computeScore(components);
    if (isGuaranteed) reasons.unshift("гарантированно");

    scored.push({
      slug: entry.slug,
      displayTitle: entry.displayTitle,
      market: bucket,
      score,
      components,
      reasons,
      ...(isGuaranteed ? { guaranteed: true } : {}),
      ...(!filter.ok ? { wouldFilter: { reason: filter.reason } } : {}),
    });
  }

  // Sort: guaranteed first (preserving their own score order), then rest by score.
  scored.sort((a, b) => {
    const gA = a.guaranteed ? 1 : 0;
    const gB = b.guaranteed ? 1 : 0;
    if (gA !== gB) return gB - gA;
    return b.score - a.score;
  });

  return scored.slice(0, topN);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function rankRoles(
  summary: ClientSummary,
  topN: number = 15,
): Promise<RankResult> {
  const buckets = computeMarketBuckets(summary);
  const clientGrade = resolveClientGrade(summary);
  const [ru, abroad] = await Promise.all([
    buckets.ru ? rankBucket(summary, "ru", topN, clientGrade) : Promise.resolve([]),
    buckets.abroad
      ? rankBucket(summary, "abroad", topN, clientGrade)
      : Promise.resolve([]),
  ]);
  return { ru, abroad, buckets, clientGrade };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtComponent(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return String(Math.round(v));
}

function renderBucketTable(rows: ScoredRole[], bucketLabel: string): string {
  if (rows.length === 0) return `_(для рынка ${bucketLabel} нет подходящих ролей)_`;
  const head =
    `| # | slug | score | m | c | s | ai | adj | t | reasons |\n` +
    `|---|------|------:|--:|--:|--:|---:|----:|--:|---------|`;
  const body = rows
    .map((r, i) => {
      const c = r.components;
      const reasons = r.reasons.slice(0, 3).join("; ").replace(/\|/g, "/");
      const gFlag = r.guaranteed ? " ★" : "";
      return `| ${i + 1} | ${r.slug}${gFlag} | ${Math.round(r.score)} | ${fmtComponent(c.market)} | ${fmtComponent(c.competition)} | ${fmtComponent(c.salary)} | ${fmtComponent(c.aiRisk)} | ${fmtComponent(c.adjacency)} | ${fmtComponent(c.trend)} | ${reasons} |`;
    })
    .join("\n");
  return `**${bucketLabel}**\n\n${head}\n${body}`;
}

/**
 * Render RankResult as a compact markdown block for prompt-02 context.
 *
 * ★ рядом со slug — `guaranteed` (текущая/желаемая роль клиента,
 * прошла мимо фильтров). Компоненты — 0..100; t (trend) и c (competition)
 * могут быть "—" если данных нет.
 */
export function formatScorerTop20ForPrompt(
  result: RankResult,
  topN: number = 20,
): string {
  const parts: string[] = [];
  const ru = result.ru.slice(0, topN);
  const abroad = result.abroad.slice(0, topN);
  parts.push(
    `_Зарплата роли в таблице — на грейде клиента (**${result.clientGrade}**). Источник: seniorityCurve[${result.clientGrade}] из market-index или fallback medianMid × множитель (junior ×0.75, middle ×1.0, senior ×1.3, lead ×1.6)._`,
  );
  if (ru.length > 0) parts.push(renderBucketTable(ru, "RU"));
  if (abroad.length > 0) parts.push(renderBucketTable(abroad, "Abroad (UK/EU/US)"));
  if (parts.length === 1) return "_(scorer вернул пустой топ для обоих рынков)_";
  parts.push(
    "_Компоненты: m=market · c=competition · s=salary · ai=ai-risk · adj=adjacency · t=trend. ★ — гарантированная (текущая/желаемая) роль клиента._",
  );
  return parts.join("\n\n");
}
