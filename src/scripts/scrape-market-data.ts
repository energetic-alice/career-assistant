/**
 * Scrape real job market data from itjobswatch.co.uk and hh.ru API.
 *
 * Usage:
 *   npx tsx src/scripts/scrape-market-data.ts itjobswatch "devops engineer"
 *   npx tsx src/scripts/scrape-market-data.ts itjobswatch all
 *
 *   npx tsx src/scripts/scrape-market-data.ts hh "devops engineer"
 *   npx tsx src/scripts/scrape-market-data.ts hh all
 *
 *   npx tsx src/scripts/scrape-market-data.ts all        # both sources, all roles
 */
import "dotenv/config";
import * as cheerio from "cheerio";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RU_TITLE_VARIANTS, slugify, KNOWN_ROLES } from "../services/market-data-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MARKET_DATA_DIR = join(__dirname, "..", "prompts", "market-data");

// Роли с generic-тайтлами, которые существуют за пределами IT.
// Для них на hh.ru ставим industry=7, чтобы отсечь не-IT вакансии.
const GENERIC_ROLES = new Set([
  "product manager", "project manager", "engineering manager",
  "tech lead", "systems analyst", "business analyst",
  "solution architect", "technical writer", "qa manual tester",
  "ux ui designer", "marketing manager", "hr recruiter",
  "product analyst",
]);

// Maps role → best itjobswatch search keyword + filter term
const ITJW_SEARCH_MAP: Record<string, { query: string; filter: string }> = {
  "backend developer java": { query: "java developer", filter: "java" },
  "backend developer python": { query: "python developer", filter: "python developer|python engineer|python backend|django|flask" },
  "backend developer go": { query: "golang", filter: "golang|\\bgo\\b" },
  "backend developer node.js": { query: "node.js developer", filter: "node" },
  "backend developer c# .net": { query: ".net developer", filter: ".net" },
  "backend developer php": { query: "php developer", filter: "php" },
  "backend developer ruby": { query: "ruby developer", filter: "ruby" },
  "backend developer rust": { query: "rust developer", filter: "rust" },
  "frontend developer react": { query: "react developer", filter: "react" },
  "frontend developer vue": { query: "vue.js", filter: "vue" },
  "frontend developer angular": { query: "angular developer", filter: "angular" },
  "mobile developer ios swift": { query: "ios developer", filter: "ios" },
  "mobile developer android kotlin": { query: "android developer", filter: "android" },
  "react native developer": { query: "react native", filter: "react native" },
  "flutter developer": { query: "flutter", filter: "flutter" },
  "devops engineer": { query: "devops", filter: "devops" },
  "sre site reliability engineer": { query: "site reliability engineer", filter: "site reliability|\\bsre\\b" },
  "platform engineer": { query: "platform engineer", filter: "platform engineer|platform engineering" },
  "cloud architect": { query: "cloud architect", filter: "cloud" },
  "devsecops engineer": { query: "devsecops", filter: "devsecops" },
  "mlops engineer": { query: "mlops", filter: "mlops" },
  "data analyst": { query: "data analyst", filter: "data analyst|analytics" },
  "data engineer": { query: "data engineer", filter: "data engineer|data engineering|data platform" },
  "data scientist": { query: "data scientist", filter: "data scien" },
  "ml engineer": { query: "machine learning engineer", filter: "machine learning|ml" },
  "qa automation engineer": { query: "qa engineer", filter: "qa|test auto" },
  "qa manual tester": { query: "qa tester", filter: "qa tester|test analyst|manual test|software tester|\\bqa\\b" },
  "product manager": { query: "product manager", filter: "product" },
  "project manager": { query: "it project manager", filter: "project manager" },
  "engineering manager": { query: "engineering manager", filter: "engineering manager" },
  "tech lead": { query: "technical lead", filter: "tech lead|technical lead|lead developer" },
  "systems analyst": { query: "systems analyst", filter: "systems analyst|system analyst" },
  "business analyst": { query: "business analyst", filter: "business analyst" },
  "solution architect": { query: "solution architect", filter: "solution architect|solutions architect" },
  "finops engineer": { query: "finops", filter: "finops" },
  "technical writer": { query: "technical writer", filter: "technical writ" },
  "backend developer c++": { query: "c++ developer", filter: "c\\+\\+" },
  "fullstack developer": { query: "full stack developer", filter: "full.?stack|fullstack" },
  "product analyst": { query: "product analyst", filter: "product analyst" },
  "ux ui designer": { query: "ux designer", filter: "ux.?design|ui.?design|ux.?ui|\\bux designer|\\bui designer" },
  "1c developer": { query: "1c developer", filter: "1c" },
  "web3 blockchain developer": { query: "blockchain developer", filter: "blockchain|web3|solidity" },
  "gamedev unity developer": { query: "game developer", filter: "game|unity|unreal|gaming" },
  "marketing manager": { query: "digital marketing manager", filter: "marketing" },
  "hr recruiter": { query: "talent acquisition", filter: "recruiter|talent|hiring" },
  "cybersecurity engineer": { query: "cyber security", filter: "cyber|security analyst|security engineer|infosec|information security" },
};

