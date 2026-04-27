import Anthropic from "@anthropic-ai/sdk";
import {
  clientFactsSchema,
  NoResumeError,
  type ClientFacts,
} from "../../schemas/client-facts.js";
import type { ClientSummary } from "../../schemas/client-summary.js";
import type { LinkedinProfile } from "../linkedin-fetcher.js";
import { parseLlmJson } from "../llm-json.js";

const MODEL = process.env.IDEAL_RESUME_FACTS_MODEL || "claude-sonnet-4-20250514";
const MAX_OUTPUT_TOKENS = 8000;

export interface ExtractFactsInput {
  /** Active resume text (plain). May be empty. */
  resumeText?: string | null;
  /** Optional LinkedIn profile snippets. */
  linkedinProfile?: LinkedinProfile | null;
  /** Stage-2 client summary (preferred source for name/contacts). */
  clientSummary?: ClientSummary | null;
  /** Original questionnaire (raw responses) — fallback. */
  rawNamedValues?: Record<string, string> | null;
  /** Free-form client notes (forwarded messages, /note). */
  clientNotes?: string[] | null;
  /** Telegram nick — used as fallback for telegramNick. */
  telegramNick?: string;
}

export interface ExtractFactsResult {
  facts: ClientFacts;
  usage: { in: number; out: number; ms: number };
  prompt: string;
}

function joinNotes(notes: string[] | null | undefined): string {
  if (!notes || notes.length === 0) return "";
  return notes
    .map((n, i) => `(${i + 1}) ${n.trim()}`)
    .join("\n")
    .slice(0, 6000);
}

function summariseClientSummaryForFacts(c: ClientSummary): string {
  const lines: string[] = [];
  const fullLatin = [c.firstNameLatin, c.lastNameLatin].filter(Boolean).join(" ").trim();
  const fullNative = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  if (fullLatin) lines.push(`Full name (Latin): ${fullLatin}`);
  if (fullNative) lines.push(`Full name (native): ${fullNative}`);
  if (c.telegramNick) lines.push(`Telegram: @${c.telegramNick}`);
  if (c.location) lines.push(`Location: ${c.location}`);
  if (c.physicalCountry) lines.push(`Country: ${c.physicalCountry}`);
  if (c.citizenships?.length) lines.push(`Citizenships: ${c.citizenships.join(", ")}`);
  if (c.englishLevel) lines.push(`English level: ${c.englishLevel}`);
  if (c.linkedinUrl) lines.push(`LinkedIn URL: ${c.linkedinUrl}`);
  if (c.currentProfession) lines.push(`Current profession: ${c.currentProfession}`);
  if (c.yearsExperience) lines.push(`Years of experience: ${c.yearsExperience}`);
  if (c.currentGrade) lines.push(`Grade: ${c.currentGrade}`);
  if (c.goal) lines.push(`Goal: ${c.goal}`);
  if (c.desiredDirections) lines.push(`Desired directions: ${c.desiredDirections}`);
  if (c.highlights?.length) {
    lines.push("Highlights:");
    for (const h of c.highlights) lines.push(`  - ${h}`);
  }
  return lines.join("\n");
}

function summariseRawNamedValues(rnv: Record<string, string> | null | undefined): string {
  if (!rnv) return "";
  const entries = Object.entries(rnv).filter(
    ([k, v]) => typeof v === "string" && v.trim().length > 0 && k.length < 200,
  );
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `Q: ${k}\nA: ${v.replace(/\s+/g, " ").trim().slice(0, 400)}`)
    .join("\n---\n")
    .slice(0, 8000);
}

function summariseLinkedin(profile: LinkedinProfile | null | undefined): string {
  if (!profile) return "";
  const parts: string[] = [];
  if (profile.url) parts.push(`URL: ${profile.url}`);
  if (profile.text) {
    parts.push(`--- Profile text ---\n${profile.text.slice(0, 7000)}`);
  }
  return parts.join("\n");
}

