/**
 * Shared itjobswatch.co.uk scraper.
 *
 * Раньше эти функции жили внутри `scripts/probe-uk-market.ts`. Вынесены в
 * сервис чтобы переиспользовать в Phase 2 niche-resolver-е (on-demand
 * scraping узких ниш типа DevSecOps Engineer).
 *
 * Главные функции:
 *   - `fetchItjwSearch(query)` — `/default.aspx?q=<query>`, парсит таблицу.
 *   - `scrapeItjwDetail(url)` — detail-страница тайтла с динамикой.
 *   - `scrapeNicheTitle(title)` — high-level helper: ищет конкретный title,
 *     возвращает best-match row + trend (или null если 0 результатов).
 *
 * itjobswatch отвечает быстро (~300-500 ms search, ещё столько же detail),
 * but сайт публичный без rate-limit'а на разумных нагрузках. Caller обязан
 * сам делать `sleep(300)` между запросами в batch-режиме.
 */
import * as cheerio from "cheerio";

const ITJW_BASE = "https://www.itjobswatch.co.uk";
const USER_AGENT = "CareerAssistant/1.0 (market research)";

export interface ItjobswatchRow {
  title: string;
  rank: number | null;
  rankYoYChange: number | null;
  /** Raw string как на сайте: "£70,000". */
  medianSalary: string;
  /** Raw string: "+9.09%" / "-15.15%" / "-". */
  salaryYoYChange: string;
  /** Raw string: "1,425". */
  permJobs: string;
  permJobsPct: string;
  liveJobs: number | null;
  /** Detail-page URL (relative or absolute), нужен для trend-scrape. */
  detailHref?: string;
}

export interface ItjobswatchTrend {
  jobsNow: string;
  jobs1yAgo: string;
  jobs2yAgo: string;
  medianSalary: string;
}

export interface ItjwSearchResponse {
  rows: ItjobswatchRow[];
  /** Cheerio root for follow-up parsing (e.g. detail-link extraction). */
  $: cheerio.CheerioAPI;
  url: string;
}

export async function fetchItjwSearch(query: string): Promise<ItjwSearchResponse> {
  const url = `${ITJW_BASE}/default.aspx?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) {
    throw new Error(`itjobswatch ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }

  const html = await resp.text();
  const $ = cheerio.load(html);
  const rows: ItjobswatchRow[] = [];

  $("table.results tbody tr").each((_, tr) => {
    const cells = $(tr).children("th, td");
    if (cells.length < 7) return;

    const title = $(cells[0]).text().trim();
    const detailHref = $(cells[0]).find("a").attr("href") ?? undefined;
    const rankText = $(cells[1]).text().trim();
    const rankChangeText = $(cells[2]).text().trim().replace(/[^0-9\-+]/g, "");
    const salary = $(cells[3]).text().trim();
    const salaryChange = $(cells[4]).text().trim();
    const permJobsRaw = $(cells[5]).text().trim();
    const liveJobsText = $(cells[6]).text().trim().replace(/,/g, "");

    const permMatch = permJobsRaw.match(/([\d,]+)\s+([\d.]+%)/);

    rows.push({
      title,
      rank: rankText ? parseInt(rankText.replace(/,/g, ""), 10) || null : null,
      rankYoYChange: rankChangeText ? parseInt(rankChangeText, 10) || null : null,
      medianSalary: salary || "N/A",
      salaryYoYChange: salaryChange || "-",
      permJobs: permMatch ? permMatch[1]! : permJobsRaw.split(" ")[0] || "N/A",
      permJobsPct: permMatch ? permMatch[2]! : "",
      liveJobs: liveJobsText ? parseInt(liveJobsText, 10) || null : null,
      detailHref,
    });
  });

  return { rows, $, url };
}

export async function scrapeItjwDetail(url: string): Promise<ItjobswatchTrend> {
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!resp.ok) throw new Error(`itjobswatch detail ${resp.status}`);
  const html = await resp.text();
  const $ = cheerio.load(html);

  const data: Record<string, string[]> = {};
  $("table.summary tr").each((_, tr) => {
    const label = $(tr).find("td").first().text().trim().toLowerCase();
    const vals = $(tr).find("td.fig").map((__, td) => $(td).text().trim()).get();
    if (vals.length >= 2) data[label] = vals;
  });

  const jobsRow = Object.entries(data).find(([k]) =>
    /^permanent jobs (citing|requiring)/.test(k),
  );
  const p50Row = Object.entries(data).find(([k]) =>
    k.includes("median annual salary"),
  );

  return {
    jobsNow: jobsRow?.[1][0] ?? "N/A",
    jobs1yAgo: jobsRow?.[1][1] ?? "N/A",
    jobs2yAgo: jobsRow?.[1][2] ?? "N/A",
    medianSalary: p50Row?.[1][0] ?? "N/A",
  };
}

/**
 * Парсит "£70,000" → 70000. Возвращает null если не парсится.
 */
