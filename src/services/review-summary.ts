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
import { formatRegions } from "./market-access.js";

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
    // null = метрики нет (UK/EU/US — справочник содержит только оценочные ratio).
    // Флаг по конкуренции рисуем только когда есть точное число (RU).
    if (
      dir.market.vacanciesPer100Specialists !== null &&
      dir.market.vacanciesPer100Specialists < 3
    ) {
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
    const vacPer100Str =
      d.vacPer100 !== null ? `${d.vacPer100} вак/100` : "конкуренция: оценка";
    lines.push(
      `   ${d.type} | ${d.adjacency}% | ${vacPer100Str} | AI: ${d.aiRisk}`,
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

function escapeHtml(s: unknown): string {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

export interface ResumeDocumentVersion {
  id?: string;
  createdAt?: string;
  source?: string;
  sourceFileName?: string;
  mimeType?: string;
  textLength?: number;
  text?: string;
}

export function formatResumeForTelegram(input: {
  title?: string;
  resumeText?: string;
  resumeVersions?: ResumeDocumentVersion[];
  activeResumeVersionId?: string;
  rawNamedValues?: Record<string, string>;
  clientSummary?: ClientSummary;
}): string | null {
  const versions = input.resumeVersions ?? [];
  const activeVersion =
    (input.activeResumeVersionId
      ? versions.find((v) => v.id === input.activeResumeVersionId)
      : undefined) ?? versions[versions.length - 1];

  const text = (activeVersion?.text || input.resumeText || "").trim();
  const sourceUrls = new Set<string>();

  for (const [key, value] of Object.entries(input.rawNamedValues ?? {})) {
    if (!/резюме/i.test(key)) continue;
    for (const url of value.match(/https?:\/\/[^\s,]+/g) ?? []) {
      sourceUrls.add(url);
    }
  }

  const summaryUrls = input.clientSummary?.resumeUrls?.length
    ? input.clientSummary.resumeUrls
    : input.clientSummary?.resumeUrl
      ? [input.clientSummary.resumeUrl]
      : [];
  for (const url of summaryUrls) {
    if (url) sourceUrls.add(url);
  }

  if (
    activeVersion?.source === "google_drive_url" &&
    activeVersion.sourceFileName?.startsWith("http")
  ) {
    sourceUrls.add(activeVersion.sourceFileName);
  }

  if (!text && sourceUrls.size === 0) return null;

  const pairs: { question: string; answer: string }[] = [];
  if (sourceUrls.size > 0) {
    pairs.push({
      question: "Исходные ссылки на резюме",
      answer: [...sourceUrls].join("\n"),
    });
  }

  if (activeVersion) {
    const meta = [
      activeVersion.createdAt ? `Дата: ${activeVersion.createdAt}` : "",
      activeVersion.source ? `Источник: ${activeVersion.source}` : "",
      activeVersion.sourceFileName ? `Файл/ссылка: ${activeVersion.sourceFileName}` : "",
      activeVersion.mimeType ? `MIME: ${activeVersion.mimeType}` : "",
      activeVersion.textLength != null ? `Длина: ${activeVersion.textLength} символов` : "",
    ].filter(Boolean);
    if (meta.length > 0) {
      pairs.push({ question: "Активная версия", answer: meta.join("\n") });
    }
  } else if (text) {
    pairs.push({ question: "Активная версия", answer: "Текст из текущего pipeline input" });
  }

  if (versions.length > 1) {
    const history = versions.map((v, idx) => {
      const active = v.id && v.id === input.activeResumeVersionId ? "активная" : "";
      const created = v.createdAt ?? "unknown date";
      const source = v.source ?? "unknown source";
      const length = v.textLength != null ? `${v.textLength} символов` : "длина неизвестна";
      return `${idx + 1}. ${created} · ${source} · ${length}${active ? ` · ${active}` : ""}`;
    });
    pairs.push({ question: "История версий", answer: history.join("\n") });
  }

  pairs.push({
    question: "Распознанный текст резюме",
    answer: text || "Пока нет распознанного текста. Есть только исходная ссылка выше.",
  });

  return buildHtmlDoc(input.title ?? "Резюме клиента", pairs);
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
  shortlist_generating: "⚙️ Предварительный анализ…",
  shortlist_ready: "🔵 Shortlist готов — ждёт ревью",
  shortlist_failed: "❌ Предварительный анализ упал",
  shortlist_approved: "🔵 Shortlist одобрен",
  deep_generating: "⚙️ Глубокий анализ…",
  deep_ready: "🔵 Глубокий анализ готов — ждёт ревью",
  deep_failed: "❌ Глубокий анализ упал",
  deep_approved: "🔵 Глубокий анализ одобрен",
  final_generating: "⚙️ Финальный анализ собирается…",
  final_ready: "🟢 Финальный анализ готов",
  final_failed: "❌ Финальный анализ упал",
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
  /**
   * Для stage=final_ready: ссылка на свежесгенерированный Google Doc финального
   * карьерного анализа (Phase 3 + Phase 4). Берётся из
   * `state.stageOutputs.finalAnalysis.docUrl`.
   */
  analysisDocUrl?: string;
  /** Для stage=final_ready: ISO timestamp генерации (для подписи в карточке). */
  analysisGeneratedAt?: string;
  /** Для stage=final_failed: текст ошибки последней попытки. */
  analysisError?: string;
  /** Направления, выбранные для дальнейшей упаковки/поиска работы. */
  selectedTargetRoles?: Array<{
    roleSlug: string;
    title: string;
    bucket?: string;
    offIndex?: boolean;
    selectedAt?: string;
  }>;
  /** Активные ручные заметки клиента (forward / /note). */
  clientNotes?: Array<{
    id: string;
    createdAt: string;
    text: string;
    authorUsername?: string;
    source?: string;
  }>;
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

  const selectedTargets = formatSelectedTargetRoles(src.selectedTargetRoles);
  const notesBlock = formatClientNotes(src.clientNotes);
  const finalAnalysisBlock = formatFinalAnalysisBlock(src);
  const withTargets = [body, selectedTargets, notesBlock, finalAnalysisBlock]
    .filter((s) => s && s.length > 0)
    .join("\n\n");

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
      return `${withTargets}\n\n${parts.join("\n")}`;
    }
  }

  return withTargets;
}

function formatSelectedTargetRoles(
  roles: ClientCardSource["selectedTargetRoles"],
): string {
  if (!roles || roles.length === 0) {
    return "<b>🎯 Упаковка/поиск:</b> не выбрано";
  }

  const lines = roles.map((role, idx) => {
    const tags = [
      role.roleSlug,
      role.bucket,
      role.offIndex ? "off-index" : "",
    ].filter(Boolean);
    const meta = tags.length ? ` <code>${escapeHtml(tags.join(" · "))}</code>` : "";
    return `${idx + 1}. ${escapeHtml(role.title)}${meta}`;
  });

  return [`<b>🎯 Упаковка/поиск:</b>`, ...lines].join("\n");
}

function formatFinalAnalysisBlock(src: ClientCardSource): string {
  if (src.stage === "final_ready" && src.analysisDocUrl) {
    const date = (src.analysisGeneratedAt || "").slice(0, 10);
    const dateLabel = date ? ` · ${escapeHtml(date)}` : "";
    return (
      `<b>📄 Карьерный анализ:</b> ` +
      `<a href="${escapeHtml(src.analysisDocUrl)}">Google Doc</a>${dateLabel}`
    );
  }
  if (src.stage === "final_generating") {
    return `<b>📄 Карьерный анализ:</b> ⚙️ собирается…`;
  }
  if (src.stage === "final_failed") {
    const err = src.analysisError ? ` (${escapeHtml(src.analysisError.slice(0, 200))})` : "";
    return `<b>📄 Карьерный анализ:</b> ❌ генерация упала${err}`;
  }
  return "";
}

function formatClientNotes(
  notes: ClientCardSource["clientNotes"],
): string {
  if (!notes || notes.length === 0) return "";
  const lines = notes.slice(0, 8).map((n, i) => {
    const date = (n.createdAt || "").slice(0, 10);
    const author = n.authorUsername ? ` <i>от @${escapeHtml(n.authorUsername)}</i>` : "";
    const truncated = n.text.length > 220 ? n.text.slice(0, 220) + "…" : n.text;
    return `${i + 1}. <code>${escapeHtml(n.id.slice(0, 8))}</code> ${date}${author}: ${escapeHtml(truncated)}`;
  });
  const more = notes.length > 8 ? `\n…и ещё ${notes.length - 8}` : "";
  return [`<b>📝 Заметки (${notes.length}):</b>`, ...lines].join("\n") + more;
}

/**
 * Для «Сейчас» в карточке. Если Клод классифицировал профессию в canonical slug
 * — показываем slug как основной идентификатор (`backend_python`) + raw-текст
 * в скобках, если raw существенно отличается. Non-IT профессии отдаются как есть.
 */
function formatProfessionLabel(slug: string | null | undefined, raw: string): string {
  if (!slug) return raw;
  const rawNorm = (raw || "").trim();
  // `other` — IT-маркер без нишевого slug'а. В карточке показываем только raw.
  if (slug === "other") return rawNorm || "other (IT)";
  if (!rawNorm || rawNorm === "—") return slug;
  // Если raw — короткая вариация slug'а (например "Python разработчик" для backend_python),
  // не дублируем. Показываем просто slug.
  const slugTokens = new Set(slug.toLowerCase().split(/[_-]/));
  const rawLower = rawNorm.toLowerCase();
  const overlap = [...slugTokens].filter((t) => t.length >= 3 && rawLower.includes(t)).length;
  if (overlap >= 2) return slug;
  return `${slug} (${rawNorm})`;
}

function formatDesiredLabel(
  slugs: ClientSummary["desiredDirectionSlugs"],
  raw: string,
): string {
  const list = (slugs ?? []).map((d) => (d.slug === "other" ? "other(IT)" : d.slug));
  if (list.length === 0) return raw || "—";
  const joined = list.join(", ");
  const rawNorm = (raw || "").trim();
  if (!rawNorm || rawNorm === "—") return joined;
  return `${joined} (${rawNorm})`;
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

  // ── 2-я строка: гражданства · 📍 локация · 🌐 таргет (Англ: уровень) ──
  const citizenshipsStr = (s.citizenships ?? []).join(", ") || "—";
  const targetStr = formatRegions(s.targetMarketRegions ?? []);
  const baseLine = [
    escapeHtml(citizenshipsStr),
    `📍 ${escapeHtml(s.location)}`,
    `🌐 ${targetStr} (Англ: ${escapeHtml(s.englishLevel)})`,
  ].join(" · ");

  // ── Хайлайты буллет-листом ────────────────────────────────────────────
  // highlights может быть: массивом (новая схема), строкой (legacy) или
  // отсутствовать вообще (недогенерённый/импортированный state).
  const highlightsRaw: unknown = s.highlights;
  let highlightItems: string[] = [];
  if (Array.isArray(highlightsRaw)) {
    highlightItems = highlightsRaw.filter((x): x is string => typeof x === "string");
  } else if (typeof highlightsRaw === "string") {
    highlightItems = highlightsRaw
      .split(/\s+·\s+|(?<=\.)\s+(?=[А-ЯA-Z])/) // legacy: " · " или ". " между фразами
      .map((x: string) => x.replace(/\.$/, "").trim())
      .filter(Boolean);
  }
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
    // Текущая профессия: canonical slug от Клода + raw-текст в скобках (если slug есть и отличается).
    // Если slug null (non-IT) — показываем raw как есть.
    `<b>Сейчас:</b> ${escapeHtml(formatProfessionLabel(s.currentProfessionSlug, s.currentProfession))} · ${escapeHtml(s.yearsExperience)} · ${escapeHtml(s.currentSalary)}`,
    "",
    `<b>Цель:</b> ${escapeHtml(s.goal)} · ${escapeHtml(targetExp)}`,
    `<b>Направления:</b> ${escapeHtml(formatDesiredLabel(s.desiredDirectionSlugs, s.desiredDirections))}`,
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
