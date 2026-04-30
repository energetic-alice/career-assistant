/**
 * Per-country salary probe via Perplexity Sonar Pro.
 *
 * Назначение: для каждой пары (страна, роль) делает Perplexity-запрос с
 * структурированным JSON-ответом, парсит и сохраняет в
 * `app/src/prompts/market-data/by-country/{COUNTRY}_{role}.md`.
 *
 * Используется как источник для `{{scrapedMarketData}}` в Phase 3, когда
 * клиент работает в стране, не покрытой `uk_*.md` / `ru_*.md` файлами
 * (NL, DE, ES, IL, US, и т.п.).
 *
 * Кэш: `data/perplexity-country-salary-cache.json` (TTL не проверяется,
 * считается что зарплаты обновляются раз в 3-6 мес ручным re-run).
 *
 * Usage:
 *   COUNTRIES=NL ROLES=recruiter,business_analyst npx tsx src/scripts/probe-country-salary.ts
 *   COUNTRIES=NL,IL ROLES=ALL npx tsx src/scripts/probe-country-salary.ts
 *   COUNTRIES=ALL ROLES=ALL npx tsx src/scripts/probe-country-salary.ts
 *   FORCE=1 ... — игнорировать кэш и переобновить
 */

import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_ROLES } from "../services/known-roles.js";
import { saveMap, loadMap } from "../services/state-store.js";
import { sanitizeRussianText } from "../services/text-sanitize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "prompts", "market-data", "by-country");

const SONAR_URL = "https://api.perplexity.ai/chat/completions";
const SONAR_MODEL = "sonar-pro";
const CACHE_NAME = "perplexity-country-salary-cache";

// ── Регион → набор стран. Используется когда COUNTRIES=ALL или REGION=eu.
const REGION_COUNTRIES: Record<string, string[]> = {
  eu: ["NL", "DE", "ES", "PL", "SE", "FR"],
  us: ["US"],
  "middle-east": ["IL", "AE"],
  "asia-pacific": ["SG", "AU"],
};

const ALL_COUNTRIES = Array.from(
  new Set(Object.values(REGION_COUNTRIES).flat()),
);

// ── Skip-irrelevant: какие роли НЕ запрашивать в каких странах.
//    Логика: если в стране практически нет рынка для роли, пропускаем.
const ROLE_SKIP: Record<string, string[]> = {
  // 1С только в RU/CIS, у нас в этом скрипте таких стран нет — полностью пропускаем
  "1c_developer": ALL_COUNTRIES,
  // Web3 — только крупные крипто-хабы
  web3_developer: ["DE", "ES", "PL", "SE", "FR", "AU"],
  // GameDev Unity — слабый рынок в малых странах
  gamedev_unity: ["NL", "ES", "PL", "AE"],
};

interface CountryCurrency {
  default: string;
}
const COUNTRY_CURRENCY: Record<string, CountryCurrency> = {
  NL: { default: "EUR" }, DE: { default: "EUR" }, ES: { default: "EUR" },
  FR: { default: "EUR" }, AT: { default: "EUR" }, IE: { default: "EUR" },
  PL: { default: "PLN" }, SE: { default: "SEK" }, US: { default: "USD" },
  IL: { default: "ILS" }, AE: { default: "AED" }, SG: { default: "SGD" },
  AU: { default: "AUD" }, UK: { default: "GBP" }, GB: { default: "GBP" },
};

// Полные названия стран — обязательны для Perplexity, иначе ISO-коды
// двусмысленны (IL = Illinois в США, не Israel; DE = Delaware и т.д.).
const COUNTRY_FULL_NAME: Record<string, string> = {
  NL: "Netherlands", DE: "Germany", ES: "Spain",
  FR: "France", AT: "Austria", IE: "Ireland",
  PL: "Poland", SE: "Sweden", US: "United States",
  IL: "Israel", AE: "United Arab Emirates", SG: "Singapore",
  AU: "Australia", UK: "United Kingdom", GB: "United Kingdom",
};

interface SalaryTier {
  min: number | null;
  max: number | null;
  median: number | null;
  years_in_role: string;
}

