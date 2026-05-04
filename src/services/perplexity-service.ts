import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { saveMap, loadMap } from "./state-store.js";
import { REGIONS, type RegionConfig } from "./market-data-service.js";
import type { CandidateProfile, Direction } from "../schemas/analysis-outputs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SONAR_URL = "https://api.perplexity.ai/v1/sonar";
const SONAR_MODEL = "sonar-pro";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_STORE_NAME = "perplexity-cache";
const LOW_VACANCY_THRESHOLD = 500;

const KNOWN_STACKS = new Set([
  "react", "vue", "angular", "svelte", "next.js", "nuxt",
  "java", "kotlin", "scala", "python", "go", "ruby", "php",
  ".net", "c#", "node.js", "typescript", "rust", "c++",
  "swift", "flutter", "react-native", "dart", "objective-c",
  "elixir", "erlang", "clojure", "haskell", "f#", "perl", "lua",
  "solidity", "cobol", "fortran", "julia", "groovy",
  "sql", "matlab",
  "kubernetes", "docker", "terraform", "aws", "gcp", "azure",
]);

const ROLE_STOP_WORDS = new Set([
  "in", "for", "with", "at", "and", "the", "of", "to", "a", "an",
  "focused", "focus", "based", "driven", "oriented",
]);

// --- Types ---

interface MarketResearchResult {
  vacancyCount: string;
  specialistCount?: string;
  marketWidth?: string;
  dynamics: string;
  competition: string;
  vacanciesPer100Specialists: number;
  salaryRange: string;
  aiRisk: string;
  aiRiskExplanation?: string;
  forecast: string;
  employers?: string[];
  keySkills?: string[];
}

interface CacheEntry {
  data: MarketResearchResult;
  citations: string[];
  fetchedAt: string;
}

interface SearchKey {
  role: string;
  stack: string | null;
  domain: string | null;
  region: string;
  cacheKey: string;
  label: string;
  level: "base" | "niche" | "adjacent";
}

export interface PerplexityMarketResult {
  formattedText: string;
  rawData: Array<{
    directionTitle: string;
    results: Array<{
      key: SearchKey;
      data: MarketResearchResult;
      citations: string[];
    }>;
  }>;
}

// --- Cache ---

const cache: Map<string, CacheEntry> = loadMap<CacheEntry>(CACHE_STORE_NAME);
console.log(`[Perplexity] Loaded ${cache.size} cached market data entries`);

function getCached(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  const age = Date.now() - new Date(entry.fetchedAt).getTime();
  if (age > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function setCache(key: string, data: MarketResearchResult, citations: string[]): void {
  cache.set(key, { data, citations, fetchedAt: new Date().toISOString() });
  saveMap(CACHE_STORE_NAME, cache);
}

// --- Stack adjacency ---

let stackAdjacency: Map<string, string[]> | null = null;

async function getStackAdjacency(): Promise<Map<string, string[]>> {
  if (stackAdjacency) return stackAdjacency;

  stackAdjacency = new Map();
  try {
    const kbPath = join(__dirname, "..", "prompts", "kb", "stack-adjacency.md");
    const content = await readFile(kbPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [stack, alts] = trimmed.split(":");
      if (stack && alts) {
        stackAdjacency.set(
          stack.trim().toLowerCase(),
          alts.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean),
        );
      }
    }
    console.log(`[Perplexity] Loaded stack adjacency: ${stackAdjacency.size} entries`);
  } catch (err) {
    console.error("[Perplexity] Failed to load stack-adjacency.md:", err);
  }
  return stackAdjacency;
}

// --- Role-based fallback stacks ---

const ROLE_FALLBACK_MAP: Array<{ pattern: RegExp; stacks: string[] }> = [
  { pattern: /backend|server|api/,           stacks: ["python", "go", "java"] },
  { pattern: /frontend|web|ui/,              stacks: ["react", "typescript"] },
  { pattern: /mobile|ios|android/,           stacks: ["swift", "kotlin"] },
  { pattern: /devops|sre|platform|infra/,    stacks: ["python", "go"] },
  { pattern: /data|analyst|engineer|bi|etl/, stacks: ["python", "sql"] },
  { pattern: /ml|machine learning|ai/,       stacks: ["python"] },
  { pattern: /qa|test|quality/,              stacks: ["python", "java"] },
];
const DEFAULT_FALLBACK = ["python", "java"];

function getRoleFallbackStacks(role: string, currentStack: string): string[] {
  const lower = role.toLowerCase();
  for (const { pattern, stacks } of ROLE_FALLBACK_MAP) {
    if (pattern.test(lower)) {
      return stacks.filter((s) => s !== currentStack);
    }
  }
  return DEFAULT_FALLBACK.filter((s) => s !== currentStack);
}

// --- Title parsing ---

function extractRole(title: string): string {
  const lower = title.toLowerCase();
  const words = lower.split(/[\s/]+/);
  const roleWords: string[] = [];

  for (const word of words) {
    const clean = word.replace(/[(),]/g, "");
    if (KNOWN_STACKS.has(clean)) break;
    if (ROLE_STOP_WORDS.has(clean) && roleWords.length > 0) break;
    if (clean) roleWords.push(clean);
  }

  return roleWords.join(" ") || lower.split(/\s+/).slice(0, 2).join(" ");
}

function extractStacks(title: string): string[] {
  const lower = title.toLowerCase();
  const found: string[] = [];
  for (const stack of KNOWN_STACKS) {
    const escaped = stack.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[\\s(/,])${escaped}(?:$|[\\s)/,])`, "i").test(lower)) {
      found.push(stack);
    }
  }
  return found;
}

function extractDomain(title: string, role: string, stacks: string[]): string | null {
  let remainder = title.toLowerCase();
  remainder = remainder.replace(new RegExp(`\\b${role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`), "");
  for (const s of stacks) {
    remainder = remainder.replace(new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`), "");
  }
  for (const w of ROLE_STOP_WORDS) {
    remainder = remainder.replace(new RegExp(`\\b${w}\\b`, "g"), "");
  }
  remainder = remainder.replace(/[(),\->/]+/g, " ").replace(/\s+/g, " ").trim();
  return remainder.length > 1 ? remainder : null;
}

