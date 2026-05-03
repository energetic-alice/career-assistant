import { loadMarketIndex } from "./role-scorer.js";
import type { Direction } from "../schemas/analysis-outputs.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import type { MarketIndexEntry, RegionStats } from "../schemas/market-index.js";
import { competitionLabel, trendLabelPct } from "../schemas/market-index.js";
import { KNOWN_ROLES, type KnownRoleSlug } from "./known-roles.js";
import { canonicalizeRoleSlug, matchRoleToSlug } from "./role-matcher.js";

/**
 * «Широкие» slug'и — их каталожная запись на деле покрывает семейство
 * близких, но разных ниш; для клиента на верхних грейдах полезно видеть
 * несколько direction'ов с одним slug (AppSec + DevSecOps + Cloud Sec —
 * все infosecspec, но для senior-клиента это реально разные карьерные треки).
 *
 * Для этих slug разрешаем до `MAX_DUPES_IN_FAMILY` directions. Для остальных —
 * строго один, как раньше.
 */
const WIDE_FAMILY_SLUGS: ReadonlySet<string> = new Set([
  "infosecspec",
  "devops",
  "data_engineer",
  "ml_engineer",
  "marketing_manager",
  "product_manager",
  "ui_ux_designer",
  "fullstack",
]);
const MAX_DUPES_IN_FAMILY = 3;

/**
 * Post-validate directions returned by Claude in prompt-02:
 *  - drops empty roleSlug
 *  - drops roles with aiRisk === "extreme" (lookup via market-index)
 *  - drops off-index roles without marketEvidence
 *  - для обычных slug: drops duplicates (keeps first occurrence)
 *  - для WIDE_FAMILY_SLUGS (infosecspec/devops/data_engineer/ml_engineer/
 *    marketing_manager/product_manager/ui_ux_designer/fullstack) разрешаем
 *    до MAX_DUPES_IN_FAMILY направлений с одним slug (разные ниши одного семейства)
 *  - normalises offIndex flag based on KNOWN_ROLES membership
 *  - junior level → warning (клиент мог явно попросить)
 *
 * Returns a NEW array (does not mutate input).
 */