interface SalaryResult {
  country: string;
  role: string;
  currency: string;
  monthly_or_annual: "monthly" | "annual";
  gross_or_net: "gross" | "net";
  tiers: {
    junior: SalaryTier;
    middle: SalaryTier;
    senior: SalaryTier;
    lead: SalaryTier;
  };
  vacancy_volume: "low" | "medium" | "high";
  trend_yoy_pct: number | null;
  ai_risk: "low" | "medium" | "high";
  competition: "low" | "medium" | "high";
  has_meaningful_data: boolean;
  notes: string;
  sources: Array<{ name: string; url?: string }>;
}

// JSON Schema для structured output Perplexity
const SCHEMA = {
  type: "object",
  required: [
    "country", "role", "currency", "monthly_or_annual", "gross_or_net",
    "tiers", "vacancy_volume", "ai_risk", "competition",
    "has_meaningful_data", "notes", "sources",
  ],
  properties: {
    country: { type: "string" },
    role: { type: "string" },
    currency: { type: "string" },
    monthly_or_annual: { type: "string", enum: ["monthly", "annual"] },
    gross_or_net: { type: "string", enum: ["gross", "net"] },
    tiers: {
      type: "object",
      required: ["junior", "middle", "senior", "lead"],
      properties: {
        junior: { $ref: "#/$defs/tier" },
        middle: { $ref: "#/$defs/tier" },
        senior: { $ref: "#/$defs/tier" },
        lead: { $ref: "#/$defs/tier" },
      },
    },
    vacancy_volume: { type: "string", enum: ["low", "medium", "high"] },
    trend_yoy_pct: { type: ["number", "null"] },
    ai_risk: { type: "string", enum: ["low", "medium", "high"] },
    competition: { type: "string", enum: ["low", "medium", "high"] },
    has_meaningful_data: { type: "boolean" },
    notes: { type: "string" },
    sources: {
      type: "array",
      items: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, url: { type: "string" } },
      },
    },
  },
  $defs: {
    tier: {
      type: "object",
      required: ["min", "max", "median", "years_in_role"],
      properties: {
        min: { type: ["number", "null"] },
        max: { type: ["number", "null"] },
        median: { type: ["number", "null"] },
        years_in_role: { type: "string" },
      },
    },
  },
};

interface CacheEntry {
  data: SalaryResult;
  citations: string[];
  fetchedAt: string;
}

/**
 * Чинит очевидные нарушения tier-инвариантов которые LLM иногда выдаёт:
 *   - median вне [min, max] -> перетягиваем median в середину диапазона
 *   - max < min -> меняем местами
 * Возвращает список предупреждений (для логов).
 */
function sanitizeTiers(data: SalaryResult): string[] {
  const warnings: string[] = [];
  for (const tierName of ["junior", "middle", "senior", "lead"] as const) {
    const t = data.tiers[tierName];
    if (t.min == null || t.max == null) continue;
    if (t.max < t.min) {
      warnings.push(`${tierName}: max(${t.max}) < min(${t.min}) - swapped`);
      const tmp = t.min;
      t.min = t.max;
      t.max = tmp;
    }
    if (t.median != null && (t.median < t.min || t.median > t.max)) {
      const fixed = Math.round((t.min + t.max) / 2);
      warnings.push(
        `${tierName}: median(${t.median}) outside [${t.min}, ${t.max}] - fixed to ${fixed}`,
      );
      t.median = fixed;
    }
  }
  return warnings;
}

const cache: Map<string, CacheEntry> = loadMap<CacheEntry>(CACHE_NAME);

