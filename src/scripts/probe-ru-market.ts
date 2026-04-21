/**
 * Сборщик ру-рынка для одной роли. Сохраняет в app/src/prompts/market-data/hh-{slug}.md.
 *
 *   - Число вакансий: hh.ru HTML (work_format=REMOTE).
 *     Каждый вариант — broad-запрос (search_field=name+company_name+description),
 *     потому что именно по этим полям hh скринит резюме при поиске работодателем.
 *
 *   - Зарплаты: career.habr.com JSON API
 *       * locations[]=c_678 (Москва)
 *       * spec_aliases[] (массивная форма обязательна!)
 *       * skills[] (опционально — фильтр по языку/фреймворку)
 *     В колонку «ЗП Москва (Middle)» кладём median Middle (=3-6 лет).
 *
 * Защита от silent-fallback: если Хабр вернул title "По всем IT-специалистам ..."
 * это значит, что spec_alias не распознан и пришла общая статистика — тогда
 * считаем зарплату недоступной (Habr column = "—").
 *
 * Usage:
 *   # 1) роль с точным habr-алиасом, без skill-фильтра:
 *   npx tsx src/scripts/probe-ru-market.ts --spec=devops --out=devops-engineer \
 *     "DevOps инженер" "DevOps engineer" "DevOps"
 *
 *   # 2) роль через spec+skill (бэкенд + python):
 *   npx tsx src/scripts/probe-ru-market.ts --spec=backend --skill=python --out=backend-developer-python \
 *     "Python разработчик" "Python developer"
 *
 *   # 3) "размытая" роль с фильтром IT-отрасли (project manager):
 *   npx tsx src/scripts/probe-ru-market.ts --spec=project_manager --it --out=project-manager \
 *     "Менеджер проектов" "Project Manager" "Проектный менеджер"
 *
 *   # 4) роль без habr-алиаса (только hh-вакансии):
 *   npx tsx src/scripts/probe-ru-market.ts --no-habr --out=mlops-engineer \
 *     "MLOps инженер" "MLOps Engineer" "MLOps"
 */

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
};

const API_HEADERS = {
  "User-Agent": BROWSER_HEADERS["User-Agent"],
  "Accept": "application/json",
};

const MOSCOW_LOCATION_ID = "c_678";
const IT_INDUSTRY_ID = "7";
const HABR_FALLBACK_TITLE_RE = /^По всем IT-специалистам\b/;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function sleepJitter(baseMs: number, jitterMs: number) {
  return sleep(baseMs + Math.floor(Math.random() * jitterMs));
}

// ---------- hh.ru ----------

interface HhCount {
  title: string;
  scope: "broad" | "name";
  count: number | null;
  url: string;
}

interface HhOpts {
  scope: "broad" | "name";
  industry?: string;
}

function buildHhUrl(text: string, opts: HhOpts): string {
  const u = new URL("https://hh.ru/search/vacancy");
  u.searchParams.set("text", text);
  if (opts.scope === "broad") {
    u.searchParams.append("search_field", "name");
    u.searchParams.append("search_field", "company_name");
    u.searchParams.append("search_field", "description");
  } else {
    u.searchParams.append("search_field", "name");
  }
  u.searchParams.set("work_format", "REMOTE");
  u.searchParams.set("enable_snippets", "false");
  if (opts.industry) u.searchParams.set("industry", opts.industry);
  return u.toString();
}

async function fetchHhCountOnce(
  text: string,
  opts: HhOpts,
): Promise<{ count: number | null; url: string; status: number | null }> {
  const url = buildHhUrl(text, opts);
  try {
    const resp = await fetch(url, { headers: BROWSER_HEADERS });
    if (!resp.ok) {
      return { count: null, url, status: resp.status };
    }
    const html = await resp.text();
    const m = html.match(/Найден[оаы]?\s+([\d\s\u00A0]+)\s+ваканс/);
    if (!m) {
      if (/Не\s+найдено\s+вакансий/.test(html)) return { count: 0, url, status: 200 };
      return { count: null, url, status: 200 };
    }
    return { count: parseInt(m[1].replace(/[\s\u00A0]/g, ""), 10), url, status: 200 };
  } catch (err) {
    console.warn(`  [hh] network error for "${text}":`, err);
    return { count: null, url, status: null };
  }
}