const REGION_LABELS: Record<string, string> = {
  eu: "European Union (remote)",
  us: "United States",
  uk: "United Kingdom",
  ru: "Russia / CIS",
  latam: "Latin America",
  "asia-pacific": "Asia-Pacific (Singapore, Malaysia, Australia, Japan)",
  "middle-east": "Middle East (UAE, Saudi Arabia)",
  global: "Global (remote)",
};

function buildSearchKeys(
  directions: Direction[],
  regions: string[],
): SearchKey[] {
  const keys: SearchKey[] = [];
  const seen = new Set<string>();

  for (const dir of directions) {
    const role = extractRole(dir.title);
    const stacks = extractStacks(dir.title);
    const domain = extractDomain(dir.title, role, stacks);

    for (const region of regions) {
      if (stacks.length === 0) {
        const baseKey = `${role}:${region}`;
        if (!seen.has(baseKey)) {
          seen.add(baseKey);
          keys.push({
            role, stack: null, domain: null, region,
            cacheKey: baseKey,
            label: role,
            level: "base",
          });
        }
        if (domain) {
          const nicheKey = `${role} ${domain}:${region}`;
          if (!seen.has(nicheKey)) {
            seen.add(nicheKey);
            keys.push({
              role, stack: null, domain, region,
              cacheKey: nicheKey,
              label: `${role} ${domain}`,
              level: "niche",
            });
          }
        }
      } else {
        for (const stack of stacks) {
          const baseKey = `${role} ${stack}:${region}`;
          if (!seen.has(baseKey)) {
            seen.add(baseKey);
            keys.push({
              role, stack, domain: null, region,
              cacheKey: baseKey,
              label: `${role} ${stack}`,
              level: "base",
            });
          }
          if (domain) {
            const nicheKey = `${role} ${stack} ${domain}:${region}`;
            if (!seen.has(nicheKey)) {
              seen.add(nicheKey);
              keys.push({
                role, stack, domain, region,
                cacheKey: nicheKey,
                label: `${role} ${stack} ${domain}`,
                level: "niche",
              });
            }
          }
        }
      }
    }
  }

  return keys;
}

// --- Perplexity API ---

