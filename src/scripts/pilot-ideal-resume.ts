import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  generateIdealResumeData,
  type GeneratedIdealResumeData,
} from "../services/ideal-resume-generator.js";
import { resolveResumeText } from "../services/resume-fetcher.js";
import type { PipelineState } from "../schemas/pipeline-state.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import type { IdealResume } from "../schemas/ideal-resume.js";
import type { ResumeVersion, SelectedTargetRole } from "../pipeline/intake.js";

/**
 * Pilot runner: generate ideal resume for N clients (DRY RUN — no Google Doc).
 *
 * Usage:
 *   PROD_URL=https://career-assistant-w7z3.onrender.com \
 *   ANTHROPIC_API_KEY=... \
 *   npx tsx src/scripts/pilot-ideal-resume.ts \
 *     --slug devops \
 *     --nicks khaitov1,energetic_alice,aaaaa11177771
 *
 * Output:
 *   - JSON files in app/data/pilot-results/<slug>-<nick>.json
 *   - Pretty markdown rendering printed to stdout for quick eyeballing.
 *
 * Notes:
 *   - We DO NOT touch state on prod.
 *   - We synthesize a SelectedTargetRole locally so the client need not have it.
 */

const PROD_URL =
  process.env.PROD_URL || "https://career-assistant-w7z3.onrender.com";

interface CliArgs {
  slug: string;
  nicks: string[];
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let slug = "devops";
  let nicks: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--slug" && args[i + 1]) {
      slug = args[i + 1];
      i++;
    } else if (args[i] === "--nicks" && args[i + 1]) {
      nicks = args[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    }
  }
  if (nicks.length === 0) {
    throw new Error(
      "Usage: pilot-ideal-resume.ts --slug devops --nicks nick1,nick2",
    );
  }
  return { slug, nicks };
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

function syntheticTarget(slug: string): SelectedTargetRole {
  return {
    id: `pilot-${slug}`,
    selectedAt: new Date().toISOString(),
    source: "shortlist",
    roleSlug: slug,
    title: slug,
    bucket: "abroad",
  };
}