// ---------------------------------------------------------------------------
// itjobswatch.co.uk scraper
// ---------------------------------------------------------------------------

interface ItjobswatchRow {
  title: string;
  rank: number | null;
  rankYoYChange: number | null;
  medianSalary: string;
  salaryYoYChange: string;
  permJobs: string;
  permJobsPct: string;
  liveJobs: number | null;
}

interface ItjobswatchTrend {
  jobsNow: string;
  jobs1yAgo: string;
  jobs2yAgo: string;
  medianSalary: string;
}

interface ItjobswatchResult {
  query: string;
  scrapedAt: string;
  source: string;
  rows: ItjobswatchRow[];
  trend?: ItjobswatchTrend;
}

async function scrapeItjobswatch(role: string): Promise<ItjobswatchResult> {
  const mapping = ITJW_SEARCH_MAP[role];
  const searchQuery = mapping?.query ?? role;
  const filterPattern = mapping?.filter
    ? new RegExp(mapping.filter, "i")
    : new RegExp(role.split(/\s+/).slice(0, 2).join("|"), "i");

  const url = `https://www.itjobswatch.co.uk/default.aspx?q=${encodeURIComponent(searchQuery)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "CareerAssistant/1.0 (market research)" },
  });
  if (!resp.ok) throw new Error(`itjobswatch ${resp.status}: ${await resp.text()}`);

  const html = await resp.text();
  const $ = cheerio.load(html);
  const allRows: ItjobswatchRow[] = [];

  $("table.results tbody tr").each((_, tr) => {
    const cells = $(tr).children("th, td");
    if (cells.length < 7) return;

    const title = $(cells[0]).text().trim();
    const rankText = $(cells[1]).text().trim();
    const rankChangeText = $(cells[2]).text().trim().replace(/[^0-9\-+]/g, "");
    const salary = $(cells[3]).text().trim();
    const salaryChange = $(cells[4]).text().trim();
    const permJobsRaw = $(cells[5]).text().trim();
    const liveJobsText = $(cells[6]).text().trim().replace(/,/g, "");

    const permMatch = permJobsRaw.match(/([\d,]+)\s+([\d.]+%)/);

    allRows.push({
      title,
      rank: rankText ? parseInt(rankText.replace(/,/g, ""), 10) || null : null,
      rankYoYChange: rankChangeText ? parseInt(rankChangeText, 10) || null : null,
      medianSalary: salary || "N/A",
      salaryYoYChange: salaryChange || "-",
      permJobs: permMatch ? permMatch[1] : permJobsRaw.split(" ")[0] || "N/A",
      permJobsPct: permMatch ? permMatch[2] : "",
      liveJobs: liveJobsText ? parseInt(liveJobsText, 10) || null : null,
    });
  });

  const rows = allRows
    .filter((r) => filterPattern.test(r.title))
    .sort((a, b) => (b.liveJobs ?? 0) - (a.liveJobs ?? 0))
    .slice(0, 10);

  // Scrape detail page for the top title to get YoY vacancy trend + salary percentiles
  let trend: ItjobswatchTrend | undefined;
  const topRow = rows[0];
  if (topRow) {
    const detailLink = $(`table.results tbody tr th a`)
      .filter((_, el) => $(el).text().trim() === topRow.title)
      .attr("href");
    if (detailLink) {
      try {
        trend = await scrapeItjobswatchDetail(`https://www.itjobswatch.co.uk${detailLink}`);
      } catch (err) {
        console.warn(`[itjw detail] Failed for "${topRow.title}":`, err);
      }
    }
  }

  return { query: searchQuery, scrapedAt: new Date().toISOString(), source: url, rows, trend };
}

