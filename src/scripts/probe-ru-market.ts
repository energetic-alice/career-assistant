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
  const order = ["Junior", "Middle", "Senior", "Lead"];
  const sorted = groups
    .filter((g) => order.includes(g.name) && g.total > 0)
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return sorted
    .map((g) => `${g.name} ${fmtK(g.median)} (n=${fmtNum(g.total)})`)
    .join(" · ");
}

/**
 * Выбор "репрезентативной" Mid+Sr медианы из habr-грейдов с фолбэками для
 * мелких ниш (Ruby / Rust / React Native / Unity и пр.), где одного из грейдов
 * может просто не быть. Возвращает значение + откуда оно взято.
 *
 * Приоритет:
 *   1. avg(Middle, Senior)           — идеал
 *   2. Middle only | Senior only     — если один грейд пустой
 *   3. Lead × 0.8                    — Lead обычно выше Senior
 *   4. Junior × 1.3                  — Junior обычно ниже Middle
 *   5. All (proxy)                   — медиана по всем грейдам
 */
function pickHabrMedian(
  groups: HabrGroup[],
): { value: number; source: string; quality: "ideal" | "partial" | "proxy" } | null {
  const by: Record<string, HabrGroup> = {};
  for (const g of groups) if (g.total > 0) by[g.name] = g;
  const { Middle: m, Senior: s, Lead: l, Junior: j, All: a } = by;
  if (m && s) return { value: Math.round((m.median + s.median) / 2), source: "avg(Middle, Senior)", quality: "ideal" };
  if (m) return { value: m.median, source: "Middle only", quality: "partial" };
  if (s) return { value: s.median, source: "Senior only", quality: "partial" };
  if (l) return { value: Math.round(l.median * 0.8), source: "Lead × 0.8", quality: "partial" };
  if (j) return { value: Math.round(j.median * 1.3), source: "Junior × 1.3", quality: "partial" };
  if (a) return { value: a.median, source: "All (proxy)", quality: "proxy" };
  return null;
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

  let habrSkillUsed: string | null = args.skill;

  if (!args.noHabr && args.spec) {
    console.log("\n=== habr (Москва) ===");
    try {
      let habr = await fetchHabrMoscow(args.spec, args.skill ?? undefined);
      console.log(`  url: ${habr.url}`);
      console.log(`  resolved title: ${habr.resolvedTitle}`);
      if (habr.isFallback) {
        habrNote =
          `⚠️ Хабр не нашёл spec_alias "${args.spec}" — вернул общую статистику IT. ` +
          `Зарплата по этой роли через Хабр недоступна.`;
        console.warn(`  ${habrNote}`);
      } else {
        let pick = pickHabrMedian(habr.groups);
        // Если с skill выборка слишком мала, чтобы дать хотя бы Middle или Senior —
        // ретраим без skill. Получим прокси по общему spec, но это лучше, чем дырка.
        if (args.skill && (!pick || pick.quality !== "ideal")) {
          console.log(`  retry без skill=${args.skill} (выборка ${args.spec}+${args.skill} мала)`);
          await sleep(3000);
          const noSkill = await fetchHabrMoscow(args.spec);
          const pickNoSkill = !noSkill.isFallback ? pickHabrMedian(noSkill.groups) : null;
          // Берём "без skill" только если он даёт лучшее качество, чем первичный.
          const rank = { ideal: 3, partial: 2, proxy: 1 } as const;
          const primRank = pick ? rank[pick.quality] : 0;
          const secRank = pickNoSkill ? rank[pickNoSkill.quality] : 0;
          if (pickNoSkill && secRank > primRank) {
            pick = pickNoSkill;
            habr = noSkill;
            habrSkillUsed = null;
          }
        }
        habrGroups = habr.groups;
        if (pick) {
          medianMidSr = pick.value;
          habrAvailable = true;
          if (pick.quality !== "ideal") {
            const skillNote = habrSkillUsed === null && args.skill ? `, без skill=${args.skill}` : "";
            habrNote = `⚠️ Зарплата — фолбэк по грейдам (${pick.source}${skillNote})`;
            console.warn(`  ${habrNote}`);
          }
        } else {
          habrNote = "⚠️ В ответе Хабра нет данных по грейдам";
          console.warn(`  ${habrNote}`);
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
        `${habrSkillUsed ? `, skills[]=${habrSkillUsed}` : ""})`,
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

  // Sanitize до записи: эти .md подгружаются в LLM-промпты, ё/тире в них
  // учат Claude нашему "плохому" стилю. См. text-sanitize.ts.
  const { sanitizeRussianText } = await import("../services/text-sanitize.js");
  const text = sanitizeRussianText(md.join("\n"));
  console.log("\n" + "=".repeat(60));
  console.log(text);

  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, "..", "prompts", "market-data");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `ru_${args.outSlug}.md`);
  await writeFile(outPath, text + "\n", "utf-8");
  console.log(`\n[saved] ${outPath}`);

  // Snapshot для динамики рынка: пишем по-датно в snapshots/, старые
  // не перезаписываются. buildRu в market-index агрегирует trend из
  // истории snapshot-ов. Первые реальные trend-ы появятся через ~год.
  const snapDir = join(outDir, "snapshots");
  await mkdir(snapDir, { recursive: true });
  const isoDate = new Date().toISOString().slice(0, 10);
  const snapPath = join(snapDir, `ru_${args.outSlug}_${isoDate}.json`);
  const snapshot = {
    date: isoDate,
    slug: args.outSlug,
    topMedianSalary: medianMidSr,
    rows: hhRows
      .filter((r) => r.scope === "broad" && r.count !== null)
      .map((r) => ({ title: r.title, vacancies: r.count ?? 0 })),
  };
  await writeFile(snapPath, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
  console.log(`[snapshot] ${snapPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
