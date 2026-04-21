/**
 * Quick test: runs only Step 1 (profile extraction) + computeMarketAccess
 * on real questionnaire data from LIGHT xlsx.
 *
 * Usage: npx tsx src/scripts/test-step1.ts [row_index]
 *   row 0  = energetic_alice (Лиссабон, РФ, B2+, EU/UK)
 *   row 5  = @paypalsv (Москва, Казахстан ВНЖ, ~A2, всё кроме РФ)
 *   row 9  = olboyarshinova (СПб, РФ, B1, РФ→EU)
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { candidateProfileSchema } from "../schemas/analysis-outputs.js";
import { loadPrompt01 } from "../pipeline/prompt-loader.js";
import { computeMarketAccess } from "../services/market-data-service.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadRow(rowIndex: number): Record<string, string> {
  const XLSX = require("xlsx");
  const xlsxPath = join(__dirname, "..", "..", "..", "Анкета новая.xlsx");
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data: Record<string, string>[] = XLSX.utils.sheet_to_json(ws);
  if (rowIndex >= data.length) throw new Error(`Row ${rowIndex} not found, max ${data.length - 1}`);
  return data[rowIndex];
}

const SSI_COLUMN = "Если есть Linkedin, напиши цифру своего SSI-рейтинга, он находится тут справа от большого кружка по ссылке: https://www.linkedin.com/sales/ssi \nНапример, на картинке ниже SSI 56";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-20250514";

async function main() {
  const rowIndex = parseInt(process.argv[2] || "0", 10);
  const row = loadRow(rowIndex);

  const nick = row["Твой ник в телеграм"] || "unknown";
  console.log(`\n=== Step 1 Test: row ${rowIndex} (${nick}) ===\n`);

  const questionnaire = JSON.stringify(row, null, 2);
  console.log(`[Questionnaire] ${questionnaire.length} chars`);

  const prompt = await loadPrompt01({
    questionnaire,
    resumeText: "",
    linkedinSSI: String(row[SSI_COLUMN] ?? "0"),
  });

  const t0 = Date.now();
  const jsonSchema = zodToJsonSchema(candidateProfileSchema);
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    tools: [{
      name: "extract_profile",
      description: "Output structured data according to the schema",
      input_schema: jsonSchema as Anthropic.Tool["input_schema"],
    }],
    tool_choice: { type: "tool", name: "extract_profile" },
    messages: [{ role: "user", content: prompt }],
  });

  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") throw new Error("No tool_use block");

  const rawProfile = candidateProfileSchema.parse(toolBlock.input);
  const elapsed = Date.now() - t0;

  console.log(`\n[Step 1] Done in ${(elapsed / 1000).toFixed(1)}s\n`);

  console.log("=== Claude raw profile ===");
  console.log(JSON.stringify(rawProfile, null, 2));

  console.log("\n=== After computeMarketAccess ===");
  const profile = computeMarketAccess(rawProfile);
  console.log(JSON.stringify(profile.barriers, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
