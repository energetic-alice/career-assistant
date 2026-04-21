import type {
  CandidateProfile,
  DirectionsOutput,
  AnalysisOutput,
  ReviewSummary,
  ReviewFlag,
} from "../schemas/analysis-outputs.js";
import type { RawQuestionnaire } from "../schemas/participant.js";
import type { PipelineStage } from "../schemas/pipeline-state.js";
import type { ClientSummary } from "../schemas/client-summary.js";

export function buildReviewSummary(
  profile: CandidateProfile,
  directions: DirectionsOutput,
  analysis: AnalysisOutput,
): ReviewSummary {
  const flags: ReviewFlag[] = [];

  const ssi = profile.linkedinSSI;
  const ssiNum = ssi ? Number(ssi) : undefined;
  const targets = profile.barriers.accessibleMarkets ?? [];
  const isEuTarget = targets.some((m) => m === "eu" || m === "uk");

  if (ssiNum !== undefined && !Number.isNaN(ssiNum) && ssiNum < 30 && isEuTarget) {
    flags.push({
      type: "red",
      message: `LinkedIn SSI = ${ssi}. Для EU рынка это критически мало.`,
    });
  }

  for (const dir of analysis.directions) {
    if (dir.market.vacanciesPer100Specialists < 3) {
      flags.push({
        type: "yellow",
        message: `${dir.title}: конкуренция высокая (${dir.market.vacanciesPer100Specialists} вак/100 спец)`,
      });
    }

    if (dir.aiRisk.level === "высокий") {
      flags.push({
        type: "yellow",
        message: `${dir.title}: AI-риск высокий`,
      });
    }

    if (dir.transition.adjacencyScorePercent < 40) {
      flags.push({
        type: "red",
        message: `${dir.title}: близость перехода ${dir.transition.adjacencyScorePercent}% - фактически новая карьера`,
      });
    }

    if (dir.salary.isDesiredSalaryAchievable.toLowerCase().includes("нереалист")) {
      flags.push({
        type: "red",
        message: `${dir.title}: желаемая зп нереалистична`,
      });
    }
  }

  const weeklyHours = profile.careerGoals.weeklyHours;
  if (weeklyHours && /[0-5]\s*(ч|час)/i.test(weeklyHours)) {
    flags.push({
      type: "yellow",
      message: `Бюджет времени: ${weeklyHours} - критически мало для серьезного перехода`,
    });
  }

  if ((profile.currentBase.englishLevel === "0" || profile.currentBase.englishLevel === "A1") && isEuTarget) {
    flags.push({
      type: "red",
      message: "English ~0, но целевой рынок EU - барьер №1",
    });
  }

  return {
    candidateName: profile.name,
    currentRole: profile.currentBase.currentRole,
    targetMarket: targets.join(", "),
    englishLevel: profile.currentBase.englishLevel,
    linkedinSSI: profile.linkedinSSI,
    superpower: undefined,
    directions: analysis.directions.map((d) => ({
      title: d.title,
      type: d.type,
      adjacency: d.transition.adjacencyScorePercent,
      competition: d.market.competition,
      vacPer100: d.market.vacanciesPer100Specialists,
      salary: d.salary.range,
      aiRisk: d.aiRisk.level,
    })),
    flags,
  };
}

export function formatReviewForTelegram(summary: ReviewSummary): string {
  const lines: string[] = [];

  lines.push(`<b>${summary.candidateName}</b>`);
  lines.push(`${summary.currentRole} | ${summary.targetMarket}`);
  lines.push(`English: ${summary.englishLevel}${summary.linkedinSSI != null ? ` | SSI: ${summary.linkedinSSI}` : ""}`);
  lines.push("");
  lines.push(`<b>Суперсила:</b> ${summary.superpower}`);
  lines.push("");

  for (let i = 0; i < summary.directions.length; i++) {
    const d = summary.directions[i];
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
    lines.push(
      `${medal} <b>${d.title}</b>`,
    );
    lines.push(
      `   ${d.type} | ${d.adjacency}% | ${d.vacPer100} вак/100 | AI: ${d.aiRisk}`,
    );
    lines.push(`   ${d.salary}`);
  }

  if (summary.flags.length > 0) {
    lines.push("");
    lines.push("<b>Флаги:</b>");
    for (const f of summary.flags) {
      const icon = f.type === "red" ? "🔴" : f.type === "yellow" ? "🟡" : "ℹ️";
      lines.push(`${icon} ${f.message}`);
    }
  }

  return lines.join("\n");
}

