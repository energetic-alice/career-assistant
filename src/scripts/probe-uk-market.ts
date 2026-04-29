/**
 * Scrape UK market data from itjobswatch.co.uk — vacancy counts, median salary,
 * 2-year trend. Сохраняет в app/src/prompts/market-data/uk_<slug>.md.
 *
 * Парная утилита: src/scripts/probe-ru-market.ts (RU-рынок через HTML hh.ru
 * + career.habr.com API). Пока api.hh.ru без OAuth недоступен, именно probe-ru
 * остаётся единственным источником RU-данных.
 *
 * Usage:
 *   npx tsx src/scripts/probe-uk-market.ts backend_python
 *   npx tsx src/scripts/probe-uk-market.ts all
 *
 * См. app/README.md → "Рыночные данные (обновлять регулярно!)".
 */
import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_ROLES } from "../services/market-data-service.js";
import {
  fetchItjwSearch,
  scrapeItjwDetail,
  type ItjobswatchRow,
  type ItjobswatchTrend,
  sleep,
} from "../services/itjw-scraper.js";
import { sanitizeRussianText as sanitizeForPrompt } from "../services/text-sanitize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MARKET_DATA_DIR = join(__dirname, "..", "prompts", "market-data");

/**
 * Maps slug → best itjobswatch search keyword + filter term.
 * Keys MUST be the canonical snake_case slug (see KNOWN_ROLES).
 */
/**
 * Per-role конфиг скрейпера itjobswatch.
 *   - `query`       — основной search keyword для /default.aspx?q=...
 *   - `extraQueries`— (опционально) доп. search queries; их результаты
 *                     мёрджатся в общий rows-список и фильтруются одним `filter`.
 *                     Полезно, когда spec-термин выражается несколькими ключами
 *                     в job-title. Пример: Python = "python" ∪ "django" ∪ "fastapi".
 *   - `filter`      — regex на title rows (после поиска)
 *   - `skillPage`   — (опционально) slug skill-страницы /jobs/uk/<slug>.do,
 *                     с которой мы дополнительно берём total live vacancies.
 *                     Используется, когда spec-term — это skill (Java, Python),
 *                     а количество вакансий по skill-странице сильно больше
 *                     суммы по тайтлам. Пример: `java.do` = 900+ live, в то
 *                     время как топ job-title "Java Developer" = ~100.
 */
interface ItjwSearchConfig {
  query: string;
  filter: string;
  extraQueries?: string[];
  skillPage?: string;
}

