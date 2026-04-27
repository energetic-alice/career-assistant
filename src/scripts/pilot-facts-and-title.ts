import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveResumeText } from "../services/resume-fetcher.js";
import { fetchLinkedinProfile } from "../services/linkedin-fetcher.js";
import { extractClientFacts } from "../services/ideal-resume/extract-facts.js";
import { resolveTitle } from "../services/ideal-resume/resolve-title.js";
import { checkRelocation } from "../services/ideal-resume/check-relocation.js";
import { getMarketPreset, type MarketCode } from "../services/ideal-resume/markets.js";
import { loadRolePattern } from "../services/ideal-resume-generator.js";
import { listClientNotes } from "../pipeline/client-notes.js";
import type { PipelineState } from "../schemas/pipeline-state.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import type { ClientFacts } from "../schemas/client-facts.js";

/**
 * Pilot for milestones M2 (extract-facts) + M3 (resolve-title + relocation).
 *
 * Usage:
 *   PROD_URL=https://career-assistant-w7z3.onrender.com \
 *   ANTHROPIC_API_KEY=... \
 *   npx tsx src/scripts/pilot-facts-and-title.ts \
 *     --slug devops --market ru \
 *     --nicks khaitov1,energetic_alice,aaaaa11177771
 *
 * For each nick:
 *   1. resolveResumeText → preloaded resume text
 *   2. fetchLinkedinProfile (if URL exists in clientSummary)
 *   3. extractClientFacts (LLM)
 *   4. resolveTitle (deterministic)
 *   5. checkRelocation (deterministic)
 *
 * Writes:
 *   data/pilot-facts/<slug>-<nick>.facts.json
 *   data/pilot-facts/<slug>-<nick>.facts.prompt.md
 *   data/pilot-facts/<slug>-<nick>.title.json
 *   data/pilot-facts/<slug>-<nick>.relocation.json
 */

const PROD_URL =
  process.env.PROD_URL || "https://career-assistant-w7z3.onrender.com";

interface CliArgs {
  slug: string;
  nicks: string[];
  market: MarketCode;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let slug = "devops";
  let nicks: string[] = [];
  let market: MarketCode = "ru";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--slug" && args[i + 1]) {
      slug = args[i + 1];
      i++;
    } else if (args[i] === "--nicks" && args[i + 1]) {
      nicks = args[i + 1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i++;
    } else if (args[i] === "--market" && args[i + 1]) {
      market = args[i + 1] as MarketCode;
      i++;
    }
  }
  if (nicks.length === 0) {
    throw new Error(
      "Usage: pilot-facts-and-title.ts --slug devops --market ru --nicks nick1,nick2",
    );
  }
  return { slug, nicks, market };
}

function normalize(s: string | null | undefined): string {
  return (s || "").replace(/^@/, "").toLowerCase();
}