const QUESTIONNAIRE_LABELS: Record<keyof RawQuestionnaire, string> = {
  timestamp: "Дата заполнения",
  telegramNick: "Telegram ник",
  itStatus: "Где сейчас",
  citizenship: "Гражданство",
  currentLocation: "Где живёшь сейчас",
  targetCountries: "Целевые страны",
  workFormat: "Идеальный формат работы",
  englishLevel: "Английский",
  education: "Высшее образование",
  currentOccupation: "Чем занимаешься сейчас",
  currentJobAndSalary: "Текущая роль и доход",
  yearsExperience: "Опыт в текущей профессии",
  desiredSalary: "Желаемая зарплата",
  desiredSalary3to5y: "Желаемая зарплата через 3-5 лет",
  whyAccelerator: "Почему акселератор / работа с Алисой",
  desiredResult: "Желаемый результат",
  directionInterest: "Интересные направления",
  whyThisDirection: "Почему именно это направление",
  retrainingReadiness: "Готовность к переобучению",
  weeklyHours: "Часов в неделю",
  currentSituation: "Текущая карьерная ситуация",
  careerGoals: "Карьерные цели на год",
  previousAttempts: "Предыдущие попытки изменить",
  communicationStyle: "Коммуникация и созвоны",
  aspirationLevel: "Целевой уровень через 3-5 лет",
  routineAttitude: "Отношение к рутине",
  workPreference: "Что любишь больше",
  hatedTasks: "Что не люблю",
  additionalThoughts: "Дополнительно",
  resumeFileUrl: "Резюме (файл)",
  resumeTextDirect: "Резюме (текстом)",
  linkedinUrl: "LinkedIn",
  linkedinSSI: "LinkedIn SSI",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const QUESTIONNAIRE_HTML_STYLE = `
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;
     max-width:760px;margin:32px auto;padding:0 20px;line-height:1.55;color:#222}
h1{font-size:20px;margin:0 0 24px;border-bottom:1px solid #eee;padding-bottom:8px}
.q{margin:18px 0 0;font-weight:600;color:#1a1a1a}
.a{margin:4px 0 0;white-space:pre-wrap;color:#333}
.unmapped{margin:32px 0 0;padding:12px 14px;background:#fff7e6;border-left:3px solid #f0a020;font-size:13px;color:#7a5200}
.unmapped strong{display:block;margin-bottom:4px;color:#5e3f00}
`.trim();

function buildHtmlDoc(
  title: string,
  pairs: { question: string; answer: string }[],
  unmapped: string[] = [],
): string {
  const items = pairs
    .map(
      (p) =>
        `<div class="q">${escapeHtml(p.question)}</div>` +
        `<div class="a">${escapeHtml(p.answer)}</div>`,
    )
    .join("\n");
  const unmappedBlock = unmapped.length
    ? `<div class="unmapped"><strong>⚠ Поля без сопоставления в COLUMN_MAP (${unmapped.length}):</strong>` +
      unmapped.map((u) => `• ${escapeHtml(u)}`).join("<br>") +
      "</div>"
    : "";
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${QUESTIONNAIRE_HTML_STYLE}</style></head>
<body><h1>${escapeHtml(title)}</h1>
${items}
${unmappedBlock}
</body></html>`;
}

/**
 * Render the participant's questionnaire verbatim for Telegram.
 *
 * Prefers `rawNamedValues` (the original {question header → answer} snapshot
 * captured from the form) so questions appear exactly as the client saw them.
 * Falls back to `RawQuestionnaire` with friendly labels when the snapshot
 * isn't available (e.g. webhook called without `namedValues`).
 *
 * Returns a standalone HTML document (DOCTYPE + CSS) ready to be uploaded
 * as a .html attachment. The questionnaire is always sent as a file —
 * Telegram's 4096-char message cap doesn't constrain us.
 */
export function formatQuestionnaireForTelegram(
  raw: RawQuestionnaire | undefined,
  rawNamedValues?: Record<string, string>,
  options: { title?: string; unmapped?: string[] } = {},
): string {
  const pairs: { question: string; answer: string }[] = [];

  if (rawNamedValues && Object.keys(rawNamedValues).length > 0) {
    for (const [question, answer] of Object.entries(rawNamedValues)) {
      const trimmed = (answer ?? "").trim();
      if (!trimmed) continue;
      pairs.push({ question, answer: trimmed });
    }
  } else if (raw) {
    for (const [key, label] of Object.entries(QUESTIONNAIRE_LABELS) as [
      keyof RawQuestionnaire,
      string,
    ][]) {
      const value = (raw[key] ?? "").toString().trim();
      if (!value) continue;
      pairs.push({ question: label, answer: value });
    }
  }

  const title = options.title ?? "Анкета клиента";
  const unmapped = options.unmapped ?? [];
  return buildHtmlDoc(title, pairs, unmapped);
}

export const STAGE_LABELS: Record<PipelineStage, string> = {
  intake_received: "🟡 Анкета получена",
  resume_parsed: "🟡 Резюме распознано",
  awaiting_analysis: "🟢 Анкета добавлена",
  analysis_running: "⚙️ Анализ запущен",
  profile_extracted: "🟡 Профиль извлечён",
  directions_generated: "🟡 Направления сгенерированы",
  market_data_fetched: "🟡 Рыночные данные собраны",
  directions_analyzed: "🟡 Анализ направлений готов",
  admin_review_pending: "🔵 Ждёт ревью",
  admin_reviewed: "🔵 Ревью пройдено",
  final_compiled: "🟢 Документ собран",
  completed: "🟢 Завершён",
  completed_legacy: "✅ Анализ готов (legacy)",
};

function pickResumeUrl(rnv: Record<string, string> | undefined): string | undefined {
  if (!rnv) return undefined;
  for (const [k, v] of Object.entries(rnv)) {
    if (/резюме/i.test(k) && /https?:\/\//i.test(v)) {
      return v.split(",")[0].trim();
    }
  }
  return undefined;
}

function pickLinkedinUrl(rnv: Record<string, string> | undefined): string | undefined {
  if (!rnv) return undefined;
  for (const [k, v] of Object.entries(rnv)) {
    if (/linkedin/i.test(k) && /https?:\/\/[^,\s]*linkedin/i.test(v)) {
      return v.split(",")[0].trim();
    }
  }
  return undefined;
}

function pickRnv(
  rnv: Record<string, string> | undefined,
  predicate: (key: string) => boolean,
): string | undefined {
  if (!rnv) return undefined;
  for (const [k, v] of Object.entries(rnv)) {
    if (predicate(k) && v.trim()) return v.trim();
  }
  return undefined;
}

export interface ClientCardSource {
  telegramNick: string;
  stage: PipelineStage;
  /** Готовый Claude-saммари клиента — основной источник данных для карточки. */
  clientSummary?: ClientSummary;
  /** Fallback: имя из профиля Phase 1 (если clientSummary не сгенерирован). */
  profileName?: string;
  /** Fallback: исходная анкета. */
  rawQuestionnaire?: RawQuestionnaire;
  /** Fallback: оригинальные пары вопрос/ответ из формы. */
  rawNamedValues?: Record<string, string>;
  /** Для stage=completed_legacy: ссылка на готовый Google Doc анализа. */
  legacyDocUrl?: string;
  /** Для stage=completed_legacy: тариф (Групповой / ВИП). */
  legacyTariff?: string;
}

/**
 * Compact one-message client card for Telegram.
 * Used both before review-summary and as response to /client <nick>.
 *
 * Уровень 1 (предпочтительный): рендер из готового `clientSummary` (JSON от Claude).
 * Уровень 2 (fallback для legacy state): рендер из rawNamedValues / rawQuestionnaire.
 */
export function formatClientCardForTelegram(src: ClientCardSource): string {
  const body = src.clientSummary
    ? renderFromClientSummary(src.clientSummary, src.telegramNick, src.stage)
    : renderFromRawFallback(src);

  if (src.stage === "completed_legacy") {
    const parts: string[] = [];
    if (src.legacyTariff) {
      parts.push(`<b>Тариф:</b> ${escapeHtml(src.legacyTariff)}`);
    }
    if (src.legacyDocUrl) {
      parts.push(
        `<b>📄 Анализ:</b> <a href="${escapeHtml(src.legacyDocUrl)}">Google Doc</a>`,
      );
    } else {
      parts.push("<b>📄 Анализ:</b> ссылка утеряна");
    }
    if (parts.length > 0) {
      return `${body}\n\n${parts.join("\n")}`;
    }
  }

  return body;
}

function renderFromClientSummary(
  s: ClientSummary,
  rawNick: string,
  stage: PipelineStage,
): string {
  const nick = (rawNick || "").replace(/^@/, "") || "—";
  const tgUrl = nick !== "—" ? `https://t.me/${nick}` : undefined;

  // ── Шапка: Имя · @ник · LinkedIn · SSI ────────────────────────────────
  const latName = [s.firstNameLatin, s.lastNameLatin]
    .filter((x) => x && x !== "—")
    .join(" ");
  const cyrName = [s.firstName, s.lastName]
    .filter((x) => x && x !== "—")
    .join(" ");
  const nameStr = latName || cyrName || `@${nick}`;

  const headParts: string[] = [`<b>${escapeHtml(nameStr)}</b>`];
  if (tgUrl) headParts.push(`<a href="${tgUrl}">@${escapeHtml(nick)}</a>`);
  else headParts.push(`@${escapeHtml(nick)}`);
  if (s.linkedinUrl) {
    headParts.push(`<a href="${escapeHtml(s.linkedinUrl)}">LinkedIn</a>`);
  }
  headParts.push(`SSI ${escapeHtml(s.linkedinSSI)}`);

  // ── 2-я строка: гражданство · 📍 локация · 🌐 рынок (Англ: уровень) ──
  const baseLine = [
    escapeHtml(s.citizenship),
    `📍 ${escapeHtml(s.location)}`,
    `🌐 ${escapeHtml(s.targetMarket)} (Англ: ${escapeHtml(s.englishLevel)})`,
  ].join(" · ");

  // ── Хайлайты буллет-листом ────────────────────────────────────────────
  const highlightItems: string[] = Array.isArray(s.highlights)
    ? s.highlights
    : (s.highlights as unknown as string)
        .split(/\s+·\s+|(?<=\.)\s+(?=[А-ЯA-Z])/) // legacy: " · " или ". " между фразами
        .map((x) => x.replace(/\.$/, "").trim())
        .filter(Boolean);
  const highlightsBlock = highlightItems.length
    ? highlightItems.map((h) => `• ${escapeHtml(h)}`).join("\n")
    : "—";

  // ── Резюме: ссылки текстом, по одной на строку ────────────────────────
  const resumeUrls = (s.resumeUrls && s.resumeUrls.length > 0)
    ? s.resumeUrls
    : (s.resumeUrl ? [s.resumeUrl] : []);
  const resumeBlock = resumeUrls.length
    ? resumeUrls.map((u) => escapeHtml(u)).join("\n")
    : "—";

  const targetExp = s.targetFieldExperience?.trim() || "—";

  const lines: string[] = [
    headParts.join(" · "),
    baseLine,
    "",
    `<b>Сейчас:</b> ${escapeHtml(s.currentProfession)} · ${escapeHtml(s.yearsExperience)} · ${escapeHtml(s.currentSalary)}`,
    "",
    `<b>Цель:</b> ${escapeHtml(s.goal)} · ${escapeHtml(targetExp)}`,
    `<b>Направления:</b> ${escapeHtml(s.desiredDirections)}`,
    `<b>Зарплата:</b> ${escapeHtml(s.desiredSalary)}, через 3-5 л ${escapeHtml(s.desiredSalary3to5y)}`,
    `<b>Переобуч.:</b> ${escapeHtml(s.retrainingReadiness)}`,
    `<b>Часов/нед:</b> ${escapeHtml(s.weeklyHours)}`,
    "",
    "<b>⚠️ Риски</b>",
    highlightsBlock,
    "",
    "<b>Резюме:</b>",
    resumeBlock,
    `<b>Статус:</b> ${STAGE_LABELS[stage] ?? stage}`,
  ];

  return lines.join("\n");
}

function renderFromRawFallback(src: ClientCardSource): string {
  const rq = src.rawQuestionnaire;
  const rnv = src.rawNamedValues;

  const nick = (src.telegramNick || "").replace(/^@/, "");
  const name = src.profileName?.trim() || (nick ? `@${nick}` : "Клиент");

  const location =
    rq?.currentLocation?.trim() ||
    pickRnv(rnv, (k) => /(в какой стране|где ты живешь|location)/i.test(k));
  const occupation =
    rq?.currentJobAndSalary?.trim() ||
    rq?.currentOccupation?.trim() ||
    pickRnv(rnv, (k) => /(чем ты занимаешься|кем ты работаешь)/i.test(k));
  const yearsExp = rq?.yearsExperience?.trim();
  const goal =
    rq?.careerGoals?.trim() ||
    rq?.desiredResult?.trim() ||
    pickRnv(rnv, (k) => /(карьерные цели|желаемый результат|какой результат)/i.test(k));
  const targets = rq?.targetCountries?.trim();

  const sentenceParts: string[] = [];
  if (location) sentenceParts.push(`📍 ${escapeHtml(location)}`);
  if (occupation) {
    const exp = yearsExp ? ` · ${escapeHtml(yearsExp)}` : "";
    sentenceParts.push(`💼 ${escapeHtml(occupation)}${exp}`);
  }
  if (targets) sentenceParts.push(`🌍 → ${escapeHtml(targets)}`);
  if (goal) sentenceParts.push(`🎯 ${escapeHtml(goal)}`);

  const tgUrl = nick ? `https://t.me/${nick}` : undefined;
  const resumeUrl = pickResumeUrl(rnv);
  const linkedinUrl = pickLinkedinUrl(rnv);

  const linkParts: string[] = [];
  if (tgUrl) linkParts.push(`<a href="${tgUrl}">Telegram</a>`);
  if (resumeUrl) linkParts.push(`<a href="${escapeHtml(resumeUrl)}">Резюме</a>`);
  if (linkedinUrl) linkParts.push(`<a href="${escapeHtml(linkedinUrl)}">LinkedIn</a>`);

  const stageLabel = STAGE_LABELS[src.stage] ?? src.stage;

  const lines = [
    `<b>${escapeHtml(name)}</b>`,
    ...sentenceParts,
    "",
    linkParts.length ? `🔗 ${linkParts.join(" · ")}` : "",
    `📊 ${stageLabel}`,
  ].filter((s) => s !== "");

  return lines.join("\n");
}
