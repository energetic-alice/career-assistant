import { z } from "zod";

/**
 * Strict factual snapshot of a client extracted from ALL available sources
 * (resume text, LinkedIn profile, client summary, manual notes).
 *
 * "Facts" = things we are NOT allowed to invent. The downstream chunked
 * pipeline (skills mixer, company enrichment, summary, analysis) operates
 * exclusively on this object, plus role-pattern + market preset.
 *
 * Every field is OPTIONAL except `experience[]`. If experience is empty
 * after extraction, callers throw `NoResumeError` and stop the pipeline.
 */

export const clientFactsLanguageSchema = z.object({
  language: z.string().min(1).max(60),
  level: z.string().max(20).default(""),
});

export const clientFactsEducationSchema = z.object({
  raw: z.string().min(1).max(400),
  degree: z.string().max(60).default(""),
  field: z.string().max(120).default(""),
  institution: z.string().max(200).default(""),
  yearStart: z.string().max(10).default(""),
  yearEnd: z.string().max(10).default(""),
  isAdditionalCourse: z.boolean().default(false),
});

export const clientFactsCertificationSchema = z.object({
  name: z.string().min(1).max(200),
  issuer: z.string().max(120).default(""),
  date: z.string().max(40).default(""),
  /** True if the credential is verifiable (URL, ID). False = client claims. */
  verifiable: z.boolean().default(false),
});

export const clientFactsExperienceSchema = z.object({
  companyName: z.string().min(1).max(200),
  companyUrl: z.string().max(300).default(""),
  /** Industry / business domain client described, e.g. "ритейл", "банк". */
  industry: z.string().max(120).default(""),
  location: z.string().max(120).default(""),
  jobTitle: z.string().min(1).max(200),
  /** Raw period as written. Examples: "March 2022 – now", "Сен 2020 — Янв 2024". */
  period: z.string().min(1).max(80),
  /** Parsed start date "YYYY-MM" if confidently known. */
  startDate: z.string().max(10).default(""),
  /** Parsed end date "YYYY-MM" or "now" if confidently known. */
  endDate: z.string().max(10).default(""),
  /** Free-form responsibilities/achievements as the client wrote them. */
  bullets: z.array(z.string().min(1).max(800)).max(30).default([]),
  /** Technologies as written by the client (comma-joined or list). */
  technologies: z.array(z.string().min(1).max(80)).max(60).default([]),
  /** Names of distinct projects mentioned inside this employer. */
  projects: z.array(z.string().min(1).max(200)).max(10).default([]),
});

export const clientFactsContactsSchema = z.object({
  email: z.string().max(120).default(""),
  phone: z.string().max(40).default(""),
  telegramNick: z.string().max(80).default(""),
  linkedinUrl: z.string().max(300).default(""),
  githubUrl: z.string().max(300).default(""),
  portfolioUrls: z.array(z.string().min(1).max(300)).max(10).default([]),
});

export const clientFactsSchema = z.object({
  fullNameLatin: z.string().max(120).default(""),
  fullNameNative: z.string().max(120).default(""),

  contacts: clientFactsContactsSchema.default({
    email: "",
    phone: "",
    telegramNick: "",
    linkedinUrl: "",
    githubUrl: "",
    portfolioUrls: [],
  }),

  /** Where client physically lives, e.g. "Алматы, Казахстан". */
  location: z.string().max(120).default(""),
  /** Country only — used by relocation rules. */
  country: z.string().max(60).default(""),
  /** Country (or "remote") client wants to work in — used for B2B note. */
  desiredLocation: z.string().max(120).default(""),
  citizenships: z.array(z.string().min(1).max(60)).max(5).default([]),

  yearsExperience: z.string().max(10).default(""),
  currentGrade: z.string().max(40).default(""),

  /** Free-form one-line client headline (from resume/LinkedIn). */
  oneLiner: z.string().max(500).default(""),

  languages: z.array(clientFactsLanguageSchema).max(8).default([]),

  /** All raw skills mentioned anywhere — feeds skills-mixer. */
  rawSkills: z.array(z.string().min(1).max(80)).max(150).default([]),

  education: z.array(clientFactsEducationSchema).max(10).default([]),

  /** ONLY real, claimed certifications. New ones go into recommendations. */
  certifications: z.array(clientFactsCertificationSchema).max(15).default([]),

  /** Experience entries — required (we throw NoResumeError if empty). */
  experience: z.array(clientFactsExperienceSchema).max(20),

  /** Bookkeeping for downstream prompts. */
  meta: z.object({
    sources: z.object({
      resumeText: z.boolean().default(false),
      linkedinProfile: z.boolean().default(false),
      clientSummary: z.boolean().default(false),
      questionnaire: z.boolean().default(false),
      clientNotes: z.boolean().default(false),
    }),
    extractedAt: z.string(),
    model: z.string(),
  }),
});

export type ClientFacts = z.infer<typeof clientFactsSchema>;
export type ClientFactsExperience = z.infer<typeof clientFactsExperienceSchema>;
export type ClientFactsEducation = z.infer<typeof clientFactsEducationSchema>;
export type ClientFactsCertification = z.infer<typeof clientFactsCertificationSchema>;
export type ClientFactsLanguage = z.infer<typeof clientFactsLanguageSchema>;

export class NoResumeError extends Error {
  constructor(message = "Невозможно построить идеальное резюме: ни в одном источнике нет опыта работы клиента.") {
    super(message);
    this.name = "NoResumeError";
  }
}
