import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "..", "prompts");
const KB_DIR = join(PROMPTS_DIR, "kb");

async function loadFile(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

const referenceFiles: Record<string, string> = {};

async function getReference(name: string): Promise<string> {
  if (!referenceFiles[name]) {
    referenceFiles[name] = await loadFile(join(PROMPTS_DIR, `${name}.md`));
  }
  return referenceFiles[name];
}

async function getKB(name: string): Promise<string> {
  return loadFile(join(KB_DIR, `${name}.md`));
}

export async function loadPrompt01(vars: {
  questionnaire: string;
  resumeText: string;
  linkedinUrl: string;
  linkedinSSI: string;
}): Promise<string> {
  let template = await loadFile(join(PROMPTS_DIR, "01-profile-extraction.md"));
  const styleGuide = await getReference("style-guide");

  template = template.replace("{{style-guide}}", styleGuide);
  template = template.replace("{{questionnaire}}", vars.questionnaire);
  template = template.replace("{{resumeText}}", vars.resumeText);
  template = template.replace("{{linkedinUrl}}", vars.linkedinUrl);
  template = template.replace("{{linkedinSSI}}", vars.linkedinSSI);

  return template;
}

export async function loadPrompt02(vars: {
  candidateProfile: string;
}): Promise<string> {
  let template = await loadFile(join(PROMPTS_DIR, "02-direction-generation.md"));
  const styleGuide = await getReference("style-guide");
  const decisionRules = await getReference("decision-rules");
  const trainingExamples = await getReference("training-examples");

  template = template.replace("{{style-guide}}", styleGuide);
  template = template.replace("{{decision-rules}}", decisionRules);
  template = template.replace("{{training-examples}}", trainingExamples);
  template = template.replace("{{candidateProfile}}", vars.candidateProfile);

  return template;
}

export async function loadPrompt03(vars: {
  candidateProfile: string;
  directionsOutput: string;
  marketData: string;
  relevantDomains: string[];
}): Promise<string> {
  let template = await loadFile(join(PROMPTS_DIR, "03-direction-analysis.md"));
  const styleGuide = await getReference("style-guide");
  const decisionRules = await getReference("decision-rules");

  const competitionRu = await getKB("competition-ru");
  const competitionEu = await getKB("competition-eu");
  const competitionRef = `${competitionRu}\n\n---\n\n${competitionEu}`;

  const domainKBs: string[] = [];
  for (const domain of vars.relevantDomains) {
    try {
      const kb = await getKB(domain);
      domainKBs.push(kb);
    } catch {
      // KB not found for this domain, skip
    }
  }

  template = template.replace("{{style-guide}}", styleGuide);
  template = template.replace("{{decision-rules}}", decisionRules);
  template = template.replace("{{candidateProfile}}", vars.candidateProfile);
  template = template.replace("{{directionsOutput}}", vars.directionsOutput);
  template = template.replace("{{marketData}}", vars.marketData);
  template = template.replace("{{competitionReference}}", competitionRef);
  template = template.replace("{{domainKBs}}", domainKBs.join("\n\n---\n\n"));

  return template;
}

export async function loadPrompt04(vars: {
  candidateProfile: string;
  directionsOutput: string;
  analysisOutput: string;
  expertFeedback: string;
}): Promise<string> {
  let template = await loadFile(join(PROMPTS_DIR, "04-final-compilation.md"));
  const styleGuide = await getReference("style-guide");
  const fewShot = await getReference("few-shot-examples");

  template = template.replace("{{style-guide}}", styleGuide);
  template = template.replace("{{few-shot-examples}}", fewShot);
  template = template.replace("{{candidateProfile}}", vars.candidateProfile);
  template = template.replace("{{directionsOutput}}", vars.directionsOutput);
  template = template.replace("{{analysisOutput}}", vars.analysisOutput);
  template = template.replace("{{expertFeedback}}", vars.expertFeedback);

  return template;
}

/**
 * Determine which KB domains are relevant based on direction titles.
 */
export function inferRelevantDomains(directionTitles: string[]): string[] {
  const domains = new Set<string>();
  const joined = directionTitles.join(" ").toLowerCase();

  domains.add("macro-trends");

  if (/devops|sre|platform|infra|mlops|devsecops|finops/.test(joined)) domains.add("devops-sre");
  if (/backend|go|java|python|node|ruby|php|c#|rust/.test(joined)) domains.add("backend");
  if (/data|analyst|engineer|scientist|analytics|bi|dbt/.test(joined)) domains.add("data-analytics");
  if (/frontend|react|vue|angular|mobile|native|flutter/.test(joined)) domains.add("frontend-mobile");
  if (/product|pm|analyst|ba|sa|growth|manager/.test(joined)) domains.add("product-management");
  if (/remote|hybrid/.test(joined)) domains.add("remote-work");

  return [...domains];
}