function buildPrompt(args: {
  resumeText?: string | null;
  linkedinProfile?: LinkedinProfile | null;
  clientSummary?: ClientSummary | null;
  rawNamedValues?: Record<string, string> | null;
  clientNotes?: string[] | null;
  telegramNick?: string;
}): string {
  const sections: string[] = [];

  sections.push(
    `Ты — извлекатель фактов о клиенте. Твоя ЕДИНСТВЕННАЯ задача — собрать в структурированный JSON РЕАЛЬНЫЕ факты о клиенте из всех приведённых источников.

═══════════════════════════════════════════════════════════════
ЖЁСТКИЕ ПРАВИЛА
═══════════════════════════════════════════════════════════════

1. НИКАКОЙ выдумки. Если факта нет ни в одном источнике — оставляй поле пустой строкой "" или пустым массивом [].
2. Имя/фамилия: бери из резюме / LinkedIn / clientSummary. Не выдумывай Latin-транслит, если в источниках есть нативное написание — оставь nativeFullName и оставь fullNameLatin = "" (мы потом сами заполним).
3. Email и телефон: если нет — "". НЕ генерируй placeholder.
4. Компании: бери ТОЛЬКО те, что упомянуты как места работы. Не путай "клиенты компании X" с "работодатель X".
5. Период (period): сохраняй формат как написано клиентом ("Сен 2020 — Янв 2024", "March 2022 – now"). Дополнительно заполняй startDate/endDate как "YYYY-MM" (или "now") ТОЛЬКО если уверен.
6. Должность (jobTitle): как написано клиентом, без "приукрашивания".
7. bullets: списком обязанностей/достижений из резюме как они есть, без переписывания.
8. technologies: только реально упомянутые технологии. Если в bullets написано "разрабатывал на Python" — Python в technologies.
9. industry: одна короткая фраза ("ритейл", "банк", "edtech", "телеком", "marketplace").
10. certifications: только реально полученные клиентом. Если не уверен — НЕ добавляй.
11. education: всё, что упомянуто (включая курсы) — потом отфильтруем. isAdditionalCourse=true для онлайн-курсов / буткемпов / коротких программ.
12. languages: все упомянутые языки.
13. desiredLocation: страна или город, куда клиент хочет работать (если упомянуто) — иначе "".

═══════════════════════════════════════════════════════════════
ФОРМАТ ВЫВОДА
═══════════════════════════════════════════════════════════════

Верни ТОЛЬКО JSON-объект, без markdown-кодблоков, без комментариев. Структура:

{
  "fullNameLatin": "string",
  "fullNameNative": "string",
  "contacts": {
    "email": "string",
    "phone": "string",
    "telegramNick": "string",
    "linkedinUrl": "string",
    "githubUrl": "string",
    "portfolioUrls": ["string"]
  },
  "location": "string",
  "country": "string",
  "desiredLocation": "string",
  "citizenships": ["string"],
  "yearsExperience": "string",
  "currentGrade": "string",
  "oneLiner": "string",
  "languages": [{"language": "string", "level": "string"}],
  "rawSkills": ["string"],
  "education": [
    {"raw": "string", "degree": "string", "field": "string", "institution": "string", "yearStart": "string", "yearEnd": "string", "isAdditionalCourse": false}
  ],
  "certifications": [
    {"name": "string", "issuer": "string", "date": "string", "verifiable": false}
  ],
  "experience": [
    {
      "companyName": "string",
      "companyUrl": "string",
      "industry": "string",
      "location": "string",
      "jobTitle": "string",
      "period": "string",
      "startDate": "string",
      "endDate": "string",
      "bullets": ["string"],
      "technologies": ["string"],
      "projects": ["string"]
    }
  ]
}
`,
  );

  if (args.telegramNick) {
    sections.push(`\n═══ TELEGRAM NICK ═══\n@${args.telegramNick}`);
  }

  if (args.clientSummary) {
    sections.push(
      `\n═══ CLIENT SUMMARY (предпочтительный источник для имени/контактов) ═══\n${summariseClientSummaryForFacts(args.clientSummary)}`,
    );
  }

  if (args.resumeText && args.resumeText.trim().length > 0) {
    sections.push(
      `\n═══ RESUME TEXT (главный источник для experience/education/skills) ═══\n${args.resumeText.slice(0, 18000)}`,
    );
  } else {
    sections.push(`\n═══ RESUME TEXT ═══\n(резюме отсутствует)`);
  }

  if (args.linkedinProfile) {
    sections.push(`\n═══ LINKEDIN PROFILE ═══\n${summariseLinkedin(args.linkedinProfile)}`);
  }

  const rnv = summariseRawNamedValues(args.rawNamedValues);
  if (rnv) {
    sections.push(`\n═══ QUESTIONNAIRE (free-form Q/A) ═══\n${rnv}`);
  }

  const notes = joinNotes(args.clientNotes);
  if (notes) {
    sections.push(
      `\n═══ CLIENT NOTES (raw, без интерпретации, можно использовать как дополнительный контекст) ═══\n${notes}`,
    );
  }

  sections.push(
    `\n═══ ВЫВОД ═══\nВерни ТОЛЬКО валидный JSON по схеме выше. Если какого-то поля нет — пустая строка "" или пустой массив [].`,
  );

  return sections.join("\n");
}

