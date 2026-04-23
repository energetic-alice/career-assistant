import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { runClientSummary } from "../pipeline/run-analysis.js";
import type { PipelineState } from "../schemas/pipeline-state.js";
import type { AnalysisInput } from "../schemas/participant.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import type { RawQuestionnaire } from "../schemas/participant.js";
import { formatClientCardForTelegram } from "../services/review-summary.js";
import { normalizeNick } from "../services/intake-mapper.js";
import { formatRegions } from "../services/market-access.js";

/**
 * Backfill clientSummary for prod participants missing it.
 *
 * Flow:
 *   1) GET prod /api/participants
 *   2) for each record WITHOUT stageOutputs.clientSummary that has rawNamedValues:
 *        call Phase 0 (runClientSummary) locally against the Anthropic SDK
 *   3) POST the whole map back to /api/admin/import-seed (overwrites store)
 *
 * This script is idempotent: records with an existing clientSummary are left
 * as-is, so re-running only fills the gaps.
 *
 * Env:
 *   PROD_URL           — override prod base URL (default: career-assistant-w7z3.onrender.com)
 *   WEBHOOK_SECRET     — секрет, который охраняет POST /api/admin/import-seed
 *   ANTHROPIC_API_KEY  — для Claude
 *   BACKFILL_DRY=1     — не зовём Клода, просто печатаем список кандидатов
 *   BACKFILL_PREVIEW=1 — зовём Клода, печатаем результат, но НЕ заливаем на prod
 *   BACKFILL_OVERSIZED=1 — также перегенерировать тех, у кого карточка > 1024 симв.
 *   BACKFILL_NEEDS_SLUGS=1 — также перегенерировать тех, у кого в summary нет canonical slug'ов
 *   BACKFILL_NEEDS_SALARY=1 — также перегенерировать тех, у кого в summary нет ни одного
 *                             структурированного salary-поля (currentSalary*Rub/Eur, desired…)
 *   BACKFILL_FORCE=1   — перегенерировать ВСЕХ клиентов с rawNamedValues
 *                        (игнорируя missing/needs* триггеры). Удобно когда меняется схема
 *                        Phase 0 и надо прокатать всех заново. Сочетается с NEWEST_FIRST + LIMIT.
 *   BACKFILL_LIMIT=N   — обработать только первых N кандидатов
 */

const PROD_URL = process.env.PROD_URL || "https://career-assistant-w7z3.onrender.com";
const SECRET = process.env.WEBHOOK_SECRET || "";
const DRY = process.env.BACKFILL_DRY === "1";
const PREVIEW = process.env.BACKFILL_PREVIEW === "1";
// Когда включено, скрипт также перегенерирует summary у клиентов, чьи
// карточки в Telegram уже не влезают в caption документа (> 1024 симв).
// Полезно после изменений в промте/рендере.
const SHRINK = process.env.BACKFILL_OVERSIZED === "1";
const NEEDS_SLUGS = process.env.BACKFILL_NEEDS_SLUGS === "1";
const NEEDS_SALARY = process.env.BACKFILL_NEEDS_SALARY === "1";
// Новое поле currentGrade (Phase 0 определяет текущий грейд клиента).
// Триггер: в summary нет ключа `currentGrade` вообще.
const NEEDS_GRADE = process.env.BACKFILL_NEEDS_GRADE === "1";
// Новое поле currentSlugs (роли из каталога, на которые клиент может выйти
// сейчас — для adjacencyComponent в scorer). Триггер: в summary нет ключа.
const NEEDS_CURRENT_SLUGS = process.env.BACKFILL_NEEDS_CURRENT_SLUGS === "1";
// FORCE=1 — перегенерировать всех клиентов с rawNamedValues, не обращая
// внимания на существующие поля в summary.
const FORCE = process.env.BACKFILL_FORCE === "1";
const LIMIT = process.env.BACKFILL_LIMIT ? Number(process.env.BACKFILL_LIMIT) : undefined;
// Сортировка: по умолчанию порядок, в котором вернул /api/participants.
// Если включено — сортируем targets по createdAt DESC (сначала самые свежие).
// Удобно для точечных backfill-ов "последние N клиентов".
const NEWEST_FIRST = process.env.BACKFILL_NEWEST_FIRST === "1";
// Фильтр по списку ников (CSV), сравнение через normalizeNick с обеих сторон.
const ONLY_NICKS: Set<string> | null = process.env.BACKFILL_ONLY_NICKS
  ? new Set(
      process.env.BACKFILL_ONLY_NICKS.split(",")
        .map((n) => normalizeNick(n.trim()))
        .filter(Boolean),
    )
  : null;
