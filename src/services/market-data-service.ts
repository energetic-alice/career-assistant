import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CandidateProfile, Direction, Region } from "../schemas/analysis-outputs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MARKET_DATA_DIR = join(__dirname, "..", "prompts", "market-data");
const KB_DIR = join(__dirname, "..", "prompts", "kb");

const SONAR_URL = "https://api.perplexity.ai/v1/sonar";
const SONAR_MODEL = "sonar-pro";
const REPORT_TTL_MS = 6 * 30 * 24 * 60 * 60 * 1000;

export { KNOWN_ROLES, type KnownRoleSlug } from "./known-roles.js";
import { KNOWN_ROLES } from "./known-roles.js";

// ---------------------------------------------------------------------------
// Region config
// ---------------------------------------------------------------------------

export interface RegionConfig {
  label: string;
  jobBoards: string[];
  salarySource?: string;
  currency: string;
  extra?: string;
  includeRegions?: string[];
}

export const REGIONS: Record<string, RegionConfig> = {
  uk: {
    label: "United Kingdom",
    jobBoards: ["itjobswatch.co.uk", "reed.co.uk", "cwjobs.co.uk"],
    salarySource: "levels.fyi",
    currency: "GBP",
  },
  eu: {
    label: "European Union (Germany, Netherlands, Ireland, Nordics, Poland, Czechia — remote-friendly)",
    jobBoards: ["stepstone.de", "arbeitnow.com", "indeed.de", "indeed.nl"],
    salarySource: "levels.fyi",
    currency: "EUR",
    extra: "Include UK remote-friendly positions as well (many EU remote roles accept UK-based candidates).",
    includeRegions: ["uk"],
  },
  us: {
    label: "United States",
    jobBoards: ["indeed.com", "builtin.com", "dice.com"],
    salarySource: "levels.fyi",
    currency: "USD",
  },
  ru: {
    label: "Russia and CIS countries",
    jobBoards: ["hh.ru", "habr.com/ru/job"],
    currency: "RUB",
    extra: "Use hh.ru vacancy counts and resume counts to calculate competition ratio (vacancies per 100 resumes).",
  },
  "middle-east": {
    label: "Middle East (UAE, Saudi Arabia, Qatar)",
    jobBoards: ["bayt.com", "gulftalent.com", "naukrigulf.com"],
    salarySource: "levels.fyi",
    currency: "USD/AED",
  },
  latam: {
    label: "Latin America (Brazil, Mexico, Argentina, Colombia)",
    jobBoards: ["computrabajo.com", "indeed.com.br", "indeed.com.mx"],
    salarySource: "levels.fyi",
    currency: "USD",
  },
  "asia-pacific": {
    label: "Asia-Pacific (Singapore, Australia, Japan, India)",
    jobBoards: ["jobstreet.com", "seek.com.au", "indeed.com.sg"],
    salarySource: "levels.fyi",
    currency: "USD/SGD",
  },
};

// engineering manager и tech lead на ру-рынке — близкие тайтлы и часто
// пересекаются. Используем общий набор формулировок, чтобы оба отчёта
// показывали единую картину рынка лидов/руководителей разработки.
const EM_TECHLEAD_VARIANTS = [
  "Тимлид", "Tech Lead", "Team Lead", "Технический лид",
  "Lead developer", "Lead engineer",
  "Руководитель разработки", "Engineering Manager",
  "Руководитель команды разработки", "Head of Engineering",
  "Руководитель IT-отдела", "Руководитель направления разработки",
];

/**
 * Russian / multilingual query variants per canonical slug. Используются в
 * probe-ru-market.ts (CLI-аргументы) и в build-market-index.ts → collectAliases
 * (для подмешивания в matcher-алиасы). Keys MUST match snake_case slugs из
 * KNOWN_ROLES / REGISTRY.
 */