async function scrapeItjobswatchDetail(url: string): Promise<ItjobswatchTrend> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "CareerAssistant/1.0 (market research)" },
  });
  if (!resp.ok) throw new Error(`itjobswatch detail ${resp.status}`);
  const html = await resp.text();
  const $ = cheerio.load(html);

  const data: Record<string, string[]> = {};
  $("table.summary tr").each((_, tr) => {
    const label = $(tr).find("td").first().text().trim().toLowerCase();
    const vals = $(tr).find("td.fig").map((__, td) => $(td).text().trim()).get();
    if (vals.length >= 2) data[label] = vals;
  });

  const jobsRow = Object.entries(data).find(([k]) => /^permanent jobs (citing|requiring)/.test(k));
  const p50Row = Object.entries(data).find(([k]) => k.includes("median annual salary"));

  return {
    jobsNow: jobsRow?.[1][0] ?? "N/A",
    jobs1yAgo: jobsRow?.[1][1] ?? "N/A",
    jobs2yAgo: jobsRow?.[1][2] ?? "N/A",
    medianSalary: p50Row?.[1][0] ?? "N/A",
  };
}

function formatItjobswatchMd(result: ItjobswatchResult): string {
  const date = new Date().toLocaleDateString("ru-RU", {
    day: "numeric", month: "long", year: "numeric",
  });
  const lines: string[] = [
    `# ${result.query} — itjobswatch.co.uk`,
    "",
    `Дата: ${date} | Источник: ${result.source}`,
    "",
    "| Title | Rank | Rank YoY | Median £ | Salary YoY | Jobs 6m | Live Now |",
    "|-------|------|----------|----------|------------|--------|----------|",
  ];

  for (const r of result.rows) {
    const rankChg = r.rankYoYChange
      ? (r.rankYoYChange > 0 ? `+${r.rankYoYChange}` : `${r.rankYoYChange}`)
      : "-";
    lines.push(
      `| ${r.title} | ${r.rank ?? "N/A"} | ${rankChg} | ${r.medianSalary} | ${r.salaryYoYChange} | ${r.permJobs} | ${r.liveJobs ?? "N/A"} |`,
    );
  }

  const top3 = result.rows.slice(0, 3);
  if (top3.length > 0) {
    lines.push("");
    lines.push("**Топ-3 тайтла:**");
    for (const [i, r] of top3.entries()) {
      lines.push(`${i + 1}. ${r.title} — ${r.liveJobs ?? "?"} live, ${r.medianSalary}`);
    }
  }

  if (result.trend) {
    const t = result.trend;
    lines.push("");
    lines.push("**Динамика (perm vacancies):**");
    lines.push(`Сейчас: ${t.jobsNow} | Год назад: ${t.jobs1yAgo} | 2 года назад: ${t.jobs2yAgo}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// hh.ru API
// ---------------------------------------------------------------------------

interface HhRow {
  title: string;
  vacancies: number;
  salaryRange: string;
  medianSalary: number | null;
}

interface HhResult {
  query: string;
  scrapedAt: string;
  source: string;
  rows: HhRow[];
  totalVacancies: number;
}

interface HhFetchOptions {
  industry?: string; // "7" = IT, undefined = все отрасли
}

async function fetchHhSalary(
  query: string,
  opts: HhFetchOptions = {},
): Promise<{ median: number | null; p25: number | null; p75: number | null; count: number }> {
  // area=1 = Москва, experience=between3And6 = Middle-Senior (3-6 лет)
  let url =
    `https://api.hh.ru/vacancies?text=${encodeURIComponent(query)}` +
    `&area=1&per_page=100&only_with_salary=true&experience=between3And6`;
  if (opts.industry) url += `&industry=${opts.industry}`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "CareerAssistant/1.0 (market research)" },
    });
    if (!resp.ok) return { median: null, p25: null, p75: null, count: 0 };
    const json = await resp.json() as {
      items: Array<{ salary: { from: number | null; to: number | null; currency: string; gross: boolean } }>;
    };
    const salaries = json.items
      .map((v) => {
        const s = v.salary;
        if (s.currency !== "RUR") return null;
        const val = s.from && s.to ? (s.from + s.to) / 2 : (s.from ?? s.to);
        if (!val) return null;
        return s.gross ? Math.round(val * 0.87) : val;
      })
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);

    if (salaries.length === 0) return { median: null, p25: null, p75: null, count: 0 };
    const n = salaries.length;
    const mid = Math.floor(n / 2);
    const median = n % 2 === 0
      ? Math.round((salaries[mid - 1]! + salaries[mid]!) / 2)
      : salaries[mid]!;
    const p25 = salaries[Math.floor(n / 4)]!;
    const p75 = salaries[Math.floor(3 * n / 4)]!;
    return { median, p25, p75, count: n };
  } catch {
    return { median: null, p25: null, p75: null, count: 0 };
  }
}