// Оставить только клиентов, у которых Phase 1 анализ ещё не прогонялся.
const ONLY_NO_PHASE1 = process.env.BACKFILL_ONLY_NO_PHASE1 === "1";
// Стадии, при которых Phase 1 анализ УЖЕ запущен или завершён — такие клиенты
// исключаются при BACKFILL_ONLY_NO_PHASE1=1, чтобы не перегенерировать summary
// у тех, кому уже сгенерированы направления.
const PHASE1_DONE_STAGES = new Set([
  "directions_analyzed",
  "admin_review_pending",
  "admin_reviewed",
  "final_compiled",
  "completed",
  "completed_legacy",
]);
const CAPTION_LIMIT = 1024;

// В preview-режиме ничего не заливаем — SECRET не нужен.
if (!DRY && !PREVIEW && !SECRET) {
  console.error(
    "WEBHOOK_SECRET is required (or set BACKFILL_DRY=1 / BACKFILL_PREVIEW=1 to preview)",
  );
  process.exit(1);
}

async function fetchProd(): Promise<PipelineState[]> {
  const res = await fetch(`${PROD_URL}/api/participants`);
  if (!res.ok) throw new Error(`GET /api/participants → HTTP ${res.status}`);
  return (await res.json()) as PipelineState[];
}

