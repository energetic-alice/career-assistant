/**
 * Fetch IT market reports via Perplexity Sonar Pro.
 *
 * Two query types:
 *   1. Region reports — general IT market overview per region
 *   2. Role reports   — one role + one region = one query
 *
 * Usage:
 *   npx tsx src/scripts/fetch-market-reports.ts region uk
 *   npx tsx src/scripts/fetch-market-reports.ts region all
 *
 *   npx tsx src/scripts/fetch-market-reports.ts role "devops engineer" uk
 *   npx tsx src/scripts/fetch-market-reports.ts role "devops engineer" all
 *   npx tsx src/scripts/fetch-market-reports.ts role all uk
 *   npx tsx src/scripts/fetch-market-reports.ts role all all
 */
import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REGIONS,
  querySonarPro,
  buildRegionPrompt,
  buildRoleRegionPrompt,
  slugify,
  ensureRoleReport,
  ensureRegionReport,
} from "../services/market-data-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MARKET_DATA_DIR = join(__dirname, "..", "prompts", "market-data");

const KNOWN_ROLES = [
  "backend developer java",
  "backend developer python",
  "backend developer go",
  "backend developer node.js",
  "backend developer c# .net",
  "backend developer php",
  "backend developer ruby",
  "backend developer rust",
  "frontend developer react",
  "frontend developer vue",
  "frontend developer angular",
  "mobile developer ios swift",
  "mobile developer android kotlin",
  "react native developer",
  "flutter developer",
  "devops engineer",
  "sre site reliability engineer",
  "platform engineer",
  "cloud architect",
  "devsecops engineer",
  "mlops engineer",
  "data analyst",
  "data engineer",
  "data scientist",
  "ml engineer",
  "qa automation engineer",
  "qa manual tester",
  "product manager",
  "project manager",
  "engineering manager",
  "tech lead",
  "systems analyst",
  "business analyst",
  "solution architect",
  "finops engineer",
  "technical writer",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatHeader(title: string): string {
  const date = new Date().toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
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

function printPreview(text: string) {
  console.log(`\n--- Preview (first 1500 chars) ---\n`);
  console.log(text.slice(0, 1500));
  if (text.length > 1500) console.log(`\n... (+${text.length - 1500} chars)`);
}

// ---------------------------------------------------------------------------
// Fetch functions
// ---------------------------------------------------------------------------

async function fetchRegionReport(regionId: string): Promise<void> {
  const region = REGIONS[regionId];
  if (!region) {
    console.error(`Unknown region: ${regionId}. Available: ${Object.keys(REGIONS).join(", ")}`);
    return;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`REGION: ${region.label}`);
  console.log(`${"=".repeat(60)}`);

  const t0 = Date.now();
  try {
    const { content, citations } = await querySonarPro(buildRegionPrompt(regionId, region));
    const elapsed = Date.now() - t0;
    console.log(`Done in ${elapsed}ms (${content.length} chars, ${citations.length} citations)`);

    const header = formatHeader(`Market Reports: ${region.label}`);
    const full = appendCitations(header + content, citations);

    const outPath = join(MARKET_DATA_DIR, `market-reports-${regionId}.md`);
    await mkdir(MARKET_DATA_DIR, { recursive: true });
    await writeFile(outPath, full, "utf-8");
    console.log(`Saved: ${outPath}`);
    printPreview(full);
  } catch (err) {
    console.error(`FAILED (${Date.now() - t0}ms):`, err);
  }
}

async function fetchRoleReport(role: string, regionId: string): Promise<void> {
  const region = REGIONS[regionId];
  if (!region) {
    console.error(`Unknown region: ${regionId}`);
    return;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`ROLE: ${role} | REGION: ${region.label}`);
  console.log(`${"=".repeat(60)}`);

  const t0 = Date.now();
  try {
    const { content, citations } = await querySonarPro(
      buildRoleRegionPrompt(role, regionId, region),
    );
    const elapsed = Date.now() - t0;
    console.log(`Done in ${elapsed}ms (${content.length} chars, ${citations.length} citations)`);

    const header = formatHeader(`Role Report: ${role} — ${region.label}`);
    const full = appendCitations(header + content, citations);

    const slug = slugify(role);
    const outPath = join(MARKET_DATA_DIR, `role-${slug}-${regionId}.md`);
    await mkdir(MARKET_DATA_DIR, { recursive: true });
    await writeFile(outPath, full, "utf-8");
    console.log(`Saved: ${outPath}`);
    printPreview(full);
  } catch (err) {
    console.error(`FAILED (${Date.now() - t0}ms):`, err);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.PERPLEXITY_API_KEY) {
    console.error("PERPLEXITY_API_KEY not set. Add it to app/.env");
    process.exit(1);
  }

  const type = process.argv[2];
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];

  if (!type || !["region", "role"].includes(type)) {
    console.log(`Usage:
  Region reports (general market overview):
    npx tsx src/scripts/fetch-market-reports.ts region uk
    npx tsx src/scripts/fetch-market-reports.ts region uk,eu,ru
    npx tsx src/scripts/fetch-market-reports.ts region all

  Role reports (one role + one region per query):
    npx tsx src/scripts/fetch-market-reports.ts role "devops engineer" uk
    npx tsx src/scripts/fetch-market-reports.ts role "devops engineer" all
    npx tsx src/scripts/fetch-market-reports.ts role all uk
    npx tsx src/scripts/fetch-market-reports.ts role all all

Available regions: ${Object.keys(REGIONS).join(", ")}
Known roles: ${KNOWN_ROLES.length}`);
    process.exit(1);
  }

  if (type === "region") {
    const ids = arg1 === "all"
      ? Object.keys(REGIONS)
      : (arg1 || "").split(",").map((s) => s.trim());
    console.log(`Fetching region reports: ${ids.join(", ")}\n`);
    for (const id of ids) {
      await fetchRegionReport(id);
    }
  } else {
    const roles = arg1 === "all" ? KNOWN_ROLES : [arg1 || ""];
    const regionIds = arg2 === "all"
      ? Object.keys(REGIONS)
      : (arg2 || "").split(",").map((s) => s.trim());

    const total = roles.length * regionIds.length;
    console.log(`Fetching role reports: ${roles.length} role(s) x ${regionIds.length} region(s) = ${total} queries\n`);

    for (const role of roles) {
      for (const regionId of regionIds) {
        await fetchRoleReport(role, regionId);
      }
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("DONE. Review generated files in app/src/prompts/market-data/");
  console.log(`${"=".repeat(60)}`);
}

main();