async function fetchHhCount(
  text: string,
  opts: HhOpts,
): Promise<{ count: number | null; url: string }> {
  let res = await fetchHhCountOnce(text, opts);
  const isRetriable =
    res.count === null &&
    (res.status === null || res.status === 403 || res.status === 502 || res.status === 429);
  if (isRetriable) {
    const reason = res.status === null ? "network error" : `status ${res.status}`;
    console.warn(`  [hh] ${reason} for "${text}", retry after 15s ...`);
    await sleep(15000);
    res = await fetchHhCountOnce(text, opts);
    if (res.count === null) {
      console.warn(`  [hh] retry failed for "${text}" (status ${res.status})`);
    }
  } else if (res.count === null && res.status !== null) {
    console.warn(`  [hh] ${res.status} for "${text}" (no retry)`);
  }
  return { count: res.count, url: res.url };
}

async function collectHh(
  variants: string[],
  itOnly: boolean,
): Promise<HhCount[]> {
  const industry = itOnly ? IT_INDUSTRY_ID : undefined;
  const results: HhCount[] = [];

  // Дедуп по token-set — hh регистронезависим и не учитывает порядок слов
  // в broad-поиске, так что "Java backend" / "Backend Java" / "backend java"
  // дают одинаковое число. Берём первую формулировку из группы.
  const seen = new Set<string>();
  const unique = variants.filter((v) => {
    const k = v.toLowerCase().split(/\s+/).filter(Boolean).sort().join(" ");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Все варианты — broad search (name+company+description). Соискателю
  // важно знать, в скольких вакансиях слово/фраза вообще встречается
  // (где hh скринит резюме), а не только в названии вакансии.
  for (const q of unique) {
    console.log(`[hh] broad: "${q}" ${itOnly ? "(IT)" : ""} ...`);
    const r = await fetchHhCount(q, { scope: "broad", industry });
    results.push({ title: q, scope: "broad", ...r });
    // 15±5 сек между запросами — чтобы hh не словил rate-limit/ban.
    await sleepJitter(15000, 5000);
  }
  return results;
}

// ---------- Хабр Карьера: зарплаты по Москве ----------

interface HabrGroup {
  name: string;
  median: number;
  total: number;
  title?: string;
}

interface HabrResult {
  groups: HabrGroup[];
  isFallback: boolean; // true => spec_alias не найден, пришла общая статистика
  url: string;
  resolvedTitle: string | null;
}

async function fetchHabrMoscow(
  specAlias: string,
  skill?: string,
): Promise<HabrResult> {
  const u = new URL(
    "https://career.habr.com/api/frontend_v1/salary_calculator/general_graph",
  );
  // ВАЖНО: spec_aliases[] и skills[] — массивная форма, иначе Хабр игнорирует параметры.
  u.searchParams.append("spec_aliases[]", specAlias);
  u.searchParams.append("locations[]", MOSCOW_LOCATION_ID);
  if (skill) u.searchParams.append("skills[]", skill);
  const url = u.toString();

  let json: { groups: HabrGroup[] } | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetch(url, { headers: API_HEADERS });
      if (!resp.ok) throw new Error(`[habr] HTTP ${resp.status}`);
      json = (await resp.json()) as { groups: HabrGroup[] };
      break;
    } catch (err) {
      if (attempt === 2) throw err;
      console.warn(`  [habr] attempt 1 failed (${err}), retry after 5s ...`);
      await sleep(5000);
    }
  }
  if (!json) throw new Error("[habr] no data");

  const all = json.groups.find((g) => g.name === "All");
  const resolvedTitle = all?.title ?? null;
  const isFallback = !!resolvedTitle && HABR_FALLBACK_TITLE_RE.test(resolvedTitle);

  return { groups: json.groups, isFallback, url, resolvedTitle };
}

// ---------- форматирование ----------

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("ru-RU").format(n);
}