function prettyResume(r: IdealResume): string {
  const lines: string[] = [];
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push(`${r.fullName}    —    ${r.title}`);
  lines.push(r.contactLine);
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");
  lines.push("SUMMARY:");
  lines.push(r.summary);
  lines.push("");

  lines.push("─── SKILLS ────────────────────────────────────────────────────");
  for (const s of r.skills) {
    lines.push(`  ${s.category}: ${s.items.join(", ")}`);
  }
  lines.push("");

  lines.push("─── EXPERIENCE ────────────────────────────────────────────────");
  for (const job of r.experience) {
    lines.push("");
    lines.push(`▸ ${job.company}    (${job.location})`);
    lines.push(`  ${job.jobTitle}    ${job.period}`);
    if (job.projects?.length) {
      for (const p of job.projects) lines.push(`  · ${p.label}`);
    }
    for (const b of job.bullets) lines.push(`    • ${b}`);
    if (job.technologies) lines.push(`  Technologies: ${job.technologies}`);
  }
  lines.push("");

  if (r.certifications?.length) {
    lines.push("─── CERTIFICATIONS ────────────────────────────────────────────");
    for (const c of r.certifications) {
      lines.push(`  · ${c.name}${c.date ? `   ${c.date}` : ""}`);
    }
    lines.push("");
  }

  if (r.education?.length) {
    lines.push("─── EDUCATION ─────────────────────────────────────────────────");
    for (const e of r.education) lines.push(`  · ${e.text}`);
    lines.push("");
  }

  if (r.languages?.length) {
    lines.push("─── LANGUAGES ─────────────────────────────────────────────────");
    lines.push(`  ${r.languages.map((l) => l.text).join("    ")}`);
    lines.push("");
  }

  if (r.recommendations?.length) {
    lines.push("─── RECOMMENDATIONS (для клиента) ─────────────────────────────");
    for (const rec of r.recommendations) {
      const eff = rec.estimatedEffort ? ` [${rec.estimatedEffort}]` : "";
      lines.push(`  · [${rec.type}]${eff} ${rec.text}`);
      if (rec.rationale) lines.push(`      → ${rec.rationale}`);
    }
    lines.push("");
  }

  if (r.redFlags?.length) {
    lines.push("─── RED FLAGS (что увидит интервьюер) ─────────────────────────");
    const sevIcon: Record<string, string> = {
      high: "🔴",
      medium: "🟡",
      low: "🟢",
    };
    for (const f of r.redFlags) {
      lines.push(`  ${sevIcon[f.severity] ?? "·"}  ${f.text}`);
      if (f.suggestion) lines.push(`      ↳ ${f.suggestion}`);
    }
    lines.push("");
  }

  if (r.addedSkills?.length) {
    lines.push("─── ADDED SKILLS (мы дописали — клиенту доучить) ──────────────");
    for (const s of r.addedSkills) {
      const eff = s.learnInDays ? ` [${s.learnInDays}]` : "";
      lines.push(`  · ${s.name}${eff}${s.why ? ` — ${s.why}` : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

interface ProcessResult {
  nick: string;
  ok: boolean;
  data?: GeneratedIdealResumeData;
  error?: string;
  resumeSource?: string;
  resumeUrl?: string | null;
  resumeChars?: number;
  candidates?: Array<{ url: string; size: number; score: number }>;
}

async function processClient(
  state: PipelineState,
  slug: string,
): Promise<ProcessResult> {
  const nick = state.telegramNick;
  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const clientSummary = outputs.clientSummary as ClientSummary | undefined;
  if (!clientSummary) {
    return { nick, ok: false, error: "no clientSummary on prod" };
  }

  const resumeVersions = (outputs.resumeVersions as ResumeVersion[] | undefined) ?? [];
  const activeResumeVersionId = outputs.activeResumeVersionId as string | undefined;
  const linkedinUrl = clientSummary.linkedinUrl;

  console.log(`\n[Pilot] ${nick}: resolving resume text for slug=${slug}…`);
  const resolved = await resolveResumeText(state, slug);
  if (!resolved) {
    console.log(`[Pilot] ${nick}: NO resume found anywhere`);
  } else {
    console.log(
      `[Pilot] ${nick}: resume source=${resolved.source} chars=${resolved.text.length}` +
        (resolved.sourceUrl ? ` url=${resolved.sourceUrl}` : ""),
    );
    if (resolved.candidates && resolved.candidates.length > 1) {
      for (const c of resolved.candidates) {
        console.log(
          `   · candidate score=${c.score} size=${c.size}  ${c.url}`,
        );
      }
    }
  }

  try {
    const data = await generateIdealResumeData({
      participantId: state.participantId,
      nick,
      target: syntheticTarget(slug),
      clientSummary,
      resumeVersions,
      activeResumeVersionId,
      linkedinUrl,
      preloadedResume: resolved
        ? { text: resolved.text, sourceUrl: resolved.sourceUrl }
        : null,
    });
    return {
      nick,
      ok: true,
      data,
      resumeSource: resolved?.source ?? "none",
      resumeUrl: resolved?.sourceUrl ?? null,
      resumeChars: resolved?.text.length ?? 0,
      candidates: resolved?.candidates,
    };
  } catch (err) {
    return {
      nick,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  const { slug, nicks } = parseArgs();
  console.log(
    `[Pilot] target=${slug}  clients=${nicks.join(",")}  prod=${PROD_URL}`,
  );

  const states = await fetchProdStates();
  console.log(`[Pilot] fetched ${states.length} prod states`);

  const targets = nicks
    .map((n) => ({ nick: n, state: findByNick(states, n) }))
    .filter((t) => {
      if (!t.state) {
        console.warn(`[Pilot] skip ${t.nick} (not found on prod)`);
        return false;
      }
      return true;
    });

  if (targets.length === 0) throw new Error("no targets to process");

  const outDir = join(process.cwd(), "data", "pilot-results");
  await import("node:fs/promises").then((fs) =>
    fs.mkdir(outDir, { recursive: true }),
  );

  const allResults: Array<{ nick: string; ok: boolean }> = [];
  for (const { nick, state } of targets) {
    const result = await processClient(state!, slug);
    allResults.push({ nick: result.nick, ok: result.ok });

    if (!result.ok) {
      console.error(`\n[Pilot] FAILED ${nick}: ${result.error}`);
      continue;
    }

    const r = result.data!;
    const fileBase = `${slug}-${normalize(nick)}`;
    await writeFile(
      join(outDir, `${fileBase}.json`),
      JSON.stringify(r.data, null, 2),
      "utf-8",
    );
    await writeFile(
      join(outDir, `${fileBase}.txt`),
      prettyResume(r.data),
      "utf-8",
    );
    await writeFile(
      join(outDir, `${fileBase}.prompt.md`),
      r.prompt,
      "utf-8",
    );

    console.log("\n" + "█".repeat(75));
    console.log(`█  ${nick}  →  generated for ${slug}`);
    console.log(
      `█  tokens in=${r.usage.in} out=${r.usage.out} ${(r.usage.ms / 1000).toFixed(1)}s`,
    );
    console.log(
      `█  resume source=${result.resumeSource}  chars=${result.resumeChars ?? 0}` +
        (result.resumeUrl ? `\n█  original resume URL: ${result.resumeUrl}` : ""),
    );
    if (result.candidates && result.candidates.length > 1) {
      console.log("█  candidates considered:");
      for (const c of result.candidates) {
        console.log(`█    score=${c.score} size=${c.size}  ${c.url}`);
      }
    }
    console.log("█".repeat(75));
    console.log(prettyResume(r.data));
  }

  console.log("\n[Pilot] summary:");
  for (const r of allResults) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.nick}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