function buildPrompt(countryCode: string, role: string): string {
  const currency = COUNTRY_CURRENCY[countryCode]?.default ?? "EUR";
  const country = COUNTRY_FULL_NAME[countryCode] ?? countryCode;
  return `Provide 2026 salary data for the role "${role}" in ${country} (country code: ${countryCode}, NOT a US state), focused on the
BROAD MID-MARKET (not FAANG / Big Tech / financial services premium).

Target audience for this data: career advisor recommending realistic starting
salaries to people transitioning from adjacent roles. Inflated numbers mislead
candidates - prefer conservative, mid-market medians.

Return strict JSON:
- currency: "${currency}" (or local default for the country)
- monthly_or_annual: "annual"
- gross_or_net: "gross"
- tiers:
    junior  (0-2 years in this exact role)
    middle  (2-5 years in this exact role)
    senior  (5-8 years in this exact role)
    lead    (8+ years or team lead in this exact role)
  Each: { min, max, median, years_in_role }

  HARD RULES per tier (NEVER violate):
    a) min <= median <= max (median MUST lie inside the range)
    b) max >= min (no inverted ranges)
    c) Across tiers: junior.median <= middle.median <= senior.median <= lead.median
       (monotonic growth - if your data shows otherwise, you got tier definitions wrong)
    d) Adjacent tiers should overlap or touch (e.g. junior.max ~= middle.min, give or take 10%).
       If you see a huge gap (e.g. junior.max=40k, middle.min=70k), recheck your sources.

  IMPORTANT: fill ALL FOUR tiers if at all possible. If a tier has weak primary
  data, interpolate from neighbors (e.g. middle ≈ midpoint of junior_max and
  senior_min). Only leave nulls if the role barely exists in this country.
- vacancy_volume: "low" / "medium" / "high"
- trend_yoy_pct: estimated YoY salary change (or null)
- ai_risk: low / medium / high (2026 AI exposure)
- competition: low / medium / high (labor market for the role in this country)
- has_meaningful_data: false ONLY if the role basically does not exist in this country
- notes: 1-2 sentences. ALWAYS mention if Big Tech / financial sector ceilings are
  significantly higher (e.g. "Big Tech in Amsterdam reaches +40% above mid-market
  for senior; FAANG total comp can exceed €X in stock+bonus").
- sources: list with name + url

Source ranking (most-trusted first):
  1. PayScale - mid-market median
  2. Glassdoor (national filter, not just capital city)
  3. ERI SalaryExpert - tier breakdowns
  4. Local boards / aggregators (Hirex for NL, StepStone for DE/AT, InfoJobs for ES,
     levels.fyi country pages for general benchmarks NOT just FAANG)
  5. Robert Half / Hays salary guides for management roles

EXPLICITLY AVOID:
- Levels.fyi as the median source (it is FAANG-skewed). Use only as a CEILING
  indicator and report that in "notes" instead.
- Specialized sub-segments unless they are the dominant market segment
  (e.g. "financial services BA" if BA broadly is bigger).
- Numbers from blogs / SEO articles (datacamp, indeed sponsored articles).

Country adjustments:
- For ${country}, report numbers reflecting NATIONAL median, not just the largest
  tech hub. If hub salary is materially higher, mention in notes.
- Use the most appropriate local currency: ${currency} unless EUR is more standard
  for this market.

Role definition: "${role}" = the standard tech-industry interpretation of this
role. E.g. "recruiter" means IT/Tech Recruiter or Talent Acquisition Specialist
in tech, NOT general HR or executive search; "data_analyst" means business/product
analyst with SQL+BI tools, NOT data scientist.`;
}

async function callPerplexity(
  country: string,
  role: string,
): Promise<{ data: SalaryResult; citations: string[] }> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("PERPLEXITY_API_KEY not set");

  const prompt = buildPrompt(country, role);

  const resp = await fetch(SONAR_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: SONAR_MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_schema", json_schema: { schema: SCHEMA } },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Perplexity ${resp.status}: ${text}`);
  }

  const json = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
    citations?: string[];
  };

  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty Perplexity response");

  let parsed: SalaryResult;
  try {
    parsed = JSON.parse(content) as SalaryResult;
  } catch (e) {
    throw new Error(`JSON parse failed: ${(e as Error).message}\n${content.slice(0, 300)}`);
  }

  return { data: parsed, citations: json.citations || [] };
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 10000) return n.toLocaleString("en-US");
  return String(n);
}

function fmtTier(t: SalaryTier): string {
  if (t.min == null && t.max == null && t.median == null) return "нет данных";
  const med = t.median != null ? `, медиана ${fmtNum(t.median)}` : "";
  return `${fmtNum(t.min)}–${fmtNum(t.max)}${med} (${t.years_in_role})`;
}

