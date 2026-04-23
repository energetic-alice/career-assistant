import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { rankRoles, formatScorerTop20ForPrompt } from "../services/role-scorer.js";
import {
  loadPrompt02,
  renderQuestionnaireForPrompt,
  renderPhase0SlugsHint,
} from "../pipeline/prompt-loader.js";
import {
  loadMarketOverview,
  computeMarketAccess,
} from "../services/market-data-service.js";
import {
  candidateProfileSchema,
  directionsOutputSchema,
  type CandidateProfile,
  type Direction,
} from "../schemas/analysis-outputs.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import {
  enrichDirections,
  postValidateDirections,
} from "../services/direction-enricher.js";
import { loadPrompt01 } from "../pipeline/prompt-loader.js";
import { scoreBadge, formatDirection } from "../bot/shortlist-format.js";
import type { EnrichedDirection } from "../services/direction-enricher.js";

/**
 * Phase 1A probe: показываем что выдаёт scorer и что Claude генерит
 * на его основе для 3 разных клиентов. Только чтение прода, никаких записей.
 *
 * Usage: NICKS=energetic_alice,nadindalinkevich,g_eckert npx tsx src/scripts/probe-phase1a.ts
 */

const PROD_URL = process.env.PROD_URL || "https://career-assistant-w7z3.onrender.com";
const NICKS = (process.env.NICKS || "rain_nl,energetic_alice,g_eckert")
  .split(",")
  .map((s) => s.trim().replace(/^@/, ""))
  .filter(Boolean);

const client = new Anthropic();
const MODEL = "claude-sonnet-4-20250514";

interface PipeStateOutputs {
  clientSummary?: ClientSummary;
  profileExtraction?: CandidateProfile;
  /** Сохраняется в intake — `rawValues` из Google Form. */
  rawNamedValues?: Record<string, string>;
  /** Полный `AnalysisPipelineInput`, включая `resumeText` и `rawNamedValues`. */
  pipelineInput?: {
    resumeText?: string;
    rawNamedValues?: Record<string, string>;
  };
}

interface PipeState {
  telegramNick?: string;
  intakeRawNamedValues?: Record<string, string>;
  stageOutputs?: PipeStateOutputs;
}

