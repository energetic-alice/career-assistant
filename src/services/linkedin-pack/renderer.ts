import type {
  AuditBlock,
  AuditItem,
  HeadlineCandidate,
  LinkedinPack,
  ProfileContent,
} from "../../schemas/linkedin-pack.js";

/**
 * Рендер LinkedinPack в Markdown для Google Doc.
 *
 * Секции документа (если соответствующие фазы отработали):
 *   1. Аудит — счётчик пунктов по статусам, топ-приоритеты, чек-лист с галочками и рекомендациями.
 *   2. Headline — текущий заголовок + 5 вариантов по формуле.
 *   3. About — готовый copy-paste (без эмодзи) + разбор по блокам.
 *   4. Top Skills — 5 закреплённых.
 *   5. Experience — переписанные позиции.
 *   6. Настройки профиля — инструкции (location, URL, open to work, cover, contact).
 *   7. Образование, языки, сертификаты, волонтёрство.
 *   8. План действий — connections, endorsements, recommendations, активность.
 *   9. Контент-план — 4 темы для первых постов.
 *
 * Эмодзи остаются ТОЛЬКО в чек-листе аудита (✅ / ❌ / ❓). Остальной документ
 * — plain text, чтобы клиент мог копировать без подчистки.
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
  const header = `- ${icon} ${it.number}. ${it.title}`;
  if (!it.recommendation?.trim()) return header;
  return `${header}\n  - ${it.recommendation.trim()}`;
}

function countByStatus(items: AuditItem[]): { pass: number; fail: number; unknown: number } {
  let pass = 0;
  let fail = 0;
  let unknown = 0;
  for (const it of items) {
    if (it.status === "pass") pass += 1;
    else if (it.status === "fail") fail += 1;
    else unknown += 1;
  }
  return { pass, fail, unknown };
}

function statusSummary(items: AuditItem[]): string {
  const { pass, fail, unknown } = countByStatus(items);
  const parts = [`${pass} ✅`, `${fail} ❌`];
  if (unknown > 0) parts.push(`${unknown} ❓`);
  return parts.join(" · ");
}

function renderAuditBlock(block: AuditBlock): string {
  const lines: string[] = [];
  lines.push(`### ${block.name} — ${statusSummary(block.items)}`);
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

  const allItems = audit.blocks.flatMap((b) => b.items);
  lines.push(`**${allItems.length} пунктов чек-листа:** ${statusSummary(allItems)}`);
  lines.push("");
  lines.push("Легенда: ✅ выполнено · ❌ не выполнено · ❓ не проверяется автоматически (проверь руками).");
  lines.push("");

  if (audit.topPriorities.length > 0) {
    lines.push("### Топ-приоритеты (что делать в первую очередь)");
    lines.push("");
    for (const p of audit.topPriorities) {
      lines.push(`1. ${p}`);
    }
    lines.push("");
  }

  lines.push("### Чек-лист");
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

  if (headline.marketKeywords.length > 0) {
    lines.push("### Market keywords — что рекрутеры реально ищут для твоей роли");
    lines.push("");
    lines.push(
      "Это ключевые слова, которые ты должна расставить в Headline, About, " +
        "Top Skills и описании каждого Experience. LinkedIn ранжирует по " +
        "keyword-совпадениям — чем больше этих слов в профиле, тем выше ты в " +
        "поиске рекрутеров.",
    );
    lines.push("");
    lines.push(headline.marketKeywords.map((k) => `\`${k}\``).join(" · "));
    lines.push("");
    if (headline.clientGaps.length > 0) {
      lines.push(
        "**Gaps (требует рынок, у тебя пока не закрыто):** " +
          headline.clientGaps.map((k) => `\`${k}\``).join(" · "),
      );
      lines.push("");
      lines.push(
        "Эти keyword'ы нужно либо освоить (pet-project / курс / сертификация), " +
          "либо добавить в профиль, если они на самом деле есть в опыте, но ты " +
          "забыла их упомянуть. Конкретные шаги — в разделе «План действий».",
      );
      lines.push("");
    }
  }

  lines.push("### 5 вариантов заголовка");
  lines.push("");
  lines.push(
    "По формуле: `[Грейд] [Должность] | [Стек] | [Индустрии] | " +
      "[Опыт / достижение] | [Формат]`. Все варианты ≤ 120 символов — можно " +
      "копировать в LinkedIn как есть. Выбери один или скомбинируй.",
  );
  lines.push("");

  headline.variants.forEach((v, i) => {
    lines.push(renderHeadline(v, i));
    lines.push("");
  });

  // ── Секции 3-9: Profile content ──────────────────────────────────────────
  if (pack.profileContent) {
    lines.push(...renderProfileContent(pack.profileContent));
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push(
    "*Следующий шаг (вне MVP): индивидуальные посты на основе контент-плана, " +
      "отслеживание роста SSI и помощь с интеграциями (Canva-баннер, оформление Featured).*",
  );

  return lines.join("\n");
}

function renderProfileContent(content: ProfileContent): string[] {
  const lines: string[] = [];

  // ── 3. About ─────────────────────────────────────────────────────────────
  lines.push("## 3. Секция «О себе» (About) — готовый текст");
  lines.push("");
  lines.push(
    "Ниже — полный текст для поля About в LinkedIn. Можно скопировать целиком " +
      "или подредактировать под свой голос. Структура из 4 блоков по методологии.",
  );
  lines.push("");
  lines.push("**Copy-paste:**");
  lines.push("");
  lines.push("```");
  lines.push(content.about.fullText);
  lines.push("```");
  lines.push("");

  lines.push("**Разбор по блокам:**");
  lines.push("");
  lines.push(`1. **Summary-абзац:** ${content.about.firstParagraph}`);
  lines.push("");
  lines.push("2. **Professional highlights** (достижения, образование, проекты, выступления, менторство):");
  for (const h of content.about.highlights) {
    lines.push(`   - ${h}`);
  }
  lines.push("");
  lines.push(`3. **Технический стэк:** ${content.about.technicalSkills}`);
  lines.push("");
  lines.push(`4. **CTA + контакт:** ${content.about.cta}`);
  lines.push("");

  // ── 4. Top Skills ────────────────────────────────────────────────────────
  lines.push("## 4. Top Skills (5 закреплённых)");
  lines.push("");
  lines.push(
    "Закрепи ровно эти 5 скиллов в разделе Skills (значок пин). Они должны " +
      "повторяться и в Headline, и в About, и в описании каждого Experience — " +
      "LinkedIn работает как поисковик по keyword-ам.",
  );
  lines.push("");
  content.topSkills.forEach((s, i) => {
    lines.push(`${i + 1}. **${s}**`);
  });
  lines.push("");

  // ── 5. Experience ────────────────────────────────────────────────────────
  lines.push("## 5. Опыт работы (Experience) — переписанные позиции");
  lines.push("");
  lines.push(
    "Для каждой позиции — готовый copy-paste для LinkedIn. Если компания " +
      "санкционная / государственная, в `suggested.company` — нейтральная " +
      "формулировка. Job title приведён к target-роли или близко.",
  );
  lines.push("");

  content.experience.forEach((exp, i) => {
    lines.push(`### ${i + 1}. ${exp.suggested.title} · ${exp.suggested.company}`);
    lines.push("");
    lines.push(
      `*Было в профиле: ${exp.original.title} · ${exp.original.company} (${exp.original.dates})*`,
    );
    lines.push("");
    lines.push("**Title:**");
    lines.push("");
    lines.push("```");
    lines.push(exp.suggested.title);
    lines.push("```");
    lines.push("");
    lines.push("**Company (как вводить в поле `Company`):**");
    lines.push("");
    lines.push("```");
    lines.push(exp.suggested.company);
    lines.push("```");
    lines.push("");
    lines.push(`**Location:** \`${exp.suggested.location}\``);
    lines.push("");
    lines.push("**Description (copy-paste в поле Description):**");
    lines.push("");
    lines.push("```");
    lines.push(exp.suggested.companyContext);
    lines.push("");
    for (const b of exp.suggested.bullets) {
      lines.push(`• ${b}`);
    }
    lines.push("```");
    lines.push("");
    lines.push(`**Skills для этой позиции:** ${exp.suggested.skills.join(", ")}`);
    lines.push("");
    if (exp.notes?.trim()) {
      lines.push(`> Комментарий: ${exp.notes}`);
      lines.push("");
    }
  });

  // ── 6. Profile settings ──────────────────────────────────────────────────
  lines.push("## 6. Настройки профиля (что кликнуть / куда вставить)");
  lines.push("");

  content.profileSettings.forEach((s, i) => {
    lines.push(`**${i + 1}. ${s.section}**`);
    lines.push("");
    lines.push(`- Как: ${s.how}`);
    if (s.valueToUse?.trim()) {
      lines.push(`- Значение: \`${s.valueToUse}\``);
    }
    lines.push("");
  });

  // ── 7. Supporting sections ───────────────────────────────────────────────
  lines.push("## 7. Образование, языки, сертификаты, волонтёрство");
  lines.push("");
  lines.push(`**Education:** ${content.supportingSections.education}`);
  lines.push("");
  lines.push("**Languages (в правильном порядке — English первым):**");
  lines.push("");
  for (const l of content.supportingSections.languages) {
    lines.push(`- ${l}`);
  }
  lines.push("");
  lines.push("**Certifications к получению (в приоритете):**");
  lines.push("");
  content.supportingSections.certificationsToEarn.forEach((c, i) => {
    lines.push(`${i + 1}. ${c}`);
  });
  lines.push("");
  if (content.supportingSections.volunteering?.trim()) {
    lines.push(`**Volunteering:** ${content.supportingSections.volunteering}`);
    lines.push("");
  }

  // ── 8. Action plan ───────────────────────────────────────────────────────
  lines.push("## 8. План действий (вне LinkedIn-UI)");
  lines.push("");
  lines.push(
    "Эти пункты руками в интерфейсе не сделаешь — нужно время и регулярность. " +
      "Ключевое: 500+ connections, 2+ recommendations, ежедневная активность в ленте.",
  );
  lines.push("");

  content.actionPlan.forEach((a, i) => {
    lines.push(`### ${i + 1}. ${a.title}`);
    lines.push("");
    lines.push(a.details);
    lines.push("");
    if (a.template?.trim()) {
      lines.push("**Шаблон сообщения:**");
      lines.push("");
      lines.push("```");
      lines.push(a.template);
      lines.push("```");
      lines.push("");
    }
  });

  // ── 9. Content ideas ─────────────────────────────────────────────────────
  lines.push("## 9. Контент-план — 4 темы для первых постов");
  lines.push("");
  lines.push(
    "Цель — 4 поста за 2-3 недели, чтобы SSI дорос до 50+. После публикации " +
      "сразу ставь сам лайк и попроси 2-3 коллег полайкать в первый час — " +
      "алгоритм подхватит и начнёт продвигать.",
  );
  lines.push("");

  content.contentIdeas.forEach((c, i) => {
    lines.push(`### Пост ${i + 1}. ${c.topic}`);
    lines.push("");
    lines.push("**Hook (первая строка поста):**");
    lines.push("");
    lines.push(`> ${c.hook}`);
    lines.push("");
    lines.push("**Тезисы для раскрытия:**");
    lines.push("");
    for (const p of c.keyPoints) {
      lines.push(`- ${p}`);
    }
    lines.push("");
  });

  return lines;
}
