import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  linkedinAuditSchema,
  headlinePackSchema,
  linkedinPackSchema,
  profileContentSchema,
  recomputeAuditTotals,
  recomputeHeadlineLengths,
  HEADLINE_MAX_LENGTH,
  type LinkedinAudit,
  type HeadlinePack,
  type LinkedinPack,
  type ProfileContent,
} from "../../schemas/linkedin-pack.js";
import type { LinkedinPackInput } from "./build-inputs.js";
import { summariseClientSummary } from "./build-inputs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "..", "..", "prompts", "linkedin");
const AUDIT_PROMPT_PATH = join(PROMPTS_DIR, "01-audit.md");
const HEADLINE_PROMPT_PATH = join(PROMPTS_DIR, "02-headline.md");
const PROFILE_CONTENT_PROMPT_PATH = join(PROMPTS_DIR, "03-profile-content.md");

const MODEL = process.env.LINKEDIN_PACK_MODEL || "claude-sonnet-4-20250514";
const MAX_OUTPUT_TOKENS = 6000;
/** Profile content — тяжёлая фаза, нужно больше tokens. */
const PROFILE_MAX_OUTPUT_TOKENS = 12000;
const HEADLINE_RETRIES = 2;
const PROFILE_CONTENT_RETRIES = 1;

// ── helpers ─────────────────────────────────────────────────────────────────

function unwrapJsonText(raw: string): string {
  let txt = raw.trim();
  if (txt.startsWith("```")) {
    txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  return txt;
}

/**
 * Картинка, прикладываемая к user message. Claude сам скачивает по URL и
 * анализирует — проверено тестом (см. `scripts/test-claude-vision.ts`).
 */
interface CallClaudeImage {
  /** Подпись, которую увидит модель перед картинкой (например, "Аватар LinkedIn"). */
  label: string;
  /** Прямая ссылка. Для LinkedIn — из `basic_info.profile_picture_url`. */
  url: string;
}

async function callClaude(
  prompt: string,
  tag: string,
  maxTokens = MAX_OUTPUT_TOKENS,
  images: CallClaudeImage[] = [],
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const client = new Anthropic();
  const t0 = Date.now();

  // Если картинок нет — классический вариант с plain string prompt.
  // Если есть — собираем multi-modal content array.
  const content =
    images.length === 0
      ? prompt
      : [
          ...images.flatMap((img) => [
            {
              type: "text" as const,
              text: `### ${img.label}`,
            },
            {
              type: "image" as const,
              source: { type: "url", url: img.url } as unknown as {
                type: "url";
                url: string;
              },
            },
          ]),
          { type: "text" as const, text: prompt },
        ];

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content }],
  });
  const ms = Date.now() - t0;

  const block = resp.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error(`[${tag}] Anthropic returned no text block`);
  }

  console.log(
    `[LinkedinPack:${tag}] in=${resp.usage.input_tokens} ` +
      `out=${resp.usage.output_tokens} ${(ms / 1000).toFixed(1)}s` +
      (images.length > 0 ? ` (images=${images.length})` : ""),
  );
  return unwrapJsonText(block.text);
}