export async function postValidateDirections(
  directions: Direction[],
  _opts?: { targetMarketRegions?: string[] },
): Promise<Direction[]> {
  const index = await loadMarketIndex();
  const knownSet: Set<string> = new Set(KNOWN_ROLES);
  const slugCounts = new Map<string, number>();
  const firstPass: Direction[] = [];

  const JUNIOR_RE = /[\s,()\[\]\-]+junior[\s,()\[\]\-]*/i;

  for (const orig of directions) {
    const d: Direction = { ...orig };
    let slug = (d.roleSlug || "").trim();

    if (!slug) {
      console.warn(`[postValidate] DROP "${d.title}": empty roleSlug`);
      continue;
    }

    // Канонизация slug'а: Claude часто придумывает свои варианты вроде
    // `fullstack_react_node`, `frontend_react_typescript`, `data_engineer_python` —
    // которые не попадают в KNOWN_ROLES и market-index, поэтому direction уходит
    // в off-index или дропается. Пробуем мапить через role-matcher (alias hits +
    // substring + fuzzy). Если нашли канонический slug с хорошим confidence —
    // подменяем. Это ставит direction на канонические рельсы (с реальными
    // данными рынка из market-index) и снимает лишний поход в Perplexity.
    if (!knownSet.has(slug)) {
      const directCanonical = canonicalizeRoleSlug(slug);
      if (directCanonical) {
        console.log(
          `[postValidate] canonical slug override ${slug} → ${directCanonical} ` +
            `(title "${d.title}")`,
        );
        slug = directCanonical;
        d.roleSlug = directCanonical;
        d.offIndex = false;
        d.marketEvidence = undefined;
      }
    }

    if (!knownSet.has(slug)) {
      const candidates = [
        slug.replace(/[_\-]+/g, " "),
        d.title,
        `${slug.replace(/[_\-]+/g, " ")} ${d.title}`,
      ];
      let normalized: string | null = null;
      let normalizedAlias = "";
      let normalizedConf = 0;
      for (const probe of candidates) {
        const hit = await matchRoleToSlug(probe);
        if (!hit || hit.confidence < 0.85) continue;
        if (!knownSet.has(hit.slug)) continue;
        if (hit.confidence > normalizedConf) {
          normalized = hit.slug;
          normalizedAlias = hit.matchedAlias;
          normalizedConf = hit.confidence;
        }
      }
      if (normalized && normalized !== slug) {
        console.log(
          `[postValidate] normalize slug ${slug} → ${normalized} ` +
            `(conf ${normalizedConf}, alias "${normalizedAlias}", title "${d.title}")`,
        );
        slug = normalized;
        d.roleSlug = normalized;
        d.offIndex = false;
        d.marketEvidence = undefined;
      }
    }

    const entry = index[slug] || null;
    if (entry && entry.aiRisk === "extreme") {
      console.warn(`[postValidate] DROP "${d.title}" (slug=${slug}): aiRisk=extreme`);
      continue;
    }

    if (knownSet.has(slug)) {
      d.offIndex = false;

      // Cross-check title ↔ slug: Claude иногда подставляет "ближайший по
      // смыслу" KNOWN_ROLES-slug для незнакомой роли (Event Manager →
      // marketing_manager, Customer Success → marketing_manager). После
      // этого enricher тянет ЧУЖИЕ цифры vacancies/salary из market-index
      // и шортлист показывает дубли. Пропускаем title через matcher:
      //  - hit с conf≥0.85 и тем же slug → OK
      //  - hit с conf≥0.85 и ДРУГИМ slug → заменяем на правильный
      //  - null/<0.85 → slug подозрителен, помечаем off-index без
      //    market-данных (shortlist покажет "⚠ нет данных рынка").
      const titleMatch = await matchRoleToSlug(d.title);
      if (titleMatch && titleMatch.confidence >= 0.85 && knownSet.has(titleMatch.slug)) {
        if (titleMatch.slug !== slug) {
          console.log(
            `[postValidate] title-slug mismatch "${d.title}": ${slug} → ${titleMatch.slug} ` +
              `(matcher conf ${titleMatch.confidence}, alias "${titleMatch.matchedAlias}")`,
          );
          slug = titleMatch.slug;
          d.roleSlug = titleMatch.slug;
        }
      } else {
        console.log(
          `[postValidate] title-slug uncertain "${d.title}" (slug=${slug}, matcher=${titleMatch?.slug ?? "null"}, conf=${titleMatch?.confidence ?? 0}) → off-index`,
        );
        d.offIndex = true;
        d.marketEvidence = d.marketEvidence ?? "Slug не подтверждён matcher'ом — проверить вручную.";
      }
    } else if (d.offIndex && d.marketEvidence && d.marketEvidence.trim().length > 0) {
      console.log(`[postValidate] off-index OK: ${slug} ("${d.title}")`);
    } else {
      console.warn(
        `[postValidate] DROP "${d.title}" (slug=${slug}): unknown slug without offIndex+marketEvidence`,
      );
      continue;
    }

    const count = slugCounts.get(slug) ?? 0;
    const limit = WIDE_FAMILY_SLUGS.has(slug) ? MAX_DUPES_IN_FAMILY : 1;
    if (count >= limit) {
      console.warn(
        `[postValidate] DROP "${d.title}": duplicate roleSlug=${slug} (уже ${count}, лимит ${limit})`,
      );
      continue;
    }
    slugCounts.set(slug, count + 1);

    if (JUNIOR_RE.test(d.title)) {
      console.warn(`[postValidate] WARN junior level in title "${d.title}" (допустимо ТОЛЬКО если клиент явно просил)`);
    }

    firstPass.push(d);
  }

  return firstPass;
}

/**
 * Enrichment = lookup LLM-generated `Direction` against the pre-scraped
 * `market-index.json` (single source of truth, no markdown re-parsing).
 *
 * Each row gets either:
 *   - source: "market-index"  — entry found, stats filled for the chosen bucket
 *   - source: "off-index"     — direction.offIndex === true, stats null/evidence kept
 *   - source: "missing"       — slug not in index AND not flagged off-index
 *                               (= post-validation error in run-analysis)
 */

export type EnrichSource = "market-index" | "off-index" | "missing";
export type EnrichBucket = "ru" | "abroad";

