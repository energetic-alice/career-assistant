import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  idealResumeSchema,
  type IdealResume,
} from "../schemas/ideal-resume.js";
import {
  roleResumePatternSchema,
  type RoleResumePattern,
} from "../schemas/role-resume-pattern.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import { type ResumeVersion, type SelectedTargetRole } from "../pipeline/intake.js";
import {
  fetchLinkedinProfile,
  type LinkedinProfile,
} from "./linkedin-fetcher.js";
import { fillIdealResumeTemplate } from "./ideal-resume-renderer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROLE_PATTERNS_DIR = join(__dirname, "..", "..", "data", "role_resume_patterns");
const RESUME_EXAMPLES_DIR = join(__dirname, "..", "..", "data", "resume_examples");
const MARKET_INDEX_PATH = join(__dirname, "..", "..", "data", "market-index.json");

const MODEL = process.env.IDEAL_RESUME_MODEL || "claude-sonnet-4-20250514";
const MAX_OUTPUT_TOKENS = 8000;

export interface IdealResumeArtifact {
  id: string;
  url: string;
  docId: string;
  generatedAt: string;
  version: number;
  targetRoleSlug: string;
  targetRoleTitle: string;
  sourceResumeVersionId: string | null;
  usedLinkedinProfile: boolean;
  usedRolePattern: boolean;
  model: string;
  data: IdealResume;
}

export interface GenerateIdealResumeInput {
  participantId: string;
  nick: string;
  target: SelectedTargetRole;
  clientSummary: ClientSummary;
  resumeVersions: ResumeVersion[];
  activeResumeVersionId?: string | null;
  linkedinUrl?: string | null;
  /**
   * Optional pre-fetched resume text (e.g. resolved by `resume-fetcher`).
   * Used as the "primary" source if `resumeVersions` is empty.
   */
  preloadedResume?: { text: string; sourceUrl?: string | null } | null;
  /** Previously generated artifact for this role (if any) — used to bump version. */
  previous?: { version?: number } | null;
}

export interface GenerateIdealResumeResult {
  artifact: IdealResumeArtifact;
  /** Already-fetched LinkedIn profile (for caching by caller). */
  linkedin: LinkedinProfile | null;
}

let cachedRolePatterns: Map<string, RoleResumePattern> | null = null;
let cachedExamples: { name: string; text: string }[] | null = null;
let cachedDisplayTitles: Map<string, string> | null = null;

