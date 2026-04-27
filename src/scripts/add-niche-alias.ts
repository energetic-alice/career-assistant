/**
 * CLI для ручного pin-а niche alias.
 *
 * Резолвер по умолчанию пишет top-1 live-scrape в runtime store как
 * `source: "live-scrape"`. Этот скрипт позволяет:
 *   - вручную закрепить (`--target=runtime`, default) или
 *   - перенести в committed (`niche-aliases.json` в репо), чтобы alias
 *     попал в git и сохранился между deploys / на новых машинах.
 *
 * Usage:
 *   tsx src/scripts/add-niche-alias.ts <slug> "<direction title>" "<row title>"
 *   tsx src/scripts/add-niche-alias.ts devops "DevSecOps Engineer (senior)" "DevSecOps"
 *   tsx src/scripts/add-niche-alias.ts --target=committed devops "DevSecOps Engineer" "DevSecOps"
 *   tsx src/scripts/add-niche-alias.ts --list
 */
import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pinNicheAlias,
  listRuntimeAliases,
  normalizeTitleForAlias,
} from "../services/market-research/niche-resolver.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMITTED_PATH = join(
  __dirname,
  "..",
  "services",
  "market-research",
  "niche-aliases.json",
);

interface ParsedArgs {
  target: "runtime" | "committed";
  list: boolean;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { target: "runtime", list: false, positional: [] };
  for (const a of argv) {
    if (a.startsWith("--target=")) {
      const v = a.slice("--target=".length);
      if (v !== "runtime" && v !== "committed") {
        throw new Error(`Invalid --target value: ${v} (allowed: runtime|committed)`);
      }
      args.target = v;
    } else if (a === "--list") {
      args.list = true;
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

async function writeCommittedAlias(
  slug: string,
  directionTitle: string,
  rowTitle: string,
): Promise<void> {
  const raw = await readFile(COMMITTED_PATH, "utf-8");
  const json = JSON.parse(raw) as Record<string, unknown>;
  const slugMap = (json[slug] && typeof json[slug] === "object"
    ? (json[slug] as Record<string, string>)
    : {});
  slugMap[normalizeTitleForAlias(directionTitle)] = rowTitle;
  json[slug] = slugMap;
  await writeFile(COMMITTED_PATH, JSON.stringify(json, null, 2) + "\n", "utf-8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    const items = listRuntimeAliases();
    if (items.length === 0) {
      console.log("Runtime aliases: empty.");
    } else {
      console.log(`Runtime aliases (${items.length}):`);
      for (const { key, alias } of items) {
        console.log(
          `  ${key}  →  "${alias.rowTitle}"  [${alias.source}, ${alias.createdAt.slice(0, 10)}]`,
        );
      }
    }
    return;
  }

  const [slug, directionTitle, rowTitle] = args.positional;
  if (!slug || !directionTitle || !rowTitle) {
    console.log(`Usage:
  tsx src/scripts/add-niche-alias.ts <slug> "<direction title>" "<row title>"
  tsx src/scripts/add-niche-alias.ts --target=committed <slug> "<dir>" "<row>"
  tsx src/scripts/add-niche-alias.ts --list

Examples:
  tsx src/scripts/add-niche-alias.ts devops "DevSecOps Engineer (senior)" "DevSecOps"
  tsx src/scripts/add-niche-alias.ts --target=committed infosecspec "AppSec Engineer" "Security Engineer"

Defaults to --target=runtime (per-installation, /var/data).
Use --target=committed to write into niche-aliases.json (commit & push to git).`);
    process.exit(1);
  }

  if (args.target === "committed") {
    await writeCommittedAlias(slug, directionTitle, rowTitle);
    console.log(
      `✓ committed alias added: ${slug} · "${normalizeTitleForAlias(directionTitle)}" → "${rowTitle}"`,
    );
    console.log(`  Don't forget to commit ${COMMITTED_PATH} into git.`);
  } else {
    pinNicheAlias(slug, directionTitle, rowTitle, "user-pin");
    console.log(
      `✓ runtime alias pinned: ${slug} · "${normalizeTitleForAlias(directionTitle)}" → "${rowTitle}"`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
