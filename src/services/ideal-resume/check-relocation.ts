import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientFacts } from "../../schemas/client-facts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(__dirname, "..", "..", "..", "data", "relocation-rules.json");

interface RelocationRule {
  id: string;
  fromCountries: string[];
  toCountries: string[];
  severity: "low" | "medium" | "high";
  note: string;
}

interface RelocationRulesFile {
  version: number;
  rules: RelocationRule[];
}

let cache: RelocationRulesFile | null = null;

async function loadRules(): Promise<RelocationRulesFile> {
  if (cache) return cache;
  const raw = await readFile(RULES_PATH, "utf-8");
  cache = JSON.parse(raw) as RelocationRulesFile;
  return cache;
}

export interface RelocationFinding {
  ruleId: string;
  severity: "low" | "medium" | "high";
  note: string;
  matchedFrom: string;
  matchedTo: string;
}

function normalize(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-zа-яё0-9 ]/gi, "").trim();
}

function matches(value: string, candidates: string[]): string | null {
  const v = normalize(value);
  if (!v) return null;
  for (const c of candidates) {
    if (c === "*") return value || "*";
    const cn = normalize(c);
    if (!cn) continue;
    if (v === cn || v.includes(cn) || cn.includes(v)) return c;
  }
  return null;
}

/**
 * Apply deterministic relocation rules. Returns 0-N findings (most clients
 * have 0). Findings are intended to be appended to `analysis.recommendations`
 * with `type: "experience_framing"`.
 */
export async function checkRelocation(
  facts: ClientFacts,
): Promise<RelocationFinding[]> {
  const rules = (await loadRules()).rules;
  const from = facts.country || facts.location || "";
  const to = facts.desiredLocation || "";
  if (!to) return [];

  const findings: RelocationFinding[] = [];
  for (const rule of rules) {
    const matchedFrom = matches(from, rule.fromCountries);
    const matchedTo = matches(to, rule.toCountries);
    if (matchedFrom && matchedTo) {
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        note: rule.note,
        matchedFrom,
        matchedTo,
      });
    }
  }
  return findings;
}