const ITJW_SEARCH_MAP: Record<string, ItjwSearchConfig> = {
  // Backend
  // ВАЖНО: java(?! ?script) — иначе цепляет JavaScript Developer (разные люди!).
  // skillPage="java" — тянем реальный total live с /jobs/uk/java.do (900+ vs
  // top-title "Java Developer" ~100). Java как skill очень популярна, и на
  // практике это лучше отражает спрос на Java-специалистов.
  // query="java" (не "java developer") — тянет больше job-тайтлов: Java Architect,
  // Java Engineer, Java/Kotlin Developer и т.д. Filter отсеивает JavaScript.
  backend_java: { query: "java", filter: "\\bjava\\b(?!.?script)", skillPage: "java" },
  // Python backend: itjobswatch search по "python developer" не возвращает
  // Django/FastAPI developer'ов (search тянет только тайтлы с keyword-ом).
  // Поэтому делаем 3 запроса подряд, мёрджим результаты, дедуплицируем — и
  // получаем полный пул backend-python тайтлов.
  backend_python: {
    query: "python developer",
    // Search по короткому skill-keyword'у возвращает больше тайтлов
    // ("django" → Django Developer, Python/Django Developer и пр.).
    extraQueries: ["django", "fastapi", "flask"],
    filter: "python developer|python engineer|python backend|django|flask|fastapi",
  },
  backend_go: { query: "golang", filter: "golang|\\bgo\\b" },
  // query без "developer" → больше разнообразных тайтлов (Architect, Engineer,
  // Senior, Lead и пр.). Filter оставляем широким — отфильтровывает релевантное.
  backend_nodejs: { query: "node.js", filter: "node" },
  backend_net: { query: ".net", filter: "\\.net" },
  backend_php: { query: "php", filter: "php" },
  backend_ruby: { query: "ruby", filter: "ruby" },
  backend_rust: { query: "rust", filter: "rust" },
  // C/C++ — itjobswatch держит их в одном пуле: "c developer", "c++ developer",
  // "c/c++ developer", "embedded software engineer" и т.д. Ловим всё.
  backend_cplusplus: {
    query: "c++ developer",
    filter: "c\\+\\+|\\bc developer\\b|c/c\\+\\+|embedded (c|software)",
  },

  // Frontend + Fullstack
  frontend_react: { query: "react developer", filter: "react" },
  frontend_vue: { query: "vue.js", filter: "vue" },
  frontend_angular: { query: "angular developer", filter: "angular" },
  fullstack: { query: "full stack developer", filter: "full.?stack|fullstack" },

  // Mobile
  mobileapp_swift: { query: "ios developer", filter: "ios" },
  mobileapp_kotlin: { query: "android developer", filter: "android" },
  mobileapp_react_native: { query: "react native", filter: "react native" },
  mobileapp_flutter: { query: "flutter", filter: "flutter" },

  // DevOps cluster (devops умышленно включает SRE / MLOps / Platform Engineer
  // через фильтр тайтлов, чтобы одним запросом собрать весь пул на itjobswatch).
  devops: {
    query: "devops",
    filter: "devops|site reliability|\\bsre\\b|platform engineer|mlops|devsecops|finops",
  },

  // Data / ML
  data_analyst: { query: "data analyst", filter: "data analyst|analytics" },
  data_engineer: { query: "data engineer", filter: "data engineer|data engineering|data platform" },
  // ml_engineer + data_scientist merged.
  // ВАЖНО: исключаем skill-entries "Machine Learning" / "Data Science" solo —
  // это skill-метки (>800 live), а не профессии. Явно перечисляем job-тайтлы.
  ml_engineer: {
    query: "data scientist",
    filter: "data scientist|data science engineer|ml engineer|machine learning engineer|machine learning scientist|machine learning architect|ai engineer|llm engineer",
  },
  product_analyst: { query: "product analyst", filter: "product analyst" },

  // QA
  qa_engineer: { query: "qa engineer", filter: "qa|test auto" },
  // ВАЖНО: только manual-specific тайтлы! Generic "QA" / "QA Engineer" /
  // "QA Automation" / "QA Manager" / "Senior QA Engineer" / "QA Leader" тянут
  // автоматизаторов и тимлидов — их медиана £55-63k/год (€5k+/мес) нерелевантна.
  // Test Analyst / QA Analyst — тоже не manual (часто test-strategy / metrics).
  // Реальный manual UK-tester: £30-35k/год (€3k/мес).
  manual_testing: {
    query: "qa tester",
    filter: "qa tester|manual test|software tester|qa officer",
  },

  // Management / Architecture
  product_manager: { query: "product manager", filter: "product" },
  project_manager: { query: "it project manager", filter: "project manager" },
  // tech_lead + Engineering Manager merged в один slug.
  tech_lead: {
    query: "technical lead",
    filter: "tech lead|technical lead|lead developer|engineering manager|head of engineering",
  },
  software_architect: { query: "solution architect", filter: "solution architect|solutions architect" },

  // Analysis (non-data)
  business_analyst: { query: "business analyst", filter: "business analyst" },
  systems_analyst: { query: "systems analyst", filter: "systems analyst|system analyst" },

  // Design / Marketing / HR / Docs
  ui_ux_designer: { query: "ux designer", filter: "ux.?design|ui.?design|ux.?ui|\\bux designer|\\bui designer" },
  // ВАЖНО: query="marketing" тянет skill-entry "Marketing" (3842 jobs, £45k) как
  // топ-1 — а это не профессия, а skill "умение". Нужен узкий filter на тайтлы
  // с "manager" / "director" / "head".
  marketing_manager: {
    query: "marketing manager",
    filter: "marketing (manager|director|lead)|head of marketing|marketing head",
  },
  recruiter: { query: "talent acquisition", filter: "recruiter|talent|hiring" },
  technical_writer: { query: "technical writer", filter: "technical writ" },

  // Security
  // infosecspec — чистый InfoSec / Cybersecurity (DevSecOps/AppSec в devops).
  infosecspec: {
    query: "cyber security",
    filter: "cyber|security analyst|security engineer|infosec|information security",
  },

  // Infra / Support
  system_admin: {
    query: "system administrator",
    filter: "system administrator|sysadmin|systems administrator|linux administrator|windows administrator",
  },
  tech_support_manager: {
    query: "it support",
    filter: "\\bit support\\b|helpdesk|help desk|desktop support|technical support|service desk",
  },

  // Other
  "1c_developer": { query: "1c developer", filter: "1c" },
  web3_developer: { query: "blockchain developer", filter: "blockchain|web3|solidity" },
  gamedev_unity: { query: "game developer", filter: "game|unity|unreal|gaming" },
};

