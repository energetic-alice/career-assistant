/**
 * LinkedIn profile fetcher.
 *
 * Единственный источник данных — Apify (`APIFY_API_TOKEN` +
 * `APIFY_LINKEDIN_ACTOR`). Прямой скрейп через cookie больше не используем:
 * LinkedIn сломал старый `/voyager/api/identity/profiles/<slug>/profileView`
 * (410 Gone), а новые Voyager-эндпоинты требуют ~5 AJAX-вызовов и частых
 * правок под смену decorationId. Apify стабильно отдаёт готовый
 * `{ basic_info, experience, education, languages }` одним запросом.
 *
 * Никакого Perplexity: он отдаёт закешированный профиль (часто несколько
 * месяцев старый), а для LinkedIn-аудита нам нужна СВЕЖАЯ страница — клиент
 * мог вчера поменять headline/опыт, и анализировать устаревшие данные
 * бессмысленно.
 *
 * Результат кешируется на диск на уровне `linkedin-pack/build-inputs.ts`
 * (`data/documents/<pid>/linkedin-profile.json`, TTL 180 дней), так что
 * платный Apify-запуск за одного клиента делается максимум раз в полгода.
 *
 * Возвращает null если Apify не сработал или URL пустой/некорректный.
 * Вызыватели трактуют null как "LinkedIn недоступен" — пайплайн продолжается
 * на резюме + clientSummary, а LinkedIn-only пункты аудита помечаются
 * "проверь руками".
 *
 * Не кидает: все ошибки логируются и конвертируются в null.
 */
export interface LinkedinProfile {
  url: string;
  fetchedAt: string;
  source: "apify";
  /** Pretty-printed JSON от Apify actor'а — сразу скармливаем в промпт. */
  text: string;
  /** Quick parsed bits для UI/лог-префиксов (best-effort, могут быть пустыми). */
  headline: string;
  location: string;
}

export async function fetchLinkedinProfile(
  rawUrl: string,
): Promise<LinkedinProfile | null> {
  const url = normalizeLinkedinUrl(rawUrl);
  if (!url) return null;

  try {
    const viaApify = await fetchWithApify(url);
    if (viaApify) {
      console.log(`[LinkedIn] Apify fetch OK for ${url}`);
      return viaApify;
    }
  } catch (err) {
    console.warn(
      `[LinkedIn] Apify failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

function normalizeLinkedinUrl(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  let url = raw.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("linkedin.com")) return null;
    if (!/\/in\/[^/]+/.test(u.pathname)) return null;
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

// ── Apify ──────────────────────────────────────────────────────────────────
//
// Актор принимает `{ username: <profile-url-or-slug>, includeEmail: false }`
// и возвращает массив с одним объектом формата
// `{ basic_info, experience, education, languages }`.
//
// Парсить этот JSON не нужно: скармливаем модели сырой pretty-printed JSON —
// там уже вся разметка (полные поля headline, about, experience[].description
// и т.д.), плюс бонус: `basic_info.profile_picture_url` и
// `basic_info.background_picture_url` позволяют автоматом проверить пункты
// чеклиста про фото и баннер, без "проверь руками".

const APIFY_TIMEOUT_MS = 180_000;

async function fetchWithApify(url: string): Promise<LinkedinProfile | null> {
  const token = process.env.APIFY_API_TOKEN;
  const actorId = process.env.APIFY_LINKEDIN_ACTOR;
  if (!token || !actorId) {
    console.log(
      "[LinkedIn] APIFY_API_TOKEN / APIFY_LINKEDIN_ACTOR not set, skipping Apify",
    );
    return null;
  }

  const endpoint =
    `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&timeout=${Math.floor(APIFY_TIMEOUT_MS / 1000)}`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: url, includeEmail: false }),
  });

  if (!resp.ok) {
    throw new Error(`Apify HTTP ${resp.status}: ${await resp.text()}`);
  }

  const items = (await resp.json()) as unknown;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Apify returned empty dataset");
  }
  const item = items[0] as Record<string, unknown>;

  const basic =
    typeof item["basic_info"] === "object" && item["basic_info"] !== null
      ? (item["basic_info"] as Record<string, unknown>)
      : {};

  const headline =
    typeof basic["headline"] === "string" ? basic["headline"] : "";
  const loc =
    typeof basic["location"] === "object" && basic["location"] !== null
      ? (basic["location"] as Record<string, unknown>)
      : {};
  const location = typeof loc["full"] === "string" ? loc["full"] : "";

  const text = JSON.stringify(item, null, 2);
  if (text.length < 200) {
    throw new Error(`Apify item too short (${text.length} chars)`);
  }

  return {
    url,
    fetchedAt: new Date().toISOString(),
    source: "apify",
    headline,
    location,
    text,
  };
}