/**
 * Источник данных в EnrichedDirection после Phase 2 enrichment.
 *
 * - `market-index`        — данные из локальной KB (надёжно, наш датасет).
 * - `perplexity`          — заполнено через Perplexity Sonar с URL-citations.
 * - `perplexity-estimate` — Perplexity дал оценку по аналогии (низкая уверенность).
 * - `claude`              — заполнено через Claude + web_search, citations прошли relevance-gate.
 * - `claude-estimate`     — Claude вернул confidence=low ИЛИ citations не прошли relevance-gate.
 * - `itjw-canonical`      — Phase 2 niche-resolver нашёл per-niche row в основной
 *                            таблице `<region>_<slug>.md` (через alias или
 *                            scoring fallback). Надёжно, тот же источник что
 *                            market-index.
 * - `itjw-live`           — Phase 2 niche-resolver на лету заскрейпил
 *                            itjobswatch (alias miss + scoring miss). Данные
 *                            одноразовые, не сохраняются в md.
 * - `none`                — данных нет ни в KB, ни provider не помог. Phase 3 разбирается вручную.
 *
 * Для Phase 1 enriched (до Phase 2) поле всегда либо `market-index`, либо `none`.
 */
export type EnrichDataSource =
  | "market-index"
  | "perplexity"
  | "perplexity-estimate"
  | "claude"
  | "claude-estimate"
  | "itjw-canonical"
  | "itjw-live"
  | "none";

export interface EnrichedDirection {
  /** Index in original `directions` array. */
  index: number;
  title: string;
  roleSlug: string;
  /** True if slug is a canonical `KNOWN_ROLES` slug. */
  knownRole: boolean;
  offIndex: boolean;
  marketEvidence?: string;
  source: EnrichSource;

  /** Which bucket was used for salary/vacancy fill. */
  bucket: EnrichBucket | null;

  /** Values from market-index for the chosen bucket (null if off-index). */
  vacancies: number | null;
  medianSalaryMid: number | null;
  aiRisk: MarketIndexEntry["aiRisk"] | null;
  competitionPer100: number | null;
  trendRatio: number | null;

  /** Raw market-index entry for downstream use (prompt-03, UI). */
  entry: MarketIndexEntry | null;

  /**
   * Phase 2: источник данных (market-index по умолчанию, perplexity/claude
   * после успешного дозаполнения, none если данных нет).
   */
  dataSource: EnrichDataSource;
  /**
   * URL-citations от внешнего провайдера (Perplexity/Claude). Поле сохранило
   * старое имя для обратной совместимости со state-файлами на проде; новое
   * заполнение пишет сюда же независимо от провайдера.
   */
  perplexityCitations?: string[];
  /** Reasoning от провайдера (часто только для оценок по аналогии). */
  perplexityReasoning?: string;
}

/**
 * Маппинг bucket'а КОНКРЕТНОГО направления (из Direction.bucket, его
 * поставил Claude в Phase 1) на bucket, которым мы тянем stats из
 * market-index: "usa" → "abroad" (USA-коэффициент ×1.5 применяется
 * отдельно в scorer-е). "ru" / "abroad" — 1-к-1.
 *
 * ВАЖНО: раньше был единый `pickBucket(summary)` для ВСЕГО клиента
 * (prefer "ru"), из-за чего у Алисы (access=[ru,eu,uk], target=[eu,uk])
 * все abroad-направления Claude'а обогащались RU-данными: Full-Stack
 * показывал vacancies=280 (RU) и medianSalary=270000 (RUB/мес как "€270k"),
 * вместо UK-цифр 876/£70k. Теперь enrichment идёт per-direction.
 */
function bucketStats(
  entry: MarketIndexEntry,
  bucket: Direction["bucket"],
): RegionStats | null {
  if (bucket === "ru") return entry.ru ?? null;
  // abroad и usa — UK/EU/US-статистика как proxy. USA-адъюстмент ×1.5
  // применяется в scorer-е (см. `roleSalaryForClient`), enricher здесь
  // зовётся для UI-цифр и делает только прямой lookup.
  return entry.uk ?? entry.eu ?? entry.us ?? null;
}

/**
 * Enrich LLM-generated directions with market-index data.
 *
 * @param directions array of `Direction` from prompt-02 output
 * @param summary    clientSummary used to pick RU vs abroad bucket
 */
