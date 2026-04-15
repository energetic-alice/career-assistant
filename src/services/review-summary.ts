import type {
  CandidateProfile,
  DirectionsOutput,
  AnalysisOutput,
  ReviewSummary,
  ReviewFlag,
} from "../schemas/analysis-outputs.js";

export function buildReviewSummary(
  profile: CandidateProfile,
  directions: DirectionsOutput,
  analysis: AnalysisOutput,
): ReviewSummary {
  const flags: ReviewFlag[] = [];

  const ssi = profile.linkedinSSI;
  const targets = profile.barriers.accessibleMarkets;
  const isEuTarget = targets.some(
    (m) => m.toLowerCase().includes("eu") || m.toLowerCase().includes("europe"),
  );

  if (ssi !== undefined && ssi < 30 && isEuTarget) {
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

  if (profile.currentBase.englishLevel.match(/a0|a1|нул|нет|0/i) && isEuTarget) {
    flags.push({
      type: "red",
      message: "English ~0, но целевой рынок EU - барьер №1",
    });
  }

  return {
    candidateName: profile.name,
    languageMode: profile.languageMode,
    currentRole: profile.currentBase.currentRole,
    targetMarket: targets.join(", "),
    englishLevel: profile.currentBase.englishLevel,
    linkedinSSI: profile.linkedinSSI,
    superpower: directions.superpower.formulation,
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
  lines.push(`Режим: ${summary.languageMode} | English: ${summary.englishLevel}${summary.linkedinSSI != null ? ` | SSI: ${summary.linkedinSSI}` : ""}`);
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