async function fetchHhRu(role: string, opts: HhFetchOptions = {}): Promise<HhResult> {
  const variants = RU_TITLE_VARIANTS[role] || [role];
  const rows: HhRow[] = [];

  for (const variant of variants) {
    let countUrl = `https://api.hh.ru/vacancies?text=${encodeURIComponent(variant)}&area=113&per_page=0`;
    if (opts.industry) countUrl += `&industry=${opts.industry}`;
    try {
      const resp = await fetch(countUrl, {
        headers: { "User-Agent": "CareerAssistant/1.0 (market research)" },
      });
      if (!resp.ok) {
        console.warn(`[hh.ru] ${resp.status} for "${variant}"`);
        continue;
      }
      const json = await resp.json() as { found: number };
      const { median, p25, p75, count } = await fetchHhSalary(variant, opts);
      const salaryStr = median && p25 && p75
        ? `${Math.round(p25 / 1000)}k–${Math.round(p75 / 1000)}k (медиана ${Math.round(median / 1000)}k) [n=${count}]`
        : "N/A";
      rows.push({ title: variant, vacancies: json.found, salaryRange: salaryStr, medianSalary: median });
    } catch (err) {
      console.warn(`[hh.ru] Failed for "${variant}":`, err);
    }
    await sleep(3000);
  }

  rows.sort((a, b) => b.vacancies - a.vacancies);
  const totalVacancies = rows[0]?.vacancies ?? 0;

  return {
    query: role,
    scrapedAt: new Date().toISOString(),
    source: "https://api.hh.ru/vacancies" + (opts.industry ? ` (industry=${opts.industry})` : ""),
    rows,
    totalVacancies,
  };
}