// ---------------------------------------------------------------------------
// itjobswatch.co.uk scraper
// ---------------------------------------------------------------------------
//
// NB: основные scraping-функции (fetchItjwSearch / scrapeItjwDetail / типы)
// живут в `app/src/services/itjw-scraper.ts` и импортируются выше.
// Здесь — только bulk-CLI логика (per-slug фильтр + skill-page).

interface ItjobswatchResult {
  query: string;
  scrapedAt: string;
  source: string;
  rows: ItjobswatchRow[];
  trend?: ItjobswatchTrend;
  /** Total live vacancies from skill-page `/jobs/uk/<slug>.do` (if configured). */
  skillPageLive?: { skill: string; live: number; url: string };
}

async function fetchSkillPageLive(skillSlug: string): Promise<{ live: number; url: string } | null> {
  // Две страницы:
  //   1. /jobs/uk/<slug>.do — содержит nav-link на /find/<Slug>-jobs-in-the-UK
  //   2. /find/<Slug>-jobs-in-the-UK — в meta description: "Search N <Skill>
  //      job vacancies in the UK"
  // Берём число из (2) — это актуальный total live.
  const doUrl = `https://www.itjobswatch.co.uk/jobs/uk/${encodeURIComponent(skillSlug)}.do`;
  try {
    const doResp = await fetch(doUrl, {
      headers: { "User-Agent": "CareerAssistant/1.0 (market research)" },
    });
    if (!doResp.ok) return null;
    const doHtml = await doResp.text();
    const findLinkMatch = doHtml.match(/href="(\/find\/[^"]+-jobs-in-(?:the-UK|UK))"/i);
    if (!findLinkMatch) return null;
    const findUrl = `https://www.itjobswatch.co.uk${findLinkMatch[1]}`;

    await sleep(200);
    const findResp = await fetch(findUrl, {
      headers: { "User-Agent": "CareerAssistant/1.0 (market research)" },
    });
    if (!findResp.ok) return null;
    const findHtml = await findResp.text();
    const liveMatch = findHtml.match(/Search\s+([\d,]+)\s+[^<"]*?\s+vacancies?\s+in\s+the\s+UK/i);
    if (!liveMatch) return null;
    const live = parseInt(liveMatch[1]!.replace(/,/g, ""), 10);
    if (!Number.isFinite(live)) return null;
    return { live, url: findUrl };
  } catch {
    return null;
  }
}

async function scrapeItjobswatch(role: string): Promise<ItjobswatchResult> {
  const mapping = ITJW_SEARCH_MAP[role];
  const fallbackQuery = role.replace(/_/g, " ");
  const searchQuery = mapping?.query ?? fallbackQuery;
  const filterPattern = mapping?.filter
    ? new RegExp(mapping.filter, "i")
    : new RegExp(fallbackQuery.split(/\s+/).slice(0, 2).join("|"), "i");

  // Первичный запрос (с него также берём detail-link для trend).
  const primary = await fetchItjwSearch(searchQuery);

  // Доп. запросы (extraQueries) — их результаты мёрджим в общий pool.
  const allRows: ItjobswatchRow[] = [...primary.rows];
  for (const q of mapping?.extraQueries ?? []) {
    await sleep(300);
    try {
      const extra = await fetchItjwSearch(q);
      allRows.push(...extra.rows);
    } catch (err) {
      console.warn(`[itjw extra] Failed query "${q}":`, err);
    }
  }

  // Dedup по title (поисковые запросы часто возвращают одни и те же тайтлы).
  const byTitle = new Map<string, ItjobswatchRow>();
  for (const r of allRows) {
    const key = r.title.toLowerCase();
    const prev = byTitle.get(key);
    if (!prev || (r.liveJobs ?? 0) > (prev.liveJobs ?? 0)) {
      byTitle.set(key, r);
    }
  }

  const rows = [...byTitle.values()]
    .filter((r) => filterPattern.test(r.title))
    .sort((a, b) => (b.liveJobs ?? 0) - (a.liveJobs ?? 0))
    .slice(0, 10);

  let trend: ItjobswatchTrend | undefined;
  const topRow = rows[0];
  if (topRow) {
    const $p = primary.$;
    const detailLink = $p(`table.results tbody tr th a`)
      .filter((_, el) => $p(el).text().trim() === topRow.title)
      .attr("href");
    if (detailLink) {
      try {
        trend = await scrapeItjwDetail(`https://www.itjobswatch.co.uk${detailLink}`);
      } catch (err) {
        console.warn(`[itjw detail] Failed for "${topRow.title}":`, err);
      }
    }
  }

  // Skill-page (если указан) — total live по skill'у (не по тайтлу).
  let skillPageLive: ItjobswatchResult["skillPageLive"];
  if (mapping?.skillPage) {
    await sleep(300);
    const skillData = await fetchSkillPageLive(mapping.skillPage);
    if (skillData) {
      skillPageLive = { skill: mapping.skillPage, ...skillData };
    } else {
      console.warn(`[itjw skill-page] No live-count parsed for "${mapping.skillPage}"`);
    }
  }

  return {
    query: searchQuery,
    scrapedAt: new Date().toISOString(),
    source: primary.url,
    rows,
    trend,
    skillPageLive,
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

  if (result.skillPageLive) {
    const s = result.skillPageLive;
    lines.push("");
    lines.push(`**Live total (skill page: ${s.skill}):** ${s.live} | Источник: ${s.url}`);
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
// CLI
// ---------------------------------------------------------------------------

async function runItjobswatch(roles: readonly string[]) {
  console.log(`\n=== itjobswatch.co.uk: ${roles.length} role(s) ===\n`);
  await mkdir(MARKET_DATA_DIR, { recursive: true });

  for (const role of roles) {
    const t0 = Date.now();
    try {
      const result = await scrapeItjobswatch(role);
      // Safety: не перезаписываем существующий файл пустыми данными
      // (hh/itjw иногда отвечают 403/блок, тогда rows пустые).
      if (result.rows.length === 0) {
        console.warn(`⚠ ${role}: 0 rows — skip write (preserve existing uk_${role}.md)`);
      } else {
        const filePath = join(MARKET_DATA_DIR, `uk_${role}.md`);
        const md = sanitizeForPrompt(formatItjobswatchMd(result));
        await writeFile(filePath, md, "utf-8");
        const best = result.rows[0];
        console.log(
          `✓ ${role}: ${result.rows.length} variations, best="${best?.title}" (${best?.liveJobs ?? 0} live) [${Date.now() - t0}ms]`,
        );
      }
    } catch (err) {
      console.error(`✗ ${role}: ${err} [${Date.now() - t0}ms]`);
    }
    await sleep(500);
  }
}

async function main() {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const roleArg = positional[0];

  if (!roleArg) {
    console.log(`Usage (itjobswatch.co.uk → uk_<slug>.md):
  npx tsx src/scripts/probe-uk-market.ts <slug>   # одна роль
  npx tsx src/scripts/probe-uk-market.ts all      # все из KNOWN_ROLES

Для RU-рынка используй src/scripts/probe-ru-market.ts
(api.hh.ru без OAuth забанен — HTML-парсинг + Habr API).

См. app/README.md → "Рыночные данные (обновлять регулярно!)".`);
    process.exit(1);
  }

  const roles = roleArg === "all" ? KNOWN_ROLES : [roleArg];
  await runItjobswatch(roles);

  console.log("\nDone. Files in app/src/prompts/market-data/");
}

main();