async function fetchProdStates(): Promise<PipelineState[]> {
  const res = await fetch(`${PROD_URL}/api/participants`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PipelineState[];
}

function findByNick(states: PipelineState[], nick: string): PipelineState | undefined {
  const wanted = normalize(nick);
  return states.find((s) => normalize(s.telegramNick) === wanted);
}

function prettyFacts(facts: ClientFacts): string {
  const lines: string[] = [];
  lines.push("═══ NAME / CONTACTS ═══");
  lines.push(
    `  Latin: ${facts.fullNameLatin || "(empty)"}    Native: ${facts.fullNameNative || "(empty)"}`,
  );
  lines.push(
    `  email=${facts.contacts.email || "—"}  phone=${facts.contacts.phone || "—"}  tg=@${facts.contacts.telegramNick || "—"}`,
  );
  lines.push(
    `  linkedin=${facts.contacts.linkedinUrl || "—"}\n  github=${facts.contacts.githubUrl || "—"}`,
  );
  if (facts.contacts.portfolioUrls.length) {
    lines.push(`  portfolio: ${facts.contacts.portfolioUrls.join(", ")}`);
  }
  lines.push("");
  lines.push("═══ LOCATION / CITIZENSHIP ═══");
  lines.push(
    `  location=${facts.location || "—"}  country=${facts.country || "—"}  desired=${facts.desiredLocation || "—"}`,
  );
  if (facts.citizenships.length) {
    lines.push(`  citizenships: ${facts.citizenships.join(", ")}`);
  }
  lines.push("");
  lines.push("═══ CAREER ═══");
  lines.push(
    `  yearsExperience=${facts.yearsExperience || "—"}  grade=${facts.currentGrade || "—"}`,
  );
  if (facts.oneLiner) lines.push(`  oneLiner: ${facts.oneLiner}`);
  if (facts.languages.length) {
    lines.push(`  languages: ${facts.languages.map((l) => `${l.language}${l.level ? ` (${l.level})` : ""}`).join(", ")}`);
  }
  lines.push("");
  lines.push(`═══ RAW SKILLS (${facts.rawSkills.length}) ═══`);
  lines.push("  " + facts.rawSkills.slice(0, 60).join(", "));
  if (facts.rawSkills.length > 60) lines.push(`  …and ${facts.rawSkills.length - 60} more`);
  lines.push("");
  lines.push(`═══ EDUCATION (${facts.education.length}) ═══`);
  for (const e of facts.education) {
    const tag = e.isAdditionalCourse ? " [course]" : "";
    lines.push(`  · ${e.raw}${tag}`);
  }
  lines.push("");
  if (facts.certifications.length) {
    lines.push(`═══ CERTIFICATIONS (${facts.certifications.length}) ═══`);
    for (const c of facts.certifications) {
      lines.push(`  · ${c.name} — ${c.issuer || "—"} (${c.date || "—"})`);
    }
    lines.push("");
  }
  lines.push(`═══ EXPERIENCE (${facts.experience.length}) ═══`);
  for (const exp of facts.experience) {
    lines.push("");
    lines.push(`  ▸ ${exp.companyName}    [${exp.industry || "—"}]   ${exp.location || ""}`);
    lines.push(`    ${exp.jobTitle}   ${exp.period}`);
    if (exp.projects.length) {
      lines.push(`    projects: ${exp.projects.join(" · ")}`);
    }
    for (const b of exp.bullets) lines.push(`      • ${b}`);
    if (exp.technologies.length) {
      lines.push(`    tech: ${exp.technologies.join(", ")}`);
    }
  }
  return lines.join("\n");
}

async function processClient(
  state: PipelineState,
  slug: string,
  market: MarketCode,
  outDir: string,
): Promise<{ nick: string; ok: boolean; error?: string }> {
  const nick = state.telegramNick;
  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const clientSummary = outputs.clientSummary as ClientSummary | undefined;
  const rawNamedValues = outputs.rawNamedValues as Record<string, string> | undefined;
  const fileBase = `${slug}-${normalize(nick)}`;

  console.log(`\n=== ${nick} ===`);

  const resolved = await resolveResumeText(state, slug);
  console.log(
    resolved
      ? `  resume: source=${resolved.source} chars=${resolved.text.length}` +
          (resolved.sourceUrl ? `  url=${resolved.sourceUrl}` : "")
      : "  resume: NONE",
  );

  let linkedinProfile = null;
  if (clientSummary?.linkedinUrl) {
    try {
      linkedinProfile = await fetchLinkedinProfile(clientSummary.linkedinUrl);
      console.log(
        linkedinProfile
          ? `  linkedin: source=${linkedinProfile.source} chars=${linkedinProfile.text.length}`
          : "  linkedin: NONE (fetch failed)",
      );
    } catch (err) {
      console.log(
        `  linkedin: ERROR ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    console.log("  linkedin: NONE (no URL)");
  }

  const notes = listClientNotes(state.participantId).map((n) => n.text);

  let facts: ClientFacts;
  let factsPrompt: string;
  try {
    const r = await extractClientFacts({
      resumeText: resolved?.text,
      linkedinProfile,
      clientSummary,
      rawNamedValues,
      clientNotes: notes,
      telegramNick: nick,
    });
    facts = r.facts;
    factsPrompt = r.prompt;
    console.log(
      `  facts OK: experience=${facts.experience.length} education=${facts.education.length} skills=${facts.rawSkills.length} certs=${facts.certifications.length}` +
        ` (in=${r.usage.in} out=${r.usage.out} ms=${r.usage.ms})`,
    );
  } catch (err) {
    console.error(`  facts FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return { nick, ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  await writeFile(join(outDir, `${fileBase}.facts.json`), JSON.stringify(facts, null, 2), "utf-8");
  await writeFile(join(outDir, `${fileBase}.facts.txt`), prettyFacts(facts), "utf-8");
  await writeFile(join(outDir, `${fileBase}.facts.prompt.md`), factsPrompt, "utf-8");

  const rolePattern = await loadRolePattern(slug);
  const marketPreset = await getMarketPreset(market);
  const titleResult = resolveTitle({
    facts,
    rolePattern,
    market,
    marketPreset,
    targetRoleTitle: rolePattern?.displayTitle ?? slug,
  });
  console.log(`  title: "${titleResult.title}"  (${titleResult.reason})`);
  await writeFile(
    join(outDir, `${fileBase}.title.json`),
    JSON.stringify(titleResult, null, 2),
    "utf-8",
  );

  const relocation = await checkRelocation(facts);
  if (relocation.length > 0) {
    console.log(`  relocation findings: ${relocation.length}`);
    for (const r of relocation) {
      console.log(`    [${r.severity}] ${r.ruleId}: ${r.note.slice(0, 120)}…`);
    }
  } else {
    console.log("  relocation: no findings");
  }
  await writeFile(
    join(outDir, `${fileBase}.relocation.json`),
    JSON.stringify(relocation, null, 2),
    "utf-8",
  );

  return { nick, ok: true };
}

async function main() {
  const { slug, nicks, market } = parseArgs();
  console.log(`[Pilot M2/M3] slug=${slug} market=${market} clients=${nicks.join(",")}`);

  const states = await fetchProdStates();
  console.log(`  fetched ${states.length} prod states`);

  const targets = nicks
    .map((n) => ({ nick: n, state: findByNick(states, n) }))
    .filter((t) => {
      if (!t.state) {
        console.warn(`  skip ${t.nick} (not found on prod)`);
        return false;
      }
      return true;
    });
  if (targets.length === 0) throw new Error("no targets");

  const outDir = join(process.cwd(), "data", "pilot-facts");
  await mkdir(outDir, { recursive: true });

  const results: Array<{ nick: string; ok: boolean }> = [];
  for (const { state } of targets) {
    const r = await processClient(state!, slug, market, outDir);
    results.push({ nick: r.nick, ok: r.ok });
  }

  console.log("\n[Pilot M2/M3] summary:");
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.nick}`);
  }
  console.log(`\n[Pilot M2/M3] outputs in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
