/**
 * Test: Step 1 (profile) → Step 0 (market summary) → Step 2 (directions 5-9)
 *
 * Usage: npx tsx src/scripts/test-step2.ts [row_index]
 *   row 0  = energetic_alice
 *   row 5  = @paypalsv
 *   row 9  = olboyarshinova
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  candidateProfileSchema,
  directionsOutputSchema,
} from "../schemas/analysis-outputs.js";
import { loadPrompt01, loadPrompt02 } from "../pipeline/prompt-loader.js";
import {
  computeMarketAccess,
  buildFullMarketSummary,
  loadMarketOverview,
} from "../services/market-data-service.js";
import {
  downloadFromGoogleDrive,
  extractResumeText,
} from "../services/file-service.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const CACHE_DIR = join(__dirname, "..", "..", "..", ".cache");

function loadRow(rowIndex: number): Record<string, string> {
  const XLSX = require("xlsx");
  const xlsxPath = join(__dirname, "..", "..", "..", "Анкета новая.xlsx");
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data: Record<string, string>[] = XLSX.utils.sheet_to_json(ws);
  if (rowIndex >= data.length) throw new Error(`Row ${rowIndex} not found, max ${data.length - 1}`);
  return data[rowIndex]!;
}

const SSI_COLUMN = "Если есть Linkedin, напиши цифру своего SSI-рейтинга, он находится тут справа от большого кружка по ссылке: https://www.linkedin.com/sales/ssi \nНапример, на картинке ниже SSI 56";

const RESUME_COLUMN = "Прикрепи свое резюме в любом формате (можно несколько версий)";
const RESUME_COLUMN_2 = "Прикрепи свое резюме в любом формате (можно несколько версий) 2";

async function loadResumeText(row: Record<string, string>): Promise<string> {
  const url = row[RESUME_COLUMN] || row[RESUME_COLUMN_2] || "";
  if (!url || !url.includes("drive.google.com")) {
    console.log("  [Resume] No Google Drive URL found, skipping");
    return "";
  }
  try {
    console.log(`  [Resume] Downloading from ${url.slice(0, 60)}...`);
    const { buffer, mimeType } = await downloadFromGoogleDrive(url);
    const text = await extractResumeText(buffer, mimeType);
    console.log(`  [Resume] Extracted ${text.length} chars (${mimeType})`);
    return text;
  } catch (err) {
    console.error(`  [Resume] Failed:`, err instanceof Error ? err.message : err);
    return "";
  }
}

const client = new Anthropic();
const MODEL = "claude-sonnet-4-20250514";

async function main() {
  const rowIndex = parseInt(process.argv[2] || "0", 10);
  const row = loadRow(rowIndex);
  const nick = row["Твой ник в телеграм"] || "unknown";
  console.log(`\n=== Test Step 2: row ${rowIndex} (${nick}) ===\n`);

  // ── Step 1: Profile extraction (cached) ──
  const cacheFile = join(CACHE_DIR, `profile-row${rowIndex}.json`);
  let profile: import("../schemas/analysis-outputs.js").CandidateProfile;
  let t0 = Date.now();

  try {
    const cached = await readFile(cacheFile, "utf-8");
    profile = candidateProfileSchema.parse(JSON.parse(cached));
    console.log(`[Step 1] Loaded from cache: ${profile.name}, ${profile.currentBase.currentRole}`);
  } catch {
    console.log("[Step 1] Extracting profile (no cache)...");
    const questionnaire = JSON.stringify(row, null, 2);
    const resumeText = await loadResumeText(row);
    const prompt01 = await loadPrompt01({
      questionnaire,
      resumeText,
      linkedinSSI: String(row[SSI_COLUMN] ?? "0"),
    });

    const jsonSchema1 = zodToJsonSchema(candidateProfileSchema);
    const resp1 = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      tools: [{ name: "extract_profile", description: "Extract structured profile", input_schema: jsonSchema1 as Anthropic.Tool["input_schema"] }],
      tool_choice: { type: "tool", name: "extract_profile" },
      messages: [{ role: "user", content: prompt01 }],
    });
    const tb1 = resp1.content.find((b) => b.type === "tool_use");
    if (!tb1 || tb1.type !== "tool_use") throw new Error("No tool_use");
    profile = candidateProfileSchema.parse(tb1.input);
    profile = computeMarketAccess(profile);

    const { mkdir } = await import("node:fs/promises");
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(profile, null, 2));
    console.log(`[Step 1] Done in ${((Date.now() - t0) / 1000).toFixed(1)}s — saved to cache`);
  }
  console.log(`  ${profile.name} | ${profile.currentBase.currentRole}`);
  console.log(`  Regions: ${profile.careerGoals.targetMarketRegions.join(", ")}`);
  console.log(`  Eng: ${profile.currentBase.englishLevel} | Salary: ${profile.currentBase.currentSalary}`);
  console.log(`  Accessible: ${profile.barriers.accessibleMarkets?.join(", ")}`);

  // ── Step 0: Market overview ──
  console.log("\n[Step 0] Building market overview...");
  t0 = Date.now();
  const regions = profile.careerGoals.targetMarketRegions;
  const [kbOverview, scrapedSummary] = await Promise.all([
    loadMarketOverview(regions),
    buildFullMarketSummary(profile),
  ]);
  const marketOverview = kbOverview + "\n\n---\n\n" + scrapedSummary.markdown;
  console.log(`[Step 0] Done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${marketOverview.length} chars, ${scrapedSummary.roles.length} roles`);

  // ── Step 2: Direction generation ──
  console.log("\n[Step 2] Generating 5-9 directions...");
  const prompt02 = await loadPrompt02({
    candidateProfile: JSON.stringify(profile, null, 2),
    marketOverview,
  });
  console.log(`[Step 2] Prompt size: ${prompt02.length} chars`);

  t0 = Date.now();
  const jsonSchema2 = zodToJsonSchema(directionsOutputSchema);
  const resp2 = await client.messages.create({
    model: MODEL,
    max_tokens: 12000,
    tools: [{ name: "generate_directions", description: "Generate career directions", input_schema: jsonSchema2 as Anthropic.Tool["input_schema"] }],
    tool_choice: { type: "tool", name: "generate_directions" },
    messages: [{ role: "user", content: prompt02 }],
  });
  const tb2 = resp2.content.find((b) => b.type === "tool_use");
  if (!tb2 || tb2.type !== "tool_use") throw new Error("No tool_use");
  const directions = directionsOutputSchema.parse(tb2.input);
  console.log(`[Step 2] Done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // ── Output ──
  console.log(`\n=== ${directions.directions.length} НАПРАВЛЕНИЙ ===`);
  for (const [i, d] of directions.directions.entries()) {
    console.log(`\n${i + 1}. ${d.title}`);
    console.log(`   Тип: ${d.type} | Близость: ${d.adjacencyScorePercent}%`);
    console.log(`   Почему: ${d.whyFits.slice(0, 150)}...`);
    console.log(`   Переносимые: ${d.transferableSkills.join(", ")}`);
    console.log(`   Доучить: ${d.skillsToLearn.join(", ")}`);
  }

  console.log("\n=== ПОЛНЫЙ JSON ===");
  console.log(JSON.stringify(directions, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