async function main(): Promise<void> {
  console.log(`[Backfill] Fetching prod from ${PROD_URL}`);
  const states = await fetchProd();
  console.log(`[Backfill] Received ${states.length} records`);

  const missing = states.filter((s) => {
    const outs = (s.stageOutputs ?? {}) as Record<string, unknown>;
    return !outs.clientSummary && outs.rawNamedValues;
  });

  const oversized: PipelineState[] = [];
  if (SHRINK) {
    for (const s of states) {
      const outs = (s.stageOutputs ?? {}) as Record<string, unknown>;
      const cs = outs.clientSummary as ClientSummary | undefined;
      if (!cs || !outs.rawNamedValues) continue;
      const cardHtml = formatClientCardForTelegram({
        telegramNick: s.telegramNick,
        stage: s.stage,
        clientSummary: cs,
        rawQuestionnaire: outs.rawQuestionnaire as RawQuestionnaire | undefined,
        rawNamedValues: outs.rawNamedValues as Record<string, string> | undefined,
        legacyDocUrl: outs.legacyDocUrl as string | undefined,
        legacyTariff: outs.legacyTariff as string | undefined,
      });
      if (cardHtml.length > CAPTION_LIMIT) {
        oversized.push(s);
      }
    }
  }

  // Клиенты, у кого summary уже есть, но нет canonical slug'ов
  // (currentProfessionSlug undefined — признак того, что summary был
  // сгенерирован до внедрения Phase 0 slug-классификации в промт).
  const needsSlugs: PipelineState[] = [];
  if (NEEDS_SLUGS) {
    for (const s of states) {
      const outs = (s.stageOutputs ?? {}) as Record<string, unknown>;
      const cs = outs.clientSummary as ClientSummary | undefined;
      if (!cs || !outs.rawNamedValues) continue;
      // Триггер: поле currentProfessionSlug вообще отсутствует (не null).
      // null означает «Клод проверил и non-IT» — таких перегенерировать не надо.
      if (!("currentProfessionSlug" in cs)) {
        needsSlugs.push(s);
      }
    }
  }

  // Клиенты, у кого summary есть, но нет нового поля `currentGrade` (добавлено
  // в Phase 0 для того, чтобы role-scorer мог сравнивать зп на правильной
  // точке seniorityCurve).
  const needsGrade: PipelineState[] = [];
  if (NEEDS_GRADE) {
    for (const s of states) {
      const outs = (s.stageOutputs ?? {}) as Record<string, unknown>;
      const cs = outs.clientSummary as ClientSummary | undefined;
      if (!cs || !outs.rawNamedValues) continue;
      if (!("currentGrade" in cs)) {
        needsGrade.push(s);
      }
    }
  }

  // Клиенты, у кого summary есть, но ни одно структурированное salary-поле не
  // заполнено, при этом в анкете зарплата указана (currentSalary/desiredSalary
  // не «—»). После добавления salary-полей в Phase 0 — необходимо перегенерировать.
  const needsSalary: PipelineState[] = [];
  if (NEEDS_SALARY) {
    for (const s of states) {
      const outs = (s.stageOutputs ?? {}) as Record<string, unknown>;
      const cs = outs.clientSummary as ClientSummary | undefined;
      if (!cs || !outs.rawNamedValues) continue;
      const hasAnyNumeric = Boolean(
        cs.currentSalaryRub || cs.currentSalaryEur ||
        cs.desiredSalaryRub || cs.desiredSalaryEur ||
        cs.desiredSalary3to5yRub || cs.desiredSalary3to5yEur,
      );
      if (hasAnyNumeric) continue;
      // В анкете зарплата явно присутствует хотя бы в одном raw-поле.
      const hasRawSalary = [cs.currentSalary, cs.desiredSalary, cs.desiredSalary3to5y]
        .some((x) => typeof x === "string" && x.trim() && x.trim() !== "—");
      if (hasRawSalary) needsSalary.push(s);
    }
  }

  // Клиенты, у кого summary есть, но нет нового поля `currentSlugs`
  // (используется scorer.adjacencyComponent для клиентов с многолетним
  // разнообразным стеком — fullstack+C#+mobile и т.п.).
  const needsCurrentSlugs: PipelineState[] = [];
  if (NEEDS_CURRENT_SLUGS) {
    for (const s of states) {
      const outs = (s.stageOutputs ?? {}) as Record<string, unknown>;
      const cs = outs.clientSummary as ClientSummary | undefined;
      if (!cs || !outs.rawNamedValues) continue;
      if (!("currentSlugs" in cs)) {
        needsCurrentSlugs.push(s);
      }
    }
  }

  // Клиенты для принудительной перегенерации: все, у кого есть rawNamedValues.
  const forced: PipelineState[] = [];
  if (FORCE) {
    for (const s of states) {
      const outs = (s.stageOutputs ?? {}) as Record<string, unknown>;
      if (outs.rawNamedValues) forced.push(s);
    }
  }

  // Дедуп по participantId, чтобы один и тот же клиент не попал в targets дважды.
  const targetMap = new Map<string, PipelineState>();
  for (const s of [
    ...missing,
    ...oversized,
    ...needsSlugs,
    ...needsSalary,
    ...needsGrade,
    ...needsCurrentSlugs,
    ...forced,
  ]) {
    targetMap.set(s.participantId, s);
  }
  let targets = [...targetMap.values()];

  if (NEWEST_FIRST) {
    targets.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  }

  // Фильтр по списку ников из CSV/внешнего источника.
  let onlyNicksFiltered = 0;
  if (ONLY_NICKS) {
    const before = targets.length;
    targets = targets.filter((s) => {
      const normalized = normalizeNick(s.telegramNick || "");
      return normalized && ONLY_NICKS.has(normalized);
    });
    onlyNicksFiltered = before - targets.length;
  }

  // Оставляем только клиентов без Phase 1 анализа.
  let onlyNoPhase1Filtered = 0;
  if (ONLY_NO_PHASE1) {
    const before = targets.length;
    targets = targets.filter((s) => !PHASE1_DONE_STAGES.has(s.stage));
    onlyNoPhase1Filtered = before - targets.length;
  }

  if (typeof LIMIT === "number" && LIMIT > 0) {
    targets = targets.slice(0, LIMIT);
  }

  console.log(
    `[Backfill] Missing clientSummary: ${missing.length}` +
      (SHRINK ? ` | Oversized (>${CAPTION_LIMIT} chars): ${oversized.length}` : "") +
      (NEEDS_SLUGS ? ` | Needs slugs: ${needsSlugs.length}` : "") +
      (NEEDS_SALARY ? ` | Needs salary: ${needsSalary.length}` : "") +
      (NEEDS_GRADE ? ` | Needs grade: ${needsGrade.length}` : "") +
      (NEEDS_CURRENT_SLUGS ? ` | Needs currentSlugs: ${needsCurrentSlugs.length}` : "") +
      (FORCE ? ` | Force-all: ${forced.length}` : "") +
      (NEWEST_FIRST ? ` | newest-first` : "") +
      (ONLY_NICKS ? ` | only-nicks=${ONLY_NICKS.size} (dropped ${onlyNicksFiltered})` : "") +
      (ONLY_NO_PHASE1 ? ` | only-no-phase1 (dropped ${onlyNoPhase1Filtered})` : "") +
      (typeof LIMIT === "number" ? ` | limit=${LIMIT}` : "") +
      ` → will process ${targets.length}`,
  );
  if (ONLY_NICKS || ONLY_NO_PHASE1) {
    for (const s of targets) {
      console.log(`  → @${s.telegramNick || s.participantId} [${s.stage}]`);
    }
  }

  let filled = 0;
  let batchSinceUpload = 0;
  const BATCH_SIZE = 5;

  async function uploadSnapshot(reason: string): Promise<void> {
    const map: Record<string, PipelineState> = {};
    for (const s of states) map[s.participantId] = s;
    const outFile = path.resolve(process.cwd(), "data/pipelineStates.backfilled.json");
    fs.writeFileSync(outFile, JSON.stringify(map, null, 2), "utf-8");
    const res = await fetch(`${PROD_URL}/api/admin/import-seed`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": SECRET },
      body: JSON.stringify(map),
    });
    const text = await res.text();
    console.log(
      `[Backfill] ${reason} → POST /api/admin/import-seed HTTP ${res.status} ${text.slice(0, 80)}`,
    );
  }

  for (const s of targets) {
    const outs = s.stageOutputs as Record<string, unknown>;
    const rawNamedValues = outs.rawNamedValues as Record<string, string>;
    const analysisInput = (outs.analysisInput ?? {}) as AnalysisInput;
    const oldCs = outs.clientSummary as ClientSummary | undefined;

    console.log(`  → @${s.telegramNick}`);
    if (DRY) {
      filled += 1;
      continue;
    }

    try {
      const summary = await runClientSummary({
        rawNamedValues,
        resumeText: analysisInput.resumeText || "",
        linkedinUrl: analysisInput.linkedinUrl || "",
        linkedinSSI: analysisInput.linkedinSSI || "",
      });
      filled += 1;

      // Подробный diff для preview-режима: смотрим глазами как Клод
      // классифицировал профессии/направления — до записи на prod.
      if (PREVIEW) {
        const formOccupation = pickRnvAny(rawNamedValues, [
          /текущ.*профес/i, /чем.*занима/i, /кем.*работа/i, /current.*job/i,
          /current.*occupat/i, /profession/i,
        ]);
        const formDesired = pickRnvAny(rawNamedValues, [
          /желаем.*направлен/i, /желаем.*проф/i, /хочеш/i, /цел.*проф/i,
          /target.*role/i, /desired.*direction/i, /в каком направлении/i,
        ]);

        const desiredSlugs = (summary.desiredDirectionSlugs ?? [])
          .map((d) => {
            const tag = d.offIndex ? " ⚠off-index" : "";
            return `${d.slug}@${d.confidence.toFixed(2)}${tag}`;
          })
          .join(", ") || "∅";
        const currentSlugLabel = summary.currentProfessionSlug
          ? `${summary.currentProfessionSlug}` +
            (summary.currentProfessionSlugConfidence
              ? ` (conf=${summary.currentProfessionSlugConfidence.toFixed(2)})`
              : "") +
            (summary.currentProfessionOffIndex ? " ⚠off-index" : "")
          : "<null / non-IT>";
        const fmtSalary = (raw: string, rub?: number | null, eur?: number | null): string => {
          const parts: string[] = [`"${raw}"`];
          if (rub != null) parts.push(`rub=${rub}`);
          if (eur != null) parts.push(`eur=${eur}`);
          if (rub == null && eur == null) parts.push("(numeric=∅)");
          return parts.join(" ");
        };
        const gradeLabel =
          summary.currentGrade != null
            ? summary.currentGrade
            : summary.currentGrade === null
            ? "null (non-IT)"
            : "∅ (не заполнен)";
        const citizenshipsLabel = (summary.citizenships ?? []).length
          ? (summary.citizenships ?? []).join(", ")
          : "∅";
        const physicalLabel = summary.physicalCountry?.trim() || "∅";
        const targetMarketsLabel = (summary.targetMarketRegions ?? []).length
          ? `${formatRegions(summary.targetMarketRegions ?? [])} (${(summary.targetMarketRegions ?? []).join(", ")})`
          : "∅";
        const accessibleMarketsLabel = (summary.accessibleMarkets ?? []).length
          ? `${formatRegions(summary.accessibleMarkets ?? [])} (${(summary.accessibleMarkets ?? []).join(", ")})`
          : "∅";
        console.log(
          `    ✓ ${summary.firstNameLatin} ${summary.lastNameLatin}\n` +
            `      анкета · сейчас:    ${truncate(formOccupation, 200)}\n` +
            `      анкета · желает:    ${truncate(formDesired, 200)}\n` +
            `      summary · current:  ${summary.currentProfession}  →  slug: ${currentSlugLabel}\n` +
            `      summary · grade:    ${gradeLabel} (опыт: ${summary.yearsExperience})\n` +
            `      location · live:    ${physicalLabel}\n` +
            `      location · passports+PR: ${citizenshipsLabel}\n` +
            `      markets · target:   ${targetMarketsLabel}\n` +
            `      markets · access:   ${accessibleMarketsLabel}\n` +
            `      salary · cur:       ${fmtSalary(summary.currentSalary, summary.currentSalaryRub, summary.currentSalaryEur)}\n` +
            `      salary · des:       ${fmtSalary(summary.desiredSalary, summary.desiredSalaryRub, summary.desiredSalaryEur)}\n` +
            `      salary · 3-5y:      ${fmtSalary(summary.desiredSalary3to5y, summary.desiredSalary3to5yRub, summary.desiredSalary3to5yEur)}\n` +
            (summary.currentProfessionMarketEvidence
              ? `                          evidence: ${truncate(summary.currentProfessionMarketEvidence, 160)}\n`
              : "") +
            `      summary · current-slugs (ready): ${(summary.currentSlugs ?? []).join(", ") || "∅"}\n` +
            `      summary · desired:  ${summary.desiredDirections}  →  slugs: ${desiredSlugs}` +
            (summary.desiredDirectionSlugs?.some((d) => d.offIndex)
              ? "\n" +
                summary.desiredDirectionSlugs
                  .filter((d) => d.offIndex && d.marketEvidence)
                  .map((d) => `                          ${d.slug} evidence: ${truncate(d.marketEvidence!, 140)}`)
                  .join("\n")
              : ""),
        );
      } else {
        outs.clientSummary = summary;
        s.updatedAt = new Date().toISOString();
        batchSinceUpload += 1;
        console.log(`    ✓ ${summary.firstNameLatin} ${summary.lastNameLatin} [${filled}/${targets.length}]`);
      }
    } catch (err) {
      console.error(
        `    ✗ failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Промежуточный flush на prod каждые BATCH_SIZE успешных записей —
    // чтобы не потерять прогресс, если процесс прервётся.
    if (!PREVIEW && !DRY && batchSinceUpload >= BATCH_SIZE) {
      await uploadSnapshot(`batch flush (${filled}/${targets.length})`);
      batchSinceUpload = 0;
    }
  }

  console.log(`[Backfill] Processed: ${filled}/${targets.length}`);

  if (DRY) {
    console.log("[Backfill] DRY-run, nothing sent to prod.");
    return;
  }
  if (PREVIEW) {
    console.log("[Backfill] PREVIEW-run, nothing written to prod.");
    return;
  }
  if (filled === 0) {
    console.log("[Backfill] Nothing to upload.");
    return;
  }

  // Финальный flush (если остался неполный батч).
  if (batchSinceUpload > 0) {
    await uploadSnapshot(`final flush (${filled}/${targets.length})`);
  } else {
    console.log("[Backfill] All batches already uploaded.");
  }
}

function pickRnvAny(rnv: Record<string, string>, patterns: RegExp[]): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(rnv)) {
    if (!v || !v.trim()) continue;
    if (patterns.some((re) => re.test(k))) {
      parts.push(v.trim());
    }
  }
  return parts.length ? parts.join(" | ") : "—";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

main().catch((err) => {
  console.error("[Backfill] Fatal:", err);
  process.exit(1);
});
