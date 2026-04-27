import { z } from "zod";

/**
 * Strict shape of an "ideal resume" produced by the generator.
 * Maps 1:1 onto the Google Doc template placeholders/blocks (see
 * `createIdealResumeTemplate` in `scripts/google-apps-script.js`):
 *
 *   simple:
 *     {{full_name}}     ← fullName
 *     {{title}}         ← title
 *     {{contact_line}}  ← contactLine
 *     {{summary}}       ← summary
 *
 *   blocks:
 *     {{skills_block}}         ← skills (Category: items, joined)
 *     {{experience_block}}     ← experience (companies → projects → bullets → tech)
 *     {{certifications_block}} ← certifications
 *     {{education_block}}      ← education
 *     {{languages_block}}      ← languages
 *
 * Renderer turns this into the Apps Script payload.
 */

export const idealResumeSkillCategorySchema = z.object({
  category: z.string().min(1).max(80),
  items: z.array(z.string().min(1)).min(1).max(30),
});

export const idealResumeExperienceProjectSchema = z.object({
  /** "Project 1: Gamified education platform…" — already includes "Project N:" prefix when present. */
  label: z.string().min(1).max(300),
});

export const idealResumeExperienceItemSchema = z.object({
  /** "Gamify, B2B SaaS EdTech startup, 1400+ active users". Keep concise. */
  company: z.string().min(1).max(200),
  /** "Remote" / "Porto, Portugal" / "On-site". */
  location: z.string().max(80).default(""),
  /** "Platform DevOps Engineer". */
  jobTitle: z.string().min(1).max(150),
  /** "March 2022 – now". */
  period: z.string().min(1).max(80),
  /** Optional list of project lines (italic). May be empty. */
  projects: z.array(idealResumeExperienceProjectSchema).max(8).default([]),
  /** Plain bullet points without leading "*". 3-8 typical. */
  bullets: z.array(z.string().min(1).max(500)).min(1).max(15),
  /** Single comma-separated technologies line; rendered with grey colour. */
  technologies: z.string().max(2000).default(""),
});

export const idealResumeCertificationSchema = z.object({
  /** "AWS Cloud Practitioner". */
  name: z.string().min(1).max(200),
  /** "Dec 2025". */
  date: z.string().max(40).default(""),
});

export const idealResumeEducationItemSchema = z.object({
  /** "BA in Computer Science, Moscow Engineering Physics Institute MEPHI". */
  text: z.string().min(1).max(300),
});

export const idealResumeLanguageItemSchema = z.object({
  /** "English, C1" / "Russian, native". */
  text: z.string().min(1).max(80),
});

/**
 * Coachable advice for the client to make the resume even stronger.
 * NOT rendered as if the client already did it — these are TODOs the
 * client should consider in the next 1-4 weeks.
 */
export const idealResumeRecommendationSchema = z.object({
  type: z.enum([
    "certification",
    "technology",
    "experience_framing",
    "portfolio",
    "soft_skill",
    "general",
  ]),
  /** "Pass AWS Cloud Practitioner exam — boosts ATS for cloud-heavy roles." */
  text: z.string().min(10).max(500),
  /** "≈2 weeks", "1 weekend", "1 month". Optional, but encouraged. */
  estimatedEffort: z.string().max(60).default(""),
  /** "Mentioned in 8/10 ideal resumes for this role." Optional context. */
  rationale: z.string().max(400).default(""),
});

/**
 * Things that will catch a recruiter's / hiring manager's eye in a NEGATIVE
 * way. Surfaced honestly so the client knows what to expect (and how to
 * pre-empt the question).
 *
 * Severity:
 *   high   — likely auto-reject signal (>1 year gap, last role mismatch)
 *   medium — interview-stage concern (multiple <6mo stints, frequent jumps)
 *   low    — stylistic / minor (no metrics, no leadership signal)
 */
export const idealResumeRedFlagSchema = z.object({
  severity: z.enum(["high", "medium", "low"]),
  /** "1.5-year gap between Company X and Company Y (Jul 2022 – Jan 2024)." */
  text: z.string().min(10).max(500),
  /** "Cover with: open-source contributions, freelance, parental leave note." */
  suggestion: z.string().max(500).default(""),
});

export const idealResumeSchema = z.object({
  fullName: z.string().min(1).max(120),
  title: z.string().min(1).max(120),
  /** "email • phone • LinkedIn • Location" — the renderer joins parts with bullet. */
  contactLine: z.string().min(1).max(300),
  /** 2-4 sentences, MUST contain quantified achievements. */
  summary: z.string().min(80).max(1500),

  skills: z.array(idealResumeSkillCategorySchema).min(3).max(12),
  experience: z.array(idealResumeExperienceItemSchema).min(1).max(12),
  certifications: z.array(idealResumeCertificationSchema).max(15).default([]),
  education: z.array(idealResumeEducationItemSchema).min(1).max(8),
  languages: z.array(idealResumeLanguageItemSchema).min(1).max(8),

  /** Coachable suggestions for the client. Not rendered as résumé content. */
  recommendations: z.array(idealResumeRecommendationSchema).max(15).default([]),
  /** Honest list of concerns a recruiter might flag. */
  redFlags: z.array(idealResumeRedFlagSchema).max(15).default([]),
  /**
   * Technologies/skills we ADDED to the resume that the client did not
   * explicitly mention. Used to coach the client to brush them up before
   * applying. Each item: `{ name, learnInDays, why }`.
   */
  addedSkills: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        learnInDays: z.string().max(40).default(""),
        why: z.string().max(300).default(""),
      }),
    )
    .max(20)
    .default([]),

  /** For our internal accounting only — not rendered to the doc. */
  meta: z.object({
    targetRoleSlug: z.string().min(1),
    targetRoleTitle: z.string().min(1),
    sourceResumeVersionId: z.string().nullable().default(null),
    sourceResumeUrl: z.string().nullable().default(null),
    usedLinkedinProfile: z.boolean().default(false),
    usedRolePattern: z.boolean().default(false),
    generatedAt: z.string(),
    model: z.string(),
  }),
});

export type IdealResume = z.infer<typeof idealResumeSchema>;
export type IdealResumeSkillCategory = z.infer<typeof idealResumeSkillCategorySchema>;
export type IdealResumeExperienceItem = z.infer<typeof idealResumeExperienceItemSchema>;
export type IdealResumeRecommendation = z.infer<typeof idealResumeRecommendationSchema>;
export type IdealResumeRedFlag = z.infer<typeof idealResumeRedFlagSchema>;