function inputSection(input: LinkedinPackInput): string {
  const parts: string[] = [];
  const summaryHeader = input.clientSummary
    ? "## Client summary"
    : "## Client summary (ВНИМАНИЕ: анкеты нет — выведи target-роль/рынок/грейд из LinkedIn + резюме)";
  parts.push(`${summaryHeader}\n\`\`\`\n` + summariseClientSummary(input.clientSummary) + "\n```");

  if (input.linkedin) {
    // Раньше здесь был slice(0, 8000) — 8K символов едва покрывают
    // basic_info + experience, а certifications/languages/education/
    // recommendations (нужные для пунктов 22-26) уезжали за обрезку,
    // и модель честно ставила им unknown. Full-sections actor возвращает
    // 10-40KB JSON, всё должно попасть в промпт. Верхняя граница 50K
    // стоит как страховка от экстремальных профилей (200+ экспы),
    // чтобы не выжрать input-budget Claude целиком.
    const MAX_LINKEDIN_CHARS = 50_000;
    const li = input.linkedin.text;
    const truncated = li.length > MAX_LINKEDIN_CHARS;
    parts.push(
      `## LinkedIn profile (fetched ${input.linkedin.source} at ${input.linkedin.fetchedAt})\n` +
        "```\n" +
        li.slice(0, MAX_LINKEDIN_CHARS) +
        (truncated ? "\n... [truncated at 50K chars]" : "") +
        "\n```",
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

function collectProfileImages(input: LinkedinPackInput): CallClaudeImage[] {
  if (!input.linkedin) return [];
  const out: CallClaudeImage[] = [];
  if (input.linkedin.profilePictureUrl) {
    out.push({
      label: "Profile photo (LinkedIn avatar)",
      url: input.linkedin.profilePictureUrl,
    });
  }
  if (input.linkedin.backgroundPictureUrl) {
    out.push({
      label: "Cover banner (LinkedIn background image)",
      url: input.linkedin.backgroundPictureUrl,
    });
  }
  return out;
}

async function runAudit(input: LinkedinPackInput): Promise<LinkedinAudit> {
  const system = await readFile(AUDIT_PROMPT_PATH, "utf-8");
  const prompt = system + "\n\n---\n\n# Input\n\n" + inputSection(input);

  const images = collectProfileImages(input);
  const raw = await callClaude(prompt, "audit", MAX_OUTPUT_TOKENS, images);

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

// ── Phase 3: profile content ────────────────────────────────────────────────

async function runProfileContent(
  input: LinkedinPackInput,
  audit: LinkedinAudit,
  headline: HeadlinePack,
): Promise<ProfileContent> {
  const system = await readFile(PROFILE_CONTENT_PROMPT_PATH, "utf-8");

  const topHeadline = headline.variants[0]?.text ?? "";
  const extraContext =
    "## Audit priorities\n" +
    audit.topPriorities.map((p) => `- ${p}`).join("\n") +
    `\n\n## Top headline (use as keyword anchor)\n\`\`\`\n${topHeadline}\n\`\`\``;

  let lastError: string | null = null;

  for (let attempt = 0; attempt <= PROFILE_CONTENT_RETRIES; attempt += 1) {
    const retryNote =
      attempt === 0
        ? ""
        : `\n\n**ВНИМАНИЕ (попытка ${attempt + 1}):** прошлый ответ упал на валидации:\n${lastError}\n\nИсправь и верни валидный JSON по схеме.`;

    const prompt =
      system +
      "\n\n---\n\n# Input\n\n" +
      inputSection(input) +
      "\n\n" +
      extraContext +
      retryNote;

    let raw: string;
    try {
      raw = await callClaude(
        prompt,
        `profile#${attempt + 1}`,
        PROFILE_MAX_OUTPUT_TOKENS,
      );
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      lastError = `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[LinkedinPack:profile] attempt ${attempt + 1} ${lastError}`);
      continue;
    }

    try {
      return profileContentSchema.parse(parsed);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[LinkedinPack:profile] attempt ${attempt + 1} schema fail: ${lastError}`,
      );
    }
  }

  throw new Error(
    `[profile] failed after ${PROFILE_CONTENT_RETRIES + 1} attempts: ${lastError ?? "unknown"}`,
  );
}

// ── Public ─────────────────────────────────────────────────────────────────

export interface RunLinkedinPackResult {
  data: LinkedinPack;
  model: string;
  timings: { auditMs: number; headlineMs: number; profileMs: number };
}

/**
 * Вызывается между фазами. Позволяет Telegram-боту обновлять «Фаза X/3…»
 * в progress-сообщении. Ошибки внутри callback'а глотаются — они не должны
 * прерывать пайплайн.
 */
export type LinkedinPackProgressCallback = (
  stage: "headline" | "profile",
  audit: LinkedinAudit,
) => Promise<void> | void;

export interface RunLinkedinPackOpts {
  onProgress?: LinkedinPackProgressCallback;
}

export async function runLinkedinPack(
  input: LinkedinPackInput,
  opts: RunLinkedinPackOpts = {},
): Promise<RunLinkedinPackResult> {
  const auditStart = Date.now();
  const audit = await runAudit(input);
  const auditMs = Date.now() - auditStart;

  if (opts.onProgress) {
    try {
      await opts.onProgress("headline", audit);
    } catch (err) {
      console.warn(`[LinkedinPack] onProgress(headline) failed: ${String(err)}`);
    }
  }

  const headlineStart = Date.now();
  const headline = await runHeadline(input, audit);
  const headlineMs = Date.now() - headlineStart;

  if (opts.onProgress) {
    try {
      await opts.onProgress("profile", audit);
    } catch (err) {
      console.warn(`[LinkedinPack] onProgress(profile) failed: ${String(err)}`);
    }
  }

  // Phase 3 тяжёлая и более склонна к сбоям. Если упала — не роняем весь
  // пакет, отдаём audit+headline и куратор сможет сгенерировать Phase 3
  // отдельно / позже.
  const profileStart = Date.now();
  let profileContent: ProfileContent | undefined;
  try {
    profileContent = await runProfileContent(input, audit, headline);
  } catch (err) {
    console.warn(
      `[LinkedinPack:profile] phase failed, continuing without it: ${String(err)}`,
    );
  }
  const profileMs = Date.now() - profileStart;

  const selectedRoles = input.clientSummary?.selectedTargetRoles ?? [];
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
    profileContent,
  };

  return {
    data: linkedinPackSchema.parse(pack),
    model: MODEL,
    timings: { auditMs, headlineMs, profileMs },
  };
}
