import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createGoogleDoc } from "../services/google-docs-service.js";

/**
 * One-off: создаёт Google Doc из заранее сгенерированного markdown,
 * чтобы быстро проверить createGoogleDoc → Apps Script / Drive API fallback
 * без полного прогона Phase 3 + Phase 4.
 *
 * Usage:
 *   npx tsx src/scripts/test-create-doc.ts test-output/probe-final/nadindalinkevich.final.md
 */
async function main(): Promise<void> {
  const argPath = process.argv[2];
  if (!argPath) {
    console.error(
      "Usage: npx tsx src/scripts/test-create-doc.ts <path-to-markdown.md>",
    );
    process.exit(1);
  }
  const md = await readFile(resolve(process.cwd(), argPath), "utf-8");
  const title = `[probe] Test Doc — ${new Date().toISOString().slice(0, 19)}`;

  console.log(`[test-doc] markdown=${md.length} chars · title="${title}"`);
  console.log(
    `[test-doc] APPS_SCRIPT_DOC_URL: ${
      process.env.APPS_SCRIPT_DOC_URL ? "set" : "NOT SET"
    }`,
  );
  console.log(
    `[test-doc] GOOGLE_SERVICE_ACCOUNT_KEY: ${
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY ? "set" : "NOT SET"
    }`,
  );
  console.log(
    `[test-doc] GOOGLE_DRIVE_FOLDER_ID: ${
      process.env.GOOGLE_DRIVE_FOLDER_ID ? "set" : "NOT SET"
    }`,
  );

  const t0 = Date.now();
  try {
    const url = await createGoogleDoc(title, md);
    const ms = Date.now() - t0;
    console.log(`\n✅ Doc created in ${ms}ms\n   ${url}\n`);
  } catch (err) {
    console.error(`\n❌ createGoogleDoc failed:`, err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[test-doc] fatal:", err);
  process.exit(1);
});
