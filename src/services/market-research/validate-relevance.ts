/**
 * Validate-gate релевантности citations для Phase 2 enrichment.
 *
 * Зачем: даже если Claude/Perplexity вернул URL-citations, они часто не
 * относятся к нужной нише. Реальный пример из бага Daria: Sonar для
 * "Security Engineer, AppSec" вернул `talent.com/digital+technician` и
 * `Digital-Technology-Salary` — совершенно мимо темы. Дальше эти "источники"
 * показывались юзеру и подтверждали неверные числа.
 *
 * Идея простая: вытащить ключевые слова из `direction.title`, проверить что
 * хотя бы одно встречается в URL/snippet citation-а. Если все мимо — drop
 * числа в null и поставить `dataSource = "<provider>-estimate"`.
 *
 * Это не строгая валидация, а sanity-check. Лучше пропустить хороший fill,
 * чем оставить мусорный.
 */

const STOP_WORDS = new Set([
  "engineer",
  "specialist",
  "manager",
  "developer",
  "analyst",
  "lead",
  "senior",
  "middle",
  "junior",
  "intern",
  "principal",
  "staff",
  "the",
  "and",
  "or",
  "for",
  "of",
  "with",
  "in",
  "at",
  "team",
  "tech",
  "software",
  "it",
  "иной",
]);

// Грубая ru→latin транслитерация для русских заголовков типа
// "Аналитик данных". Покрывает только базовый кейс — для большинства
// направлений Claude и так возвращает english title, но pipeline это не
// гарантирует.
const RU_TO_LAT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e",
  ж: "zh", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u",
  ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

function translit(s: string): string {
  return s.split("").map((ch) => RU_TO_LAT[ch] ?? ch).join("");
}

/**
 * Извлекает ключевые слова из заголовка направления, нормализует в lowercase
 * latin, отбрасывает стоп-слова и пунктуацию.
 *
 *   "Security Engineer, AppSec (senior)"
 *     → ["security", "appsec"]
 *   "Аналитик данных"
 *     → ["analitik", "dannyh"]  (фоллбэк на транслит)
 *   "DevSecOps Engineer"
 *     → ["devsecops"]
 *
 * Минимум — пустой массив (тогда `isCitationRelevant` всегда true, gate
 * фактически отключается для невнятных заголовков).
 */
export function extractKeywords(title: string): string[] {
  if (!title) return [];
  const lower = translit(title.toLowerCase());
  const tokens = lower
    .split(/[^a-z0-9+#./]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .filter((t) => !STOP_WORDS.has(t));

  // Уникальные значения, сохраняем порядок.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Проверяет, попадает ли цитата в тематику направления.
 * Цитата = URL или (URL + snippet). Один матч любого keyword'а в URL-path
 * или snippet — достаточно для PASS.
 *
 * Для очень общих заголовков (мало ключевых слов / только стоп-слова)
 * gate возвращает true — мы не хотим дропать честный fill только из-за
 * того что заголовок неудачный.
 */
export function isCitationRelevant(
  url: string,
  snippet: string | undefined,
  keywords: string[],
): boolean {
  if (keywords.length === 0) return true;
  const haystack = `${url} ${snippet ?? ""}`.toLowerCase();
  return keywords.some((kw) => haystack.includes(kw));
}

/**
 * Проверяет массив citation-ов целиком: достаточно одной релевантной.
 * Для compatibility с существующим форматом `string[]` принимаем массив
 * URL'ов; если есть отдельные snippets — передавайте через
 * `urlsWithSnippets`.
 */
export function anyCitationRelevant(
  citations: Array<string | { url: string; snippet?: string }>,
  keywords: string[],
): boolean {
  if (keywords.length === 0) return true;
  for (const c of citations) {
    if (typeof c === "string") {
      if (isCitationRelevant(c, undefined, keywords)) return true;
    } else {
      if (isCitationRelevant(c.url, c.snippet, keywords)) return true;
    }
  }
  return false;
}
