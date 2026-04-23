import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseHhFile,
  parseItjwFile,
  RU_TITLE_VARIANTS,
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
  /**
   * Технологический стек (см. комментарий в `market-index.ts`). Задавать
   * только для ролей, где язык/стек критичен (backend_*, frontend_*,
   * fullstack, mobile_*, web3/gamedev/1c). Для infra/data/ML/management
   * оставлять undefined — там работает category-bridge.
   */
  stackFamily?: string;
  /** habr.com/career spec_aliases[] value (for future live fetches) */
  habrSpec: string | null;
  /** habr.com/career skills[] filter (optional) */
  habrSkill?: string;
  /**
   * File under market-data/ for RU data (hh.ru scrape). Defaults to `ru_${slug}.md`.
   * Override only when a role shares a file with another role (e.g. EM/TL).
   * Set to `null` explicitly to skip RU data for this role.
   */
  ruFile?: string | null;
  /**
   * File under market-data/ for UK data (itjobswatch scrape). Defaults to `uk_${slug}.md`.
   * Omit (or set to null) when chosen on purpose (e.g. no UK abroad data for the role).
   */
  ukFile?: string | null;
  /** Manually-added aliases (free-text ru/en tokens used by role-matcher) */
  extraAliases?: string[];
  /** Drop these aliases (useful for EM/TL split — tech_lead only, em only, etc.) */
  dropAliases?: string[];
  /**
   * Если true, UK-vacancies считаются как сумма `liveNow` по всем строкам
   * uk_<slug>.md (используется, когда один канонический тайтл не покрывает
   * реальный спрос, напр. Python ≈ Python Dev + Django Dev + FastAPI Dev).
   * По умолчанию берём top-1 liveJobs.
   * ПРИМЕЧАНИЕ: skill-page override (строка "Live total (skill page): N"
   * в md-файле) имеет более высокий приоритет.
   */
  ukSumLive?: boolean;
  /**
   * Если задан regex, RU-vacancies = сумма `vacancies` по строкам, чей title
   * матчит regex (регистр игнорируется). По умолчанию берём `Math.max` по
   * всем строкам — но для ролей, где keyword слишком широкий и ловит чужие
   * вакансии (напр. "python" тянет ML/Data), нужно считать только по
   * фреймворк-специфичным тайтлам (Django/FastAPI/Flask).
   */
  ruSumTitles?: string;
  aiRisk: AiRisk;
}

// ---------------------------------------------------------------------------
// Canonical registry — the one place where slugs, data files and metadata
// live together. Keep sorted by category for easier review.
// ---------------------------------------------------------------------------

// Market-data files живут в app/src/prompts/market-data/ и называются по
// схеме `ru_<slug>.md` / `uk_<slug>.md`. Если файла нет — достаточно
// `ukFile: null` / `ruFile: null`. Override нужен только когда два slug'а
// шарят один файл (EM/TL) или нужен merge-source (devops cluster).