export async function enrichDirections(
  directions: Direction[],
  _summary: ClientSummary,
): Promise<EnrichedDirection[]> {
  const index = await loadMarketIndex();
  const knownSet: Set<string> = new Set(KNOWN_ROLES);

  return directions.map((d, i) => {
    const rawSlug = d.roleSlug?.trim() ?? "";
    const slug = canonicalizeRoleSlug(rawSlug) ?? rawSlug;
    // Уважаем d.offIndex=true даже когда slug валидный: postValidate ставит
    // этот флаг когда matcher не подтвердил slug по title (Event Manager с
    // slug=marketing_manager и т.п.). В таких случаях НЕ тянем market-index,
    // чтобы не подмешать чужие цифры.
    const known = knownSet.has(slug) && !d.offIndex;
    const entry = known && slug && index[slug] ? index[slug] : null;
    const offIndex = known ? false : Boolean(d.offIndex);

    let source: EnrichSource;
    if (entry) {
      source = "market-index";
    } else if (offIndex) {
      source = "off-index";
    } else {
      source = "missing";
    }

    // Per-direction bucket: Claude в Phase 1 сам расставляет "ru"|"abroad"|"usa"
    // для каждой роли. Соответствие stats-источнику: ru→entry.ru; abroad/usa →
    // entry.uk (fallback на eu/us). Нельзя выбрать единый bucket для клиента —
    // у мульти-рынка клиента (Алиса: ru+eu+uk) направления должны показывать
    // СВОЮ рыночную цифру, а не RU-подмену.
    const stats = entry ? bucketStats(entry, d.bucket) : null;
    // Для отчётности в EnrichedDirection.bucket сохраняем enrichment-bucket
    // ("usa" нормализуем в "abroad" — это он и есть по данным).
    const enrichBucket: EnrichBucket = d.bucket === "ru" ? "ru" : "abroad";

    // dataSource: для baseline (Phase 1) — market-index если есть данные,
    // иначе none. Phase 2 enrichGapsForClient может пометить perplexity*.
    const hasAnyValue =
      stats?.vacancies !== undefined ||
      stats?.medianSalaryMid !== undefined ||
      entry?.aiRisk !== undefined;
    const dataSource: EnrichDataSource = hasAnyValue ? "market-index" : "none";

    // competitionPer100 / trendRatio: slug-level, одно число на роль
    // (см. market-index.ts). Fallback на per-region для старых index-файлов
    // без top-level полей - чтобы не падали state-файлы, сохранённые до
    // миграции.
    const slugCompetition =
      entry?.competitionPer100 ?? stats?.competitionPer100Specialists ?? null;
    const slugTrendRatio =
      entry?.trendRatio ?? stats?.trend?.ratio ?? null;

    return {
      index: i,
      title: d.title,
      roleSlug: slug,
      knownRole: known,
      offIndex,
      marketEvidence: d.marketEvidence,
      source,
      bucket: enrichBucket,
      vacancies: stats?.vacancies ?? null,
      medianSalaryMid: stats?.medianSalaryMid ?? null,
      aiRisk: entry?.aiRisk ?? null,
      competitionPer100: slugCompetition,
      trendRatio: slugTrendRatio,
      entry,
      dataSource,
    };
  });
}

/**
 * Готовый набор значений для финальных таблиц Phase 4 (Таблица 1 "Рынок" и
 * Таблица 3 "Зарплатные ожидания"). Собирается **в коде** из slug-level
 * данных market-index и передаётся в промпт Phase 4 как единственный
 * источник для этих колонок. Модель не пересчитывает, только подставляет.
 *
 * Это устраняет два частых источника галлюцинаций:
 *   - «+35%» динамики при том, что в данных -12%;
 *   - «низкая конкуренция» при competitionPer100=1.3 (на самом деле высокая).
 */
export interface DirectionTableHints {
  /** Совпадает с EnrichedDirection.index — ключ для стыковки. */
  index: number;
  title: string;
  roleSlug: string;
  /** Ширина рынка: качественно, без цифр. Из vacancies + vacancy_volume. */
  width: "нишевый" | "средний" | "широкий" | null;
  /** Динамика, готовая строка для таблицы: "+40% за 2 года" / "стабильно" / "-15% за 2 года". */
  trend: string | null;
  /** Конкуренция, готовая метка из competitionLabel(). */
  competition: "низкая" | "средняя" | "высокая" | null;
  /** AI-риск в русском виде, совместимом с analyzedDirectionSchema.aiRisk.level. */
  aiRisk: "низкий" | "средний" | "средний-высокий" | "высокий" | null;
}

