/**
 * One-off preprocessor: distill 25 zip archives of HH top-10 resumes
 * (located at repo root in `resume_helpers/`) into plain-text snippets
 * grouped by canonical role slug.
 *
 * Output:
 *   app/data/resume_helpers_raw/<slug>/<source_label>__<n>.txt
 *
 * The output directory is gitignored (large, derivable). Used as input
 * for `npm run build:role-patterns`, which compresses the raw text into
 * a small JSON "playbook" per role.
 *
 * Uses `pdf-parse` (not Claude) — this step needs cheap raw extraction,
 * not perfect formatting.
 *
 * Usage:
 *   npm run build:resume-helpers-raw           # incremental
 *   npm run build:resume-helpers-raw -- --force # rebuild from scratch
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import pdfParse from "pdf-parse";
import { RESUME_HELPERS_MAPPING } from "../services/resume-helpers-mapping.js";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const ZIP_DIR = join(REPO_ROOT, "resume_helpers");
const OUT_DIR = join(__dirname, "..", "..", "data", "resume_helpers_raw");

const force = process.argv.includes("--force");

interface ProcessResult {
  slug: string;
  source: string;
  written: number;
  skipped: number;
  failed: number;
}

function cleanText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[\u00A0\u2000-\u200B]/g, " ")
    .trim();
}

async function listPdfsRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const nested = await listPdfsRecursive(full);
      out.push(...nested);
    } else if (e.isFile() && extname(e.name).toLowerCase() === ".pdf") {
      out.push(full);
    }
  }
  return out;
}

async function processZip(zipPath: string): Promise<ProcessResult> {
  const zipName = basename(zipPath, ".zip");
  const slug = RESUME_HELPERS_MAPPING[zipName];
  const result: ProcessResult = {
    slug: slug || "(unmapped)",
    source: zipName,
    written: 0,
    skipped: 0,
    failed: 0,
  };
  if (!slug) {
    console.warn(`[skip] no mapping for "${zipName}"`);
    return result;
  }

  const tmp = await mkdtemp(join(tmpdir(), "resume-helpers-"));
  try {
    await execFileP("unzip", ["-q", "-o", zipPath, "-d", tmp]);
    const pdfs = (await listPdfsRecursive(tmp)).sort();
    const slugDir = join(OUT_DIR, slug);
    await mkdir(slugDir, { recursive: true });

    for (const pdf of pdfs) {
      const idxMatch = basename(pdf).match(/\((\d+)\)/);
      const idx = idxMatch ? idxMatch[1].padStart(2, "0") : "00";
      const sourceLabel = zipName.replace(/[^a-z0-9]/gi, "_").toLowerCase() || "src";
      const outFile = join(slugDir, `${sourceLabel}__${idx}.txt`);

      if (!force && existsSync(outFile)) {
        result.skipped += 1;
        continue;
      }

      try {
        const buf = await readFile(pdf);
        const parsed = await pdfParse(buf);
        const text = cleanText(parsed.text);
        if (text.length < 200) {
          console.warn(`[warn] short text (${text.length} chars) in ${basename(pdf)}`);
        }
        await writeFile(outFile, text, "utf-8");
        result.written += 1;
      } catch (err) {
        console.warn(
          `[fail] ${basename(pdf)}: ${err instanceof Error ? err.message : String(err)}`,
        );
        result.failed += 1;
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  return result;
}

async function main() {
  if (!existsSync(ZIP_DIR)) {
    throw new Error(`resume_helpers dir not found: ${ZIP_DIR}`);
  }
  await mkdir(OUT_DIR, { recursive: true });

  const all = (await readdir(ZIP_DIR))
    .filter((f) => f.endsWith(".zip"))
    .map((f) => join(ZIP_DIR, f))
    .sort();

  console.log(`Found ${all.length} zip(s) in ${ZIP_DIR}`);
  if (force) console.log("FORCE mode: rebuilding from scratch");

  const results: ProcessResult[] = [];
  for (const zip of all) {
    const t0 = Date.now();
    const res = await processZip(zip);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `  ${basename(zip).padEnd(28)} → ${res.slug.padEnd(18)} ` +
        `written=${res.written} skipped=${res.skipped} failed=${res.failed}  (${dt}s)`,
    );
    results.push(res);
  }

  const bySlug = new Map<string, number>();
  for (const r of results) {
    bySlug.set(r.slug, (bySlug.get(r.slug) ?? 0) + r.written + r.skipped);
  }

  console.log("\nSummary by slug:");
  for (const [slug, count] of [...bySlug.entries()].sort()) {
    console.log(`  ${slug.padEnd(20)} ${count} files`);
  }

  const totalWritten = results.reduce((s, r) => s + r.written, 0);
  const totalSkipped = results.reduce((s, r) => s + r.skipped, 0);
  const totalFailed = results.reduce((s, r) => s + r.failed, 0);
  console.log(
    `\nTotal: written=${totalWritten} skipped=${totalSkipped} failed=${totalFailed}`,
  );
  console.log(`Output: ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
