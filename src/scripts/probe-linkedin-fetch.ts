import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { fetchLinkedinProfile } from "../services/linkedin-fetcher.js";
import {
  loadCachedLinkedin,
  saveCachedLinkedin,
} from "../services/linkedin-pack/build-inputs.js";

/**
 * Probe: берём N клиентов с заполненным LinkedIn URL из локального
 * `pipelineStates*.json`, парсим профиль через `fetchLinkedinProfile`
 * (Apify), сохраняем JSON в `data/documents/<pid>/linkedin-profile.json`
 * и выводим короткую сводку. При повторном запуске используется кеш с
 * диска (так же как будет работать в проде).
 *
 * Запуск:
 *   npx tsx src/scripts/probe-linkedin-fetch.ts
 *   npx tsx src/scripts/probe-linkedin-fetch.ts 5                  # 5 клиентов
 *   npx tsx src/scripts/probe-linkedin-fetch.ts 3 @emilylogin      # 3, но начать с @emilylogin
 *
 * Env: APIFY_API_TOKEN + APIFY_LINKEDIN_ACTOR
 */

interface MinState {
  participantId: string;
  telegramNick: string;
  stageOutputs?: {
    clientSummary?: { linkedinUrl?: string | null };
  };
}

function findStateFile(): string {
  const dataDir = path.join(process.cwd(), "data");
  const candidates = [
    "pipelineStates.backfilled.json",
    "pipelineStates.migrated.json",
    "pipelineStates.json",
  ];
  for (const name of candidates) {
    const fp = path.join(dataDir, name);
    if (fs.existsSync(fp)) return fp;
  }
  throw new Error(`No pipelineStates*.json found in ${dataDir}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limit = Number(args[0]) > 0 ? Number(args[0]) : 3;
  const startFromNick = args[1]?.replace(/^@/, "") ?? null;

  const stateFile = findStateFile();
  const raw = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as Record<string, MinState>;

  const candidates: Array<{ pid: string; nick: string; url: string }> = [];
  for (const [pid, state] of Object.entries(raw)) {
    const nick = (state.telegramNick ?? "").replace(/^@/, "").trim();
    const url = state.stageOutputs?.clientSummary?.linkedinUrl ?? "";
    if (!pid || !nick || !url || !url.includes("linkedin.com/in/")) continue;
    candidates.push({ pid, nick, url });
  }

  if (candidates.length === 0) {
    console.error("No clients with LinkedIn URL found.");
    process.exit(1);
  }

  let startIdx = 0;
  if (startFromNick) {
    const found = candidates.findIndex((c) => c.nick.toLowerCase() === startFromNick.toLowerCase());
    if (found >= 0) startIdx = found;
    else console.warn(`Nick @${startFromNick} not found, starting from beginning`);
  }

  const slice = candidates.slice(startIdx, startIdx + limit);
  console.log(
    `[probe] state file: ${stateFile}\n` +
      `[probe] total with LinkedIn: ${candidates.length}, probing ${slice.length} starting from ${startIdx}\n` +
      `[probe] APIFY_API_TOKEN: ${process.env.APIFY_API_TOKEN ? "set" : "NOT SET"}` +
      (process.env.APIFY_LINKEDIN_ACTOR ? ` · actor=${process.env.APIFY_LINKEDIN_ACTOR}` : "") +
      "\n",
  );

  let ok = 0;
  let fail = 0;
  let fromCache = 0;
  for (const c of slice) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`@${c.nick}  pid=${c.pid}`);
    console.log(`URL: ${c.url}`);

    const cached = loadCachedLinkedin(c.pid, c.url);
    if (cached) {
      console.log(
        `💾 CACHE HIT fetchedAt=${cached.fetchedAt} source=${cached.source} text=${cached.text.length} chars`,
      );
      ok += 1;
      fromCache += 1;
      continue;
    }

    const t0 = Date.now();
    try {
      const profile = await fetchLinkedinProfile(c.url);
      const ms = Date.now() - t0;
      if (!profile) {
        console.log(`❌ [${ms}ms] profile = null (все источники не сработали)`);
        fail += 1;
      } else {
        saveCachedLinkedin(c.pid, profile);
        console.log(
          `✅ [${ms}ms] source=${profile.source} headline="${profile.headline.slice(0, 80)}" location="${profile.location}" text=${profile.text.length} chars (saved to disk)`,
        );
        const preview = profile.text.split("\n").slice(0, 12).join("\n");
        console.log(`--- preview (first 12 lines) ---\n${preview}\n---`);
        ok += 1;
      }
    } catch (err) {
      const ms = Date.now() - t0;
      console.log(
        `❌ [${ms}ms] exception: ${err instanceof Error ? err.message : String(err)}`,
      );
      fail += 1;
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`[probe] done: ok=${ok}, fail=${fail}`);
  process.exit(fail > 0 && ok === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[probe] fatal:", err);
  process.exit(1);
});