const MARKET_RESEARCH_SCHEMA = {
  type: "object" as const,
  properties: {
    vacancyCount: { type: "string" as const, description: "Число вакансий в регионе (с указанием источника)" },
    specialistCount: { type: "string" as const, description: "Примерное число специалистов в регионе" },
    marketWidth: { type: "string" as const, enum: ["широкий", "средний", "нишевый"] },
    dynamics: { type: "string" as const, description: "Растёт/стабильно/падает + % за 1-2 года" },
    competition: { type: "string" as const, description: "Уровень конкуренции" },
    vacanciesPer100Specialists: { type: "number" as const, description: "Вакансий на 100 специалистов" },
    salaryRange: { type: "string" as const, description: "Зарплатная вилка junior/middle/senior в целевой валюте" },
    aiRisk: { type: "string" as const, enum: ["низкий", "средний", "средний-высокий", "высокий"] },
    aiRiskExplanation: { type: "string" as const },
    forecast: { type: "string" as const, description: "Прогноз на 2026-2030" },
    employers: { type: "array" as const, items: { type: "string" as const }, description: "Топ-5 типичных работодателей" },
    keySkills: { type: "array" as const, items: { type: "string" as const }, description: "Ключевые навыки в вакансиях" },
    dataSource: { type: "string" as const, description: "Основной источник данных (itjobswatch, hh.ru и т.д.)" },
    bestSearchTitle: { type: "string" as const, description: "Тайтл с максимумом вакансий" },
  },
  required: [
    "vacancyCount", "salaryRange", "competition",
    "vacanciesPer100Specialists", "dynamics", "aiRisk", "forecast",
  ],
};

function buildSourceAwarePrompt(key: SearchKey): string {
  const regionConfig = REGIONS[key.region];
  const regionLabel = REGION_LABELS[key.region] || key.region;

  if (!regionConfig) {
    return (
      `Актуальные данные рынка труда для роли "${key.label}" в регионе ${regionLabel}, 2026 год. ` +
      `Используй реальные данные с job-бордов и аналитических отчётов. ` +
      `Ответь строго в JSON по указанной схеме.`
    );
  }

  const boards = regionConfig.jobBoards.map((b) => `- ${b}`).join("\n");
  const isRu = key.region === "ru";

  if (isRu) {
    return (
      `Актуальные данные рынка труда для роли "${key.label}" в России/СНГ, 2026 год.\n\n` +
      `ОБЯЗАТЕЛЬНО ищи на:\n${boards}\n\n` +
      `Для числа вакансий: зайди на hh.ru/search/vacancy и найди "${key.label}". ` +
      `Укажи ТОЧНОЕ число вакансий с hh.ru и дату запроса.\n` +
      `Для конкуренции: используй hh.ru индекс рынка IT — соотношение вакансий к резюме.\n` +
      `Для зарплат: hh.ru аналитика + Хабр Карьера.\n\n` +
      `Также укажи bestSearchTitle — какой тайтл на hh.ru даёт максимум вакансий.\n\n` +
      `ПРАВИЛА: указывай ТОЛЬКО проверяемые данные. Если не нашёл — пиши "данные недоступны".\n` +
      `Ответь строго в JSON по указанной схеме.`
    );
  }

  const salaryRef = regionConfig.salarySource
    ? `\nДля зарплат кросс-проверь с ${regionConfig.salarySource}.`
    : "";

  return (
    `Current IT job market data for "${key.label}" in ${regionLabel}, 2026.\n\n` +
    `SEARCH THESE SPECIFIC SOURCES:\n${boards}\n` +
    `- Reference baseline: itjobswatch.co.uk (for title variations and UK vacancy counts)\n` +
    `${salaryRef}\n\n` +
    `${regionConfig.extra || ""}\n\n` +
    `For vacancy counts: search ${regionConfig.jobBoards[0]} for "${key.label}" and report the actual number.\n` +
    `For bestSearchTitle: check itjobswatch.co.uk — which title/keyword gives the MOST vacancies? ` +
    `(e.g., "DevOps" gives 1,380 vs "DevOps Engineer" gives 224).\n\n` +
    `RULES: Only report verifiable data. If unavailable, say "data not available".\n` +
    `Respond strictly in JSON per the schema.`
  );
}

