import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resumeAuditSchema,
  resumePackSchema,
  recomputeResumeAuditTotals,
  type ResumeAudit,
  type ResumePack,
} from "../../schemas/resume-pack.js";
import type { ResumePackInput } from "./build-inputs.js";
import { summariseClientSummary } from "./build-inputs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "..", "..", "prompts", "resume");
const AUDIT_PROMPT_PATH = join(PROMPTS_DIR, "01-audit.md");

const MODEL = process.env.RESUME_PACK_MODEL || "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS = 6000;

// ── helpers ─────────────────────────────────────────────────────────────────

function unwrapJsonText(raw: string): string {
  let txt = raw.trim();
  if (txt.startsWith("```")) {
    txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  return txt;
}

async function callClaude(
  prompt: string,
  tag: string,
  maxTokens = MAX_OUTPUT_TOKENS,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const client = new Anthropic();
  const t0 = Date.now();

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const ms = Date.now() - t0;

  const block = resp.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error(`[${tag}] Anthropic returned no text block`);
  }

  console.log(
    `[ResumePack:${tag}] in=${resp.usage.input_tokens} ` +
      `out=${resp.usage.output_tokens} ${(ms / 1000).toFixed(1)}s`,
  );
  return unwrapJsonText(block.text);
}

function inputSection(input: ResumePackInput): string {
  const parts: string[] = [];

  // Текущая дата — критична для корректного подсчёта длительности позиций,
  // в которых стоит `now` / `present` / `по настоящее время`. Без неё модель
  // считает `now` ≈ cutoff своих знаний (декабрь 2024) и занижает стаж
  // на 1-1.5 года. Формат `YYYY-MM-DD (Month YYYY)` — чтобы было видно
  // оба представления одновременно.
  const now = new Date();
  const monthName = now.toLocaleString("en-US", { month: "long" });
  const today = `${now.toISOString().slice(0, 10)} (${monthName} ${now.getUTCFullYear()})`;
  parts.push(`## Today\n${today}\n\nИспользуй эту дату как **end-date** для всех позиций, где стоит \`now\` / \`Present\` / \`current\` / \`по настоящее время\`. **Не подменяй её** на cutoff своих знаний.`);

  const summaryHeader = input.clientSummary
    ? "## Client summary"
    : "## Client summary (анкеты нет — выведи target-роль/рынок/грейд из самого резюме)";
  parts.push(`${summaryHeader}\n\`\`\`\n` + summariseClientSummary(input.clientSummary) + "\n```");

  // Резюме — главный вход. Кладём целиком (или ограничиваем сверху).
  const MAX_RESUME_CHARS = 25_000;
  const resumeText = input.resume.text;
  const truncated = resumeText.length > MAX_RESUME_CHARS;
  parts.push(
    `## Resume (text, version ${input.resume.versionId ?? "—"})\n` +
      "```\n" +
      resumeText.slice(0, MAX_RESUME_CHARS) +
      (truncated ? "\n... [truncated at 25K chars]" : "") +
      "\n```",
  );

  // LinkedIn — опциональный cross-check.
  if (input.linkedin) {
    const MAX_LINKEDIN_CHARS = 30_000;
    const li = input.linkedin.text;
    const liTrunc = li.length > MAX_LINKEDIN_CHARS;
    parts.push(
      `## LinkedIn profile (fetched ${input.linkedin.source} at ${input.linkedin.fetchedAt}) — для cross-check\n` +
        "```\n" +
        li.slice(0, MAX_LINKEDIN_CHARS) +
        (liTrunc ? "\n... [truncated at 30K chars]" : "") +
        "\n```",
    );
  } else if (input.linkedinUrl) {
    parts.push(
      `## LinkedIn profile\nNOT FETCHED (URL: ${input.linkedinUrl}). Не используй для cross-check; в рекомендации пункта 5 можешь использовать этот URL как готовый.`,
    );
  } else {
    parts.push(
      "## LinkedIn profile\nNOT AVAILABLE — оценивай резюме отдельно. В пункте 5, если LinkedIn-URL'а нет в резюме, пиши «создай LinkedIn и добавь ссылку».",
    );
  }

  return parts.join("\n\n");
}

// ── Phase 1: audit ──────────────────────────────────────────────────────────

async function runAudit(input: ResumePackInput): Promise<ResumeAudit> {
  const system = await readFile(AUDIT_PROMPT_PATH, "utf-8");
  const prompt = system + "\n\n---\n\n# Input\n\n" + inputSection(input);

  const raw = await callClaude(prompt, "audit", MAX_OUTPUT_TOKENS);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[audit] JSON parse failed: ${err instanceof Error ? err.message : String(err)}\n` +
        `--- raw (first 1500) ---\n${raw.slice(0, 1500)}`,
    );
  }

  let audit: ResumeAudit;
  try {
    audit = resumeAuditSchema.parse(parsed);
  } catch (err) {
    throw new Error(
      `[audit] schema validation failed: ${err instanceof Error ? err.message : String(err)}\n` +
        `--- raw output ---\n${raw.slice(0, 2000)}`,
    );
  }

  return recomputeResumeAuditTotals(audit);
}

// ── Public ─────────────────────────────────────────────────────────────────

export interface RunResumePackResult {
  data: ResumePack;
  model: string;
  timings: {
    auditMs: number;
  };
}

export type ResumePackProgressCallback = (
  stage: "audit_done",
  audit: ResumeAudit,
) => Promise<void> | void;

export interface RunResumePackOpts {
  onProgress?: ResumePackProgressCallback;
}

export async function runResumePack(
  input: ResumePackInput,
  opts: RunResumePackOpts = {},
): Promise<RunResumePackResult> {
  const selectedRoles = input.clientSummary?.selectedTargetRoles ?? [];
  const firstTarget = selectedRoles[0];

  const auditStart = Date.now();
  const audit = await runAudit(input);
  const auditMs = Date.now() - auditStart;

  if (opts.onProgress) {
    try {
      await opts.onProgress("audit_done", audit);
    } catch (err) {
      console.warn(`[ResumePack] onProgress(audit_done) failed: ${String(err)}`);
    }
  }

  const pack: ResumePack = {
    meta: {
      participantId: input.participantId,
      nick: input.nick,
      generatedAt: new Date().toISOString(),
      model: MODEL,
      resumeVersionId: input.resume.versionId,
      usedLinkedinProfile: !!input.linkedin,
      targetRoleSlug: firstTarget?.roleSlug ?? null,
      targetRoleTitle: firstTarget?.title ?? null,
      // Модель проставила targetMarket в самом audit JSON — переносим в meta
      // и удаляем из audit, чтобы артефакт не дублировал значение.
      targetMarket: audit.targetMarket ?? null,
    },
    audit,
  };

  return {
    data: resumePackSchema.parse(pack),
    model: MODEL,
    timings: { auditMs },
  };
}
