/**
 * Локальный smoke на mvp-handle-final / mvp-card-link.
 *
 * Без сети — чисто проверяем что:
 *   - formatClientCardForTelegram на stage=final_ready отдаёт ссылку на Google Doc
 *     и метку даты;
 *   - на stage=final_generating — «собирается»;
 *   - на stage=final_failed — «генерация упала» с error.
 *
 * Запуск:
 *   npx tsx src/scripts/probe-final-mvp.ts
 *
 * Реальный e2e на @daryarioux делается вручную через Telegram кнопку
 * «📄 Сгенерировать финальный анализ» на проде (требует ANTHROPIC_API_KEY,
 * APPS_SCRIPT_DOC_URL и существующий deep_approved state).
 */

import {
  formatClientCardForTelegram,
  type ClientCardSource,
} from "../services/review-summary.js";

let pass = 0;
let fail = 0;

function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const baseSrc: ClientCardSource = {
  telegramNick: "daryarioux",
  stage: "final_ready",
  profileName: "Daria",
  rawNamedValues: {
    "Имя": "Daria",
    "Текущая роль": "Security Engineer",
  },
};

console.log("\n[final_ready] карточка с analysisDocUrl");
{
  const html = formatClientCardForTelegram({
    ...baseSrc,
    stage: "final_ready",
    analysisDocUrl: "https://docs.google.com/document/d/abc123/edit",
    analysisGeneratedAt: "2026-04-26T08:30:00.000Z",
  });
  assert(
    html.includes("📄 Карьерный анализ:"),
    "блок 'Карьерный анализ' присутствует",
  );
  assert(
    html.includes("https://docs.google.com/document/d/abc123/edit"),
    "ссылка на Google Doc присутствует",
  );
  assert(
    html.includes("2026-04-26"),
    "дата генерации присутствует",
  );
}

console.log("\n[final_generating] карточка показывает собирается");
{
  const html = formatClientCardForTelegram({
    ...baseSrc,
    stage: "final_generating",
  });
  assert(
    html.includes("⚙️ собирается"),
    "статус '⚙️ собирается' показан",
  );
  assert(
    !html.includes("Google Doc"),
    "ссылка на Google Doc НЕ показана пока генерится",
  );
}

console.log("\n[final_failed] карточка показывает ошибку");
{
  const html = formatClientCardForTelegram({
    ...baseSrc,
    stage: "final_failed",
    analysisError: "Anthropic 429 rate limited",
  });
  assert(
    html.includes("❌ генерация упала"),
    "статус '❌ генерация упала' показан",
  );
  assert(
    html.includes("Anthropic 429 rate limited"),
    "текст ошибки показан в карточке",
  );
}

console.log("\n[deep_approved] финального блока ещё нет");
{
  const html = formatClientCardForTelegram({
    ...baseSrc,
    stage: "deep_approved",
  });
  assert(
    !html.includes("📄 Карьерный анализ:"),
    "блок 'Карьерный анализ' НЕ показан до запуска finalize",
  );
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