/**
 * Переводит low/medium/high/extreme из market-index в русский enum,
 * который используем в финальном документе. `extreme` — теоретически не
 * должен доходить до Phase 4 (direction дропается в postValidate), но
 * на всякий случай мапим в "высокий".
 */
function mapAiRisk(risk: MarketIndexEntry["aiRisk"] | null): DirectionTableHints["aiRisk"] {
  if (!risk) return null;
  switch (risk) {
    case "low": return "низкий";
    case "medium": return "средний";
    case "high": return "высокий";
    case "extreme": return "высокий";
  }
}

/**
 * Качественная ширина рынка из числа live-вакансий. Пороги калиброваны под
 * UK itjobswatch (единственный цифровой источник для abroad-ролей):
 *   < 100       → нишевый (реально редкая роль, типа Rust-разработчик в UK)
 *   100-499     → средний
 *   >= 500      → широкий
 * Для RU-bucket используется абсолютное число hh.ru-вакансий, шкала та же —
 * RU-рынок сопоставим с UK по абсолютным числам для большинства ролей.
 */
function widthFromVacancies(vacancies: number | null): DirectionTableHints["width"] {
  if (vacancies === null) return null;
  if (vacancies < 100) return "нишевый";
  if (vacancies < 500) return "средний";
  return "широкий";
}

export function buildTableHints(rows: EnrichedDirection[]): DirectionTableHints[] {
  return rows.map((r) => ({
    index: r.index,
    title: r.title,
    roleSlug: r.roleSlug,
    width: widthFromVacancies(r.vacancies),
    trend: trendLabelPct(r.trendRatio),
    competition: competitionLabel(r.competitionPer100),
    aiRisk: mapAiRisk(r.aiRisk),
  }));
}

/**
 * Находит медиану рынка для ТЕКУЩЕЙ роли кандидата (нужна для Таблицы 3
 * "Зарплатные ожидания", колонка "Senior в твоей текущей роли сейчас").
 *
 * Делает 2 прохода: canonicalizeRoleSlug по summary.currentRole.normalizedSlug
 * (если есть) → fallback на matchRoleToSlug по title/currentRole.title.
 * Возвращает enriched-совместимую запись с vacancies/medianSalaryMid/aiRisk
 * для bucket'а, выбранного по primary target market.
 *
 * Если текущую роль не удалось смапить в slug — вернёт null, финальный
 * документ покажет прочерк в соответствующей колонке (без галлюцинации).
 */
export async function resolveCandidateCurrentRoleStats(
  summary: ClientSummary,
): Promise<{ roleSlug: string; medianSalaryMid: number | null; bucket: EnrichBucket } | null> {
  const currentTitle = summary.currentProfession;
  if (!currentTitle) return null;

  const index = await loadMarketIndex();
  const knownSet: Set<string> = new Set(KNOWN_ROLES);

  let slug: string | null = null;
  const canonical = canonicalizeRoleSlug(currentTitle);
  if (canonical && knownSet.has(canonical)) {
    slug = canonical;
  } else {
    const hit = await matchRoleToSlug(currentTitle);
    if (hit && hit.confidence >= 0.85 && knownSet.has(hit.slug)) {
      slug = hit.slug;
    }
  }
  if (!slug) return null;

  const entry = index[slug];
  if (!entry) return null;

  // Bucket: если у клиента в targetMarketRegions есть что-то не-ru, берём
  // abroad (UK proxy); иначе ru. Санкции/локация кандидата учитываются
  // выше по стеку (см. isRuBlockedBySanctions), здесь просто статистика.
  const hasAbroadTarget = (summary.targetMarketRegions ?? []).some(
    (r) => r.toLowerCase() !== "ru",
  );
  const bucket: EnrichBucket = hasAbroadTarget ? "abroad" : "ru";
  const stats = bucket === "ru" ? entry.ru : entry.uk ?? entry.eu ?? entry.us;

  return {
    roleSlug: slug,
    medianSalaryMid: stats?.medianSalaryMid ?? null,
    bucket,
  };
}

/**
 * Формирует markdown-блок с готовыми значениями для Таблиц 1 и 3 финального
 * документа. Подставляется в промпт 04 как `{{tableHints}}`. Все колонки,
 * которые можно посчитать детерминированно (ширина, динамика, конкуренция,
 * AI-риск), берутся из market-index; модель их не пересчитывает, чтобы
 * избежать расхождений между прозой и таблицами.
 *
 * `candidateCurrentRole` — заполняется результатом
 * `resolveCandidateCurrentRoleStats` (медиана для текущей роли в целевой
 * локации клиента). `null` → модель ставит прочерк, без выдумки.
 */