function renderMd(data: SalaryResult, citations: string[]): string {
  const cur = data.currency;
  const period = data.monthly_or_annual === "monthly" ? "/мес" : "/год";
  const lines: string[] = [];
  lines.push(`# ${data.role} — ${data.country} (${cur} ${data.gross_or_net} ${period})`);
  lines.push("");
  lines.push(`Дата: ${new Date().toISOString().slice(0, 10)} | Источник: Perplexity Sonar Pro`);
  lines.push("");
  if (!data.has_meaningful_data) {
    lines.push("> ⚠ Perplexity сообщает: достоверных данных по этой паре (страна/роль) нет.");
    lines.push("> Используй качественную оценку из общих рыночных трендов.");
    lines.push("");
  }
  lines.push(`## Зарплатные tier-вилки (${cur} ${data.gross_or_net} ${period})`);
  lines.push("");
  lines.push("| Tier | Опыт в роли | Min | Max | Медиана |");
  lines.push("|---|---|---:|---:|---:|");
  for (const tier of ["junior", "middle", "senior", "lead"] as const) {
    const t = data.tiers[tier];
    lines.push(
      `| ${tier} | ${t.years_in_role} | ${fmtNum(t.min)} | ${fmtNum(t.max)} | ${fmtNum(t.median)} |`,
    );
  }
  lines.push("");
  lines.push(`**Объём вакансий:** ${data.vacancy_volume}`);
  if (data.trend_yoy_pct != null) lines.push(`**Динамика YoY:** ${data.trend_yoy_pct > 0 ? "+" : ""}${data.trend_yoy_pct}%`);
  lines.push(`**AI-риск:** ${data.ai_risk}`);
  lines.push(`**Конкуренция:** ${data.competition}`);
  lines.push("");
  if (data.notes) {
    lines.push(`**Заметки:** ${data.notes}`);
    lines.push("");
  }
  lines.push("## Источники");
  for (const s of data.sources) {
    lines.push(`- ${s.name}${s.url ? ` — ${s.url}` : ""}`);
  }
  if (citations.length > 0) {
    lines.push("");
    lines.push("### Citations (Perplexity)");
    for (const c of citations) lines.push(`- ${c}`);
  }
  return lines.join("\n") + "\n";
}

async function processOne(
  country: string,
  role: string,
  force: boolean,
): Promise<"hit" | "fetched" | "skipped" | "no_data" | "error"> {
  if ((ROLE_SKIP[role] ?? []).includes(country)) {
    console.log(`  [skip] ${country}/${role} - role not relevant in this country`);
    return "skipped";
  }

  const cacheKey = `${country}|${role}`;
  let entry = cache.get(cacheKey);

  if (entry && !force) {
    console.log(`  [cache hit] ${country}/${role}`);
  } else {
    try {
      const result = await callPerplexity(country, role);
      const warnings = sanitizeTiers(result.data);
      entry = {
        data: result.data,
        citations: result.citations,
        fetchedAt: new Date().toISOString(),
      };
      cache.set(cacheKey, entry);
      saveMap(CACHE_NAME, cache);
      console.log(`  [fetched] ${country}/${role} - has_data=${result.data.has_meaningful_data}`);
      for (const w of warnings) console.log(`    [tier-fix] ${w}`);
    } catch (err) {
      console.error(`  [error] ${country}/${role}:`, (err as Error).message);
      return "error";
    }
  }

  if (!entry) return "error";

  await mkdir(OUT_DIR, { recursive: true });
  const md = sanitizeRussianText(renderMd(entry.data, entry.citations));
  const filename = `${country}_${role}.md`;
  await writeFile(join(OUT_DIR, filename), md, "utf-8");

  return entry.data.has_meaningful_data ? "fetched" : "no_data";
}

function parseList(env: string | undefined, all: readonly string[]): string[] {
  if (!env || env.toUpperCase() === "ALL") return [...all];
  return env.split(",").map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const countries = parseList(process.env.COUNTRIES, ALL_COUNTRIES);
  const roles = parseList(process.env.ROLES, KNOWN_ROLES);
  const force = process.env.FORCE === "1";

  const pairs: Array<{ country: string; role: string }> = [];
  for (const country of countries) {
    for (const role of roles) {
      pairs.push({ country, role });
    }
  }

  console.log(`Total pairs: ${pairs.length} (${countries.length} countries × ${roles.length} roles)`);
  console.log(`Force: ${force}`);
  console.log(`Output: ${OUT_DIR}\n`);

  const stats = { hit: 0, fetched: 0, skipped: 0, no_data: 0, error: 0 };

  for (let i = 0; i < pairs.length; i++) {
    const { country, role } = pairs[i];
    process.stdout.write(`[${i + 1}/${pairs.length}] `);
    const r = await processOne(country, role, force);
    stats[r]++;
    // Лёгкий rate limit для Perplexity (50 RPM)
    if (r === "fetched") await new Promise((res) => setTimeout(res, 1500));
  }

  console.log("\n=== Summary ===");
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
