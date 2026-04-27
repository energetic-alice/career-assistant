import type { ClientFacts } from "../../schemas/client-facts.js";
import type { RoleResumePattern } from "../../schemas/role-resume-pattern.js";
import type { MarketCode, MarketPreset } from "./markets.js";

/**
 * Pick the most marketable title for the resume header.
 *
 * Strategy (deterministic, no LLM):
 *   1) Drop typicalTitles that don't match the target language.
 *      RU market → prefer Cyrillic OR English titles, both ok (HH-стандарт).
 *      Global/USA market → prefer English titles only.
 *   2) Match seniority from `clientFacts.currentGrade` / yearsExperience
 *      against tokens in the title (Junior/Middle/Senior/Lead/Staff/Principal).
 *   3) If no seniority match — pick the most "marketable" mid/senior title:
 *      prefer ones containing "Senior", then plain "Engineer/Developer".
 *   4) Fallback: rolePattern.displayTitle.
 */

export interface ResolveTitleInput {
  facts: ClientFacts;
  rolePattern: RoleResumePattern | null;
  market: MarketCode;
  marketPreset: MarketPreset;
  /** Selected target role title from clientSummary, e.g. "DevOps Engineer". */
  targetRoleTitle: string;
}

export interface ResolveTitleResult {
  title: string;
  /** Why we picked it (for debugging / pilot dumps). */
  reason: string;
  /** All considered candidates after filtering. */
  candidates: string[];
}

const SENIORITY_TOKENS_BY_GRADE: Record<string, string[]> = {
  intern: ["intern", "стажер", "стажёр"],
  junior: ["junior", "джуниор", "младший"],
  middle: ["middle", "mid", "regular", "ведущий"],
  senior: ["senior", "сеньор", "старший", "lead engineer"],
  lead: ["lead", "tech lead", "team lead", "tl", "тимлид", "техлид"],
  staff: ["staff", "principal"],
  principal: ["principal", "staff", "architect"],
};

function normaliseGrade(g: string): keyof typeof SENIORITY_TOKENS_BY_GRADE | null {
  const lower = (g || "").trim().toLowerCase();
  if (!lower) return null;
  if (/junior|джуниор|младш/.test(lower)) return "junior";
  if (/intern|стаж/.test(lower)) return "intern";
  if (/lead|тимлид|техлид/.test(lower)) return "lead";
  if (/staff/.test(lower)) return "staff";
  if (/principal|архит|architect/.test(lower)) return "principal";
  if (/senior|сеньор|старш/.test(lower)) return "senior";
  if (/middle|мидл|regular|ведущ/.test(lower)) return "middle";
  return null;
}

function inferGradeFromYears(years: string): keyof typeof SENIORITY_TOKENS_BY_GRADE | null {
  const n = parseFloat(years.replace(",", ".").replace(/[^\d.]/g, ""));
  if (Number.isNaN(n)) return null;
  if (n < 1) return "intern";
  if (n < 2) return "junior";
  if (n < 4) return "middle";
  if (n < 8) return "senior";
  return "lead";
}

function isLatin(s: string): boolean {
  return /^[\x00-\x7F]+$/.test(s);
}

function isCyrillic(s: string): boolean {
  return /[А-Яа-яЁё]/.test(s);
}

export function resolveTitle(input: ResolveTitleInput): ResolveTitleResult {
  const candidatesRaw = input.rolePattern?.typicalTitles ?? [];
  const fallback = input.rolePattern?.displayTitle ?? input.targetRoleTitle;
  const targetLang = input.marketPreset.language;

  const candidates = candidatesRaw.filter((t) => {
    if (!t || t.length > 80) return false;
    if (targetLang === "ru") {
      return isCyrillic(t) || isLatin(t);
    }
    return isLatin(t) && !isCyrillic(t);
  });

  if (candidates.length === 0) {
    return {
      title: fallback,
      reason: "no typicalTitles in role pattern (or none match market language) — using fallback displayTitle",
      candidates: [],
    };
  }

  const grade =
    normaliseGrade(input.facts.currentGrade) ??
    inferGradeFromYears(input.facts.yearsExperience) ??
    "senior";

  const wantTokens = SENIORITY_TOKENS_BY_GRADE[grade];

  const matched = candidates.filter((t) =>
    wantTokens.some((token) => t.toLowerCase().includes(token)),
  );

  if (matched.length > 0) {
    return {
      title: matched[0],
      reason: `matched seniority "${grade}" by token in pattern.typicalTitles`,
      candidates,
    };
  }

  const seniorPreferred = candidates.find((t) => /senior|сеньор|старш/i.test(t));
  if (seniorPreferred) {
    return {
      title: seniorPreferred,
      reason: `no exact "${grade}" match — defaulted to most marketable Senior variant`,
      candidates,
    };
  }

  return {
    title: candidates[0],
    reason: `no seniority match — picked first candidate`,
    candidates,
  };
}