const REGISTRY: RoleDef[] = [
  // ── Backend ────────────────────────────────────────────────────────────
  {
    slug: "backend_python", displayTitle: "Backend Developer (Python)", category: "backend",
    stackFamily: "python",
    habrSpec: "backend", habrSkill: "python",
    extraAliases: ["Python developer", "Python engineer", "Django разработчик", "FastAPI разработчик", "Flask разработчик", "Python backend"],
    // UK: sum Python Dev + Django + FastAPI + Flask + Senior/Lead/Full-Stack →
    // ближе к реальному спросу (top-1 "Python Developer" слишком узкий).
    ukSumLive: true,
    // RU: "Python developer" на hh.ru тянет ML/Data (fuzzy-матч по описанию),
    // поэтому считаем спрос только по backend-фреймворкам Django/FastAPI/Flask.
    ruSumTitles: "django|fastapi|flask",
    aiRisk: "medium",
  },
  {
    slug: "backend_java", displayTitle: "Backend Developer (Java)", category: "backend",
    stackFamily: "java",
    habrSpec: "backend", habrSkill: "java",
    extraAliases: ["Java developer", "Java engineer", "Spring разработчик", "Java backend"],
    aiRisk: "medium",
  },
  {
    slug: "backend_go", displayTitle: "Backend Developer (Go)", category: "backend",
    stackFamily: "go",
    habrSpec: "backend", habrSkill: "golang",
    extraAliases: ["Go developer", "Go engineer", "Golang developer", "Golang engineer", "Go backend"],
    aiRisk: "medium",
  },
  {
    slug: "backend_nodejs", displayTitle: "Backend Developer (Node.js)", category: "backend",
    stackFamily: "js",
    habrSpec: "backend", habrSkill: "node-js",
    extraAliases: ["Node developer", "Node.js developer", "NestJS разработчик", "Node backend"],
    aiRisk: "medium",
  },
  {
    slug: "backend_net", displayTitle: "Backend Developer (C# / .NET)", category: "backend",
    stackFamily: "dotnet",
    habrSpec: "backend", habrSkill: "net",
    extraAliases: ["C# developer", ".NET developer", "C# engineer", "ASP.NET разработчик"],
    aiRisk: "medium",
  },
  {
    slug: "backend_php", displayTitle: "Backend Developer (PHP)", category: "backend",
    stackFamily: "php",
    habrSpec: "backend", habrSkill: "php",
    extraAliases: ["PHP developer", "PHP engineer", "Laravel разработчик", "Symfony разработчик", "Bitrix разработчик"],
    aiRisk: "medium",
  },
  {
    slug: "backend_ruby", displayTitle: "Backend Developer (Ruby)", category: "backend",
    stackFamily: "ruby",
    habrSpec: "backend", habrSkill: "ruby",
    extraAliases: ["Ruby developer", "Ruby on Rails", "Rails разработчик", "RoR developer"],
    aiRisk: "medium",
  },
  {
    slug: "backend_rust", displayTitle: "Backend Developer (Rust)", category: "backend",
    stackFamily: "rust",
    habrSpec: "backend", habrSkill: "rust",
    extraAliases: ["Rust developer", "Rust engineer", "Rust backend"],
    aiRisk: "medium",
  },
  {
    // На itjobswatch C и C++ лежат в общем пуле embedded/systems-разработчиков,
    // поэтому для UK берём общий запрос и считаем их одной ролью.
    slug: "backend_cplusplus", displayTitle: "Backend Developer (C / C++)", category: "backend",
    stackFamily: "cpp",
    habrSpec: "backend", habrSkill: "cplusplus",
    extraAliases: [
      "C++ developer", "C++ engineer", "C developer", "C engineer",
      "C/C++ разработчик", "Embedded C++", "Embedded C", "Cplusplus",
    ],
    aiRisk: "medium",
  },

  // ── Frontend ───────────────────────────────────────────────────────────
  {
    slug: "frontend_react", displayTitle: "Frontend Developer (React)", category: "frontend",
    stackFamily: "js",
    habrSpec: "frontend", habrSkill: "react-js",
    extraAliases: ["React developer", "React engineer", "Фронтенд React", "React.js разработчик", "React frontend"],
    aiRisk: "high",
  },
  {
    slug: "frontend_vue", displayTitle: "Frontend Developer (Vue)", category: "frontend",
    stackFamily: "js",
    habrSpec: "frontend", habrSkill: "vue-js",
    extraAliases: ["Vue developer", "Vue.js developer", "Nuxt разработчик", "Vue frontend"],
    aiRisk: "high",
  },
  {
    slug: "frontend_angular", displayTitle: "Frontend Developer (Angular)", category: "frontend",
    stackFamily: "js",
    habrSpec: "frontend", habrSkill: "angular",
    extraAliases: ["Angular developer", "Angular engineer", "Angular frontend"],
    aiRisk: "high",
  },

  // ── Fullstack ──────────────────────────────────────────────────────────
  {
    slug: "fullstack", displayTitle: "Full-stack Developer", category: "fullstack",
    stackFamily: "js",
    habrSpec: "fullstack",
    extraAliases: ["Full stack", "Full-stack", "Fullstack JS", "MERN разработчик"],
    aiRisk: "medium",
  },

  // ── Mobile ─────────────────────────────────────────────────────────────
  {
    slug: "mobileapp_swift", displayTitle: "iOS Developer (Swift)", category: "mobile",
    stackFamily: "swift",
    habrSpec: "mobileapp_developer", habrSkill: "swift",
    extraAliases: ["iOS developer", "Swift developer", "iOS engineer", "iOS разработчик"],
    aiRisk: "medium",
  },
  {
    slug: "mobileapp_kotlin", displayTitle: "Android Developer (Kotlin)", category: "mobile",
    stackFamily: "kotlin",
    habrSpec: "mobileapp_developer", habrSkill: "kotlin",
    extraAliases: ["Android developer", "Kotlin developer", "Android engineer", "Android разработчик"],
    aiRisk: "medium",
  },
  {
    slug: "mobileapp_flutter", displayTitle: "Flutter Developer", category: "mobile",
    stackFamily: "dart",
    habrSpec: "mobileapp_developer", habrSkill: "flutter",
    extraAliases: ["Flutter developer", "Dart developer", "Cross-platform Flutter"],
    aiRisk: "medium",
  },
  {
    slug: "mobileapp_react_native", displayTitle: "React Native Developer", category: "mobile",
    stackFamily: "js",
    habrSpec: "mobileapp_developer", habrSkill: "react-native",
    extraAliases: ["React Native developer", "RN developer", "Cross-platform RN"],
    aiRisk: "medium",
  },

  // ── DevOps / Infra ─────────────────────────────────────────────────────
  // Collapsed cluster: DevOps + SRE + MLOps + Platform Engineer live as one
  // canonical slug `devops`. These roles overlap heavily on the job market
  // (same candidates, same hiring processes) and it's noise to recommend
  // all four variants independently. Клиент с чётким запросом «хочу SRE»
  // всё равно попадёт в devops по aliases (ниже), а в самом боте роль
  // обсуждается словами. Рыночные цифры берём только из `ru_devops.md` /
  // `uk_devops.md` — они репрезентативны для всего кластера.
  {
    slug: "devops", displayTitle: "DevOps / SRE / Platform Engineer", category: "infra",
    habrSpec: "devops",
    extraAliases: [
      "DevOps", "инженер инфраструктуры",
      "SRE", "Site Reliability Engineer", "инженер надёжности",
      "MLOps", "MLOps Engineer", "ML инфраструктура", "ML platform engineer",
      "Platform Engineer", "Платформенный инженер", "Internal Platform Engineer",
      "Cloud Engineer", "Infrastructure Engineer",
      "DevSecOps", "DevSecOps инженер", "DevSecOps engineer", "Security DevOps",
      "FinOps", "FinOps Engineer",
    ],
    aiRisk: "low",
  },

  // ── Data / ML ──────────────────────────────────────────────────────────
  {
    slug: "data_engineer", displayTitle: "Data Engineer", category: "data",
    habrSpec: "data_engineer",
    extraAliases: ["Data Engineer", "ETL разработчик", "Big Data инженер", "DWH разработчик"],
    aiRisk: "low",
  },
  {
    slug: "ml_engineer", displayTitle: "ML Engineer / Data Scientist", category: "data",
    habrSpec: "ml-engineer",
    extraAliases: [
      "ML Engineer", "Machine Learning инженер", "AI engineer", "LLM инженер",
      "Data Scientist", "DS", "ML researcher", "NLP инженер", "CV инженер",
    ],
    aiRisk: "low",
  },
  {
    slug: "data_analyst", displayTitle: "Data Analyst", category: "analytics",
    habrSpec: "data_analyst",
    extraAliases: ["Data Analyst", "Аналитик данных", "Дата аналитик"],
    aiRisk: "medium",
  },
  {
    slug: "product_analyst", displayTitle: "Product Analyst", category: "analytics",
    habrSpec: "product_analyst",
    extraAliases: ["Product Analyst", "Продакт-аналитик", "Growth аналитик", "CJM аналитик"],
    aiRisk: "medium",
  },

  // ── QA ─────────────────────────────────────────────────────────────────
  {
    slug: "qa_engineer", displayTitle: "QA Automation Engineer", category: "qa",
    habrSpec: "qa_engineer",
    extraAliases: ["Automation QA", "SDET", "Test Automation Engineer", "Автотестировщик"],
    aiRisk: "high",
  },
  {
    slug: "manual_testing", displayTitle: "QA Manual Tester", category: "qa",
    habrSpec: "manual_testing",
    extraAliases: ["Manual QA", "Тестировщик ПО", "QA инженер", "Инженер по тестированию"],
    aiRisk: "low",
  },

  // ── Management / Architecture ──────────────────────────────────────────
  {
    slug: "product_manager", displayTitle: "Product Manager", category: "management",
    habrSpec: "product_manager",
    extraAliases: ["Product Manager", "Менеджер продукта", "Продакт-менеджер", "Product Owner"],
    aiRisk: "low",
  },
  {
    slug: "project_manager", displayTitle: "Project Manager", category: "management",
    habrSpec: "project_manager",
    extraAliases: ["Project Manager", "Менеджер проектов", "Руководитель проекта", "Delivery Manager"],
    aiRisk: "low",
  },
  {
    slug: "tech_lead", displayTitle: "Tech Lead / Engineering Manager", category: "management",
    habrSpec: null,
    extraAliases: [
      "Тимлид", "Tech Lead", "Team Lead", "Технический лид", "Lead developer", "Lead engineer",
      "Engineering Manager", "Head of Engineering",
      "Руководитель разработки", "Руководитель IT-отдела", "Руководитель направления разработки",
    ],
    aiRisk: "low",
  },
  {
    slug: "software_architect", displayTitle: "Solution Architect", category: "architecture",
    habrSpec: "software_architect",
    extraAliases: ["Solution Architect", "Системный архитектор", "Software Architect", "Enterprise Architect"],
    aiRisk: "low",
  },

  // ── Analysis (non-data) ────────────────────────────────────────────────
  {
    slug: "business_analyst", displayTitle: "Business Analyst", category: "analytics",
    habrSpec: "business_analyst",
    extraAliases: ["Business Analyst", "Бизнес-аналитик", "BA", "Аналитик бизнес-процессов"],
    aiRisk: "medium",
  },
  {
    slug: "systems_analyst", displayTitle: "Systems Analyst", category: "analytics",
    habrSpec: "systems_analyst",
    extraAliases: ["Systems Analyst", "Системный аналитик", "System Analyst"],
    aiRisk: "medium",
  },

  // ── Design / Marketing / HR / Docs ─────────────────────────────────────
  {
    slug: "ui_ux_designer", displayTitle: "UX/UI Designer", category: "design",
    habrSpec: "ui_ux_designer",
    extraAliases: ["UX/UI designer", "UX designer", "UI designer", "Product Designer", "Дизайнер интерфейсов"],
    aiRisk: "high",
  },
  {
    slug: "marketing_manager", displayTitle: "Marketing Manager", category: "marketing",
    habrSpec: "marketing_manager",
    extraAliases: ["Marketing Manager", "Маркетолог", "Digital маркетолог", "Интернет маркетолог", "Бренд-менеджер"],
    aiRisk: "medium",
  },
  {
    slug: "recruiter", displayTitle: "IT Recruiter / HR", category: "hr",
    habrSpec: "recruiter",
    extraAliases: ["IT рекрутер", "HR менеджер", "Рекрутер", "Talent Acquisition", "IT recruiter", "Sourcer", "HR BP"],
    aiRisk: "high",
  },
  {
    slug: "technical_writer", displayTitle: "Technical Writer", category: "docs",
    habrSpec: "technical_writer",
    extraAliases: ["Technical Writer", "Технический писатель", "Документалист", "Documentation Engineer"],
    aiRisk: "extreme",
  },

  // ── Security ───────────────────────────────────────────────────────────
  {
    slug: "infosecspec", displayTitle: "Cybersecurity / InfoSec Engineer", category: "security",
    habrSpec: "infosecspec",
    extraAliases: [
      "Cybersecurity", "Специалист ИБ", "ИБ инженер", "Пентестер", "SOC аналитик",
      "Security Engineer", "Information Security",
    ],
    aiRisk: "low",
  },

  // ── Other ──────────────────────────────────────────────────────────────
  {
    slug: "1c_developer", displayTitle: "1C Developer", category: "other",
    stackFamily: "1c",
    habrSpec: "1c_developer",
    extraAliases: ["1С разработчик", "1С программист", "Разработчик 1С", "1С консультант"],
    aiRisk: "medium",
  },
  {
    slug: "gamedev_unity", displayTitle: "Unity GameDev Developer", category: "gamedev",
    stackFamily: "unity_csharp",
    habrSpec: "gamedev", habrSkill: "unity3d",
    extraAliases: ["Unity разработчик", "Game developer", "Геймдев разработчик", "Unity engineer"],
    aiRisk: "medium",
  },
  {
    // У Habr нет отдельного spec для web3 / blockchain, но по сути это smart-contract
    // разработчики (Solidity / Rust / TypeScript) — берём "backend" как прокси,
    // probe-ru-market.ts сохранит запись с пометкой "proxy" в ru_web3_developer.md.
    slug: "web3_developer", displayTitle: "Web3 / Blockchain Developer", category: "other",
    stackFamily: "solidity",
    habrSpec: "backend",
    extraAliases: ["Web3 developer", "Blockchain разработчик", "Solidity разработчик", "Smart Contract Developer"],
    aiRisk: "medium",
  },

  // ── Infra / Support ────────────────────────────────────────────────────
  {
    slug: "system_admin", displayTitle: "System Administrator", category: "infra",
    habrSpec: "system_admin",
    extraAliases: [
      "System Administrator", "Системный администратор", "Sysadmin", "Сисадмин",
      "Системный администратор Linux", "Windows-администратор", "Linux-администратор",
    ],
    aiRisk: "medium",
  },
  {
    slug: "tech_support_manager", displayTitle: "Technical Support", category: "support",
    habrSpec: "technical_support_manager",
    extraAliases: [
      "Technical Support", "Техническая поддержка", "Инженер техподдержки",
      "IT support", "Helpdesk", "Support Engineer", "Helpdesk Engineer",
    ],
    aiRisk: "medium",
  },
];

