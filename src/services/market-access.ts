import type { Region } from "../schemas/analysis-outputs.js";

/**
 * CEFR-шкала для гейтов native-English рынков.
 * Дублируем мини-таблицу здесь (а не импортируем из market-data-service),
 * чтобы market-access оставался листовым модулем без обратных зависимостей
 * на pipeline/data-services.
 */
const CEFR_ORDER: Record<string, number> = {
  "0": 0, A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6,
};

export function cefrAtLeast(level: string, threshold: string): boolean {
  return (CEFR_ORDER[level] ?? 0) >= (CEFR_ORDER[threshold] ?? 0);
}

/**
 * UI-рендер региона: эмодзи-флаг для одно-страновых + короткий код для
 * мульти-страновых / remote. Используется во всех карточках и CLI-выводах.
 */
const REGION_DISPLAY: Record<Region, string> = {
  ru: "🇷🇺",
  eu: "🇪🇺",
  uk: "🇬🇧",
  us: "🇺🇸",
  cis: "СНГ",
  latam: "LATAM",
  "asia-pacific": "APAC",
  "middle-east": "MENA",
  israel: "🇮🇱",
  global: "🌐",
};

export function formatRegion(r: Region): string {
  return REGION_DISPLAY[r];
}

export function formatRegions(regions: readonly Region[]): string {
  if (!regions || regions.length === 0) return "—";
  return regions.map(formatRegion).join(" ");
}

/**
 * USA-primary клиент = целится в США (target) или физически там живёт.
 * Используется в scorer'е: abroad-медианы у нас из UK-источников, а USA-зп
 * в среднем выше. Чтобы не отсеивать USA-клиента по заниженным ожиданиям,
 * умножаем UK-медиану на `USA_SALARY_MULTIPLIER` при сравнении.
 *
 * Полумера до введения отдельного `usa`-bucket'а в `market-index.json`.
 */
export function isUsaPrimaryClient(args: {
  targetMarketRegions: readonly Region[];
  physicalCountry: string;
}): boolean {
  if (args.targetMarketRegions.includes("us")) return true;
  if (US_COUNTRIES.has(args.physicalCountry)) return true;
  return false;
}

/** Множитель US зп относительно EU/UK медиан. */
export const USA_SALARY_MULTIPLIER = 1.5;

/**
 * Country→region tables used by both Phase 0 (ClientSummary.accessibleMarkets)
 * and Phase 1 (CandidateProfile.barriers.accessibleMarkets).
 *
 * Страны в таблицах — на английском (как их возвращает Клод или как они
 * стандартизованы в Wikipedia). Клод в Phase 0 должен нормализовать
 * citizenship/location в эти названия.
 */

export const EU_COUNTRIES = new Set<string>([
  "Austria", "Belgium", "Bulgaria", "Croatia", "Cyprus", "Czech Republic",
  "Czechia", "Denmark", "Estonia", "Finland", "France", "Germany", "Greece",
  "Hungary", "Ireland", "Italy", "Latvia", "Lithuania", "Luxembourg", "Malta",
  "Netherlands", "Poland", "Portugal", "Romania", "Slovakia", "Slovenia",
  "Spain", "Sweden", "Norway", "Switzerland", "Iceland",
]);

export const UK_COUNTRIES = new Set<string>(["United Kingdom", "UK"]);

export const US_COUNTRIES = new Set<string>([
  "United States", "USA", "US", "United States of America",
]);

export const RU_COUNTRIES = new Set<string>(["Russia", "Russian Federation"]);

/** Страны с безвизовым / упрощённым доступом к найму в РФ. */
export const RU_WORK_PERMIT_COUNTRIES = new Set<string>(["Russia", "Belarus"]);

/** Страны СНГ (без РФ). */
export const CIS_COUNTRIES = new Set<string>([
  "Kazakhstan", "Belarus", "Armenia", "Kyrgyzstan", "Uzbekistan",
  "Tajikistan", "Moldova", "Azerbaijan", "Georgia", "Turkmenistan",
]);

export const LATAM_COUNTRIES = new Set<string>([
  "Brazil", "Mexico", "Argentina", "Colombia", "Chile", "Peru",
  "Ecuador", "Venezuela", "Uruguay", "Paraguay", "Bolivia",
  "Costa Rica", "Panama", "Dominican Republic",
]);