function fmtK(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${Math.round(n / 1000)}k ₽`;
}

function buildMainTable(
  rows: HhCount[],
  medianMidSr: number | null,
  itOnly: boolean,
  habrAvailable: boolean,
): string {
  const sorted = [...rows].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const scopeLabel = itOnly ? "РФ remote, IT" : "РФ remote";
  const salaryCell = habrAvailable ? fmtK(medianMidSr) : "—";
  const lines = [
    `| Тайтл | Вакансий (${scopeLabel}) | ЗП Москва net, ₽/мес (avg Mid+Sr) |`,
    "|-------|------------------------:|----------------------------------:|",
  ];
  for (const r of sorted) {
    lines.push(`| ${r.title} | ${fmtNum(r.count)} | ${salaryCell} |`);
  }
  return lines.join("\n");
}

function buildTop3(rows: HhCount[]): string {
  const top = [...rows]
    .filter((r) => (r.count ?? 0) > 0)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .slice(0, 3);
  return top
    .map((r, i) => `${i + 1}. ${r.title} — ${fmtNum(r.count)}`)
    .join("\n");
}

function buildGradeBreakdown(groups: HabrGroup[]): string {
  const order = ["Middle", "Senior", "Lead"];
  const sorted = groups
    .filter((g) => order.includes(g.name))
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return sorted
    .map((g) => `${g.name} ${fmtK(g.median)} (n=${fmtNum(g.total)})`)
    .join(" · ");
}

// ---------- main ----------

interface ParsedArgs {
  spec: string | null;
  skill: string | null;
  variants: string[];
  itOnly: boolean;
  noHabr: boolean;
  outSlug: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  let spec: string | null = null;
  let skill: string | null = null;
  let outSlug: string | null = null;
  let itOnly = false;
  let noHabr = false;
  const variants: string[] = [];

  for (const a of argv) {
    if (a === "--it") itOnly = true;
    else if (a === "--no-habr") noHabr = true;
    else if (a.startsWith("--spec=")) spec = a.slice("--spec=".length);
    else if (a.startsWith("--skill=")) skill = a.slice("--skill=".length);
    else if (a.startsWith("--out=")) outSlug = a.slice("--out=".length);
    else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      variants.push(a);
    }
  }

  if (variants.length === 0) throw new Error("at least one variant is required");
  if (!noHabr && !spec) throw new Error("either --spec=<alias> or --no-habr must be set");
  if (!outSlug) throw new Error("--out=<slug> is required (e.g. --out=devops-engineer)");

  return { spec, skill, variants, itOnly, noHabr, outSlug };
}

async function main() {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err));
    console.error(
      'Usage: npx tsx src/scripts/probe-ru-market.ts --broad="..." [--spec=alias] [--skill=name] [--it] [--no-habr] "<v1>" "<v2>" ...',
    );
    process.exit(1);
  }

  console.log(
    `spec=${args.spec ?? "(none)"}, skill=${args.skill ?? "(none)"}, ` +
      `variants=[${args.variants.join(", ")}], ` +
      `itOnly=${args.itOnly}, noHabr=${args.noHabr}, out=${args.outSlug}\n`,
  );

  console.log("=== hh.ru ===");
  const hhRows = await collectHh(args.variants, args.itOnly);

  let medianMidSr: number | null = null;
  let habrGroups: HabrGroup[] = [];
  let habrAvailable = false;
  let habrNote = "";

  if (!args.noHabr && args.spec) {
    console.log("\n=== habr (Москва) ===");
    try {
      const habr = await fetchHabrMoscow(args.spec, args.skill ?? undefined);
      console.log(`  url: ${habr.url}`);
      console.log(`  resolved title: ${habr.resolvedTitle}`);
      if (habr.isFallback) {
        habrNote =
          `⚠️ Хабр не нашёл spec_alias "${args.spec}" — вернул общую статистику IT. ` +
          `Зарплата по этой роли через Хабр недоступна.`;
        console.warn(`  ${habrNote}`);
      } else {
        habrGroups = habr.groups;
        const middle = habrGroups.find((g) => g.name === "Middle");
        const senior = habrGroups.find((g) => g.name === "Senior");
        if (middle && senior) {
          medianMidSr = Math.round((middle.median + senior.median) / 2);
          habrAvailable = true;
        } else {
          habrNote = "⚠️ В ответе Хабра нет грейдов Middle и/или Senior";
        }
      }
    } catch (err) {
      habrNote = `⚠️ Хабр API ошибка: ${err}`;
      console.warn(`  ${habrNote}`);
    }
  }

  const today = new Date().toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const sources: string[] = [`hh.ru HTML (work_format=REMOTE, search по name+company+description${args.itOnly ? ", industry=7" : ""})`];
  if (args.spec) {
    sources.push(
      `career.habr.com API (locations[]=c_678 Москва, spec_aliases[]=${args.spec}` +
        `${args.skill ? `, skills[]=${args.skill}` : ""})`,
    );
  }

  const md = [
    `# ${args.outSlug} — hh.ru + habr`,
    "",
    `Дата: ${today}`,
    `Источники:`,
    ...sources.map((s) => `- ${s}`),
    "",
    buildMainTable(hhRows, medianMidSr, args.itOnly, habrAvailable),
    "",
    "**Топ-3 формулировки (по числу вакансий):**",
    buildTop3(hhRows),
  ];
  if (habrAvailable && habrGroups.length > 0) {
    md.push("", `**По грейдам (Москва):** ${buildGradeBreakdown(habrGroups)}`);
  }
  if (habrNote) {
    md.push("", `_${habrNote}_`);
  }

  const text = md.join("\n");
  console.log("\n" + "=".repeat(60));
  console.log(text);

  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, "..", "prompts", "market-data");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `hh-${args.outSlug}.md`);
  await writeFile(outPath, text + "\n", "utf-8");
  console.log(`\n[saved] ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
