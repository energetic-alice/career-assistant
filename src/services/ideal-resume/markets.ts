import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRESETS_PATH = join(__dirname, "..", "..", "..", "data", "market-presets.json");

export type MarketCode = "ru" | "global" | "usa";

export interface MarketPreset {
  code: MarketCode;
  displayName: string;
  language: "ru" | "en";
  languageDisplay: string;
  preferredCloud: string[];
  secondaryCloud: string[];
  preferredCI: string[];
  preferredVCS: string[];
  dateFormat: string;
  dateExample: string;
  sectionLabels: {
    summary: string;
    skills: string;
    experience: string;
    education: string;
    certifications: string;
    languages: string;
  };
  styleHints: string[];
  extraSummaryHints: string[];
}

let cache: Map<MarketCode, MarketPreset> | null = null;

export async function loadMarketPresets(): Promise<Map<MarketCode, MarketPreset>> {
  if (cache) return cache;
  const raw = await readFile(PRESETS_PATH, "utf-8");
  const parsed = JSON.parse(raw) as { markets: Record<string, MarketPreset> };
  const map = new Map<MarketCode, MarketPreset>();
  for (const [code, preset] of Object.entries(parsed.markets)) {
    map.set(code as MarketCode, { ...preset, code: code as MarketCode });
  }
  cache = map;
  return map;
}

export async function getMarketPreset(code: MarketCode): Promise<MarketPreset> {
  const map = await loadMarketPresets();
  const preset = map.get(code);
  if (!preset) {
    throw new Error(
      `Unknown market "${code}". Available: ${Array.from(map.keys()).join(", ")}`,
    );
  }
  return preset;
}