export function formatTableHints(params: {
  topDirections: { title: string; roleSlug: string }[];
  hints: DirectionTableHints[];
  candidateCurrentRole: {
    roleSlug: string;
    medianSalaryMid: number | null;
    bucket: EnrichBucket;
  } | null;
  /**
   * True если клиент выбрал только RU/CIS в `targetMarketRegions`, но его
   * английский ≥ B2 — технически для него открыт EU/UK remote B2B. Мы не
   * расширяем `accessibleMarkets` автоматически (это меняет скоринг и
   * bucket'ы), но в Стратегическом алерте финала предлагаем как опцию.
   */
  shouldMentionEuB2B?: boolean;
}): string {
  const lines: string[] = [];
  lines.push("# Готовые значения для сравнительных таблиц Phase 4");
  lines.push("");
  lines.push(
    "⚠ Значения ниже посчитаны детерминированно из `market-index.json`. В Таблице 1 " +
      "(Рынок) и Таблице 3 (Зарплатные ожидания) **копируй их дословно** — не пересчитывай, " +
      "не меняй формулировки, не «сглаживай». Если в поле стоит `—`, оставляй прочерк.",
  );
  lines.push("");

  // Ключ — сопоставление по roleSlug (устойчиво к перестановке direction'ов в
  // analysisOutput, в отличие от числовых индексов).
  const byRoleSlug = new Map<string, DirectionTableHints>();
  for (const h of params.hints) byRoleSlug.set(h.roleSlug, h);

  lines.push("## Таблица 1 (Рынок) - строки");
  lines.push("");
  lines.push("| направление | ширина рынка | динамика | конкуренция (вак/100 спец) | AI-риск |");
  lines.push("|---|---|---|---|---|");
  for (const d of params.topDirections) {
    const h = byRoleSlug.get(d.roleSlug);
    const width = h?.width ?? "—";
    const trend = h?.trend ?? "—";
    const comp = h?.competition ?? "—";
    const ai = h?.aiRisk ?? "—";
    lines.push(`| ${d.title} | ${width} | ${trend} | ${comp} | ${ai} |`);
  }
  lines.push("");

  lines.push("## Якорь текущей роли кандидата (для прозы)");
  lines.push("");
  if (params.candidateCurrentRole && params.candidateCurrentRole.medianSalaryMid !== null) {
    const b = params.candidateCurrentRole.bucket;
    const sal = params.candidateCurrentRole.medianSalaryMid;
    lines.push(
      `- Медиана рынка для текущей роли кандидата (slug: \`${params.candidateCurrentRole.roleSlug}\`, bucket: ${b}): **${sal}** (годовая в валюте рынка; см. marketData для уточнения).`,
    );
    lines.push(
      "- Используй эту цифру в прозе (Стратегический алерт / Итоговая рекомендация) как базу " +
        "для сравнения с желаемой зп. Не округляй, не конвертируй. В таблицы не выноси — там " +
        "её отдельной колонки нет.",
    );
  } else {
    lines.push(
      "- Медиана рынка для текущей роли кандидата: **нет точной цифры в market-index**. " +
        "В прозе не выдумывай базовую цифру — пиши о текущей роли качественно.",
    );
  }
  lines.push("");
  lines.push(
    "Для каждого топ-3 направления колонку «Senior сейчас в этой роли» Таблицы 3 бери из " +
      "marketData (поле medianSalaryMid соответствующего bucket'а и/или seniorityCurve.senior). " +
      "Если в данных только UK-цифра, а клиент ищет в EU/US — пиши UK-цифру и в примечании " +
      "делай пометку «UK proxy», без арифметики ×1.5 для US.",
  );

  if (params.shouldMentionEuB2B) {
    lines.push("");
    lines.push("## Опция EU/UK B2B (обязательно упомянуть в Стратегическом алерте)");
    lines.push("");
    lines.push(
      "Клиент выбрал только RU/CIS рынок, но его английский ≥ B2. Это значит технически " +
        "ему открыт формат EU/UK remote B2B (виза не нужна, работодатель оформляет через " +
        "юрлицо клиента). В секции «Стратегический алерт» финального документа одним абзацем " +
        "аккуратно упомяни эту опцию как альтернативу: «если захочешь — B2B-контракты с " +
        "EU/UK работодателями реалистичны, можем проработать отдельно». Без давления, как " +
        "справку. Основной анализ (направления, зп, рынок) оставляй по текущему выбору клиента.",
    );
  }

  return lines.join("\n");
}