export async function extractClientFacts(
  input: ExtractFactsInput,
): Promise<ExtractFactsResult> {
  const prompt = buildPrompt(input);

  const client = new Anthropic();
  const t0 = Date.now();
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: "user", content: prompt }],
  });
  const ms = Date.now() - t0;

  const block = resp.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("extractClientFacts: Anthropic returned no text block");
  }
  const parsed = parseLlmJson<Record<string, unknown>>(block.text, "extractClientFacts");

  const enriched = {
    ...parsed,
    contacts: {
      ...((parsed.contacts as Record<string, unknown>) ?? {}),
      telegramNick:
        ((parsed.contacts as Record<string, unknown>)?.telegramNick as string) ||
        input.telegramNick ||
        input.clientSummary?.telegramNick ||
        "",
      portfolioUrls:
        ((parsed.contacts as Record<string, unknown>)?.portfolioUrls as string[]) ?? [],
    },
    meta: {
      sources: {
        resumeText: Boolean(input.resumeText && input.resumeText.trim().length > 0),
        linkedinProfile: Boolean(input.linkedinProfile),
        clientSummary: Boolean(input.clientSummary),
        questionnaire: Boolean(
          input.rawNamedValues && Object.keys(input.rawNamedValues).length > 0,
        ),
        clientNotes: Boolean(input.clientNotes && input.clientNotes.length > 0),
      },
      extractedAt: new Date().toISOString(),
      model: MODEL,
    },
  };

  let validated: ClientFacts;
  try {
    validated = clientFactsSchema.parse(enriched);
  } catch (err) {
    throw new Error(
      `extractClientFacts: schema validation failed (${err instanceof Error ? err.message : String(err)})\n--- LLM raw (first 1500) ---\n${block.text.slice(0, 1500)}`,
    );
  }

  if (validated.experience.length === 0) {
    throw new NoResumeError(
      `Невозможно построить идеальное резюме: ни в одном источнике нет опыта работы клиента (resume=${validated.meta.sources.resumeText}, linkedin=${validated.meta.sources.linkedinProfile}, summary=${validated.meta.sources.clientSummary}).`,
    );
  }

  console.log(
    `[extractFacts] in=${resp.usage.input_tokens} out=${resp.usage.output_tokens} ms=${ms} ` +
      `experience=${validated.experience.length} education=${validated.education.length} ` +
      `certs=${validated.certifications.length} skills=${validated.rawSkills.length}`,
  );

  return {
    facts: validated,
    usage: { in: resp.usage.input_tokens, out: resp.usage.output_tokens, ms },
    prompt,
  };
}
