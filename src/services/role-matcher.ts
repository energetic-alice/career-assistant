import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MarketIndex } from "../schemas/market-index.js";

/**
 * Match free-text profession strings (ru/en) to canonical market-index slugs.
 *
 * Three tiers, best first:
 *   1. Exact alias hit (confidence 1.00)
 *   2. Substring either-way hit (confidence 0.85, biased by alias length)
 *   3. Levenshtein similarity ≥ 0.85 (confidence = similarity)
 *
 * Returns null when nothing clears the 0.75 confidence threshold.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX_PATH = join(__dirname, "..", "..", "data", "market-index.json");

export interface RoleMatch {
  slug: string;
  confidence: number;
  matchedAlias: string;
  raw: string;
}

type AliasEntry = { slug: string; alias: string; normalized: string };

let cachedIndex: MarketIndex | null = null;
let cachedAliases: AliasEntry[] | null = null;

export async function loadMarketIndex(path: string = DEFAULT_INDEX_PATH): Promise<MarketIndex> {
  if (cachedIndex) return cachedIndex;
  const content = await readFile(path, "utf-8");
  cachedIndex = JSON.parse(content) as MarketIndex;
  return cachedIndex;
}

// Cheap cache reset (used by tests).
export function _resetMatcherCache(): void {
  cachedIndex = null;
  cachedAliases = null;
}

function buildAliasList(index: MarketIndex): AliasEntry[] {
  const list: AliasEntry[] = [];
  for (const entry of Object.values(index)) {
    for (const alias of entry.aliases) {
      list.push({ slug: entry.slug, alias, normalized: normalize(alias) });
    }
    // Always include the slug with spaces, just in case.
    const slugAlias = entry.slug.replace(/-/g, " ");
    list.push({ slug: entry.slug, alias: slugAlias, normalized: normalize(slugAlias) });
  }
  return list;
}

async function getAliases(): Promise<AliasEntry[]> {
  if (cachedAliases) return cachedAliases;
  const index = await loadMarketIndex();
  cachedAliases = buildAliasList(index);
  return cachedAliases;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[.,/\\()[\]{}:;"'`!?*]/g, " ")
    // Preserve "#" and "+" inside words (c#, c++), but normalise separators.
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Generic words that don't uniquely identify a role. When matching we require
 * at least one "significant" (non-stopword) token to be shared between input
 * and alias — otherwise "PLC Engineer" and "PHP Engineer" would match just
 * because they both end in "engineer".
 */
const TOKEN_STOPWORDS = new Set<string>([
  "разработчик", "разработка", "разраб", "programmer", "программист",
  "developer", "dev", "engineer", "инженер", "инженера",
  "specialist", "специалист", "спец",
  "manager", "менеджер",
  "lead", "ведущий", "старший", "senior", "middle", "junior", "intern",
  "middle+", "mid", "sr", "jr",
  "head", "руководитель",
  "it", "the", "a", "an", "the", "и", "или", "or", "and",
  "backend", "frontend", "mobile", // categorical — used by category overlap (see below)
  "of",
]);

function significantTokens(normalized: string): string[] {
  return normalized
    .split(" ")
    .filter((t) => t.length >= 2 && !TOKEN_STOPWORDS.has(t));
}

function haveCommonSignificant(a: string, b: string): boolean {
  const as = new Set(significantTokens(a));
  for (const t of significantTokens(b)) if (as.has(t)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Levenshtein similarity
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,    // insertion
        prev[j]! + 1,        // deletion
        prev[j - 1]! + cost, // substitution
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// ---------------------------------------------------------------------------
// Core matcher
// ---------------------------------------------------------------------------

const CONFIDENCE_MIN = 0.75;

export async function matchRoleToSlug(raw: string): Promise<RoleMatch | null> {
  if (!raw || !raw.trim()) return null;
  const normalized = normalize(raw);
  if (!normalized) return null;
  const aliases = await getAliases();

  // Tier 1: exact alias
  for (const a of aliases) {
    if (a.normalized === normalized) {
      return { slug: a.slug, confidence: 1.0, matchedAlias: a.alias, raw };
    }
  }

  // Tier 2a: substring either-way (handles "Python developer" containing "Python" alias)
  const substringHits = aliases
    .filter(
      (a) =>
        a.normalized.length >= 3 &&
        (normalized.includes(a.normalized) || a.normalized.includes(normalized)),
    )
    .sort((x, y) => y.normalized.length - x.normalized.length);
  if (substringHits.length) {
    const best = substringHits[0]!;
    return { slug: best.slug, confidence: 0.85, matchedAlias: best.alias, raw };
  }

  // Tier 2b: token-set subset match (handles reorderings like "React Frontend" vs "Frontend React")
  const inputTokens = new Set(normalized.split(" ").filter((t) => t.length >= 2));
  if (inputTokens.size >= 1) {
    let bestToken: { alias: AliasEntry; aliasTokens: number } | null = null;
    for (const a of aliases) {
      const at = a.normalized.split(" ").filter((t) => t.length >= 2);
      if (at.length === 0) continue;
      const allIn = at.every((t) => inputTokens.has(t));
      if (!allIn) continue;
      if (!bestToken || at.length > bestToken.aliasTokens) {
        bestToken = { alias: a, aliasTokens: at.length };
      }
    }
    if (bestToken && bestToken.aliasTokens >= 2) {
      return { slug: bestToken.alias.slug, confidence: 0.82, matchedAlias: bestToken.alias.alias, raw };
    }
  }

  // Tier 3: fuzzy
  let best: { alias: AliasEntry; sim: number } | null = null;
  for (const a of aliases) {
    const sim = similarity(a.normalized, normalized);
    if (!best || sim > best.sim) best = { alias: a, sim };
  }
  if (best && best.sim >= CONFIDENCE_MIN) {
    return {
      slug: best.alias.slug,
      confidence: Math.round(best.sim * 100) / 100,
      matchedAlias: best.alias.alias,
      raw,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Multi-match
// ---------------------------------------------------------------------------

const SPLIT_REGEX = /[,;/]|\s+\/\s+|\s(?:и|или|or|and|vs)\s/giu;

export async function matchMultiple(raw: string): Promise<RoleMatch[]> {
  if (!raw || !raw.trim()) return [];
  const parts = raw
    .split(SPLIT_REGEX)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2);
  const seen = new Map<string, RoleMatch>();
  // Also try the full string (it might be a single tricky phrase).
  const all = [raw, ...parts];
  for (const p of all) {
    const hit = await matchRoleToSlug(p);
    if (!hit) continue;
    const existing = seen.get(hit.slug);
    if (!existing || hit.confidence > existing.confidence) {
      seen.set(hit.slug, hit);
    }
  }
  return [...seen.values()].sort((a, b) => b.confidence - a.confidence);
}