async function callSonarPro(key: SearchKey): Promise<{ data: MarketResearchResult; citations: string[] }> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("PERPLEXITY_API_KEY not set");

  const query = buildSourceAwarePrompt(key);

  const response = await fetch(SONAR_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: SONAR_MODEL,
      messages: [{ role: "user", content: query }],
      response_format: {
        type: "json_schema",
        json_schema: { schema: MARKET_RESEARCH_SCHEMA },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Perplexity API ${response.status}: ${text}`);
  }

  const json = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    citations?: string[];
  };

  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty Perplexity response");

  const data = JSON.parse(content) as MarketResearchResult;
  const citations = json.citations || [];

  return { data, citations };
}

// --- Main function ---

export async function fetchMarketDataForDirections(
  directions: Direction[],
  profile: CandidateProfile,
): Promise<PerplexityMarketResult> {
  // Источник правды — `accessibleMarkets` (whitelist, вычисленный
  // `computeAccessibleMarkets` с учётом физ. локации + паспортов +
  // английского). Раньше брали `targetMarketRegions` — это открывало
  // USD-запросы для клиентов, физически вне США, которые просто
  // мечтали работать на US-рынке. Perplexity возвращал US-вилки,
  // модель встраивала их в финальный документ → клиент получал
  // недостижимую картину рынка.
  const accessible = profile.barriers.accessibleMarkets ?? [];
  // Fallback на targetMarketRegions — только если computeAccessibleMarkets
  // вообще не был вызван (старые state-ы). Даже тогда не даём `us`
  // автоматом — он требует физ. локации, которую мы здесь не знаем.
  const regions =
    accessible.length > 0
      ? accessible
      : (profile.careerGoals.targetMarketRegions ?? []).filter(
          (r) => r !== "us",
        );
  if (!regions || regions.length === 0) {
    throw new Error("No accessibleMarkets (or fallback targetMarketRegions) in profile");
  }

  const allKeys = buildSearchKeys(directions, regions);

  const toFetch: SearchKey[] = [];
  const cached: Map<string, CacheEntry> = new Map();
  let cacheHits = 0;

  for (const key of allKeys) {
    const entry = getCached(key.cacheKey);
    if (entry) {
      cached.set(key.cacheKey, entry);
      cacheHits++;
    } else {
      toFetch.push(key);
    }
  }

  console.log(
    `[Perplexity] ${allKeys.length} search keys: ${cacheHits} cache hits, ${toFetch.length} to fetch`,
  );

  if (toFetch.length > 0) {
    const results = await Promise.all(
      toFetch.map(async (key) => {
        try {
          console.log(`[Perplexity] Fetching: ${key.cacheKey}`);
          const result = await callSonarPro(key);
          setCache(key.cacheKey, result.data, result.citations);
          cached.set(key.cacheKey, {
            data: result.data,
            citations: result.citations,
            fetchedAt: new Date().toISOString(),
          });
          return { key, success: true };
        } catch (err) {
          console.error(`[Perplexity] Failed for ${key.cacheKey}:`, err);
          return { key, success: false };
        }
      }),
    );
    const failed = results.filter((r) => !r.success).length;
    if (failed > 0) console.warn(`[Perplexity] ${failed}/${toFetch.length} queries failed`);
  }

  // Check base results for low vacancy counts -> fetch adjacent stacks
  const adjacency = await getStackAdjacency();
  const adjacentKeys: SearchKey[] = [];
  const seenAdjacent = new Set(allKeys.map((k) => k.cacheKey));

  for (const key of allKeys) {
    if (key.level !== "base" || !key.stack) continue;
    const entry = cached.get(key.cacheKey);
    if (!entry) continue;

    const vacCount = parseInt(entry.data.vacancyCount.replace(/[^\d]/g, ""), 10);
    if (isNaN(vacCount) || vacCount >= LOW_VACANCY_THRESHOLD) continue;

    const alts = adjacency.get(key.stack) || getRoleFallbackStacks(key.role, key.stack);
    if (alts.length === 0) continue;

    console.log(
      `[Perplexity] ${key.label} has ${vacCount} vacancies (< ${LOW_VACANCY_THRESHOLD}), checking adjacent: ${alts.join(", ")}`,
    );

    for (const alt of alts) {
      const adjKey: SearchKey = {
        role: key.role,
        stack: alt,
        domain: null,
        region: key.region,
        cacheKey: `${key.role} ${alt}:${key.region}`,
        label: `${key.role} ${alt}`,
        level: "adjacent",
      };
      if (!seenAdjacent.has(adjKey.cacheKey)) {
        seenAdjacent.add(adjKey.cacheKey);
        const adjCached = getCached(adjKey.cacheKey);
        if (adjCached) {
          cached.set(adjKey.cacheKey, adjCached);
        } else {
          adjacentKeys.push(adjKey);
        }
      }
    }
  }

  if (adjacentKeys.length > 0) {
    console.log(`[Perplexity] Fetching ${adjacentKeys.length} adjacent stack queries`);
    await Promise.all(
      adjacentKeys.map(async (key) => {
        try {
          console.log(`[Perplexity] Fetching adjacent: ${key.cacheKey}`);
          const result = await callSonarPro(key);
          setCache(key.cacheKey, result.data, result.citations);
          cached.set(key.cacheKey, {
            data: result.data,
            citations: result.citations,
            fetchedAt: new Date().toISOString(),
          });
        } catch (err) {
          console.error(`[Perplexity] Failed adjacent ${key.cacheKey}:`, err);
        }
      }),
    );
    allKeys.push(...adjacentKeys);
  }

  return formatMarketData(directions, regions, allKeys, cached);
}

// --- Formatting ---

function formatEntry(data: MarketResearchResult): string {
  const lines: string[] = [];
  lines.push(`- Вакансии: ${data.vacancyCount}`);
  if (data.specialistCount) lines.push(`- Специалисты: ${data.specialistCount}`);
  if (data.marketWidth) lines.push(`- Ширина рынка: ${data.marketWidth}`);
  lines.push(`- Конкуренция: ${data.competition} (${data.vacanciesPer100Specialists} вак/100 спец.)`);
  lines.push(`- Зарплата: ${data.salaryRange}`);
  lines.push(`- Динамика: ${data.dynamics}`);
  lines.push(`- AI-риск: ${data.aiRisk}${data.aiRiskExplanation ? ` — ${data.aiRiskExplanation}` : ""}`);
  if (data.employers?.length) lines.push(`- Работодатели: ${data.employers.join(", ")}`);
  if (data.keySkills?.length) lines.push(`- Ключевые навыки: ${data.keySkills.join(", ")}`);
  lines.push(`- Прогноз: ${data.forecast}`);
  return lines.join("\n");
}

function formatMarketData(
  directions: Direction[],
  regions: string[],
  allKeys: SearchKey[],
  entries: Map<string, CacheEntry>,
): PerplexityMarketResult {
  const rawData: PerplexityMarketResult["rawData"] = [];
  const sections: string[] = [];
  sections.push("## Рыночные данные (Perplexity Sonar Pro, " + new Date().toLocaleDateString("ru-RU", { month: "long", year: "numeric" }) + ")\n");

  for (const dir of directions) {
    const role = extractRole(dir.title);
    const stacks = extractStacks(dir.title);
    const domain = extractDomain(dir.title, role, stacks);
    const dirResults: PerplexityMarketResult["rawData"][0]["results"] = [];

    for (const region of regions) {
      const regionLabel = REGION_LABELS[region] || region;
      sections.push(`### ${dir.title} (${regionLabel})\n`);

      const regionKeys = allKeys.filter((k) => k.region === region);

      // Base results
      const baseKeys = regionKeys.filter(
        (k) => k.level === "base" && k.role === role &&
          (stacks.length === 0 ? !k.stack : stacks.includes(k.stack!)),
      );

      if (baseKeys.length > 0) {
        sections.push(stacks.length > 1 ? "Основные стеки:" : "Базовый рынок:");
        for (const bk of baseKeys) {
          const entry = entries.get(bk.cacheKey);
          if (!entry) continue;
          sections.push(stacks.length > 1 ? `\n**${bk.stack?.toUpperCase()}:**` : "");
          sections.push(formatEntry(entry.data));
          dirResults.push({ key: bk, data: entry.data, citations: entry.citations });
        }
      }

      // Niche results
      if (domain) {
        const nicheKeys = regionKeys.filter(
          (k) => k.level === "niche" && k.role === role && k.domain === domain,
        );
        if (nicheKeys.length > 0) {
          sections.push(`\nНишевый рынок (${domain}):`);
          for (const nk of nicheKeys) {
            const entry = entries.get(nk.cacheKey);
            if (!entry) continue;
            if (nk.stack && stacks.length > 1) sections.push(`\n**${nk.stack.toUpperCase()}:**`);
            sections.push(formatEntry(entry.data));
            dirResults.push({ key: nk, data: entry.data, citations: entry.citations });
          }
        }
      }

      // Adjacent results
      const adjKeys = regionKeys.filter(
        (k) => k.level === "adjacent" && k.role === role,
      );
      if (adjKeys.length > 0) {
        const adjWithData = adjKeys.filter((k) => entries.has(k.cacheKey));
        if (adjWithData.length > 0) {
          sections.push("\nСмежные стеки (основной рынок узкий, < 500 вакансий):");
          for (const ak of adjWithData) {
            const entry = entries.get(ak.cacheKey)!;
            sections.push(`\n**${ak.stack?.toUpperCase()}:**`);
            sections.push(formatEntry(entry.data));
            dirResults.push({ key: ak, data: entry.data, citations: entry.citations });
          }
        }
      }

      sections.push("");
    }

    rawData.push({ directionTitle: dir.title, results: dirResults });
  }

  return {
    formattedText: sections.join("\n"),
    rawData,
  };
}