async function loadDisplayTitles(): Promise<Map<string, string>> {
  if (cachedDisplayTitles) return cachedDisplayTitles;
  const map = new Map<string, string>();
  try {
    const raw = await readFile(MARKET_INDEX_PATH, "utf-8");
    const data = JSON.parse(raw) as Record<string, { displayTitle?: string }> & {
      roles?: Record<string, { displayTitle?: string }>;
    };
    const root = data.roles ?? (data as Record<string, { displayTitle?: string }>);
    for (const [slug, entry] of Object.entries(root)) {
      if (entry?.displayTitle) map.set(slug, entry.displayTitle);
    }
  } catch (err) {
    console.warn(
      `[IdealResume] failed to load display titles: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  cachedDisplayTitles = map;
  return map;
}

export async function loadRolePattern(
  slug: string,
): Promise<RoleResumePattern | null> {
  if (!cachedRolePatterns) {
    cachedRolePatterns = new Map();
    if (existsSync(ROLE_PATTERNS_DIR)) {
      const files = await readdir(ROLE_PATTERNS_DIR);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(ROLE_PATTERNS_DIR, f), "utf-8");
          const parsed = roleResumePatternSchema.parse(JSON.parse(raw));
          cachedRolePatterns.set(parsed.slug, parsed);
        } catch (err) {
          console.warn(
            `[IdealResume] bad role-pattern file ${f}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }
  return cachedRolePatterns.get(slug) ?? null;
}

async function loadExamples(): Promise<{ name: string; text: string }[]> {
  if (cachedExamples) return cachedExamples;
  cachedExamples = [];
  if (!existsSync(RESUME_EXAMPLES_DIR)) return cachedExamples;
  const files = (await readdir(RESUME_EXAMPLES_DIR))
    .filter((f) => f.endsWith(".txt"))
    .sort();
  for (const f of files) {
    const text = await readFile(join(RESUME_EXAMPLES_DIR, f), "utf-8");
    cachedExamples.push({ name: f, text });
  }
  return cachedExamples;
}

function pickPrimaryResumeVersion(
  versions: ResumeVersion[],
  activeId?: string | null,
): ResumeVersion | null {
  if (!Array.isArray(versions) || versions.length === 0) return null;
  if (activeId) {
    const active = versions.find((v) => v.id === activeId);
    if (active) return active;
  }
  return versions[versions.length - 1];
}

function summariseClientSummary(c: ClientSummary): string {
  const lines: string[] = [];
  const fullNameLatin =
    [c.firstNameLatin, c.lastNameLatin].filter(Boolean).join(" ").trim();
  const fullNameNative =
    [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  if (fullNameLatin) lines.push(`Full name (Latin, USE THIS): ${fullNameLatin}`);
  if (fullNameNative) lines.push(`Full name (native): ${fullNameNative}`);
  lines.push(`Telegram: @${c.telegramNick}`);
  if (c.location) lines.push(`Location: ${c.location}`);
  if (c.physicalCountry) lines.push(`Physical country: ${c.physicalCountry}`);
  if (c.citizenships?.length) lines.push(`Citizenships: ${c.citizenships.join(", ")}`);
  if (c.englishLevel) lines.push(`English: ${c.englishLevel}`);
  if (c.linkedinSSI) lines.push(`LinkedIn SSI: ${c.linkedinSSI}`);
  if (c.currentProfession) lines.push(`Current profession: ${c.currentProfession}`);
  if (c.yearsExperience) lines.push(`Years of experience: ${c.yearsExperience}`);
  if (c.currentGrade) lines.push(`Current grade: ${c.currentGrade}`);
  if (c.currentSalary) lines.push(`Current salary: ${c.currentSalary}`);
  if (c.goal) lines.push(`Career goal: ${c.goal}`);
  if (c.desiredSalary) lines.push(`Desired salary: ${c.desiredSalary}`);
  if (c.desiredSalary3to5y) lines.push(`Desired salary in 3-5y: ${c.desiredSalary3to5y}`);
  if (c.desiredDirections) lines.push(`Desired directions: ${c.desiredDirections}`);
  if (c.targetFieldExperience) lines.push(`Target-field experience: ${c.targetFieldExperience}`);
  if (c.retrainingReadiness) lines.push(`Retraining readiness: ${c.retrainingReadiness}`);
  if (c.weeklyHours) lines.push(`Weekly hours: ${c.weeklyHours}`);
  if (c.highlights?.length) {
    lines.push("\nHighlights:");
    for (const h of c.highlights) lines.push(`  - ${h}`);
  }
  if (c.linkedinUrl) lines.push(`\nLinkedIn URL: ${c.linkedinUrl}`);
  return lines.join("\n");
}

function buildPrompt(args: {
  target: SelectedTargetRole;
  targetDisplayTitle: string;
  rolePattern: RoleResumePattern | null;
  primaryResume: ResumeVersion | null;
  otherVersions: ResumeVersion[];
  clientSummarySnippet: string;
  linkedin: LinkedinProfile | null;
  examples: { name: string; text: string }[];
}): string {
  const parts: string[] = [];

  parts.push(`Ты — старший карьерный консультант и автор сильных IT-резюме на роль "${args.targetDisplayTitle}".

═══════════════════════════════════════════════════════════════
ГЛАВНЫЙ ПРИНЦИП (ОЧЕНЬ ВАЖНО, ПЕРЕЧИТАЙ ДВАЖДЫ)
═══════════════════════════════════════════════════════════════

Мы НЕ переписываем резюме клиента "получше". Мы строим ИДЕАЛЬНОГО ${args.targetDisplayTitle} в вакууме — какие у него скиллы, какие достижения, какие метрики, какой стек — и затем АДАПТИРУЕМ этот идеал под РЕАЛЬНЫЙ контекст клиента: его компании, его периоды, его индустрии, его технологический стек.

ИСТОЧНИК ИСТИНЫ ДЛЯ "ЧТО ДОЛЖНО БЫТЬ В РЕЗЮМЕ":
1. role playbook (REFERENCE: role playbook ниже) — distilled из ТОП-10 HH-резюме. Это ОСНОВА.
2. stylistic examples — РОВНО такая структура, плотность, формулировки.

ИСТОЧНИК ИСТИНЫ ДЛЯ "ЧТО БЫЛО У КЛИЕНТА":
1. clientSummary + resume text — РЕАЛЬНЫЕ компании, периоды, должности, индустрии.

═══════════════════════════════════════════════════════════════
🚫 ЖЁСТКИЕ ЗАПРЕТЫ (НИКОГДА НЕ НАРУШАТЬ)
═══════════════════════════════════════════════════════════════

ЗАПРЕЩЕНО ВЫДУМЫВАТЬ:
  ❌ Имя и фамилию клиента. Берём из resume / LinkedIn / clientSummary. Если ни в одном источнике нет — ставь "[FULL NAME]".
  ❌ Email, телефон. Если нет — "[email]", "[phone]".
  ❌ Названия компаний, в которых работал клиент. БРАТЬ строго из резюме / LinkedIn. Если в источнике "ООО «Софтсервис»" — пиши "Softservice LLC", но не превращай это в "Tinkoff Bank".
  ❌ Чем компания занимается (бизнес-домен). Если клиент написал "ритейл" — это ритейл, не банк.
  ❌ Даты работы. Период такой, как в резюме / LinkedIn (можно нормализовать формат "March 2022 – now", но не сдвигать месяцы и годы).
  ❌ Должности. Можно переписать формулировку под целевую роль ("Backend Developer" → "Senior Software Engineer (Platform / DevOps focus)"), но РОЛЬ должна оставаться правдоподобной для фактической позиции.
  ❌ Сертификации, которые клиент НЕ получал. Если в источниках нет AWS/CKA/GCP — НЕ пиши их в "certifications". Помести их в "recommendations" со статусом "Recommended next step".
  ❌ Образование, которого не было. Если ВУЗ/диплом в источниках не указан — ставь "[CLIENT TO FILL: education]".

ЕСЛИ В ИСТОЧНИКАХ НЕТ ОПЫТА ВООБЩЕ (resume пуст, LinkedIn пуст):
  - В experience: ОДИН placeholder-блок:
    company:    "[CLIENT TO FILL: company name]"
    location:   "[location]"
    jobTitle:   "<целевая позиция>"
    period:     "[start date – end date]"
    bullets:    [используй 4-7 идеальных буллетов из playbook как заготовки, но префикс "[Adapt to your context] "]
    technologies: <общий стек из playbook>
  - Помести в redFlags запись severity=high о том, что нет фактуры.
  - В summary честно укажи "<N>+ years … focused on …" только если N можно подтвердить из clientSummary.yearsExperience.

РАЗРЕШЕНО (это всё ещё про "вкусную упаковку", не про обман):
  ✓ Дописывать публично известный КОНТЕКСТ компании ("X5 Tech, Russian retail leader, 170k+ employees") — но только если компания реальная и факты публичные.
  ✓ Переформулировать РЕАЛЬНЫЕ обязанности клиента в плотные буллеты с метриками. Если у клиента в резюме была фраза "оптимизировал API" — можно расширить до "Optimized API response time by ~40% via caching and query batching" (метрика — реалистичная оценка, не вранье).
  ✓ Адаптировать формулировки достижений из playbook к нише клиента, при условии что в опыте клиента такой проект ВЕРОЯТНО существовал (вёл backend в банке → "Designed payment idempotency layer handling 50K+ tx/min").
  ✓ Добавлять технологии в Skills с пометкой в "addedSkills" (см. ниже).

═══════════════════════════════════════════════════════════════
ЦЕЛЕВАЯ РОЛЬ
═══════════════════════════════════════════════════════════════
- Slug: ${args.target.roleSlug}
- Display title: ${args.targetDisplayTitle}
- Bucket: ${args.target.bucket}${args.target.offIndex ? "\n- Off-index роль (нет в основном каталоге)" : ""}${args.target.marketEvidence ? `\n- Market evidence: ${args.target.marketEvidence.slice(0, 600)}` : ""}

═══════════════════════════════════════════════════════════════
ЛОГИКА ГЕНЕРАЦИИ
═══════════════════════════════════════════════════════════════

ШАГ 1. ПРЕДСТАВЬ ИДЕАЛЬНОГО ${args.targetDisplayTitle} (мысленно, не выводи)
- Какие категории навыков обязательно должны быть (из skillCategories playbook)
- Какие достижения с какими метриками типичны (из achievementPhrases playbook + stylistic examples)
- Какой типичный стек, инструменты, методологии
- Какие индустрии / типы продуктов

ШАГ 2. ВОЗЬМИ РЕАЛЬНЫЙ КОНТЕКСТ КЛИЕНТА
- Список компаний (НЕ ВЫДУМЫВАЙ новые! Только те, где он реально работал)
- Периоды работы (как в резюме)
- Должности (можно слегка нормализовать под целевую роль: "Backend Engineer" → "Senior Software Engineer (DevOps focus)" если был сильный devops-крен)
- Индустрии (ритейл, банк, edtech, gaming, classifieds, fintech и т.д.)
- Названия систем, которые он называл (даже одной фразой)

ШАГ 3. АДАПТИРУЙ ИДЕАЛЬНЫЕ ДОСТИЖЕНИЯ ПОД КОНТЕКСТ КЛИЕНТА

Для каждой компании клиента, продумай 4-7 буллетов так:

a) Возьми ИДЕАЛЬНЫЕ достижения из playbook.achievementPhrases / examples, релевантные тому, чем занималась эта компания.
b) Перенеси их в нишу клиента:
   - В playbook: "reduced p99 latency in banking core from 2s to 200ms"
   - У клиента ритейл → "reduced checkout API p99 latency from 2s to 200ms during Black Friday peak (1M+ daily orders)"
c) Используй цифры из reference resumes как BEST GUESS типичного масштаба для этой роли в этой индустрии. Не выдумывай "5М+ users" если клиент явно работал в маленьком стартапе. Но если индустрия и компания публично известны как масштабные — смело подставляй порядки величин.
d) НЕ повторяй один и тот же буллет в двух компаниях.
e) Каждый буллет начинается с глагола действия в past simple (Built, Reduced, Migrated, Led, Owned, Implemented, Designed, Architected, Scaled).
f) ОБЯЗАТЕЛЬНО метрика: % / x / N+ / time / money / scale.

ШАГ 4. ТЕХНОЛОГИЧЕСКИЙ СТЕК — РАСШИРЕННАЯ УПАКОВКА

Базовый набор: что есть в резюме клиента + LinkedIn.

ДОПУСК (важно!): добавляй технологии, которые клиент НЕ упомянул, ЕСЛИ:
  ✓ они в playbook.skillCategories или playbook.popularIndustries
  ✓ это must-have для целевой роли (например DevOps без Terraform — странно)
  ✓ они доучиваются за неделю при наличии смежного опыта (Helm рядом с Kubernetes, Kustomize рядом с Helm, Karpenter рядом с EKS, Loki рядом с Prometheus)
  ✓ компании, в которых работал клиент, НЕ МОГЛИ обходиться без этих инструментов в его роли (если клиент был SRE в банке — у него точно был Vault / Consul / Service Mesh, даже если он не написал)

НЕ ДОБАВЛЯЙ:
  ✗ редкие/нишевые тулы без основы (не пиши Tekton если не было CI/CD, не пиши OpenStack если работа только с публичными облаками)
  ✗ все три облака, если в резюме явно только AWS (можно добавить ОДНО соседнее, не больше)
  ✗ языки программирования, которых нет в опыте (не добавляй Go если человек 10 лет на Python)

ШАГ 5. ОПИСАНИЕ КОМПАНИИ — ВКУСНО, КОНТЕКСТНО

Поле company = "Название, короткое позиционирование с цифрой/масштабом".

Шаблоны (используй только публичные факты):
  ✓ "X5 Tech, Russian retail leader (Pyatyorochka, Perekrestok), 170k+ employees"
  ✓ "Avito, top-1 classifieds platform in Russia, 50M+ MAU"
  ✓ "Tinkoff, leading digital bank, 40M+ customers"
  ✓ "Yandex Cloud, top-3 Russian public cloud"
  ✓ "Wildberries, largest e-commerce marketplace in CIS, 6.5M orders/day"
  ✓ "EPAM, global IT services company, 50k+ engineers"

Если компания малоизвестна — нейтральное, но привлекательное описание:
  ✓ "B2B SaaS startup in EdTech, 10k+ active users"
  ✓ "Fintech scale-up, lending platform, $100M+ portfolio"
  ✓ "Series A AI startup focused on ${args.targetDisplayTitle.toLowerCase()} workflows"

НЕ выдумывай конкретные публичные цифры (число сотрудников, MAU) если не уверен — используй диапазоны.

═══════════════════════════════════════════════════════════════
ШАГ 6. RECOMMENDATIONS — что клиенту доделать
═══════════════════════════════════════════════════════════════

3-8 конкретных коротких советов. Каждый: type, text, estimatedEffort, rationale.
Типы:
  - certification         "Pass AWS Cloud Practitioner — 1-day exam, ~$100, mentioned in 7/10 ideal resumes"
  - technology            "Brush up Helm + ArgoCD — they appear in skills, you should be ready to discuss in interview"
  - experience_framing    "Schloss your 3 short freelance gigs (Mar–Sep 2022) into one entry: 'Independent consultant'"
  - portfolio             "Add 2-3 GitHub projects showcasing Terraform modules"
  - soft_skill            "Prepare a STAR story about leading the migration project"
  - general               anything else

ВАЖНО: Сертификации в этом блоке — ТОЛЬКО рекомендация ("recommend you obtain"), не вписывать их в "certifications" блок резюме как уже полученные.

═══════════════════════════════════════════════════════════════
ШАГ 7. RED FLAGS — что увидит интервьюер/HR/Team Lead
═══════════════════════════════════════════════════════════════

Честно подсветить вещи, которые могут вызвать сомнения у работодателя.
Триггеры:
  high:
    - Пробел в стаже >12 месяцев без объяснения
    - Последнее место работы НЕ соответствует целевой роли (например, был SMM, а целится в DevOps)
    - Полное отсутствие коммерческого опыта по целевой роли
    - 3+ короткие работы (<6 мес) подряд за последние 2 года
  medium:
    - Пробел 6-12 месяцев
    - Несколько коротких работ (3-6 мес) разбросаны по таймлайну
    - Технологии в текущей работе не пересекаются с целевой ролью >50%
    - Уровень английского ниже B2 для зарубежного рынка
  low:
    - Нет цифр в исходных формулировках достижений
    - Нет упоминания командного лида / mentoring (если позиция Senior+)
    - Нет соответствующего образования / сертификатов

Каждый flag: severity, text (что именно), suggestion (как сгладить / прикрыть в cover letter / на интервью).

═══════════════════════════════════════════════════════════════
ШАГ 8. ADDED SKILLS — что мы дописали клиенту
═══════════════════════════════════════════════════════════════

Список технологий, которые мы добавили в "skills" / "experience.technologies", которых не было в резюме клиента. Для каждой:
  - name (technology)
  - learnInDays ("3 days", "1 week", "1 weekend")
  - why ("appears in 8/10 ideal devops resumes")

Это нужно, чтобы клиент быстро доучил их перед собеседованием — он "почти наверняка" с ними работал, но просто забыл вспомнить.

═══════════════════════════════════════════════════════════════
ПРИНЦИПЫ КАЧЕСТВА
═══════════════════════════════════════════════════════════════
- Английский язык во всех полях, кроме раздела languages.
- Summary (2-4 предложения): "I'm a {Title} ({N+ years}). I {built/scaled/migrated} … reducing X by N% / serving N+ users. Stack: …"
- Skills: 5-10 категорий, каждая 5-15 элементов. Группировки осмысленные. НЕ ставь категорию "Other".
- Experience: 4-7 буллетов на место, technologies одной строкой через запятую (15-30 элементов).
- НЕ повторяй один и тот же буллет в разных компаниях.
- Без фанатизма: реалистично, но "очень вкусно". Цель — резюме, которое пройдёт ATS и захотят забрать в любую команду.
- Не более 1.5 страниц — отбирай самое сильное.

═══════════════════════════════════════════════════════════════
ФОРМАТ ОТВЕТА
═══════════════════════════════════════════════════════════════
Только JSON, СТРОГО по схеме ниже, без markdown wrapper, без комментариев.
{
  "fullName": string,
  "title": string,
  "contactLine": string,
  "summary": string,
  "skills": [{ "category": string, "items": [string] }],
  "experience": [{
    "company": string,
    "location": string,
    "jobTitle": string,
    "period": string,
    "projects": [{ "label": string }],
    "bullets": [string],
    "technologies": string
  }],
  "certifications": [{ "name": string, "date": string }],
  "education": [{ "text": string }],
  "languages": [{ "text": string }],
  "recommendations": [{ "type": string, "text": string, "estimatedEffort": string, "rationale": string }],
  "redFlags": [{ "severity": "high"|"medium"|"low", "text": string, "suggestion": string }],
  "addedSkills": [{ "name": string, "learnInDays": string, "why": string }]
}`);

  if (args.rolePattern) {
    parts.push(
      "\n═══════════════════════════════════════════════════════════════\n" +
        "REFERENCE 1: role playbook — DISTILLED ИЗ ТОП-10 HH-РЕЗЮМЕ\n" +
        "Это твой ОСНОВНОЙ источник истины «как должен выглядеть идеал».\n" +
        "═══════════════════════════════════════════════════════════════\n" +
        JSON.stringify(args.rolePattern, null, 2),
    );
  }

  if (args.examples.length > 0) {
    parts.push(
      "\n═══════════════════════════════════════════════════════════════\n" +
        "REFERENCE 2: stylistic examples — match this tone, density, structure\n" +
        "═══════════════════════════════════════════════════════════════",
    );
    for (let i = 0; i < args.examples.length; i++) {
      parts.push(`\n# Example ${i + 1} (${args.examples[i].name}):\n${args.examples[i].text.slice(0, 6000)}`);
    }
  }

  parts.push(
    "\n═══════════════════════════════════════════════════════════════\n" +
      "CLIENT DATA — реальный контекст: компании, периоды, индустрии, стек.\n" +
      "ЭТО НЕ ИСТОЧНИК ФОРМУЛИРОВОК — это источник фактов.\n" +
      "═══════════════════════════════════════════════════════════════",
  );

  parts.push("\n--- CLIENT: summary (output of intake pipeline) ---");
  parts.push(args.clientSummarySnippet);

  if (args.primaryResume) {
    parts.push(
      "\n--- CLIENT: primary resume text (most recent version) ---\n" +
        args.primaryResume.text.slice(0, 14000),
    );
  } else {
    parts.push(
      "\n--- CLIENT: primary resume text ---\n(no resume on file — rely on questionnaire and LinkedIn)",
    );
  }

  if (args.otherVersions.length > 0) {
    const blob = args.otherVersions
      .map(
        (v, i) =>
          `## Version ${i + 1} (${v.source}, ${v.createdAt})\n${v.text.slice(0, 6000)}`,
      )
      .join("\n\n");
    parts.push(
      "\n--- CLIENT: previous resume versions (might mention things missing from primary) ---\n" +
        blob,
    );
  }

  if (args.linkedin) {
    parts.push(
      `\n--- CLIENT: LinkedIn profile (${args.linkedin.source}) ---\n${args.linkedin.text.slice(0, 8000)}`,
    );
  }

  parts.push(
    "\n\n═══════════════════════════════════════════════════════════════\n" +
      "ВЫПОЛНИ:\n" +
      "1. Извлеки реальный список компаний / периодов / должностей из CLIENT-блока.\n" +
      "2. Для каждой компании построй буллеты по логике ШАГ 3 (адаптация идеальных формулировок к индустрии клиента).\n" +
      "3. Технологии по логике ШАГ 4 (базовый набор + must-have допуски).\n" +
      "4. Опиши каждую компанию по логике ШАГ 5.\n" +
      "5. Верни ТОЛЬКО JSON-объект по схеме. Без markdown, без преамбулы, без комментариев.\n" +
      "═══════════════════════════════════════════════════════════════",
  );

  return parts.join("\n");
}

function unwrapJsonText(raw: string): string {
  let txt = raw.trim();
  if (txt.startsWith("```")) {
    txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  return txt;
}

export interface GeneratedIdealResumeData {
  data: IdealResume;
  generatedAt: string;
  targetRoleSlug: string;
  targetRoleTitle: string;
  sourceResumeVersionId: string | null;
  sourceResumeUrl: string | null;
  usedLinkedinProfile: boolean;
  usedRolePattern: boolean;
  linkedin: LinkedinProfile | null;
  model: string;
  usage: { in: number; out: number; ms: number };
  /** Final prompt that was actually sent to the LLM (debug/audit). */
  prompt: string;
}

/**
 * LLM-part only: builds the prompt, calls Claude, validates the JSON.
 * Does NOT render to Google Doc — useful for pilots / dry-run.
 */
export async function generateIdealResumeData(
  input: GenerateIdealResumeInput,
): Promise<GeneratedIdealResumeData> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const titles = await loadDisplayTitles();
  const targetDisplayTitle =
    titles.get(input.target.roleSlug) || input.target.title || input.target.roleSlug;

  const rolePattern = await loadRolePattern(input.target.roleSlug);
  const examples = await loadExamples();

  const versionPrimary = pickPrimaryResumeVersion(
    input.resumeVersions,
    input.activeResumeVersionId,
  );
  // Synthesise a virtual ResumeVersion from preloadedResume so the rest of
  // the pipeline can treat it uniformly.
  const preloadedAsVersion: ResumeVersion | null =
    !versionPrimary && input.preloadedResume?.text
      ? {
          id: "preloaded",
          createdAt: new Date().toISOString(),
          source: "google_drive_url",
          textLength: input.preloadedResume.text.length,
          text: input.preloadedResume.text,
        }
      : null;
  const primary = versionPrimary ?? preloadedAsVersion;
  const sourceResumeVersionId = versionPrimary?.id ?? null;
  const sourceResumeUrl = preloadedAsVersion
    ? input.preloadedResume?.sourceUrl ?? null
    : null;
  const others =
    input.resumeVersions
      ?.filter((v) => v.id !== primary?.id)
      ?.slice(-2) ?? [];

  let linkedin: LinkedinProfile | null = null;
  if (input.linkedinUrl) {
    try {
      linkedin = await fetchLinkedinProfile(input.linkedinUrl);
    } catch (err) {
      console.warn(
        `[IdealResume] LinkedIn fetch failed for ${input.linkedinUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const prompt = buildPrompt({
    target: input.target,
    targetDisplayTitle,
    rolePattern,
    primaryResume: primary,
    otherVersions: others,
    clientSummarySnippet: summariseClientSummary(input.clientSummary),
    linkedin,
    examples,
  });

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
    throw new Error("Anthropic returned no text block");
  }
  const raw = unwrapJsonText(block.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `JSON parse failed: ${err instanceof Error ? err.message : String(err)}\n--- raw (first 1000 chars) ---\n${raw.slice(0, 1000)}`,
    );
  }

  const generatedAt = new Date().toISOString();
  const enriched = {
    ...(parsed as Partial<IdealResume>),
    meta: {
      targetRoleSlug: input.target.roleSlug,
      targetRoleTitle: targetDisplayTitle,
      sourceResumeVersionId,
      sourceResumeUrl,
      usedLinkedinProfile: !!linkedin,
      usedRolePattern: !!rolePattern,
      generatedAt,
      model: MODEL,
    },
  };

  let validated: IdealResume;
  try {
    validated = idealResumeSchema.parse(enriched);
  } catch (err) {
    throw new Error(
      `IdealResume schema validation failed: ${err instanceof Error ? err.message : String(err)}\n--- raw output ---\n${raw.slice(0, 2000)}`,
    );
  }

  console.log(
    `[IdealResume] generated for ${input.nick}/${input.target.roleSlug} ` +
      `in=${resp.usage.input_tokens} out=${resp.usage.output_tokens} ${(ms / 1000).toFixed(1)}s`,
  );

  return {
    data: validated,
    generatedAt,
    targetRoleSlug: input.target.roleSlug,
    targetRoleTitle: targetDisplayTitle,
    sourceResumeVersionId,
    sourceResumeUrl,
    usedLinkedinProfile: !!linkedin,
    usedRolePattern: !!rolePattern,
    linkedin,
    model: MODEL,
    usage: {
      in: resp.usage.input_tokens,
      out: resp.usage.output_tokens,
      ms,
    },
    prompt,
  };
}

export async function generateIdealResume(
  input: GenerateIdealResumeInput,
): Promise<GenerateIdealResumeResult> {
  const generated = await generateIdealResumeData(input);

  const docTitle = `Resume — ${input.nick} — ${generated.targetRoleTitle}`;
  const renderResult = await fillIdealResumeTemplate(generated.data, docTitle);

  const artifact: IdealResumeArtifact = {
    id: crypto.randomUUID(),
    url: renderResult.url,
    docId: renderResult.id,
    generatedAt: generated.generatedAt,
    version: (input.previous?.version ?? 0) + 1,
    targetRoleSlug: generated.targetRoleSlug,
    targetRoleTitle: generated.targetRoleTitle,
    sourceResumeVersionId: generated.sourceResumeVersionId,
    usedLinkedinProfile: generated.usedLinkedinProfile,
    usedRolePattern: generated.usedRolePattern,
    model: generated.model,
    data: generated.data,
  };

  return { artifact, linkedin: generated.linkedin };
}
