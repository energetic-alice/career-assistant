import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  linkedinAuditSchema,
  headlinePackSchema,
  linkedinPackSchema,
  recomputeAuditTotals,
  recomputeHeadlineLengths,
  HEADLINE_MAX_LENGTH,
  type LinkedinAudit,
  type HeadlinePack,
  type LinkedinPack,
} from "../../schemas/linkedin-pack.js";
import type { LinkedinPackInput } from "./build-inputs.js";
import { summariseClientSummary } from "./build-inputs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "..", "..", "prompts", "linkedin");
const AUDIT_PROMPT_PATH = join(PROMPTS_DIR, "01-audit.md");
const HEADLINE_PROMPT_PATH = join(PROMPTS_DIR, "02-headline.md");

const MODEL = process.env.LINKEDIN_PACK_MODEL || "claude-sonnet-4-20250514";
const MAX_OUTPUT_TOKENS = 6000;
const HEADLINE_RETRIES = 2;

// ── helpers ─────────────────────────────────────────────────────────────────

function unwrapJsonText(raw: string): string {
  let txt = raw.trim();
  if (txt.startsWith("```")) {
    txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  return txt;
}

async function callClaude(prompt: string, tag: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const client = new Anthropic();
  const t0 = Date.now();
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: "user", content: prompt }],
  });
  const ms = Date.now() - t0;

  const block = resp.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error(`[${tag}] Anthropic returned no text block`);
  }

  console.log(
    `[LinkedinPack:${tag}] in=${resp.usage.input_tokens} ` +
      `out=${resp.usage.output_tokens} ${(ms / 1000).toFixed(1)}s`,
  );
  return unwrapJsonText(block.text);
}

function inputSection(input: LinkedinPackInput): string {
  const parts: string[] = [];
  parts.push("## Client summary\n```\n" + summariseClientSummary(input.clientSummary) + "\n```");

  if (input.linkedin) {
    parts.push(
      `## LinkedIn profile (fetched ${input.linkedin.source} at ${input.linkedin.fetchedAt})\n` +
        "```\n" + input.linkedin.text.slice(0, 8000) + "\n```",
    );
  } else {
    parts.push(
      `## LinkedIn profile\nNOT AVAILABLE${
        input.linkedinUrl ? ` (URL: ${input.linkedinUrl}, fetch failed)` : " (no URL provided)"
      }. Mark all LinkedIn-only audit items as \`unknown\` and add "проверь руками" to recommendation.`,
    );
  }

  if (input.resume) {
    parts.push(
      "## Resume\n```\n" + input.resume.text.slice(0, 10000) + "\n```",
    );
  } else {
    parts.push("## Resume\nNOT AVAILABLE — rely on LinkedIn + client summary only.");
  }
  return parts.join("\n\n");
}

// ── Phase 1: audit ──────────────────────────────────────────────────────────

async function runAudit(input: LinkedinPackInput): Promise<LinkedinAudit> {
  const system = await readFile(AUDIT_PROMPT_PATH, "utf-8");
  const prompt = system + "\n\n---\n\n# Input\n\n" + inputSection(input);

  const raw = await callClaude(prompt, "audit");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[audit] JSON parse failed: ${err instanceof Error ? err.message : String(err)}\n` +
        `--- raw (first 1500) ---\n${raw.slice(0, 1500)}`,
    );
  }

  let audit: LinkedinAudit;
  try {
    audit = linkedinAuditSchema.parse(parsed);
  } catch (err) {
    throw new Error(
      `[audit] schema validation failed: ${err instanceof Error ? err.message : String(err)}\n` +
        `--- raw output ---\n${raw.slice(0, 2000)}`,
    );
  }

  return recomputeAuditTotals(audit);
}

// ── Phase 2: headline ───────────────────────────────────────────────────────

async function runHeadline(
  input: LinkedinPackInput,
  audit: LinkedinAudit,
): Promise<HeadlinePack> {
  const system = await readFile(HEADLINE_PROMPT_PATH, "utf-8");

  const auditContext =
    "auditTopPriorities:\n" +
    audit.topPriorities.map((p) => `- ${p}`).join("\n");

  let lastError: string | null = null;

  for (let attempt = 0; attempt <= HEADLINE_RETRIES; attempt += 1) {
    const retryNote =
      attempt === 0
        ? ""
        : `\n\n**ВНИМАНИЕ (попытка ${attempt + 1}):** прошлый ответ упал на валидации:\n${lastError}\n\nИсправь: каждый вариант ≤ ${HEADLINE_MAX_LENGTH} символов, length === text.length.`;

    const prompt =
      system +
      "\n\n---\n\n# Input\n\n" +
      inputSection(input) +
      "\n\n## Audit priorities\n" +
      auditContext +
      retryNote;

    let raw: string;
    try {
      raw = await callClaude(prompt, `headline#${attempt + 1}`);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      lastError = `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[LinkedinPack:headline] attempt ${attempt + 1} ${lastError}`);
      continue;
    }

    try {
      const pack = headlinePackSchema.parse(parsed);
      return recomputeHeadlineLengths(pack);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(`[LinkedinPack:headline] attempt ${attempt + 1} schema fail: ${lastError}`);
    }
  }

  throw new Error(
    `[headline] failed after ${HEADLINE_RETRIES + 1} attempts: ${lastError ?? "unknown"}`,
  );
}

// ── Public ─────────────────────────────────────────────────────────────────

export interface RunLinkedinPackResult {
  data: LinkedinPack;
  model: string;
  timings: { auditMs: number; headlineMs: number };
}

export async function runLinkedinPack(
  input: LinkedinPackInput,
): Promise<RunLinkedinPackResult> {
  const auditStart = Date.now();
  const audit = await runAudit(input);
  const auditMs = Date.now() - auditStart;

  const headlineStart = Date.now();
  const headline = await runHeadline(input, audit);
  const headlineMs = Date.now() - headlineStart;

  const selectedRoles = input.clientSummary.selectedTargetRoles ?? [];
  const firstTarget = selectedRoles[0];

  const pack: LinkedinPack = {
    meta: {
      participantId: input.participantId,
      nick: input.nick,
      generatedAt: new Date().toISOString(),
      model: MODEL,
      usedLinkedinProfile: !!input.linkedin,
      usedResume: !!input.resume,
      linkedinUrl: input.linkedinUrl,
      targetRoleSlug: firstTarget?.roleSlug ?? null,
      targetRoleTitle: firstTarget?.title ?? null,
    },
    audit,
    headline,
  };

  return {
    data: linkedinPackSchema.parse(pack),
    model: MODEL,
    timings: { auditMs, headlineMs },
  };
}