export const APAC_COUNTRIES = new Set<string>([
  "Singapore", "Australia", "Japan", "India", "South Korea",
  "Malaysia", "Thailand", "Indonesia", "Vietnam", "Philippines",
  "New Zealand", "Hong Kong", "Taiwan", "China",
]);

export const ME_COUNTRIES = new Set<string>([
  "UAE", "United Arab Emirates", "Saudi Arabia", "Qatar",
  "Bahrain", "Kuwait", "Oman", "Turkey",
]);

/**
 * Israel вынесен в отдельный bucket `israel`. Tech-сектор там:
 *   - Зарплаты в USD (не ILS и не MENA-уровня).
 *   - Команды англоязычные (IL-стартапы продают в US).
 *   - Налоги и B2B/employment — свои специфичные.
 * По зарплатам Израиль ближе к EU senior / US middle, а не к UAE/Qatar.
 */
export const ISRAEL_COUNTRIES = new Set<string>(["Israel"]);

export function isPhysicallyInRU(physicalCountry: string): boolean {
  return RU_COUNTRIES.has(physicalCountry);
}

export function isPhysicallyInEU(physicalCountry: string): boolean {
  return EU_COUNTRIES.has(physicalCountry);
}

export function isPhysicallyInUK(physicalCountry: string): boolean {
  return UK_COUNTRIES.has(physicalCountry);
}

export function isPhysicallyInUS(physicalCountry: string): boolean {
  return US_COUNTRIES.has(physicalCountry);
}

export function isPhysicallyInIsrael(physicalCountry: string): boolean {
  return ISRAEL_COUNTRIES.has(physicalCountry);
}

export function isPhysicallyInCIS(physicalCountry: string): boolean {
  return CIS_COUNTRIES.has(physicalCountry);
}

/**
 * Закрыт ли RU-рынок из-за санкций для клиента, физически находящегося в
 * этой стране. Работодатели из РФ не могут легально платить резидентам
 * ЕС/UK/США, банки блокируют SWIFT-платежи, плюс законодательные ограничения.
 *
 * Клиент в ЕС, который всё равно хотел бы "работать на РФ-рынок" — не
 * реалистичный кейс, RU-данные в таких анализах только путают.
 *
 * Клиенты из Латам/APAC/ME/СНГ — санкциями не ограничены; RU-рынок
 * остаётся доступным по их выбору (низкий английский, языковой барьер
 * в местных tech-компаниях и т.п.).
 */
export function isRuBlockedBySanctions(physicalCountry: string): boolean {
  return (
    isPhysicallyInEU(physicalCountry) ||
    isPhysicallyInUK(physicalCountry) ||
    isPhysicallyInUS(physicalCountry)
  );
}

export function hasRuWorkPermit(
  physicalCountry: string,
  citizenships: readonly string[],
): boolean {
  return (
    RU_WORK_PERMIT_COUNTRIES.has(physicalCountry) ||
    citizenships.some((c) => RU_WORK_PERMIT_COUNTRIES.has(c))
  );
}

export function hasEUWorkPermit(
  physicalCountry: string,
  citizenships: readonly string[],
): boolean {
  return (
    isPhysicallyInEU(physicalCountry) ||
    citizenships.some((c) => EU_COUNTRIES.has(c))
  );
}