/**
 * Renders Phase 2 EnrichedDirection[] in a markdown shape suitable for
 * substitution into prompt-03's `{{marketData}}` slot. Replaces the
 * `formattedText` from Perplexity Step 5 when caller has decided to skip
 * Step 5 (`runDeepFromShortlist({ skipPerplexityStep5: true })`).
 *
 * Goal: keep prompt-03 stable, but feed it data that already passed the
 * relevance gate. Each direction gets a clear source badge so Claude in
 * Step 6 knows which numbers to lean on and which to treat as estimates.
 */
export function formatEnrichedAsMarketData(rows: EnrichedDirection[]): string {
  if (rows.length === 0) return "Данные рынка не предоставлены.";

  const lines: string[] = [];
  lines.push("# Данные рынка по направлениям (Phase 2 enrichment)\n");
  lines.push(
    "Источники: `[m]` market-index (наша KB), `[p]` Perplexity, `[~p]` Perplexity-estimate, " +
      "`[c]` Claude+web_search, `[~c]` Claude-estimate, " +
      "`[itjw]` itjobswatch canonical, `[itjw·live]` itjw live-scraped, `[?]` нет данных.\n",
  );

  for (const r of rows) {
    const badge = sourceBadge(r.dataSource);
    const title = `## ${badge} ${r.title || r.roleSlug}`;
    lines.push(title);
    lines.push(`- slug: \`${r.roleSlug}\`${r.offIndex ? " (off-index)" : ""}`);
    lines.push(`- bucket: ${r.bucket ?? "—"}`);
    // competition/100 - одно число на slug (см. market-index). Модели
    // отдаём с готовой меткой "низкая/средняя/высокая" чтобы не пересчитывала
    // шкалу самостоятельно и не путала `1.3 = низкая` (на самом деле высокая).
    const compLabel = competitionLabel(r.competitionPer100);
    const compPart =
      r.competitionPer100 !== null && compLabel !== null
        ? ` · competition/100: ${r.competitionPer100.toFixed(1)} (${compLabel.toUpperCase()})`
        : "";
    lines.push(
      `- vacancies: ${fmtNum(r.vacancies)} · medianSalary: ${fmtNum(r.medianSalaryMid)}${compPart}`,
    );
    lines.push(
      `- aiRisk: ${r.aiRisk ?? "—"} · trend: ${r.trendRatio !== null ? `${((r.trendRatio - 1) * 100).toFixed(0)}%` : "—"}`,
    );
    if (r.perplexityReasoning) {
      lines.push(`- reasoning: ${r.perplexityReasoning}`);
    }
    if (r.perplexityCitations && r.perplexityCitations.length > 0) {
      lines.push(`- sources:`);
      for (const c of r.perplexityCitations.slice(0, 5)) {
        lines.push(`  - ${c}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function sourceBadge(src: EnrichDataSource): string {
  switch (src) {
    case "market-index": return "[m]";
    case "perplexity": return "[p]";
    case "perplexity-estimate": return "[~p]";
    case "claude": return "[c]";
    case "claude-estimate": return "[~c]";
    case "itjw-canonical": return "[itjw]";
    case "itjw-live": return "[itjw·live]";
    case "none": return "[?]";
    default: return "[ ]";
  }
}

function fmtNum(n: number | null): string {
  return n === null ? "—" : String(n);
}

export function formatEnrichedForLog(rows: EnrichedDirection[]): string {
  if (rows.length === 0) return "(пусто)";
  const lines = rows.map((r) => {
    const vac = r.vacancies !== null ? `${r.vacancies} вак` : "—";
    const sal = r.medianSalaryMid !== null ? `med=${r.medianSalaryMid}` : "—";
    const ai = r.aiRisk ?? "—";
    const src =
      r.source === "market-index"
        ? "✓index"
        : r.source === "off-index"
        ? "⚠off-index"
        : "✗missing";
    return `  ${r.index + 1}. [${src}] ${r.roleSlug || "(no slug)"} — ${r.title} · ${vac} · ${sal} · ai=${ai}`;
  });
  return lines.join("\n");
}
