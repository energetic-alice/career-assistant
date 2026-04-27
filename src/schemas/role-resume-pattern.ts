import { z } from "zod";

/**
 * Compact "playbook" for a canonical role slug, distilled by LLM from
 * top-10 HH resumes (`app/data/resume_helpers_raw/<slug>/*.txt`).
 *
 * One file per slug at `app/data/role_resume_patterns/<slug>.json`.
 * Used by ideal-resume-generator to prime the LLM with role-specific
 * vocabulary, achievement phrasing, and skill taxonomy.
 *
 * Designed to be tight (~5–15 KB) so all relevant fields fit in the
 * generation prompt comfortably.
 */
export const skillCategorySchema = z.object({
  category: z.string().min(1),
  items: z.array(z.string().min(1)).min(1),
});

export const roleResumePatternSchema = z.object({
  slug: z.string().min(1),
  displayTitle: z.string().min(1),
  builtAt: z.string(),
  sourceCount: z.number().int().nonnegative(),

  /** 5–8 typical job-title variants seen in the corpus, including seniority. */
  typicalTitles: z.array(z.string().min(1)).min(1).max(15),

  /** 3–5 example summary paragraphs (1–2 sentences each, with metrics). */
  summaryPatterns: z.array(z.string().min(1)).min(1).max(10),

  /** 5–10 skill categories with grouped items — directly maps to the
   *  Skills block of the resume template. */
  skillCategories: z.array(skillCategorySchema).min(1).max(15),

  /** 8–20 quantified achievement phrasings ("Reduced X by N%", "Built Y serving N+ users"). */
  achievementPhrases: z.array(z.string().min(1)).min(1).max(30),

  /** 5–10 typical responsibilities (non-quantified, broader scope). */
  keyResponsibilities: z.array(z.string().min(1)).min(1).max(15),

  /** Popular certifications worth mentioning. */
  certifications: z.array(z.string().min(1)).max(15).default([]),

  /** Industries / company types frequently seen for this role. */
  popularIndustries: z.array(z.string().min(1)).max(15).default([]),

  /** Things that look weak or red-flagging — to avoid in generated resume. */
  redFlags: z.array(z.string().min(1)).max(15).default([]),

  /** Free-form summary note from LLM (5–15 lines). */
  notes: z.string().min(1).max(4000),
});

export type RoleResumePattern = z.infer<typeof roleResumePatternSchema>;
export type SkillCategory = z.infer<typeof skillCategorySchema>;