/**
 * Вычисляет рынки, на которых клиент реально может работать.
 *
 * Принцип — **whitelist**: этот список дальше превращается в жёсткое
 * ограничение для промптов и Perplexity (никакие другие рынки в анализе
 * не упоминаются). Поэтому хотение клиента (`targetMarketRegions`) само по
 * себе рынок **не открывает** — нужен реальный путь к найму.
 *
 * Правила:
 *   - `ru`: **не** открывается автоматически по RU/BY-паспорту. Только:
 *     (a) физически в РФ/Беларуси; (b) физически в СНГ + RU/BY permit
 *     (KZ/GE/AM/UZ — там PPP паритет, RU-зп релевантны); (c) клиент
 *     явно целится в `ru` И есть RU/BY permit. Клиенту с RU-паспортом
 *     в Израиле / EU / UAE / Сингапуре RU-рынок не показываем — зп по
 *     PPP неинтересны, санкции тоже могут блокировать (для EU/UK/US
 *     это ловит `isRuBlockedBySanctions`).
 *   - `cis`: паспорт или физически в стране СНГ.
 *   - `eu`: физически в ЕС ИЛИ паспорт ЕС (независимо от английского).
 *     Дополнительно: если клиент целится в `eu` (или `global`) через remote
 *     B2B, и English ≥ B1 — открываем. B1 хватает, потому что в EU много
 *     non-English-speaking компаний и русскоязычных команд, плюс B2B
 *     не требует полноценного interview-цикла на native-level.
 *   - `uk`: native English, только при English ≥ B2 И (физически в UK
 *     ИЛИ паспорт ЕС/UK). Таргет `uk` без локации/паспорта рынок не
 *     открывает.
 *   - `us`: native English. Только при физическом нахождении в США И
 *     English ≥ B2. Никакая виза/таргет не открывают — это отдельный
 *     кейс со стратегическим алертом (`shouldWarnUsWithoutUsPresence`).
 *   - `latam` / `asia-pacific` / `middle-east`: физически там ИЛИ
 *     паспорт ИЛИ таргет при English ≥ B1 (remote B2B).
 *   - `israel`: отдельный bucket (не часть `middle-east`). Открывается
 *     при физ. локации в Израиле ИЛИ израильском паспорте. IL-tech
 *     работает в USD с англоязычными командами — зп ближе к US middle,
 *     чем к Gulf States.
 *   - `global`: только если клиент сам целится в `global` И English ≥ B1
 *     (B2B контракты из любой юрисдикции не требуют native-level).
 *
 * Пороги английского:
 *   - B1 — non-native remote B2B (eu / global / latam / apac / me).
 *   - B2 — native English рынки (uk / us).
 *   - Israel — без жёсткого порога (IL-tech работает в USD с
 *     англоязычными командами, но клиент уже там физически).
 */
export function computeAccessibleMarkets(args: {
  citizenships: readonly string[];
  physicalCountry: string;
  targetMarketRegions: readonly Region[];
  englishLevel: string;
}): Region[] {
  const { citizenships, physicalCountry, targetMarketRegions, englishLevel } =
    args;
  const accessible = new Set<Region>();
  const targets = new Set<Region>(targetMarketRegions);
  const hasEuPassport = citizenships.some((c) => EU_COUNTRIES.has(c));
  const ruOrByPermit = hasRuWorkPermit(physicalCountry, citizenships);
  const hasB1 = cefrAtLeast(englishLevel, "B1");
  const hasB2 = cefrAtLeast(englishLevel, "B2");

  // RU: (a) физ. в РФ/BY; (b) физ. в СНГ + RU/BY permit (PPP паритет);
  // (c) явный target `ru` + RU/BY permit. Паспорт сам по себе рынок
  // НЕ открывает — клиент в Израиле/EU/UAE с RU-паспортом получает
  // ru только если явно попросил.
  if (isPhysicallyInRU(physicalCountry)) {
    accessible.add("ru");
  } else if (isPhysicallyInCIS(physicalCountry) && ruOrByPermit) {
    accessible.add("ru");
  } else if (targets.has("ru") && ruOrByPermit) {
    accessible.add("ru");
  }

  if (
    citizenships.some((c) => CIS_COUNTRIES.has(c)) ||
    CIS_COUNTRIES.has(physicalCountry)
  ) {
    accessible.add("cis");
  }
  if (isPhysicallyInEU(physicalCountry) || hasEUWorkPermit(physicalCountry, citizenships)) {
    accessible.add("eu");
  }
  // EU через remote B2B (в т.ч. для RU/CIS-контингента) — достаточно B1.
  if (targets.has("eu") && hasB1) {
    accessible.add("eu");
  }
  // UK — native English, B2+. Автоматом только при физ. локации в UK
  // или EU-паспорте (Settlement Scheme / frontier-worker).
  // Таргет "uk" без локации/паспорта рынок не открывает.
  if (hasB2 && (isPhysicallyInUK(physicalCountry) || hasEuPassport)) {
    accessible.add("uk");
  }
  // US — native English, только при физическом нахождении в США и B2+.
  // Таргет `us` из анкеты НЕ открывает рынок — вместо этого Phase 4
  // вставляет стратегический алерт про кризис US-найма за рубежом.
  if (isPhysicallyInUS(physicalCountry) && hasB2) {
    accessible.add("us");
  }
  if (
    LATAM_COUNTRIES.has(physicalCountry) ||
    citizenships.some((c) => LATAM_COUNTRIES.has(c)) ||
    (targets.has("latam") && hasB1)
  ) {
    accessible.add("latam");
  }
  if (
    APAC_COUNTRIES.has(physicalCountry) ||
    citizenships.some((c) => APAC_COUNTRIES.has(c)) ||
    (targets.has("asia-pacific") && hasB1)
  ) {
    accessible.add("asia-pacific");
  }
  if (
    ME_COUNTRIES.has(physicalCountry) ||
    citizenships.some((c) => ME_COUNTRIES.has(c)) ||
    (targets.has("middle-east") && hasB1) ||
    // Израиль физически в MENA — регион как гео-контекст (Gulf states,
    // Jordan, Turkey) для клиентов из IL остаётся открытым, хотя
    // основной их bucket — отдельный `israel`.
    isPhysicallyInIsrael(physicalCountry)
  ) {
    accessible.add("middle-east");
  }
  // Израиль — отдельный bucket (USD-зп, англоязычные стартапы).
  // Открывается физ. локацией или израильским паспортом. Клиенты с
  // RU/EU паспортом, таргетящие IL, не получают его автоматически —
  // Израиль требует alyah/визу, это не remote B2B.
  if (
    isPhysicallyInIsrael(physicalCountry) ||
    citizenships.some((c) => ISRAEL_COUNTRIES.has(c))
  ) {
    accessible.add("israel");
  }
  // `global` = remote B2B-контракты в любой юрисдикции. Для RU/CIS
  // клиентов это основной путь работать на международном рынке.
  // Достаточно B1.
  if (targets.has("global") && hasB1) {
    accessible.add("global");
  }
  // Global fallback: клиент целился в native-English рынок (us/uk), но
  // код его не открыл (не в США / нет B2 / нет EU-паспорта). При B1+
  // global — реалистичная альтернатива (EU B2B / EOR). Это не расширение
  // желаемого рынка (US/UK он всё равно не получит), а опция работы на
  // международном рынке из любой юрисдикции.
  if (
    hasB1 &&
    ((targets.has("us") && !accessible.has("us")) ||
      (targets.has("uk") && !accessible.has("uk")))
  ) {
    accessible.add("global");
  }

  return [...accessible];
}