export const RU_TITLE_VARIANTS: Record<string, string[]> = {
  // Backend
  backend_java: [
    "Java разработчик", "Java программист", "Java developer", "Java инженер",
    "Backend Java", "Java Spring разработчик",
  ],
  backend_python: [
    "Python разработчик", "Python программист", "Python developer", "Python инженер",
    "Backend Python", "Django", "FastAPI", "Flask",
  ],
  backend_go: [
    "Go разработчик", "Golang разработчик", "Golang developer", "Go программист",
    "Backend Go", "Go инженер",
  ],
  backend_nodejs: [
    "Node.js разработчик", "Node.js developer", "Node.js программист",
    "Node разработчик", "Backend Node.js", "NestJS разработчик",
  ],
  backend_net: [
    "C# разработчик", ".NET разработчик", "C# программист", "C# developer",
    "Backend C#", "ASP.NET разработчик", ".NET инженер",
  ],
  backend_php: [
    "PHP разработчик", "PHP программист", "PHP developer",
    "Backend PHP", "Laravel разработчик", "Symfony разработчик", "Bitrix разработчик",
  ],
  backend_ruby: [
    "Ruby разработчик", "Ruby on Rails", "Ruby программист",
    "Rails разработчик", "RoR разработчик", "Backend Ruby",
  ],
  backend_rust: [
    "Rust разработчик", "Rust developer", "Rust программист",
    "Backend Rust", "Rust инженер",
  ],
  // C и C++ на hh.ru тоже лежат в одном пуле (embedded / systems).
  // ВАЖНО: "C разработчик" / "Embedded C" без плюсов НЕ включать — hh.ru fuzzy-матч
  // цепляет C# / Objective-C / упоминания буквы "C" в описании. Реального embedded C
  // очень мало, язык C отдельной популяцией на hh практически не представлен.
  backend_cplusplus: [
    "C++ разработчик", "C++ программист", "C++ developer", "C/C++ разработчик",
    "C++ инженер", "Embedded C++",
  ],

  // Frontend + Fullstack
  frontend_react: [
    "React разработчик", "Frontend React", "React developer", "React программист",
    "Фронтенд React", "React инженер",
  ],
  frontend_vue: [
    "Vue разработчик", "Vue.js developer", "Vue программист",
    "Фронтенд Vue", "Nuxt разработчик", "Vue инженер",
  ],
  frontend_angular: [
    "Angular разработчик", "Angular developer", "Angular программист",
    "Фронтенд Angular", "Angular инженер",
  ],
  fullstack: [
    "Fullstack разработчик", "Full stack developer", "Фулстек разработчик",
    "Fullstack JS", "Fullstack engineer", "MERN разработчик", "Full-stack",
  ],

  // Mobile
  mobileapp_swift: [
    "iOS разработчик", "iOS developer", "Swift разработчик", "iOS программист",
    "Swift developer", "iOS инженер", "iOS engineer",
  ],
  mobileapp_kotlin: [
    "Android разработчик", "Android developer", "Kotlin разработчик", "Android программист",
    "Kotlin developer", "Android инженер", "Android engineer",
  ],
  mobileapp_react_native: [
    "React Native разработчик", "React Native developer", "React Native программист",
    "RN разработчик", "React Native инженер", "Cross-platform разработчик",
  ],
  mobileapp_flutter: [
    "Flutter разработчик", "Flutter developer", "Flutter программист",
    "Flutter инженер", "Dart разработчик",
  ],

  // DevOps cluster — SRE / MLOps / Platform Engineer / DevSecOps / FinOps слиты
  // в `devops`, берём их русские тайтлы сюда, чтобы hh.ru-скрейпер видел весь пул.
  devops: [
    "DevOps", "DevOps инженер", "DevOps engineer",
    "инженер инфраструктуры", "инженер сопровождения",
    "CI/CD инженер", "release engineer",
    "SRE", "SRE инженер", "Site Reliability Engineer", "инженер надёжности",
    "MLOps инженер", "MLOps Engineer", "MLOps", "ML platform engineer",
    "Платформенный инженер", "Platform Engineer", "Инженер платформы",
    "Internal Platform Engineer",
    "DevSecOps инженер", "DevSecOps", "DevSecOps engineer",
    "Security DevOps", "AppSec DevOps", "Безопасник DevOps",
    "FinOps", "FinOps Engineer",
  ],
  // Data / ML
  data_analyst: ["Аналитик данных", "Data Analyst", "Дата аналитик"],
  product_analyst: [
    "Продуктовый аналитик", "Product Analyst", "Аналитик продукта",
    "Продакт-аналитик", "Growth аналитик", "CJM аналитик",
  ],
  data_engineer: [
    "Инженер данных", "Data Engineer", "Дата инженер",
    "ETL разработчик", "ETL инженер", "Big Data инженер", "DWH разработчик",
  ],
  // ml_engineer + data_scientist слиты в один слаг (на рынке они пересекаются
  // настолько, что job description часто неотличимы).
  ml_engineer: [
    "ML инженер", "ML Engineer", "Machine Learning инженер",
    "Инженер машинного обучения", "ML разработчик", "AI engineer", "LLM инженер",
    "Data Scientist", "Специалист по данным", "Дата сайентист",
    "DS", "ML researcher", "NLP инженер", "CV инженер",
  ],

  // QA
  qa_engineer: [
    "QA Automation", "Автоматизатор тестирования", "QA Engineer",
    "Automation QA", "Test Automation Engineer", "SDET", "Автотестировщик",
  ],
  manual_testing: [
    "QA инженер", "Тестировщик", "Manual QA",
    "Тестировщик ПО", "Manual QA Engineer", "QA tester", "Инженер по тестированию",
  ],

  // Management / Architecture
  product_manager: [
    "Продакт менеджер", "Product Manager", "Менеджер продукта",
    "Owner продукта", "Product owner",
  ],
  project_manager: [
    "Проектный менеджер", "Project Manager", "Менеджер проектов",
    "Руководитель проекта", "Руководитель проектов", "Delivery Manager",
  ],
  tech_lead: EM_TECHLEAD_VARIANTS,
  software_architect: [
    "Архитектор решений", "Solution Architect", "Системный архитектор",
    "Архитектор ПО", "Software Architect", "Enterprise Architect", "Технический архитектор",
  ],

  // Analysis (non-data)
  systems_analyst: ["Системный аналитик", "System Analyst"],
  business_analyst: [
    "Бизнес-аналитик", "Business Analyst", "Бизнес аналитик",
    "BA", "Аналитик бизнес-процессов",
  ],

  // Design / Marketing / HR / Docs
  ui_ux_designer: [
    "UX/UI дизайнер", "UX дизайнер", "Продуктовый дизайнер", "UI дизайнер",
    "Web дизайнер", "Product Designer", "Дизайнер интерфейсов", "UX/UI",
  ],
  marketing_manager: [
    "Маркетолог", "Digital маркетолог", "Интернет маркетолог", "Marketing Manager",
    "Performance маркетолог", "Product маркетолог", "Бренд-менеджер", "Head of Marketing",
  ],
  recruiter: [
    "IT рекрутер", "HR менеджер", "Рекрутер", "Talent Acquisition",
    "IT recruiter", "Sourcer", "HR BP", "HR generalist",
  ],
  technical_writer: [
    "Технический писатель", "Technical Writer", "Техписатель",
    "Документалист", "Tech Writer", "Documentation Engineer",
  ],

  // Security — чистый InfoSec / Cybersecurity (без DevSecOps: он в devops).
  infosecspec: [
    "Специалист по информационной безопасности", "Инженер по кибербезопасности",
    "ИБ инженер", "Cybersecurity", "Специалист ИБ",
    "Пентестер", "Penetration Tester", "SOC аналитик",
    "Security Engineer", "Information Security",
  ],

  // Infra / Support
  system_admin: [
    "Системный администратор", "Sysadmin", "Сисадмин",
    "System Administrator", "Linux-администратор", "Windows-администратор",
    "Администратор серверов", "IT-администратор",
  ],
  tech_support_manager: [
    "Техническая поддержка", "Инженер техподдержки", "Специалист техподдержки",
    "IT support", "Helpdesk", "Technical Support Engineer",
    "Инженер службы поддержки", "Support Engineer",
  ],

  // Other
  "1c_developer": [
    "1С разработчик", "1С программист", "Разработчик 1С",
    "1C разработчик", "Программист 1С", "1С специалист", "1С консультант",
  ],
  web3_developer: [
    "Blockchain разработчик", "Web3 developer", "Solidity разработчик",
    "Smart Contract Developer", "Web3 разработчик", "Crypto разработчик", "EVM разработчик",
  ],
  gamedev_unity: [
    "Unity разработчик", "Game developer", "Геймдев разработчик", "Unity программист",
    "Game-разработчик", "Unity engineer", "Game developer Unity",
  ],
};