async function fetchAll(): Promise<PipeState[]> {
  const res = await fetch(`${PROD_URL}/api/participants`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PipeState[];
}

function findByNick(states: PipeState[], nick: string): PipeState | undefined {
  const n = nick.toLowerCase();
  return states.find((s) => (s.telegramNick || "").replace(/^@/, "").toLowerCase() === n);
}

function summaryToQuestionnaire(cs: ClientSummary): string {
  return JSON.stringify(cs, null, 2);
}

async function buildProfileFromSummary(cs: ClientSummary): Promise<CandidateProfile> {
  const prompt = await loadPrompt01({
    questionnaire: summaryToQuestionnaire(cs),
    resumeText: "",
    linkedinSSI: cs.linkedinSSI || "",
  });
  const jsonSchema = zodToJsonSchema(candidateProfileSchema);
  const r = await client.messages.create({
    model: MODEL,
    max_tokens: 6000,
    tools: [
      {
        name: "extract_profile",
        description: "Extract structured profile",
        input_schema: jsonSchema as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: "extract_profile" },
    messages: [{ role: "user", content: prompt }],
  });
  const t = r.content.find((b) => b.type === "tool_use");
  if (!t || t.type !== "tool_use") throw new Error("no tool_use");
  return computeMarketAccess(candidateProfileSchema.parse(t.input));
}

/**
 * Папка, куда probe сохраняет скомпилированный prompt-02 для каждого
 * клиента — полезно чтобы увидеть глазами, что реально отправилось Клоду.
 */
const PROMPT_DUMP_DIR = resolve(process.cwd(), "test-output/probe-phase1a");

async function generateDirections(
  profile: CandidateProfile,
  marketOverview: string,
  scorerTop20: string,
  dumpPromptAs?: string,
  resumeText?: string,
  questionnaireHuman?: string,
  phase0SlugsHint?: string,
): Promise<Direction[]> {
  const prompt = await loadPrompt02({
    candidateProfile: JSON.stringify(profile, null, 2),
    marketOverview,
    scorerTop20,
    resumeText,
    questionnaireHuman,
    phase0SlugsHint,
  });
  if (dumpPromptAs) {
    await mkdir(PROMPT_DUMP_DIR, { recursive: true });
    const p = resolve(PROMPT_DUMP_DIR, `${dumpPromptAs}.prompt02.md`);
    await writeFile(p, prompt, "utf-8");
    console.log(`  📝 prompt-02 dumped: ${p}`);
  }
  const jsonSchema = zodToJsonSchema(directionsOutputSchema);
  const r = await client.messages.create({
    model: MODEL,
    max_tokens: 12000,
    tools: [
      {
        name: "generate_directions",
        description: "Generate directions",
        input_schema: jsonSchema as Anthropic.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: "generate_directions" },
    messages: [{ role: "user", content: prompt }],
  });
  const t = r.content.find((b) => b.type === "tool_use");
  if (!t || t.type !== "tool_use") throw new Error("no tool_use");
  const parsed = directionsOutputSchema.parse(t.input);
  return parsed.directions;
}

function header(title: string): string {
  const bar = "═".repeat(72);
  return `\n${bar}\n  ${title}\n${bar}`;
}

/**
 * Человекочитаемая строка с желаемой/текущей зп. Показываем ТОЛЬКО
 * валюту целевого рынка клиента:
 *   - target содержит "ru"/"cis"  →  показываем ₽
 *   - target содержит любой из eu/uk/us/global/apac/latam/me  →  €
 *   - target пуст                  →  дефолт abroad (€), RU не навязываем
 *     (наша аудитория — emigr-клиенты, если регион не проставлен — это
 *     ошибка парсинга, а не сигнал, что человек хочет в РФ).
 *
 * RU **НЕ** показываем для чистого abroad-клиента, даже если у него
 * заполнено `desiredSalaryRub` (это делается «для справки»/UI — внутри
 * шортлиста рубли только зашумляют вывод).
 */
function formatSalaries(
  cs: NonNullable<NonNullable<PipeState["stageOutputs"]>["clientSummary"]>,
): string {
  const regions = cs.targetMarketRegions ?? [];
  const showRu = regions.some((r) => r === "ru" || r === "cis");
  const hasAnyAbroad = regions.some(
    (r) => r !== "ru" && r !== "cis",
  );
  // Если регионы пусты — считаем abroad (см. комментарий выше).
  const showAbroad = hasAnyAbroad || regions.length === 0;

  const parts: string[] = [];
  if (showAbroad && cs.desiredSalaryEur) parts.push(`€${cs.desiredSalaryEur}/мес (des)`);
  if (showRu && cs.desiredSalaryRub) parts.push(`₽${cs.desiredSalaryRub}/мес (des)`);

  const cur: string[] = [];
  if (showAbroad && cs.currentSalaryEur) cur.push(`€${cs.currentSalaryEur}`);
  if (showRu && cs.currentSalaryRub) cur.push(`₽${cs.currentSalaryRub}`);
  if (cur.length > 0) parts.push(`cur ${cur.join("/")}`);

  return parts.join(" · ") || "—";
}

/**
 * Формат зп из market-index: месячная в локальной валюте
 * (ru=RUB, uk=GBP, eu=EUR, us=USD). Тут не знаем региона — показываем
 * "k" с символом в зависимости от bucket'а direction'а.
 */
function fmtMedian(n: number | null, bucket: Direction["bucket"]): string {
  if (n == null) return "—";
  const k = Math.round(n / 1000);
  if (bucket === "ru") return `${k}k₽`;
  return `~${k}k`; // abroad/usa — в локальной валюте региона (GBP/EUR/USD)
}

function fmtCompetition(c: number | null): string {
  if (c == null) return "—";
  const label = c >= 10 ? "низк" : c >= 3 ? "средн" : "высок";
  return `${c.toFixed(1)} (${label})`;
}

function fmtAi(ai: EnrichedDirection["aiRisk"]): string {
  return ai ?? "—";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function padRight(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
  return s + " ".repeat(len - s.length);
}

function padLeft(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
  return " ".repeat(len - s.length) + s;
}

function renderDirectionsTable(
  directions: Direction[],
  enriched: EnrichedDirection[],
): string {
  const byKey = new Map<string, EnrichedDirection>();
  for (const e of enriched) byKey.set(`${e.roleSlug}::${e.title}`, e);

  const cols = [
    { h: "#", w: 3, align: "right" as const },
    { h: "", w: 2, align: "left" as const },
    { h: "score", w: 5, align: "right" as const },
    { h: "bucket", w: 6, align: "left" as const },
    { h: "slug", w: 20, align: "left" as const },
    { h: "title", w: 38, align: "left" as const },
    { h: "median", w: 8, align: "right" as const },
    { h: "vac", w: 6, align: "right" as const },
    { h: "конк", w: 13, align: "right" as const },
    { h: "AI", w: 6, align: "left" as const },
    { h: "rec", w: 3, align: "left" as const },
  ];

  const fmtRow = (cells: string[]): string =>
    cells
      .map((c, i) =>
        cols[i].align === "right" ? padLeft(c, cols[i].w) : padRight(c, cols[i].w),
      )
      .join("  ");

  const headerLine = fmtRow(cols.map((c) => c.h));
  const sepLine = fmtRow(cols.map((c) => "-".repeat(c.w)));
  const rows = directions.map((d, i) => {
    const e = byKey.get(`${d.roleSlug}::${d.title}`);
    return fmtRow([
      String(i + 1),
      scoreBadge(d),
      d.score != null ? String(d.score) : "—",
      d.bucket,
      truncate(d.roleSlug || "(no slug)", 20),
      truncate(d.title, 38),
      fmtMedian(e?.medianSalaryMid ?? null, d.bucket),
      e?.vacancies != null ? String(e.vacancies) : "—",
      fmtCompetition(e?.competitionPer100 ?? null),
      fmtAi(e?.aiRisk ?? null),
      d.recommended === false ? "🚫" : d.offIndex ? "⚠" : "✓",
    ]);
  });

  return [headerLine, sepLine, ...rows].join("\n");
}

async function probeOne(state: PipeState): Promise<void> {
  const nick = (state.telegramNick || "").replace(/^@/, "");
  const cs = state.stageOutputs?.clientSummary;
  if (!cs) {
    console.log(`\n@${nick}: НЕТ clientSummary — skip`);
    return;
  }

  console.log(header(`@${nick}  ·  ${cs.firstNameLatin} ${cs.lastNameLatin}`));
  const currentLine = cs.currentProfession
    ? `${cs.currentProfession}${cs.currentProfessionSlug ? ` (${cs.currentProfessionSlug})` : " (non-IT)"}`
    : "—";
  console.log(`  current:  ${currentLine}`);
  console.log(`  desired:  ${cs.desiredDirections || "—"}  [${(cs.desiredDirectionSlugs ?? []).map((d) => d.slug).join(", ") || "∅"}]`);
  console.log(`  salary:   ${formatSalaries(cs)}`);
  console.log(`  market:   target=[${(cs.targetMarketRegions ?? []).join(", ") || "—"}]  access=[${(cs.accessibleMarkets ?? []).join(", ") || "—"}]  grade=${cs.currentGrade ?? "?"}`);

  // ── Profile + Claude ──────────────────────────────────────────────
  let profile: CandidateProfile;
  try {
    profile = state.stageOutputs?.profileExtraction
      ? computeMarketAccess(state.stageOutputs.profileExtraction)
      : await buildProfileFromSummary(cs);
  } catch (err) {
    console.error("  ❌ profile build failed:", err);
    return;
  }

  // Тот же набор, что в runShortlist прода: только competition-ru для RU-
  // таргета, никаких EU-matrix / compact summary (дубль scorer top-20).
  const regions = profile.careerGoals.targetMarketRegions;
  const showRuScorer = regions.some((r) => r === "ru" || r === "cis");
  const showAbroadScorer = regions.some(
    (r) => r === "eu" || r === "uk" || r === "us" || r === "global",
  );

  let marketOverview = "";
  try {
    marketOverview = await loadMarketOverview(regions);
  } catch (err) {
    console.error("  ⚠ marketOverview build failed:", err);
  }

  // ── Scorer (после profile, чтобы знать регионы) ──────────────────
  const rank = await rankRoles(cs, 20);
  const scorerTop20 = formatScorerTop20ForPrompt(rank, 20, {
    showRu: showRuScorer,
    showAbroad: showAbroadScorer,
  });

  // Полный текст резюме и анкета для Phase 1 промпта — так же, как на проде.
  // Пробуем сначала pipelineInput (новое поле), затем top-level rawNamedValues.
  const outputs = state.stageOutputs ?? {};
  const resumeText =
    outputs.pipelineInput?.resumeText && outputs.pipelineInput.resumeText.trim()
      ? outputs.pipelineInput.resumeText
      : undefined;
  const rawNamedValues =
    outputs.pipelineInput?.rawNamedValues ?? outputs.rawNamedValues;
  const questionnaireHuman = renderQuestionnaireForPrompt(rawNamedValues);
  const phase0SlugsHint = renderPhase0SlugsHint(cs);
  console.log(
    `  sources: resume=${resumeText ? `${resumeText.length} симв` : "—"}, q&a=${rawNamedValues ? `${Object.keys(rawNamedValues).length} пар` : "—"}, closestIt=${(cs.closestItSlugs ?? []).join(",") || "—"}`,
  );

  let directionsRaw: Direction[];
  try {
    directionsRaw = await generateDirections(
      profile,
      marketOverview,
      scorerTop20,
      nick,
      resumeText,
      questionnaireHuman,
      phase0SlugsHint,
    );
  } catch (err) {
    console.error("  ❌ Claude failed:", err);
    return;
  }

  const directionsValidated = await postValidateDirections(directionsRaw, {
    targetMarketRegions: profile.careerGoals.targetMarketRegions,
  });
  // Safety-sort by score DESC — так же делает runShortlist в проде.
  const directions = [...directionsValidated].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0),
  );

  // ── Enrichment ────────────────────────────────────────────────────
  let enriched: EnrichedDirection[] = [];
  try {
    enriched = await enrichDirections(directions, cs);
  } catch (err) {
    console.error("  ❌ enrich failed:", err);
  }

  const ACTIVE_SLOTS = 10;
  const active = directions.slice(0, ACTIVE_SLOTS);
  const reserve = directions.slice(ACTIVE_SLOTS);

  console.log(`\n  Claude: ${directionsRaw.length} → post-validate ${directionsValidated.length} → top-${active.length} + reserve ${reserve.length}\n`);
  console.log(renderDirectionsTable(active, enriched).split("\n").map((l) => "  " + l).join("\n"));
  if (reserve.length > 0) {
    console.log(`\n  Reserve (${reserve.length}):`);
    console.log(renderDirectionsTable(reserve, enriched).split("\n").map((l) => "  " + l).join("\n"));
  }

  // ── TG-preview для ручного глазения: как будут выглядеть сообщения ──
  // Рендерим топ-7 через ту же formatDirection, что и бот, но тут печатаем
  // plain-текстом, а не HTML-сырьём в TG, поэтому теги <b>/<i>/<code>
  // снимаем (чтобы глаз не резало в консоли).
  const PREVIEW_N = 7;
  const enrichedByKey = new Map<string, EnrichedDirection>();
  for (const e of enriched) enrichedByKey.set(`${e.roleSlug}::${e.title}`, e);
  console.log(`\n  TG preview (top-${Math.min(PREVIEW_N, active.length)}):`);
  for (let i = 0; i < Math.min(PREVIEW_N, active.length); i += 1) {
    const d = active[i];
    const slot = { direction: d, enriched: enrichedByKey.get(`${d.roleSlug}::${d.title}`) };
    const msg = formatDirection(slot, i, active.length)
      .replace(/<\/?b>/g, "**")
      .replace(/<\/?i>/g, "_")
      .replace(/<\/?code>/g, "`")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    console.log("  " + "─".repeat(70));
    console.log(msg.split("\n").map((l) => "  " + l).join("\n"));
  }
}

async function main(): Promise<void> {
  const states = await fetchAll();
  console.log(`Загружено ${states.length} клиентов с прода. Проба для: ${NICKS.join(", ")}`);
  for (const nick of NICKS) {
    const s = findByNick(states, nick);
    if (!s) {
      console.log(`\n@${nick}: НЕ НАЙДЕН на проде`);
      continue;
    }
    await probeOne(s);
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
