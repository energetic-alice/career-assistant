import { extractResumeText } from "./file-service.js";
import { fetchResumeFromUrl } from "./url-fetcher.js";
import type { PipelineState } from "../schemas/pipeline-state.js";
import type { ResumeVersion } from "../pipeline/intake.js";

/**
 * Resolves THE BEST resume text we can get for a client + a target role,
 * trying every source we have on file:
 *
 *   1) `outputs.resumeVersions[active]` — already-parsed version (preferred).
 *   2) `outputs.pipelineInput.resumeText` — text from the original intake.
 *   3) `outputs.analysisInput.resumeText` — same idea, fallback shape.
 *   4) Any Google Drive URL found in `outputs.rawNamedValues` /
 *      `pipelineInput.resumeUrl`. If multiple URLs are present, we
 *      download all of them and pick the one with the most
 *      role-keyword overlap.
 *
 * Returns `null` when we have nothing at all.
 */

export interface ResolvedResume {
  text: string;
  source:
    | "resumeVersions"
    | "pipelineInput"
    | "analysisInput"
    | "drive_url";
  sourceUrl: string | null;
  /** When source = drive_url, candidate URLs we considered. */
  candidates?: Array<{ url: string; size: number; score: number }>;
}

const RESUME_FIELD_RE = /резюме|resume|cv/i;

export async function resolveResumeText(
  state: PipelineState,
  roleSlug: string,
): Promise<ResolvedResume | null> {
  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;

  const resumeVersions = (outputs.resumeVersions as ResumeVersion[] | undefined) ?? [];
  const activeId = outputs.activeResumeVersionId as string | undefined;
  if (resumeVersions.length > 0) {
    const active =
      resumeVersions.find((v) => v.id === activeId) ??
      resumeVersions[resumeVersions.length - 1];
    if (active?.text) {
      return {
        text: active.text,
        source: "resumeVersions",
        sourceUrl: null,
      };
    }
  }

  const pipelineInput = outputs.pipelineInput as
    | { resumeText?: string; resumeUrl?: string }
    | undefined;
  if (pipelineInput?.resumeText) {
    return {
      text: pipelineInput.resumeText,
      source: "pipelineInput",
      sourceUrl: pipelineInput.resumeUrl ?? null,
    };
  }

  const analysisInput = outputs.analysisInput as
    | { resumeText?: string; resumeUrl?: string }
    | undefined;
  if (analysisInput?.resumeText) {
    return {
      text: analysisInput.resumeText,
      source: "analysisInput",
      sourceUrl: analysisInput.resumeUrl ?? null,
    };
  }

  const urls = collectResumeUrls(state);
  if (urls.length === 0) return null;

  const downloaded = await downloadAll(urls);
  if (downloaded.length === 0) return null;

  const slugKeywords = roleKeywords(roleSlug);
  const scored = downloaded.map((d) => ({
    ...d,
    score: scoreText(d.text, slugKeywords),
  }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  return {
    text: best.text,
    source: "drive_url",
    sourceUrl: best.url,
    candidates: scored.map((s) => ({
      url: s.url,
      size: s.text.length,
      score: s.score,
    })),
  };
}

function collectResumeUrls(state: PipelineState): string[] {
  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const found = new Set<string>();

  const pipelineInput = outputs.pipelineInput as { resumeUrl?: string } | undefined;
  splitUrls(pipelineInput?.resumeUrl).forEach((u) => found.add(u));

  const analysisInput = outputs.analysisInput as { resumeUrl?: string } | undefined;
  splitUrls(analysisInput?.resumeUrl).forEach((u) => found.add(u));

  const rawNamedValues = (outputs.rawNamedValues ?? {}) as Record<string, string | string[]>;
  for (const [key, raw] of Object.entries(rawNamedValues)) {
    if (!RESUME_FIELD_RE.test(key)) continue;
    const arr = Array.isArray(raw) ? raw : [raw];
    for (const v of arr) splitUrls(v).forEach((u) => found.add(u));
  }

  return Array.from(found);
}

function splitUrls(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

async function downloadAll(
  urls: string[],
): Promise<Array<{ url: string; text: string; mimeType: string }>> {
  const out: Array<{ url: string; text: string; mimeType: string }> = [];
  for (const url of urls) {
    try {
      const { buffer, mimeType } = await fetchResumeFromUrl(url);
      const text = await extractResumeText(buffer, mimeType);
      const cleaned = text.trim();
      if (cleaned.length < 100) continue;
      out.push({ url, text: cleaned, mimeType });
    } catch (err) {
      console.warn(
        `[resume-fetcher] ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/**
 * Cheap heuristic: count occurrences of role-specific keywords in the text.
 * Higher score = more relevant resume version for this target role.
 */
function scoreText(text: string, keywords: string[]): number {
  const t = text.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeRe(kw.toLowerCase())}\\b`, "g");
    const matches = t.match(re);
    if (matches) score += matches.length;
  }
  return score;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Lightweight per-slug keyword sets for "which version is more relevant"
 * scoring. Intentionally short; not meant to be authoritative. If a slug
 * is unknown, we fall back to a generic set + the slug itself.
 */
function roleKeywords(slug: string): string[] {
  const generic = [slug.replace(/_/g, " "), slug.replace(/_/g, "-")];
  const map: Record<string, string[]> = {
    devops: [
      "devops", "sre", "kubernetes", "k8s", "docker", "terraform",
      "ansible", "ci/cd", "gitlab", "jenkins", "prometheus", "grafana",
      "aws", "gcp", "helm", "argocd", "observability", "platform",
    ],
    frontend_react: [
      "react", "frontend", "next.js", "typescript", "redux", "tailwind",
      "javascript", "webpack", "jest", "css", "html", "ui",
    ],
    backend_python: [
      "python", "django", "flask", "fastapi", "celery", "postgres",
      "sqlalchemy", "backend",
    ],
    backend_nodejs: [
      "node.js", "node", "typescript", "express", "nestjs", "javascript",
      "backend",
    ],
    backend_java: [
      "java", "spring", "spring boot", "maven", "gradle", "hibernate",
    ],
    backend_go: ["go", "golang", "grpc", "gin", "kubernetes"],
    data_engineer: [
      "spark", "airflow", "etl", "kafka", "data engineer", "dbt",
      "snowflake", "hadoop", "data warehouse",
    ],
    data_analyst: ["sql", "tableau", "power bi", "data analyst", "metabase"],
    ml_engineer: ["machine learning", "ml", "pytorch", "tensorflow", "mlops"],
    qa_engineer: ["qa", "quality assurance", "selenium", "playwright", "testing"],
    manual_testing: ["manual testing", "test cases", "qa", "regression"],
    product_manager: ["product manager", "roadmap", "stakeholders", "prd"],
    product_analyst: ["product analyst", "ab test", "amplitude", "mixpanel"],
    business_analyst: ["business analyst", "bpmn", "requirements", "user stories"],
    systems_analyst: ["systems analyst", "swagger", "openapi", "architecture"],
  };
  return [...generic, ...(map[slug] ?? [])];
}