// ---------------------------------------------------------------------------
// computeMarketAccess — заполняет булевые флаги и accessibleMarkets после Step 1
// ---------------------------------------------------------------------------

import {
  computeAccessibleMarkets,
  hasEUWorkPermit as computeHasEUWorkPermit,
  hasRuWorkPermit as computeHasRuWorkPermit,
  isPhysicallyInEU as computeIsPhysicallyInEU,
  isPhysicallyInRU as computeIsPhysicallyInRU,
} from "./market-access.js";

export function computeMarketAccess(profile: CandidateProfile): CandidateProfile {
  const country = profile.barriers.physicalCountry;
  const citizenships = profile.barriers.citizenships;

  return {
    ...profile,
    barriers: {
      ...profile.barriers,
      isPhysicallyInRU: computeIsPhysicallyInRU(country),
      isPhysicallyInEU: computeIsPhysicallyInEU(country),
      hasRuWorkPermit: computeHasRuWorkPermit(country, citizenships),
      hasEUWorkPermit: computeHasEUWorkPermit(country, citizenships),
      accessibleMarkets: computeAccessibleMarkets({
        citizenships,
        physicalCountry: country,
        targetMarketRegions: profile.careerGoals.targetMarketRegions,
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Parsed market data types
// ---------------------------------------------------------------------------

export interface ParsedItjwRow {
  title: string;
  rank: number | null;
  rankYoY: number | null;
  medianSalary: number | null;
  salaryYoY: string;
  jobs6m: number | null;
  liveNow: number | null;
}

export interface ParsedItjw {
  query: string;
  rows: ParsedItjwRow[];
  top3: Array<{ title: string; liveJobs: number; salary: number }>;
  trend: { now: number; yearAgo: number; twoYearsAgo: number } | null;
}

export interface ParsedHhRow {
  title: string;
  vacancies: number;
  salaryRange: string;
  medianSalary: number | null;
}

export interface ParsedHh {
  query: string;
  rows: ParsedHhRow[];
  totalVacancies: number;
  topMedianSalary: number | null;
}

// ---------------------------------------------------------------------------
// parseItjwFile — parse itjw-*.md into structured data
// ---------------------------------------------------------------------------

function parseNumber(s: string): number | null {
  const cleaned = s.replace(/[,£₽\s]/g, "").trim();
  if (!cleaned || cleaned === "N/A" || cleaned === "-") return null;
  const n = parseInt(cleaned, 10);
  return Number.isNaN(n) ? null : n;
}

export function parseItjwFile(content: string): ParsedItjw | null {
  const lines = content.split("\n");
  if (lines.length < 6) return null;

  const headerLine = lines[0] ?? "";
  const query = headerLine.replace(/^#\s*/, "").replace(/\s*—.*/, "").trim();

  const rows: ParsedItjwRow[] = [];
  for (const line of lines) {
    if (!line.startsWith("|") || line.includes("------") || line.includes("Title")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 7) continue;

    rows.push({
      title: cells[0]!,
      rank: parseNumber(cells[1]!),
      rankYoY: parseNumber(cells[2]!),
      medianSalary: parseNumber(cells[3]!),
      salaryYoY: cells[4] ?? "-",
      jobs6m: parseNumber(cells[5]!),
      liveNow: parseNumber(cells[6]!),
    });
  }

  const top3: ParsedItjw["top3"] = [];
  for (const line of lines) {
    const m = line.match(/^\d+\.\s+(.+?)\s+—\s+(\d[\d,]*)\s+live,\s+£([\d,]+)/);
    if (m) {
      top3.push({
        title: m[1]!,
        liveJobs: parseNumber(m[2]!) ?? 0,
        salary: parseNumber(m[3]!) ?? 0,
      });
    }
  }

  let trend: ParsedItjw["trend"] = null;
  for (const line of lines) {
    const m = line.match(/Сейчас:\s*([\d,]+)\s*\|\s*Год назад:\s*([\d,]+)\s*\|\s*2 года назад:\s*([\d,]+)/);
    if (m) {
      trend = {
        now: parseNumber(m[1]!) ?? 0,
        yearAgo: parseNumber(m[2]!) ?? 0,
        twoYearsAgo: parseNumber(m[3]!) ?? 0,
      };
    }
  }

  return { query, rows, top3, trend };
}

// ---------------------------------------------------------------------------
// parseHhFile — parse hh-*.md into structured data
// ---------------------------------------------------------------------------

export function parseHhFile(content: string): ParsedHh | null {
  const lines = content.split("\n");
  if (lines.length < 6) return null;

  const headerLine = lines[0] ?? "";
  const query = headerLine.replace(/^#\s*/, "").replace(/\s*—.*/, "").trim();

  const rows: ParsedHhRow[] = [];
  for (const line of lines) {
    if (!line.startsWith("|") || line.includes("------") || line.includes("Тайтл")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 3) continue;

    const salaryRange = cells[2]!;
    let medianSalary: number | null = null;
    // Форматы ячейки:
    //   (probe-ru-market.ts) "365k ₽"          — avg(Middle, Senior) median
    //   (legacy api.hh.ru)    "200k–350k (медиана 270k) [n=42]"
    const probeMatch = salaryRange.match(/(\d+)\s*k\s*₽/);
    const legacyMatch = salaryRange.match(/медиана\s+([\d]+)k/);
    if (legacyMatch) medianSalary = parseInt(legacyMatch[1]!, 10) * 1000;
    else if (probeMatch) medianSalary = parseInt(probeMatch[1]!, 10) * 1000;

    rows.push({
      title: cells[0]!,
      vacancies: parseNumber(cells[1]!) ?? 0,
      salaryRange,
      medianSalary,
    });
  }

  const totalVacancies = rows.length > 0 ? Math.max(...rows.map((r) => r.vacancies)) : 0;
  const topMedian = rows.find((r) => r.medianSalary !== null)?.medianSalary ?? null;

  return { query, rows, totalVacancies, topMedianSalary: topMedian };
}

// ---------------------------------------------------------------------------
// Load & parse helpers for pipeline use
// ---------------------------------------------------------------------------

/**
 * Load UK market data from `uk_<slug>.md` (scraped from itjobswatch.co.uk).
 * Previous filename scheme: `itjw-<kebab-role>.md`.
 */
export async function loadParsedUk(slug: string): Promise<ParsedItjw | null> {
  try {
    const content = await readFile(join(MARKET_DATA_DIR, `uk_${slug}.md`), "utf-8");
    return parseItjwFile(content);
  } catch {
    return null;
  }
}

/**
 * Load RU market data from `ru_<slug>.md` (scraped from hh.ru API).
 * Previous filename scheme: `hh-<kebab-role>.md`.
 */
export async function loadParsedRu(slug: string): Promise<ParsedHh | null> {
  try {
    const content = await readFile(join(MARKET_DATA_DIR, `ru_${slug}.md`), "utf-8");
    return parseHhFile(content);
  } catch {
    return null;
  }
}

// Legacy names kept so external callers don't break during refactor.
// TODO: remove once all call sites migrated.
export const loadParsedItjw = loadParsedUk;
export const loadParsedHh = loadParsedRu;

// ---------------------------------------------------------------------------
// buildMarketSummary — compact market summary for prompts
// ---------------------------------------------------------------------------

interface MarketCoefficients {
  intlLowEnglish: number;    // x0.07 — international vacancies if eng < B1
  ruNotPhysical: number;     // x0.15 — RU vacancies if not physically in RU
  ruNoWorkPermit: number;    // x0.6  — RU vacancies if no RU work permit
  euNoWorkPermit: number;    // x0.35 — EU vacancies if no EU work permit
  remoteOnly: number;        // x0.3  — remote-only fraction
}

interface RoleSummaryRow {
  role: string;
  ukLive: number | null;
  ukMedian: number | null;
  ukTrendAbs: string;
  ruVacancies: number | null;
  ruMedian: number | null;
  coeffNotes: string[];
}

export interface MarketSummary {
  showUK: boolean;
  showRU: boolean;
  coefficients: Partial<MarketCoefficients>;
  roles: RoleSummaryRow[];
  markdown: string;
}

const CEFR_ORDER: Record<string, number> = {
  "0": 0, "A1": 1, "A2": 2, "B1": 3, "B2": 4, "C1": 5, "C2": 6,
};

function cefrAtLeast(level: string, threshold: string): boolean {
  return (CEFR_ORDER[level] ?? 0) >= (CEFR_ORDER[threshold] ?? 0);
}

export async function buildMarketSummary(
  profile: CandidateProfile,
  roleSlugs: string[],
): Promise<MarketSummary> {
  const b = profile.barriers;
  const eng = profile.currentBase.englishLevel;
  const targets = new Set(profile.careerGoals.targetMarketRegions);
  const accessible = new Set(b.accessibleMarkets ?? []);

  // --- Determine which markets to show ---
  let showUK = targets.has("uk") || targets.has("eu") || targets.has("us") || targets.has("global");
  let showRU = targets.has("ru");

  // Physical in RU and not explicitly excluding → always show RU
  if (b.isPhysicallyInRU && !b.explicitlyExcludesRU) showRU = true;

  // Explicitly excludes RU → never show RU regardless of accessible
  if (b.explicitlyExcludesRU) showRU = false;

  // B2+ without international targets → show UK/EU as opportunity
  if (cefrAtLeast(eng, "B2") && !showUK) {
    showUK = true;
  }

  // --- Compute applicable coefficients ---
  const coefficients: Partial<MarketCoefficients> = {};
  const globalNotes: string[] = [];

  if (!cefrAtLeast(eng, "B1") && showUK) {
    coefficients.intlLowEnglish = 0.07;
    globalNotes.push(`UK/EU ×0.07 (англ ${eng} < B1, только русскоязычные вакансии)`);
  }

  if (showRU && !b.isPhysicallyInRU) {
    coefficients.ruNotPhysical = 0.15;
    globalNotes.push("RU ×0.15 (не в РФ физически, только remote)");
  }

  if (showRU && !b.hasRuWorkPermit) {
    coefficients.ruNoWorkPermit = 0.6;
    globalNotes.push("RU ×0.6 (нет work permit РФ, только B2B/ГПХ)");
  }

  if (showUK && !b.hasEUWorkPermit) {
    coefficients.euNoWorkPermit = 0.35;
    globalNotes.push("EU ×0.35 (нет EU work permit, только B2B)");
  }

  if (b.isRemoteOnly) {
    coefficients.remoteOnly = 0.3;
    globalNotes.push("×0.3 (remote only)");
  }

  // --- Load data per role ---
  const roles: RoleSummaryRow[] = [];

  for (const slug of roleSlugs) {
    const itjw = showUK ? await loadParsedItjw(slug) : null;
    const hh = showRU ? await loadParsedHh(slug) : null;

    let ukLive: number | null = null;
    let ukMedian: number | null = null;
    let ukTrendAbs = "—";

    if (itjw && itjw.rows.length > 0) {
      ukLive = itjw.rows[0]!.liveNow;
      ukMedian = itjw.rows[0]!.medianSalary;
      if (itjw.trend) {
        const diff = itjw.trend.now - itjw.trend.twoYearsAgo;
        const sign = diff >= 0 ? "+" : "";
        ukTrendAbs = `${sign}${diff} за 2г (${itjw.trend.twoYearsAgo}→${itjw.trend.now})`;
      }
    }

    let ruVacancies: number | null = null;
    let ruMedian: number | null = null;

    if (hh && hh.rows.length > 0) {
      ruVacancies = hh.totalVacancies;
      ruMedian = hh.topMedianSalary;
    }

    const notes: string[] = [];
    if (ukLive !== null && coefficients.intlLowEnglish) {
      notes.push(`UK adj: ~${Math.round(ukLive * coefficients.intlLowEnglish)}`);
    }
    if (ukLive !== null && coefficients.euNoWorkPermit) {
      notes.push(`EU adj: ~${Math.round(ukLive * coefficients.euNoWorkPermit)}`);
    }
    if (ruVacancies !== null && coefficients.ruNotPhysical) {
      notes.push(`RU adj: ~${Math.round(ruVacancies * coefficients.ruNotPhysical)}`);
    }
    if (ruVacancies !== null && coefficients.ruNoWorkPermit) {
      notes.push(`RU permit adj: ~${Math.round(ruVacancies * coefficients.ruNoWorkPermit)}`);
    }

    roles.push({
      role: slug,
      ukLive, ukMedian, ukTrendAbs,
      ruVacancies, ruMedian,
      coeffNotes: notes,
    });
  }

  // --- Build markdown table ---
  const mdLines: string[] = [
    "## Компактная рыночная сводка",
    "",
  ];

  if (globalNotes.length > 0) {
    mdLines.push("**Коэффициенты доступа:**");
    for (const n of globalNotes) mdLines.push(`- ${n}`);
    mdLines.push("");
  }

  const hasSomeUK = showUK && roles.some((r) => r.ukLive !== null);
  const hasSomeRU = showRU && roles.some((r) => r.ruVacancies !== null);

  const headerParts = ["| Роль"];
  if (hasSomeUK) headerParts.push("UK: live / £ median / тренд 2г");
  if (hasSomeRU) headerParts.push("RU: вакансий / ₽ median");
  if (roles.some((r) => r.coeffNotes.length > 0)) headerParts.push("adj");
  headerParts.push("");
  mdLines.push(headerParts.join(" | "));
  mdLines.push(headerParts.map(() => "---").join("|"));

  for (const r of roles) {
    const parts = [`| ${r.role}`];
    if (hasSomeUK) {
      const live = r.ukLive !== null ? r.ukLive.toLocaleString("en") : "—";
      const med = r.ukMedian !== null ? `£${(r.ukMedian / 1000).toFixed(0)}k` : "—";
      parts.push(`${live} / ${med} / ${r.ukTrendAbs}`);
    }
    if (hasSomeRU) {
      const vac = r.ruVacancies !== null ? r.ruVacancies.toLocaleString("ru") : "—";
      const med = r.ruMedian !== null ? `${Math.round(r.ruMedian / 1000)}k ₽` : "—";
      parts.push(`${vac} / ${med}`);
    }
    if (roles.some((x) => x.coeffNotes.length > 0)) {
      parts.push(r.coeffNotes.join("; ") || "—");
    }
    parts.push("");
    mdLines.push(parts.join(" | "));
  }

  if (showUK && !hasSomeUK) {
    mdLines.push("");
    mdLines.push("*UK/EU данные: itjobswatch файлы не найдены для указанных ролей*");
  }
  if (showRU && !hasSomeRU) {
    mdLines.push("");
    mdLines.push("*RU данные: hh.ru файлы пусты (требуется перезаполнение)*");
  }

  return {
    showUK,
    showRU,
    coefficients,
    roles,
    markdown: mdLines.join("\n"),
  };
}

/**
 * Full market summary across ALL known roles — used in Step 2
 * so Claude sees the entire market when generating directions.
 */
export async function buildFullMarketSummary(
  profile: CandidateProfile,
): Promise<MarketSummary> {
  // KNOWN_ROLES is already in canonical snake_case slug form.
  return buildMarketSummary(profile, [...KNOWN_ROLES]);
}


// ---------------------------------------------------------------------------
// Perplexity API
// ---------------------------------------------------------------------------

export async function querySonarPro(prompt: string): Promise<{ content: string; citations: string[] }> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("PERPLEXITY_API_KEY not set");

  const response = await fetch(SONAR_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: SONAR_MODEL,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Perplexity API ${response.status}: ${text}`);
  }

  const json = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    citations?: string[];
  };

  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty Perplexity response");

  return { content, citations: json.citations || [] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function formatHeader(title: string): string {
  const date = new Date().toLocaleDateString("ru-RU", {
    day: "numeric", month: "long", year: "numeric",
  });
  return `# ${title}\n\nДата сбора: ${date}\nИсточник: Perplexity Sonar Pro\nОбновлять: раз в 3-6 месяцев\n\n---\n\n`;
}

function appendCitations(content: string, citations: string[]): string {
  if (citations.length === 0) return content;
  let out = content + "\n\n---\n\n## Источники (citations)\n\n";
  for (const [i, url] of citations.entries()) {
    out += `${i + 1}. ${url}\n`;
  }
  return out;
}

async function isStale(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    return Date.now() - s.mtimeMs > REPORT_TTL_MS;
  } catch {
    return true;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Region report prompts
// ---------------------------------------------------------------------------

export function buildRegionPrompt(regionId: string, region: RegionConfig): string {
  if (regionId === "ru") return buildRegionPromptRu(region);
  return buildRegionPromptIntl(region);
}

function buildRegionPromptIntl(region: RegionConfig): string {
  const boards = region.jobBoards.join(", ");

  return `You are a senior IT job market analyst. Provide a macro-level overview of the IT job market in ${region.label} for 2025-2026.

Search for the latest data from: ${boards}${region.salarySource ? `, ${region.salarySource}` : ""}, and industry reports (Stack Overflow Survey, LinkedIn Workforce Report, Hays, Robert Half).

${region.extra || ""}

Report the following:

## 1. Market size and dynamics
- Total IT vacancies in the region (approximate, with source)
- YoY hiring trend: growing / stable / declining, % change
- Remote vs on-site/hybrid split

## 2. Roles growing fastest (top 5-7)
For each: role name, approximate YoY growth %, why it's growing.
Example: "DevOps Engineer: +15% YoY, driven by cloud migration and platform engineering demand"

## 3. Roles declining or stagnating (top 5)
For each: role name, YoY change %, why.

## 4. Salary trends
- Average IT salary trend (growing/flat/declining, %)
- Which roles have highest salary growth
- Which roles have salary stagnation

## 5. AI impact on IT hiring (2026)
- Which roles are most affected by AI (reduced demand)
- Which roles benefit from AI (increased demand for AI-adjacent skills)
- New roles emerging due to AI

## 6. Key market shifts for 2026-2027
5-7 bullet points on concrete changes.

RULES:
- Only cite data you can verify from real sources.
- Always include source name and date.
- Focus on SPECIFIC roles (e.g., "DevOps Engineer", not "cloud experts").

Format as structured markdown.`;
}

function buildRegionPromptRu(region: RegionConfig): string {
  return `Ты — старший аналитик IT-рынка труда. Дай макро-обзор IT-рынка России/СНГ на 2025-2026.

Ищи данные на: hh.ru, habr.com/ru/job, Хабр Карьера, отчёты hh.ru по рынку IT.

${region.extra || ""}

Отчёт по следующим пунктам:

## 1. Размер рынка и динамика
- Общее число IT-вакансий в РФ (примерно, с источником)
- Динамика YoY: растёт / стабильно / падает, % изменения
- Индекс hh.ru для IT (вакансий на резюме)
- Удалёнка vs офис: % вакансий remote

## 2. Роли с самым быстрым ростом (топ 5-7)
Для каждой: название роли, примерный % роста YoY, причина роста.
Пример: "DevOps инженер: +15% YoY, рост из-за миграции в облака и потребности в Platform Engineering"

## 3. Роли в стагнации или падении (топ 5)
Для каждой: название, % изменения YoY, причина.

## 4. Зарплатные тренды
- Средний тренд IT-зарплат (рост/стагнация, %)
- Какие роли с наибольшим ростом ЗП
- Какие роли с застоем ЗП

## 5. Влияние AI на IT-найм (2026)
- Какие роли больше всего страдают от AI (снижение спроса)
- Какие роли выигрывают (рост спроса на AI-смежные навыки)
- Новые роли, появляющиеся благодаря AI

## 6. Ключевые сдвиги рынка на 2026-2027
5-7 конкретных пунктов.

ПРАВИЛА:
- Только проверяемые данные с реальными источниками.
- Указывай источник и дату.
- Фокусируйся на КОНКРЕТНЫХ ролях ("DevOps инженер", а не "облачные специалисты").

Формат: структурированный markdown.`;
}

// ---------------------------------------------------------------------------
// Role + region report prompts
// ---------------------------------------------------------------------------

export function buildRoleRegionPrompt(role: string, regionId: string, region: RegionConfig): string {
  if (regionId === "ru") return buildRoleRuPrompt(role, region);
  return buildRoleIntlPrompt(role, regionId, region);
}

function buildRoleRuPrompt(role: string, region: RegionConfig): string {
  const ruTitles = RU_TITLE_VARIANTS[role];
  const titlesBlock = ruTitles
    ? ruTitles.map((t) => `"${t}"`).join(", ")
    : `"${role}" и русские варианты`;

  return `Найди на hh.ru данные по роли "${role}".
Варианты поиска: ${titlesBlock}

Ответь СТРОГО в этом формате, без лишнего текста:

## Тайтлы (топ-10 по числу вакансий, сортировка desc)
| Тайтл | Вакансий | Резюме | Вак/100рез | Медиана ЗП ₽ | ЗП YoY |
|-------|----------|--------|------------|--------------|--------|

## Итого
- Широкий тайтл (максимум вакансий): ...
- Всего вакансий (по широкому тайтлу): ...
- Конкуренция (вак/100 резюме): ...

## Зарплаты (₽ gross/мес)
Middle: ... | Senior: ... | Lead: ...

## Топ навыки (из вакансий hh.ru)
1. ... 2. ... 3. ... 4. ... 5. ...

## Топ работодатели
1. ... 2. ... 3. ... 4. ... 5. ...

## Тренд
YoY вакансий: ...% | AI-риск: низкий/средний/высокий | Прогноз: ...

ПРАВИЛА:
- ТОЛЬКО данные с hh.ru. Нет данных = "Н/Д".
- Никакого текста-воды. Только таблица и метрики.
- Для каждого числа: источник, дата запроса.`;
}

function buildRoleIntlPrompt(role: string, regionId: string, region: RegionConfig): string {
  const isUk = regionId === "uk";

  const regionalBlock = isUk ? "" : `
## Regional (${region.label})
Also search ${region.jobBoards[0]} for "${role}" and report vacancy count.
${region.salarySource ? `Salary: cross-reference with ${region.salarySource}` : ""}
${region.extra || ""}`;

  return `Search itjobswatch.co.uk for "${role}".

Answer STRICTLY in this format, no filler text:

## Title variations (top 10 by live vacancies, sorted desc)
| Title | Rank | Median Salary £ | Salary YoY | Perm Jobs | Live Vacancies |
|-------|------|----------------|------------|-----------|---------------|

Use the BROAD keyword (e.g. "DevOps" not "DevOps Engineer") as the first row — it shows total market size.
Include Senior, Lead, and technology-specific variants (e.g., AWS DevOps, Azure DevOps).
${regionalBlock}

## Summary
- Best broad title (most vacancies): ...
- Total live vacancies (broad title): ...
- Total perm jobs (broad title): ...
- Competition: low/medium/high (based on rank and demand trend)

## Salaries (${region.currency})
Middle: ... | Senior: ... | Lead: ...

## Top skills (from job postings on ${region.jobBoards[0]})
1. ... 2. ... 3. ... 4. ... 5. ...

## Top employers (actively hiring)
1. ... 2. ... 3. ... 4. ... 5. ...

## Trend
Vacancies YoY: ...% | AI risk: low/medium/high | Outlook: ...

RULES:
- ONLY data from itjobswatch.co.uk${isUk ? "" : ` and ${region.jobBoards[0]}`}. No data = "N/A".
- NO filler text. Only the table and metrics above.
- Cite source and date for every number.`;
}

// ---------------------------------------------------------------------------
// Ensure region report (auto-fetch if missing/stale)
// ---------------------------------------------------------------------------

export async function ensureRegionReport(regionId: string): Promise<string | null> {
  const region = REGIONS[regionId];
  if (!region) return null;

  const fileName = `market-reports-${regionId}.md`;
  const filePath = join(MARKET_DATA_DIR, fileName);

  const stale = await isStale(filePath);
  if (!stale) return filePath;

  if (!process.env.PERPLEXITY_API_KEY) {
    if (await fileExists(filePath)) {
      console.log(`[MarketData] Region ${regionId}: stale but no API key, using existing`);
      return filePath;
    }
    return null;
  }

  console.log(`[MarketData] Region ${regionId}: ${stale ? "stale" : "not found"}, fetching...`);
  try {
    const { content, citations } = await querySonarPro(buildRegionPrompt(regionId, region));
    const full = appendCitations(formatHeader(`Market Reports: ${region.label}`) + content, citations);
    await mkdir(MARKET_DATA_DIR, { recursive: true });
    await writeFile(filePath, full, "utf-8");
    console.log(`[MarketData] Saved: ${filePath}`);
    return filePath;
  } catch (err) {
    console.error(`[MarketData] Failed for region ${regionId}:`, err);
    return (await fileExists(filePath)) ? filePath : null;
  }
}

// ---------------------------------------------------------------------------
// Ensure role report (auto-fetch if missing/stale)
// ---------------------------------------------------------------------------

export async function ensureRoleReport(role: string, regionId: string): Promise<string | null> {
  const region = REGIONS[regionId];
  if (!region) return null;

  const slug = slugify(role);
  const fileName = `role-${slug}-${regionId}.md`;
  const filePath = join(MARKET_DATA_DIR, fileName);

  const stale = await isStale(filePath);
  if (!stale) return filePath;

  if (!process.env.PERPLEXITY_API_KEY) {
    if (await fileExists(filePath)) {
      console.log(`[MarketData] "${role}" in ${regionId}: stale but no API key, using existing`);
      return filePath;
    }
    return null;
  }

  console.log(`[MarketData] "${role}" in ${regionId}: ${stale ? "stale" : "not found"}, fetching...`);
  try {
    const { content, citations } = await querySonarPro(buildRoleRegionPrompt(role, regionId, region));
    const full = appendCitations(formatHeader(`Role Report: ${role} — ${region.label}`) + content, citations);
    await mkdir(MARKET_DATA_DIR, { recursive: true });
    await writeFile(filePath, full, "utf-8");
    console.log(`[MarketData] Saved: ${filePath}`);
    return filePath;
  } catch (err) {
    console.error(`[MarketData] Failed for "${role}" in ${regionId}:`, err);
    return (await fileExists(filePath)) ? filePath : null;
  }
}

// ---------------------------------------------------------------------------
// Load market overview for regions (Step 0)
// ---------------------------------------------------------------------------

/**
 * Рыночный контекст для Phase 1 (prompt-02). Раньше грузил 5 KB-файлов
 * всегда (competition-eu + competition-ru + salaries-eu + salaries-ru +
 * macro-trends), независимо от того, куда клиент целится → EU-кандидату
 * прилетал сверху 200-строчный справочник российских зарплат в рублях, плюс
 * макро-тренды и дублирующие зарплатные таблицы, которые всё равно есть в
 * scorer top-20 с точными числами из market-index.
 *
 * Сейчас оставляем МИНИМУМ:
 *   - для RU/CIS клиентов → `competition-ru.md`
 *   - для EU/UK/US/Global → `competition-eu.md`
 *   - если клиент целится и туда и туда — оба файла
 * Зарплаты и макро-тренды — не подгружаем, они дублируют scorer top-20.
 */
export async function loadMarketOverview(regions: string[]): Promise<string> {
  const needRu = regions.some((r) => r === "ru" || r === "cis");
  const needIntl = regions.some(
    (r) => r === "eu" || r === "uk" || r === "us" || r === "global",
  );

  const files: string[] = [];
  if (needIntl) files.push("competition-eu");
  if (needRu) files.push("competition-ru");

  const parts: string[] = [];
  for (const name of files) {
    try {
      const content = await readFile(join(KB_DIR, `${name}.md`), "utf-8");
      parts.push(content);
    } catch {
      // KB-файл опционален — если нет, идём дальше.
    }
  }

  if (parts.length === 0) {
    return "_(рыночный KB не загружен — используй scorer top-20 и compact market summary ниже)_";
  }

  return parts.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Load role reports for directions (Step 4: KB check)
// ---------------------------------------------------------------------------

export async function loadRoleReports(
  directions: Direction[],
  regions: string[],
): Promise<string> {
  const parts: string[] = [];
  const loaded = new Set<string>();

  for (const dir of directions) {
    const roleKey = extractRoleKey(dir.title);
    for (const regionId of regions) {
      const key = `${roleKey}:${regionId}`;
      if (loaded.has(key)) continue;
      loaded.add(key);

      const filePath = await ensureRoleReport(roleKey, regionId);
      if (filePath) {
        try {
          const content = await readFile(filePath, "utf-8");
          parts.push(content);
        } catch {
          console.warn(`[MarketData] Could not read ${filePath}`);
        }
      }
    }
  }

  return parts.length > 0
    ? parts.join("\n\n---\n\n")
    : "Детальные отчёты по ролям не загружены.";
}

function extractRoleKey(directionTitle: string): string {
  return directionTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s/.#+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Title optimization (Step 3)
// ---------------------------------------------------------------------------

export interface TitleOptimizationResult {
  directionTitle: string;
  bestTitle: string;
  titleVariations: string;
  totalMarketSize: string;
}

export async function optimizeTitles(
  directions: Direction[],
  regions: string[],
): Promise<TitleOptimizationResult[]> {
  if (!process.env.PERPLEXITY_API_KEY) {
    return directions.map((d) => ({
      directionTitle: d.title,
      bestTitle: d.title,
      titleVariations: "API key not set",
      totalMarketSize: "unknown",
    }));
  }

  const results: TitleOptimizationResult[] = [];
  const seen = new Set<string>();

  for (const dir of directions) {
    const roleKey = extractRoleKey(dir.title);
    if (seen.has(roleKey)) continue;
    seen.add(roleKey);

    const primaryRegion = regions[0] || "uk";
    const isRu = primaryRegion === "ru";

    const prompt = isRu
      ? buildTitleOptimizationPromptRu(dir.title, roleKey)
      : buildTitleOptimizationPromptIntl(dir.title, roleKey);

    try {
      console.log(`[TitleOpt] Searching best title for "${roleKey}"...`);
      const { content } = await querySonarPro(prompt);
      const parsed = parseTitleOptResult(content, dir.title);
      results.push(parsed);
      console.log(`[TitleOpt] Best title: "${parsed.bestTitle}" (market: ${parsed.totalMarketSize})`);
    } catch (err) {
      console.error(`[TitleOpt] Failed for "${roleKey}":`, err);
      results.push({
        directionTitle: dir.title,
        bestTitle: dir.title,
        titleVariations: "fetch failed",
        totalMarketSize: "unknown",
      });
    }
  }

  return results;
}

function buildTitleOptimizationPromptIntl(dirTitle: string, roleKey: string): string {
  return `Search itjobswatch.co.uk for "${roleKey}" and list ALL related job title variations.

For each title variation found, report:
| Title | Live Vacancies | Median Salary | Rank |

Then answer:
1. BEST_TITLE: Which title/keyword gives the MOST vacancies? (e.g., "DevOps" gives 1,380 vs "DevOps Engineer" gives 224)
2. TOTAL_MARKET: Total number of live vacancies across the broadest relevant keyword
3. RECOMMENDED: Which specific title should a job seeker use?

IMPORTANT: Use the BROAD keyword (skill/role name) for total market size, not the narrow exact title.
Only report data you can verify from itjobswatch.co.uk. Format as markdown.`;
}

function buildTitleOptimizationPromptRu(dirTitle: string, roleKey: string): string {
  const ruTitles = RU_TITLE_VARIANTS[roleKey];
  const variants = ruTitles
    ? ruTitles.map((t) => `"${t}"`).join(", ")
    : `"${roleKey}"`;

  return `Зайди на hh.ru и найди число вакансий по следующим вариантам названий:
${variants}

Для каждого варианта укажи:
| Тайтл | Число вакансий | Регион |

Ответь:
1. ЛУЧШИЙ_ТАЙТЛ: какой вариант даёт БОЛЬШЕ ВСЕГО вакансий?
2. РАЗМЕР_РЫНКА: общее число вакансий по самому широкому тайтлу
3. РЕКОМЕНДАЦИЯ: какой тайтл использовать для поиска работы?

Указывай ТОЛЬКО реальные данные с hh.ru. Формат: markdown.`;
}

function parseTitleOptResult(content: string, fallbackTitle: string): TitleOptimizationResult {
  const bestMatch = content.match(/(?:BEST_TITLE|ЛУЧШИЙ_ТАЙТЛ)[:\s]*[""]?([^"""\n]+)/i);
  const totalMatch = content.match(/(?:TOTAL_MARKET|РАЗМЕР_РЫНКА)[:\s]*([^\n]+)/i);

  return {
    directionTitle: fallbackTitle,
    bestTitle: bestMatch?.[1]?.trim() || fallbackTitle,
    titleVariations: content,
    totalMarketSize: totalMatch?.[1]?.trim() || "unknown",
  };
}
