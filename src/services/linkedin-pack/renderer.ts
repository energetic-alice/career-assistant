import type {
  AuditBlock,
  AuditItem,
  HeadlineCandidate,
  LinkedinPack,
} from "../../schemas/linkedin-pack.js";

/**
 * Рендер LinkedinPack в Markdown для Google Doc.
 *
 * В MVP документ состоит из двух больших секций:
 *   1. Аудит — общий балл, топ-приоритеты, чек-лист с галочками и рекомендациями.
 *   2. Headline — текущий заголовок + 5 вариантов по формуле.
 */

function statusIcon(status: AuditItem["status"]): string {
  switch (status) {
    case "pass":
      return "✅";
    case "fail":
      return "❌";
    case "unknown":
      return "❓";
  }
}

function renderAuditItem(it: AuditItem): string {
  const icon = statusIcon(it.status);
  const score = `**${it.pointsAwarded}/${it.maxPoints}**`;
  const header = `- ${icon} ${it.number}. ${it.title} — ${score}`;
  if (!it.recommendation?.trim()) return header;
  return `${header}\n  - ${it.recommendation.trim()}`;
}

function renderAuditBlock(block: AuditBlock): string {
  const earned = block.items.reduce((acc, it) => acc + it.pointsAwarded, 0);
  const lines: string[] = [];
  lines.push(`### ${block.name} — ${earned}/${block.maxScore} баллов`);
  lines.push("");
  for (const item of block.items) {
    lines.push(renderAuditItem(item));
  }
  return lines.join("\n");
}

function renderHeadline(h: HeadlineCandidate, idx: number): string {
  const lines: string[] = [];
  const angleLabel: Record<HeadlineCandidate["angle"], string> = {
    classic: "Классика",
    achievement: "Акцент на достижение",
    industry: "Акцент на индустрию",
    b2b_remote: "B2B / Remote-формат",
    keyword_heavy: "Keyword-heavy (под ATS)",
  };
  lines.push(`### Вариант ${idx + 1} — ${angleLabel[h.angle]} (${h.length}/120 симв)`);
  lines.push("");
  lines.push("```");
  lines.push(h.text);
  lines.push("```");
  lines.push("");
  lines.push(`**Ключевые слова:** ${h.keywords.join(", ")}`);
  lines.push("");
  lines.push(`**Зачем этот вариант:** ${h.whyThis}`);
  return lines.join("\n");
}

export function renderLinkedinPack(pack: LinkedinPack): string {
  const { audit, headline, meta } = pack;

  const lines: string[] = [];

  lines.push(`# LinkedIn-пак для @${meta.nick}`);
  lines.push("");

  const metaBits: string[] = [];
  metaBits.push(`Сгенерировано: ${new Date(meta.generatedAt).toLocaleString("ru-RU")}`);
  metaBits.push(`Источники: ${[
    meta.usedLinkedinProfile ? "LinkedIn" : null,
    meta.usedResume ? "резюме" : null,
  ].filter(Boolean).join(" + ")}`);
  if (meta.targetRoleTitle) metaBits.push(`Target-роль: ${meta.targetRoleTitle}`);
  lines.push(`*${metaBits.join(" · ")}*`);
  lines.push("");

  // ── Секция 1: Аудит ──────────────────────────────────────────────────────
  lines.push("## 1. Аудит профиля");
  lines.push("");
  lines.push(
    `**Итоговый балл: ${audit.totalScore} / ${audit.maxTotalScore}** · ` +
      `SSI-потенциал: **${ssiLabel(audit.ssiEstimate)}**`,
  );
  lines.push("");

  if (audit.topPriorities.length > 0) {
    lines.push("### Топ-приоритеты (что делать в первую очередь)");
    lines.push("");
    for (const p of audit.topPriorities) {
      lines.push(`1. ${p}`);
    }
    lines.push("");
  }

  lines.push("### Чек-лист (18 пунктов)");
  lines.push("");
  lines.push("Легенда: ✅ выполнено · ❌ не выполнено · ❓ не проверяется автоматически (проверь руками).");
  lines.push("");

  for (const block of audit.blocks) {
    lines.push(renderAuditBlock(block));
    lines.push("");
  }

  // ── Секция 2: Headline ───────────────────────────────────────────────────
  lines.push("## 2. Заголовок (Headline)");
  lines.push("");

  if (headline.currentHeadline?.trim()) {
    lines.push("**Текущий заголовок:**");
    lines.push("");
    lines.push("```");
    lines.push(headline.currentHeadline.trim());
    lines.push("```");
    lines.push("");
  }

  lines.push(
    "Ниже 5 вариантов по формуле: `[Грейд] [Должность] | [Стек] | [Индустрии] | " +
      "[Опыт / достижение] | [Формат]`. Все варианты ≤ 120 символов — можно " +
      "копировать в LinkedIn как есть. Выбери один или скомбинируй.",
  );
  lines.push("");

  headline.variants.forEach((v, i) => {
    lines.push(renderHeadline(v, i));
    lines.push("");
  });

  // ── Footer ───────────────────────────────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push(
    "*Следующий шаг (вне MVP): тексты для секций About / Experience / Skills, " +
      "контент-план и генерация постов для роста SSI.*",
  );

  return lines.join("\n");
}

function ssiLabel(estimate: "low" | "medium" | "high"): string {
  switch (estimate) {
    case "low":
      return "низкий";
    case "medium":
      return "средний";
    case "high":
      return "высокий";
  }
}
