/**
 * Phase 1.3 of the ideal-resume pipeline: compress raw text from
 * `app/data/resume_helpers_raw/<slug>/*.txt` into a small JSON "playbook"
 * per canonical slug.
 *
 * Output: `app/data/role_resume_patterns/<slug>.json` (committed to repo).
 * Schema: `schemas/role-resume-pattern.ts`.
 *
 * Cost model (Claude Sonnet, ~50 KB input + ~5 KB output per slug):
 *   ~$0.05 per slug × 22 slugs ≈ $1.10 total.
 *
 * Usage:
 *   npm run build:role-patterns                  # process missing slugs only
 *   npm run build:role-patterns -- --force       # rebuild all
 *   npm run build:role-patterns -- --slug devops # one slug only
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { roleResumePatternSchema, type RoleResumePattern } from "../schemas/role-resume-pattern.js";
import type { KnownRoleSlug } from "../services/known-roles.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = join(__dirname, "..", "..", "data", "resume_helpers_raw");
const OUT_DIR = join(__dirname, "..", "..", "data", "role_resume_patterns");
const MARKET_INDEX_PATH = join(__dirname, "..", "..", "data", "market-index.json");

const MODEL = process.env.ROLE_PATTERN_MODEL || "claude-sonnet-4-20250514";
const MAX_OUTPUT_TOKENS = 6000;
const MAX_RAW_CHARS_PER_FILE = 6000;

const args = process.argv.slice(2);
const force = args.includes("--force");
const slugFilterIdx = args.indexOf("--slug");
const slugFilter = slugFilterIdx >= 0 ? args[slugFilterIdx + 1] : null;

interface MarketEntry {
  displayTitle?: string;
  category?: string;
}

async function loadDisplayTitle(slug: string): Promise<string> {
  try {
    const raw = await readFile(MARKET_INDEX_PATH, "utf-8");
    const data: Record<string, MarketEntry> = JSON.parse(raw);
    const root = (data as { roles?: Record<string, MarketEntry> }).roles ?? data;
    return root[slug]?.displayTitle ?? slug;
  } catch {
    return slug;
  }
}

function buildPrompt(slug: string, displayTitle: string, count: number): string {
  return `Ты — эксперт по составлению IT-резюме и автор курсов по карьере.
Тебе дан корпус из ${count} ЛУЧШИХ российских резюме на роль "${displayTitle}" (slug: ${slug}) с HeadHunter.

Твоя задача: проанализируй их и выпиши общие паттерны, по которым отличается СИЛЬНОЕ резюме на эту роль. Ответ нужен в виде строгого JSON для последующего использования при автогенерации идеального резюме.

ТРЕБОВАНИЯ К JSON:
- typicalTitles: 5-8 наиболее частых вариантов должности (с уровнями — Junior/Middle/Senior/Lead если уместно)
- summaryPatterns: 3-5 коротких summary (1-2 предложения каждый, ОБЯЗАТЕЛЬНО с метриками — годами опыта, цифрами достижений, размерами команд/нагрузок). На английском, в стиле "I'm a … (N+ years), built …"
- skillCategories: МАССИВ объектов вида [{"category": "Infrastructure & Cloud", "items": ["AWS", "Azure", ...]}, ...] (НЕ объект-словарь!). 5-10 категорий, в каждой 5-15 конкретных технологий/инструментов. Категории должны быть осмысленные (не "Other"), например для DevOps: "Infrastructure & Cloud", "Containers & Orchestration", "CI/CD", "Observability", "DevSecOps", "Scripting"
- achievementPhrases: 8-20 типичных формулировок достижений С ЦИФРАМИ. Английский. Образцы: "Reduced infrastructure costs by 40%", "Built CI/CD pipeline serving 50+ engineers", "Decreased MTTD from hours to <5 minutes"
- keyResponsibilities: 5-10 типичных обязанностей (без цифр, более общие)
- certifications: популярные сертификации (если для роли актуальны, иначе пустой массив)
- popularIndustries: типичные отрасли работодателей (например "fintech", "e-commerce", "telecom")
- redFlags: 3-7 вещей, которые делают резюме слабее (не ставить в генерируемое резюме). Например "ставить общие фразы без цифр", "перечислять более 30 технологий"
- notes: общая заметка о специфике этой роли (5-15 строк, по-русски)

ВАЖНО:
- Только JSON, без markdown wrapper, без комментариев
- Все строки на английском, КРОМЕ notes (русский)
- Не выдумывай — опирайся на корпус
- Цифры в achievementPhrases — реальные из корпуса (можно округлять: 5x, 40%, 50+)`;
}

function buildCorpus(texts: { name: string; text: string }[]): string {
  const parts: string[] = [];
  texts.forEach((t, i) => {
    const truncated = t.text.length > MAX_RAW_CHARS_PER_FILE
      ? t.text.slice(0, MAX_RAW_CHARS_PER_FILE) + "\n\n[truncated…]"
      : t.text;
    parts.push(`--- RESUME ${i + 1} (${t.name}) ---\n${truncated}`);
  });
  return parts.join("\n\n");
}

async function processSlug(slug: KnownRoleSlug): Promise<void> {
  const slugDir = join(RAW_DIR, slug);
  if (!existsSync(slugDir)) {
    console.warn(`  no raw dir for ${slug}, skipping`);
    return;
  }
  const files = (await readdir(slugDir))
    .filter((f) => f.endsWith(".txt"))
    .sort();
  if (files.length === 0) {
    console.warn(`  no .txt files for ${slug}, skipping`);
    return;
  }

  const outPath = join(OUT_DIR, `${slug}.json`);
  if (!force && existsSync(outPath)) {
    console.log(`  ${slug}: already exists, skip (use --force to rebuild)`);
    return;
  }

  const displayTitle = await loadDisplayTitle(slug);
  const corpus: { name: string; text: string }[] = [];
  for (const f of files) {
    const txt = await readFile(join(slugDir, f), "utf-8");
    corpus.push({ name: f, text: txt });
  }

  const prompt = buildPrompt(slug, displayTitle, corpus.length);
  const corpusText = buildCorpus(corpus);

  console.log(
    `  ${slug}: ${corpus.length} resumes, ${(corpusText.length / 1024).toFixed(0)} KB → calling ${MODEL}…`,
  );

  const client = new Anthropic();
  const t0 = Date.now();
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [
      {
        role: "user",
        content: `${prompt}\n\nКОРПУС РЕЗЮМЕ:\n\n${corpusText}`,
      },
    ],
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  const block = resp.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error(`No text block in response for ${slug}`);
  }
  let raw = block.text.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    const errPath = join(OUT_DIR, `${slug}.error.txt`);
    await writeFile(errPath, raw, "utf-8");
    throw new Error(
      `JSON parse failed for ${slug}: ${err instanceof Error ? err.message : String(err)} (raw saved to ${errPath})`,
    );
  }

  // LLMs sometimes return skillCategories as a {category: items[]} dict
  // instead of [{category, items}] — normalise.
  if (
    parsed.skillCategories &&
    typeof parsed.skillCategories === "object" &&
    !Array.isArray(parsed.skillCategories)
  ) {
    parsed.skillCategories = Object.entries(
      parsed.skillCategories as Record<string, unknown>,
    ).map(([category, items]) => ({
      category,
      items: Array.isArray(items)
        ? (items as unknown[]).map((x) => String(x))
        : typeof items === "string"
          ? items.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
          : [],
    }));
  }

  const enriched = {
    typicalTitles: [],
    summaryPatterns: [],
    skillCategories: [],
    achievementPhrases: [],
    keyResponsibilities: [],
    certifications: [],
    popularIndustries: [],
    redFlags: [],
    notes: "",
    ...(parsed as Partial<RoleResumePattern>),
    slug,
    displayTitle,
    builtAt: new Date().toISOString(),
    sourceCount: corpus.length,
  };

  const validated = roleResumePatternSchema.parse(enriched);
  await writeFile(outPath, JSON.stringify(validated, null, 2), "utf-8");
  console.log(
    `  ${slug}: ✓ saved (${(JSON.stringify(validated).length / 1024).toFixed(1)} KB, ${dt}s, in=${resp.usage.input_tokens} out=${resp.usage.output_tokens})`,
  );
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const allSlugs = await readdir(RAW_DIR);
  let slugs = allSlugs.filter((s) => !s.startsWith("."));
  if (slugFilter) {
    slugs = slugs.filter((s) => s === slugFilter);
    if (slugs.length === 0) {
      throw new Error(`No raw data for slug "${slugFilter}"`);
    }
  }
  slugs.sort();

  console.log(`Building role patterns for ${slugs.length} slug(s):\n`);

  let okCount = 0;
  let failCount = 0;
  for (const slug of slugs) {
    try {
      await processSlug(slug as KnownRoleSlug);
      okCount += 1;
    } catch (err) {
      failCount += 1;
      console.error(`  ${slug}: ✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nDone. ok=${okCount} failed=${failCount}`);
  console.log(`Output: ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