// ---------------------------------------------------------------------------
// Alias collection — mix extraAliases + RU_TITLE_VARIANTS + displayTitle/slug variants
// ---------------------------------------------------------------------------

function collectAliases(def: RoleDef): string[] {
  const aliases = new Set<string>();

  // displayTitle (strip parenthesised tech detail for cleaner matching)
  const title = def.displayTitle;
  aliases.add(title);
  aliases.add(title.replace(/\s*\(.*\)\s*/g, "").trim());

  // slug with underscores replaced by spaces — good free-text fallback
  aliases.add(def.slug.replace(/_/g, " "));

  // Hand-crafted RU variants from market-data-service (keyed by slug).
  const variants = RU_TITLE_VARIANTS[def.slug] ?? [];
  for (const v of variants) aliases.add(v);

  // Role-specific extras
  for (const a of def.extraAliases ?? []) aliases.add(a);

  // Drop explicit undesired aliases (for EM/TL split, etc.)
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

  // Выбор источника числа живых вакансий:
  //   1. skill-page live (hardcoded "Live total (skill page): N" строка в md-файле)
  //   2. def.ukSumLive = true → сумма по всем родственным тайтлам таблицы
  //   3. top-1 liveJobs из поиска (по умолчанию)
  let vacancies: number | null = top?.liveJobs ?? parsed.trend?.now ?? null;
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
  console.log(`[market-index] Building from ${REGISTRY.length} roles…`);

  const seen = new Set<string>();
  for (const def of REGISTRY) {
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
  for (const def of REGISTRY) {
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
    total: REGISTRY.length,
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
