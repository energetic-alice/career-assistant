import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { rankRoles, formatScorerTop20ForPrompt } from "../services/role-scorer.js";
import { loadPrompt02 } from "../pipeline/prompt-loader.js";
import {
  loadMarketOverview,
  buildFullMarketSummary,
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
  formatEnrichedForLog,
  postValidateDirections,
} from "../services/direction-enricher.js";
import { loadPrompt01 } from "../pipeline/prompt-loader.js";

/**
 * Phase 1A probe: показываем что выдаёт scorer и что Claude генерит
 * на его основе для 3 разных клиентов. Только чтение прода, никаких записей.
 *
 * Usage: NICKS=energetic_alice,nadindalinkevich,g_eckert npx tsx src/scripts/probe-phase1a.ts
 */

const PROD_URL = process.env.PROD_URL || "https://career-assistant-w7z3.onrender.com";
const NICKS = (process.env.NICKS || "energetic_alice,nadindalinkevich,g_eckert")
  .split(",")
  .map((s) => s.trim().replace(/^@/, ""))
  .filter(Boolean);

const client = new Anthropic();
const MODEL = "claude-sonnet-4-20250514";

interface PipeState {
  telegramNick?: string;
  intakeRawNamedValues?: Record<string, string>;
  stageOutputs?: { clientSummary?: ClientSummary; profileExtraction?: CandidateProfile };
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

async function generateDirections(
  profile: CandidateProfile,
  marketOverview: string,
  scorerTop20: string,
): Promise<Direction[]> {
  const prompt = await loadPrompt02({
    candidateProfile: JSON.stringify(profile, null, 2),
    marketOverview,
    scorerTop20,
  });
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

async function probeOne(state: PipeState): Promise<void> {
  const nick = (state.telegramNick || "").replace(/^@/, "");
  const cs = state.stageOutputs?.clientSummary;
  if (!cs) {
    console.log(`\n@${nick}: НЕТ clientSummary — skip`);
    return;
  }

  console.log(header(`@${nick}  ·  ${cs.firstNameLatin} ${cs.lastNameLatin}`));
  console.log(`  current:  ${cs.currentProfession || "—"}`);
  console.log(`  current slug: ${cs.currentProfessionSlug ?? "<non-IT>"}`);
  console.log(`  desired:  ${cs.desiredDirections || "—"}`);
  console.log(
    `  desired slugs: ${(cs.desiredDirectionSlugs ?? [])
      .map((d) => `${d.slug}${d.offIndex ? "⚠" : ""}`)
      .join(", ") || "∅"}`,
  );
  console.log(`  target:   [${(cs.targetMarketRegions ?? []).join(", ") || "—"}]  access: [${(cs.accessibleMarkets ?? []).join(", ") || "—"}]`);
  const sal: string[] = [];
  if (cs.currentSalaryRub) sal.push(`curRUB=${cs.currentSalaryRub}`);
  if (cs.currentSalaryEur) sal.push(`curEUR=${cs.currentSalaryEur}`);
  if (cs.desiredSalaryRub) sal.push(`desRUB=${cs.desiredSalaryRub}`);
  if (cs.desiredSalaryEur) sal.push(`desEUR=${cs.desiredSalaryEur}`);
  console.log(`  salary:   ${sal.join(" ") || "—"}`);

  // ── Step A: scorer ────────────────────────────────────────────────
  console.log(`\n  ━━ ALGO: rankRoles(summary, 20) ━━`);
  const t0 = Date.now();
  const rank = await rankRoles(cs, 20);
  console.log(`  buckets: ru=${rank.buckets.ru} abroad=${rank.buckets.abroad}  (${Date.now() - t0}ms)`);
  const scorerTop20 = formatScorerTop20ForPrompt(rank, 20);
  console.log("\n" + scorerTop20.split("\n").map((l) => "  " + l).join("\n"));

  // ── Step B: profile + Claude ──────────────────────────────────────
  console.log(`\n  ━━ CLAUDE: prompt-02 (с scorerTop20) → directions ━━`);
  const t1 = Date.now();
  let profile: CandidateProfile;
  try {
    if (state.stageOutputs?.profileExtraction) {
      profile = computeMarketAccess(state.stageOutputs.profileExtraction);
      console.log(`  (profile из stageOutputs.profileExtraction)`);
    } else {
      console.log(`  (profileExtraction нет, генерирую на лету из clientSummary)`);
      profile = await buildProfileFromSummary(cs);
    }
    console.log(`  profile ready (${Date.now() - t1}ms). target regions: ${profile.careerGoals.targetMarketRegions.join(", ")}`);
  } catch (err) {
    console.error("  ❌ profile build failed:", err);
    return;
  }

  let marketOverview = "";
  try {
    const [kb, scraped] = await Promise.all([
      loadMarketOverview(profile.careerGoals.targetMarketRegions),
      buildFullMarketSummary(profile),
    ]);
    marketOverview = `${kb}\n\n---\n\n${scraped.markdown}`;
  } catch (err) {
    console.error("  ⚠ marketOverview build failed:", err);
  }

  const t2 = Date.now();
  let directionsRaw: Direction[];
  try {
    directionsRaw = await generateDirections(profile, marketOverview, scorerTop20);
    console.log(`  Claude вернул ${directionsRaw.length} направлений (${Date.now() - t2}ms)`);
  } catch (err) {
    console.error("  ❌ Claude failed:", err);
    return;
  }

  console.log(`\n  ━━ POST-VALIDATE (дедупликация slug, ban extreme, strip junior) ━━`);
  const directions = await postValidateDirections(directionsRaw, {
    targetMarketRegions: profile.careerGoals.targetMarketRegions,
  });
  console.log(`  После валидации: ${directions.length}/${directionsRaw.length} направлений\n`);

  for (const [i, d] of directions.entries()) {
    const tag = d.offIndex ? `⚠OFF` : `✓`;
    const bucket = d.bucket ? `[${d.bucket}]` : "[?]";
    const score = d.score != null ? `score=${d.score}` : "";
    console.log(`  ${i + 1}. ${bucket} [${tag}] ${d.roleSlug || "(no slug)"} — ${d.title}`);
    console.log(`     ${score}  adj=${d.adjacencyScorePercent}%`);
    console.log(`     whyFits: ${d.whyFits.replace(/\s+/g, " ").slice(0, 220)}${d.whyFits.length > 220 ? "…" : ""}`);
    if (d.offIndex) {
      console.log(`     marketEvidence: ${(d.marketEvidence || "—").slice(0, 220)}`);
    }
    console.log();
  }

  // ── Step C: enrichment ────────────────────────────────────────────
  console.log(`  ━━ ENRICH: market-index lookup ━━`);
  try {
    const enriched = await enrichDirections(directions, cs);
    console.log(formatEnrichedForLog(enriched));
  } catch (err) {
    console.error("  ❌ enrich failed:", err);
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