/**
 * UK-данные (itjobswatch) — proxy-ориентир для EU-рынка: отдельного
 * гранулярного source по каждой EU-стране у нас нет. Этот флаг разрешает
 * показывать UK-колонку в `scrapedMarketData` клиентам, у кого EU открыт,
 * но UK нет в accessible (B1 / не-EU паспорт / не в UK). В whitelist
 * промпта UK при этом **не попадает** — цифры идут с пометкой
 * "UK как ориентир для EU".
 */
export function shouldShowUkDataAsEuProxy(
  accessible: readonly Region[],
): boolean {
  return accessible.includes("eu") && !accessible.includes("uk");
}

/**
 * True, если клиент явно просил US-рынок, но не находится в США физически.
 * В таком случае Phase 4 финала вставляет `US_CRISIS_STRATEGIC_ALERT`
 * вместо US-вилок — US в `accessibleMarkets` всё равно не попадает.
 */
export function shouldWarnUsWithoutUsPresence(args: {
  targetMarketRegions: readonly Region[];
  physicalCountry: string;
}): boolean {
  return (
    args.targetMarketRegions.includes("us") &&
    !isPhysicallyInUS(args.physicalCountry)
  );
}

/**
 * Алерт, который модель обязана вставить в Стратегический алерт финала,
 * если `shouldWarnUsWithoutUsPresence === true`. Формулировка
 * согласована с куратором.
 */
export const US_CRISIS_STRATEGIC_ALERT =
  "US-рынок вообще не нанимает людей за пределами США и испытывает " +
  "глубокий кризис прямо сейчас (200+ тыс IT-увольнений за 2025 год, " +
  "H1B/O-1 фактически закрыты, большинство вакансий требуют физического " +
  "присутствия и подтверждения work authorization). Реалистичный путь " +
  "работать с US-компаниями для клиента без US-локации — через EOR / " +
  "B2B-контракт из EU-юрисдикции.";