function formatHhMd(result: HhResult): string {
  const date = new Date().toLocaleDateString("ru-RU", {
    day: "numeric", month: "long", year: "numeric",
  });
  const lines: string[] = [
    `# ${result.query} — hh.ru`,
    "",
    `Дата: ${date} | Источник: ${result.source}`,
    "",
    `| Тайтл | Вакансий (${result.source.includes("industry=") ? "РФ, IT" : "РФ"}) | ЗП Москва net, ₽/мес (3-6 лет) |`,
    "|-------|-------------------|-------------------------------|",
  ];

  for (const r of result.rows) {
    lines.push(`| ${r.title} | ${r.vacancies.toLocaleString("ru-RU")} | ${r.salaryRange} |`);
  }

  const top3 = result.rows.slice(0, 3);
  if (top3.length > 0) {
    lines.push("");
    lines.push("**Топ-3 тайтла:**");
    for (const [i, r] of top3.entries()) {
      lines.push(`${i + 1}. ${r.title} — ${r.vacancies.toLocaleString("ru-RU")} вакансий, ${r.salaryRange}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function runItjobswatch(roles: readonly string[]) {
  console.log(`\n=== itjobswatch.co.uk: ${roles.length} role(s) ===\n`);
  await mkdir(MARKET_DATA_DIR, { recursive: true });

  for (const role of roles) {
    const t0 = Date.now();
    try {
      const result = await scrapeItjobswatch(role);
      const md = formatItjobswatchMd(result);
      const filePath = join(MARKET_DATA_DIR, `itjw-${slugify(role)}.md`);
      await writeFile(filePath, md, "utf-8");
      const best = result.rows[0];
      console.log(
        `✓ ${role}: ${result.rows.length} variations, best="${best?.title}" (${best?.liveJobs ?? 0} live) [${Date.now() - t0}ms]`,
      );
    } catch (err) {
      console.error(`✗ ${role}: ${err} [${Date.now() - t0}ms]`);
    }
    await sleep(500);
  }
}

async function runHh(roles: readonly string[], forceOpts?: HhFetchOptions) {
  console.log(`\n=== hh.ru API: ${roles.length} role(s) ===\n`);
  await mkdir(MARKET_DATA_DIR, { recursive: true });

  for (let i = 0; i < roles.length; i++) {
    const role = roles[i]!;
    const opts = forceOpts ?? (GENERIC_ROLES.has(role) ? { industry: "7" } : {});
    const label = opts.industry ? " [IT]" : "";
    const t0 = Date.now();
    try {
      const result = await fetchHhRu(role, opts);
      const md = formatHhMd(result);
      const filePath = join(MARKET_DATA_DIR, `hh-${slugify(role)}.md`);
      await writeFile(filePath, md, "utf-8");
      const best = result.rows[0];
      console.log(
        `✓ [${i + 1}/${roles.length}] ${role}${label}: ${result.rows.length} variants, best="${best?.title}" (${best?.vacancies ?? 0}) [${Date.now() - t0}ms]`,
      );
    } catch (err) {
      console.error(`✗ [${i + 1}/${roles.length}] ${role}: ${err} [${Date.now() - t0}ms]`);
    }
    await sleep(5000);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const allIndustries = args.includes("--all-industries");
  const positional = args.filter((a) => !a.startsWith("--"));
  const source = positional[0];
  const roleArg = positional[1];

  if (!source || !["itjobswatch", "hh", "all"].includes(source)) {
    console.log(`Usage:
  npx tsx src/scripts/scrape-market-data.ts itjobswatch "devops engineer"
  npx tsx src/scripts/scrape-market-data.ts itjobswatch all
  npx tsx src/scripts/scrape-market-data.ts hh "devops engineer"
  npx tsx src/scripts/scrape-market-data.ts hh all
  npx tsx src/scripts/scrape-market-data.ts all
  npx tsx src/scripts/scrape-market-data.ts hh all --all-industries  # без фильтра IT`);
    process.exit(1);
  }

  const roles = (!roleArg || roleArg === "all") ? KNOWN_ROLES : [roleArg];
  const forceOpts = allIndustries ? {} as HhFetchOptions : undefined;

  if (source === "itjobswatch" || source === "all") await runItjobswatch(roles);
  if (source === "hh" || source === "all") await runHh(roles, forceOpts);

  console.log("\nDone. Files in app/src/prompts/market-data/");
}

main();