export function parseSalaryGbp(raw: string): number | null {
  const m = raw.replace(/[\s,]/g, "").match(/£?(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  return Number.isFinite(n) ? n : null;
}

/**
 * Парсит "+9.09%" / "-6.38%" / "-" → 9.09 / -6.38 / null.
 */
export function parseYoYPct(raw: string): number | null {
  if (!raw || raw === "-") return null;
  const m = raw.replace(/\s/g, "").match(/([+-]?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  return Number.isFinite(n) ? n : null;
}

/**
 * Парсит "10,090" → 10090. Возвращает null если не парсится.
 */
export function parseIntSafe(raw: string): number | null {
  if (!raw || raw === "N/A") return null;
  const n = parseInt(raw.replace(/[\s,]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Считает trend.ratio = now / twoYearsAgo (fallback на yearAgo если 2y нет).
 * Возвращает null если данных не хватает или знаменатель = 0.
 */
export function computeTrendRatio(trend: ItjobswatchTrend): number | null {
  const now = parseIntSafe(trend.jobsNow);
  const y2 = parseIntSafe(trend.jobs2yAgo);
  const y1 = parseIntSafe(trend.jobs1yAgo);
  if (now !== null && y2 !== null && y2 > 0) return Math.round((now / y2) * 100) / 100;
  if (now !== null && y1 !== null && y1 > 0) return Math.round((now / y1) * 100) / 100;
  return null;
}

export interface ScrapedNiche {
  matchedTitle: string;
  liveVacancies: number | null;
  medianSalaryGbp: number | null;
  salaryYoYPct: number | null;
  permJobs6m: number | null;
  trend: ItjobswatchTrend | null;
  trendRatio: number | null;
  sourceUrl: string;
  scrapedAt: string;
}

/**
 * On-demand scrape по конкретному title для niche-resolver-а.
 *
 * Поведение:
 *   1. `?q=<title>` (URL-encoded полностью, без кавычек: itjobswatch
 *      разбирает natural-language search).
 *   2. Берёт top-row (отсортирован по live по умолчанию). Если top-row.title
 *      содержит slug-words из запроса → принимаем; иначе — null.
 *   3. Тянет detail-page по top-row.detailHref для trend.
 *
 * NB: caller должен сам решать сохранять ли результат в KB. Эта функция
 * работает чисто как HTTP wrapper.
 */
export async function scrapeNicheTitle(title: string): Promise<ScrapedNiche | null> {
  const search = await fetchItjwSearch(title);
  if (search.rows.length === 0) return null;

  // Простой match: top-row, у которого title содержит хотя бы одно
  // significant-слово из искомого title (>= 3 символа). Это защищает от
  // случаев когда `?q=devsecops` неожиданно вернул "DevOps Engineer" topом.
  const wantWords = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

  const matched = search.rows.find((r) => {
    const lower = r.title.toLowerCase();
    return wantWords.some((w) => lower.includes(w));
  });

  if (!matched) return null;

  let trend: ItjobswatchTrend | null = null;
  if (matched.detailHref) {
    const detailUrl = matched.detailHref.startsWith("http")
      ? matched.detailHref
      : `${ITJW_BASE}${matched.detailHref}`;
    try {
      trend = await scrapeItjwDetail(detailUrl);
    } catch (err) {
      console.warn(`[itjw-scraper] trend fetch failed for "${matched.title}":`, err);
    }
  }

  return {
    matchedTitle: matched.title,
    liveVacancies: matched.liveJobs,
    medianSalaryGbp: parseSalaryGbp(matched.medianSalary),
    salaryYoYPct: parseYoYPct(matched.salaryYoYChange),
    permJobs6m: parseIntSafe(matched.permJobs),
    trend,
    trendRatio: trend ? computeTrendRatio(trend) : null,
    sourceUrl: search.url,
    scrapedAt: new Date().toISOString(),
  };
}

const STOPWORDS = new Set<string>([
  "engineer",
  "developer",
  "specialist",
  "analyst",
  "manager",
  "lead",
  "senior",
  "junior",
  "middle",
  "intern",
  "the",
  "and",
  "with",
]);

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Live-scrape по `?q=<title>` возвращает top-N кандидатов для disambiguation
 * (niche-resolver alias miss). В отличие от `scrapeNicheTitle` НЕ тянет detail
 * trend для каждого row — это batch-helper, и trend-fetch занимает >300ms на row.
 *
 * Filter: row.title должен содержать хотя бы одно significant-слово из запроса
 * (>= 3 символа, не STOPWORD). Sort: liveJobs desc.
 *
 * @returns массив отфильтрованных rows (может быть пустым) + sourceUrl.
 */
export async function scrapeNicheCandidates(
  query: string,
  topN = 5,
): Promise<{ rows: ItjobswatchRow[]; sourceUrl: string }> {
  const search = await fetchItjwSearch(query);
  const wantWords = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

  const filtered = search.rows.filter((r) => {
    if (wantWords.length === 0) return true;
    const lower = r.title.toLowerCase();
    return wantWords.some((w) => lower.includes(w));
  });

  filtered.sort((a, b) => (b.liveJobs ?? 0) - (a.liveJobs ?? 0));

  return {
    rows: filtered.slice(0, topN),
    sourceUrl: search.url,
  };
}
