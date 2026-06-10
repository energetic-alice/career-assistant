import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { buildLinkedinPackInputs } from "../services/linkedin-pack/build-inputs.js";
import { runLinkedinPack } from "../services/linkedin-pack/run-pack.js";
import { renderLinkedinPack } from "../services/linkedin-pack/renderer.js";

/**
 * Ad-hoc probe для внешнего человека (вне КА-программы), для которого
 * у нас нет сохранённого `clientSummary`. На вход — только LinkedIn URL.
 * Target-роль / рынок / грейд вытащит сам LLM из LinkedIn-данных.
 *
 * Запуск:
 *   npx tsx src/scripts/probe-linkedin-external.ts https://www.linkedin.com/in/<slug>/
 *
 * Результат:
 *   - Markdown: `./probe-output/linkedin-pack-external-<slug>.md`
 *   - JSON:     `./probe-output/linkedin-pack-external-<slug>.json`
 *
 * Кеш LinkedIn профиля пишется в `data/documents/external-<slug>/linkedin-profile.json`,
 * так что повторный запуск на том же URL не будет заново дёргать Apify.
 */

function slugFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const inIdx = segments.indexOf("in");
    if (inIdx >= 0 && segments[inIdx + 1]) return segments[inIdx + 1];
    return segments[segments.length - 1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url || !/^https?:\/\//.test(url)) {
    console.error(
      "Usage: npx tsx src/scripts/probe-linkedin-external.ts <linkedin-profile-url>\n" +
        "Example: npx tsx src/scripts/probe-linkedin-external.ts https://www.linkedin.com/in/alicecybergirl/",
    );
    process.exit(1);
  }

  const slug = slugFromUrl(url);
  const participantId = `external-${slug}`;
  const nick = slug;

  console.log(`[probe-external] url: ${url}`);
  console.log(`[probe-external] slug: ${slug}`);

  const t0 = Date.now();

  console.log(`\n[probe-external] → buildLinkedinPackInputs() (no clientSummary)`);
  const input = await buildLinkedinPackInputs({
    participantId,
    nick,
    clientSummary: null,
    resumeVersions: [],
    activeResumeVersionId: null,
    linkedinUrlOverride: url,
  });
  console.log(
    `[probe-external] inputs ready · linkedin=${
      input.linkedin ? `${input.linkedin.source} (${input.linkedin.text.length} chars)` : "—"
    } · resume=${input.resume ? `${input.resume.text.length} chars` : "—"}`,
  );

  console.log(`\n[probe-external] → runLinkedinPack()`);
  const result = await runLinkedinPack(input);
  const ms = Date.now() - t0;
  console.log(
    `\n[probe-external] pack generated in ${(ms / 1000).toFixed(1)}s ` +
      `(audit=${(result.timings.auditMs / 1000).toFixed(1)}s, ` +
      `headline=${(result.timings.headlineMs / 1000).toFixed(1)}s, ` +
      `profile=${(result.timings.profileMs / 1000).toFixed(1)}s)`,
  );
  const a = result.data.audit;
  console.log(
    `[probe-external] audit: ${a.passCount} pass · ${a.failCount} fail · ${a.unknownCount} unknown / ${a.totalCount} items  ` +
      `variants=${result.data.headline.variants.length}  ` +
      `profileContent=${result.data.profileContent ? "ok" : "missing"}`,
  );

  const md = renderLinkedinPack(result.data);

  const outDir = path.join(process.cwd(), "probe-output");
  fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, `linkedin-pack-external-${slug}.md`);
  const jsonPath = path.join(outDir, `linkedin-pack-external-${slug}.json`);
  fs.writeFileSync(mdPath, md, "utf-8");
  fs.writeFileSync(jsonPath, JSON.stringify(result.data, null, 2), "utf-8");
  console.log(`\n[probe-external] saved:\n  ${mdPath}\n  ${jsonPath}`);

  console.log(`\n=== MARKDOWN PREVIEW (first 60 lines) ===\n`);
  console.log(md.split("\n").slice(0, 60).join("\n"));
  console.log(`\n=== (truncated) ===`);
}

main().catch((err) => {
  console.error("[probe-external] fatal:", err);
  process.exit(1);
});
