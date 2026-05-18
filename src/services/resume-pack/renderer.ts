import type {
  AuditBlock,
  AuditItem,
  ResumePack,
} from "../../schemas/resume-pack.js";

/**
 * Рендер ResumePack в Markdown для Google Doc / telegram-preview.
 *
 * Сейчас единственная секция — `Аудит резюме` (Phase 1). Когда добавим
 * Phase 2 (переписанные Summary / Experience / Skills) — расширим
 * рендер, по образцу renderLinkedinPack.
 *
 * Эмодзи — только в чек-листе (✅ / ❌ / ❓). Остальной документ — plain
 * text, чтобы клиент копировал без подчистки.
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

function countByStatus(items: AuditItem[]): {
  pass: number;
  fail: number;
  unknown: number;
} {
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

function targetMarketLabel(m: ResumePack["meta"]["targetMarket"]): string {
  switch (m) {
    case "abroad":
      return "зарубежный рынок (EU / UK / US / LATAM / MENA)";
    case "ru":
      return "российский рынок (HeadHunter, Москва)";
    case "mixed":
      return "смешанный таргет (RU + зарубеж)";
    default:
      return "не определён (модель не вывела)";
  }
}

export function renderResumePack(pack: ResumePack): string {
  const { audit, meta } = pack;

  const lines: string[] = [];
  lines.push(`# Резюме-пак для @${meta.nick}`);
  lines.push("");

  const metaBits: string[] = [];
  metaBits.push(`Сгенерировано: ${new Date(meta.generatedAt).toLocaleString("ru-RU")}`);
  metaBits.push(`Целевой рынок: ${targetMarketLabel(meta.targetMarket)}`);
  if (meta.targetRoleTitle) metaBits.push(`Target-роль: ${meta.targetRoleTitle}`);
  if (meta.usedLinkedinProfile) metaBits.push("LinkedIn привлекался для cross-check");
  lines.push(`*${metaBits.join(" · ")}*`);
  lines.push("");

  // ── Секция 1: Аудит ──────────────────────────────────────────────────────
  lines.push("## 1. Аудит резюме");
  lines.push("");

  const allItems = audit.blocks.flatMap((b) => b.items);
  lines.push(`**${allItems.length} пунктов чек-листа:** ${statusSummary(allItems)}`);
  lines.push("");
  lines.push(
    "Легенда: ✅ выполнено · ❌ не выполнено · ❓ не проверяется автоматически (проверь руками).",
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

  lines.push("### Чек-лист");
  lines.push("");

  for (const block of audit.blocks) {
    lines.push(renderAuditBlock(block));
    lines.push("");
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push(
    "*Следующий шаг (вне MVP): автоматически переписанные Summary / Experience / Skills " +
      "под target-роль и target-рынок — после approval'а аудита.*",
  );

  return lines.join("\n");
}
