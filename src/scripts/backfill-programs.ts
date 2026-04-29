/**
 * Backfill `stageOutputs.program` для всех 44 текущих клиентов на проде.
 *
 * Правила (от куратора):
 *   - @margaritako4               → "М14"
 *   - есть stageOutputs.legacyDocUrl/legacyTariff (первые 27 импортов)
 *                                  → "КА1"
 *   - rawQuestionnaire.timestamp ≥ 2026-04-14 (текущая активная программа)
 *                                  → "КА2"
 *   - всё остальное (тестовые/пилотные клиенты до КА2)
 *                                  → "тест"
 *
 * Реальная дата подачи берётся из `stageOutputs.rawQuestionnaire.timestamp`
 * (`dd/mm/yyyy hh:mm:ss` из Google Form), потому что у seed-импортированных
 * клиентов поле `state.createdAt` = дата seed-импорта в БД, а не подачи.
 *
 * env:
 *   PROD_URL          base URL прода (default: prod render)
 *   WEBHOOK_SECRET    для /api/admin/upsert-states
 *   DRY_RUN=1         только показать распределение, не пушить
 *   ONLY_NICKS=a,b,c  ограничить список ник-ами
 */

import "dotenv/config";
import type { PipelineState } from "../schemas/pipeline-state.js";
import { PROGRAM_LABELS, type ProgramLabel } from "../schemas/pipeline-state.js";
import { normalizeNick } from "../services/intake-mapper.js";

const PROD_URL =
  process.env.PROD_URL ?? "https://career-assistant-w7z3.onrender.com";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";
const DRY_RUN = process.env.DRY_RUN === "1";
const ONLY_NICKS = (process.env.ONLY_NICKS ?? "")
  .split(",")
  .map((s) => normalizeNick(s.trim()))
  .filter(Boolean);

/** Граница "КА2 vs тест" — анкеты с этой даты включительно идут на КА2. */
const KA2_BOUNDARY_ISO = "2026-04-14T00:00:00";

/**
 * Парсим `dd/mm/yyyy hh:mm:ss` из Google Form в ISO. Если timestamp отсутствует
 * или невалидный, fallback на state.createdAt — это безопасно для seed-клиентов
 * (у них createdAt = дата seed-загрузки 2026-04-21, что > KA2_BOUNDARY, но мы
 * всё равно их сначала проверяем через legacyDocUrl и попадаем в КА1).
 */
function realSubmissionIso(state: PipelineState): string {
  const outs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const rq = outs.rawQuestionnaire as { timestamp?: string } | undefined;
  const ts = (rq?.timestamp ?? "").trim();
  const m = ts.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    const [, dd, mm, yyyy, hh, mi, ss] = m;
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
  }
  return state.createdAt.slice(0, 19);
}

function classify(state: PipelineState): ProgramLabel {
  const nick = normalizeNick(state.telegramNick);
  if (nick === "margaritako4") return "М14";

  const outs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  if (outs.legacyDocUrl || outs.legacyTariff) return "КА1";

  const submitted = realSubmissionIso(state);
  return submitted >= KA2_BOUNDARY_ISO ? "КА2" : "тест";
}

async function main() {
  if (!DRY_RUN && !WEBHOOK_SECRET) {
    throw new Error(
      "WEBHOOK_SECRET not set — нужен для POST /api/admin/upsert-states (или DRY_RUN=1)",
    );
  }

  console.log(`PROD_URL: ${PROD_URL}`);
  console.log(`DRY_RUN:  ${DRY_RUN}`);
  if (ONLY_NICKS.length) console.log(`ONLY_NICKS: ${ONLY_NICKS.join(", ")}`);
  console.log();

  const res = await fetch(`${PROD_URL}/api/participants`);
  if (!res.ok) throw new Error(`GET /api/participants → ${res.status}`);
  const all = (await res.json()) as PipelineState[];
  console.log(`Загружено ${all.length} клиентов с прода.\n`);

  const updated: Record<string, PipelineState> = {};
  const counts: Record<string, number> = {};

  for (const s of all) {
    const nick = normalizeNick(s.telegramNick);
    if (ONLY_NICKS.length && !ONLY_NICKS.includes(nick)) continue;

    const label = classify(s);
    const outs = (s.stageOutputs ?? {}) as Record<string, unknown>;
    const current = outs.program as ProgramLabel | undefined;

    counts[label] = (counts[label] ?? 0) + 1;

    if (current === label) {
      console.log(`  • @${nick.padEnd(22)} → ${label} (уже ок)`);
      continue;
    }

    // mutate в копии чтобы не трогать массив all (на случай повторного use)
    const next: PipelineState = JSON.parse(JSON.stringify(s));
    const nextOuts = (next.stageOutputs ?? {}) as Record<string, unknown>;
    nextOuts.program = label;
    next.stageOutputs = nextOuts;
    next.updatedAt = new Date().toISOString();
    updated[next.participantId] = next;

    const fromLabel = current ? ` (было ${current})` : "";
    console.log(`  • @${nick.padEnd(22)} → ${label}${fromLabel}`);
  }

  console.log(`\nПо программам: ${JSON.stringify(counts)}`);
  console.log(`К заливке state'ов: ${Object.keys(updated).length}`);

  // sanity check — суммы должны сходиться с ожидаемым распределением
  const sum = (counts["КА1"] ?? 0) + (counts["КА2"] ?? 0) + (counts["М14"] ?? 0) + (counts["тест"] ?? 0);
  if (sum !== all.length && !ONLY_NICKS.length) {
    console.warn(
      `⚠ Сумма по программам (${sum}) не совпадает с total (${all.length}). ` +
        `Допустимые метки: ${PROGRAM_LABELS.join(", ")}. Проверь classify().`,
    );
  }

  if (DRY_RUN) {
    console.log("\nDRY_RUN=1 — на прод НЕ заливаем. Снимите DRY_RUN и перезапустите.");
    return;
  }

  if (Object.keys(updated).length === 0) {
    console.log("Заливать нечего, у всех уже стоит правильная метка.");
    return;
  }

  const upsertRes = await fetch(`${PROD_URL}/api/admin/upsert-states`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-secret": WEBHOOK_SECRET,
    },
    body: JSON.stringify({ states: updated }),
  });
  const body = await upsertRes.text();
  console.log(`\nupsert-states → ${upsertRes.status}: ${body}`);
  if (!upsertRes.ok) throw new Error(`upsert failed (${upsertRes.status})`);

  console.log("\n✅ Готово. Метки программ обновлены на проде.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
