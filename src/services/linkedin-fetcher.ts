import { load } from "cheerio";

/**
 * Public-LinkedIn-profile fetcher with two-tier strategy:
 *
 *   1. Direct GET with operator's `LINKEDIN_COOKIE` (li_at + JSESSIONID etc.) —
 *      bypasses LinkedIn's auth wall using the operator's logged-in session.
 *      Cookie typically lives ~1-2 months; refresh from browser when stale.
 *
 *   2. Fallback to Perplexity Sonar — asks the model to summarise the public
 *      profile by URL. Less precise but works without LinkedIn auth.
 *
 * Returns null if both paths fail or url is empty/invalid. Callers should treat
 * null as "no LinkedIn enrichment available" and proceed with the rest of the
 * data (the resume + clientSummary remain the primary source).
 *
 * Output is a plain text summary (~1-3 KB) with sections:
 *   - headline / current title
 *   - location, summary
 *   - experience (company, role, dates, bullets when available)
 *   - education
 *   - skills
 *   - certifications
 *
 * Does NOT raise — errors are logged and converted to null.
 */
export interface LinkedinProfile {
  url: string;
  fetchedAt: string;
  source: "direct_cookie" | "perplexity";
  text: string;
  /** Quick parsed bits (best-effort, may be empty). */
  headline: string;
  location: string;
}

export async function fetchLinkedinProfile(
  rawUrl: string,
): Promise<LinkedinProfile | null> {
  const url = normalizeLinkedinUrl(rawUrl);
  if (!url) return null;

  try {
    const direct = await fetchWithCookie(url);
    if (direct) {
      console.log(`[LinkedIn] direct fetch OK for ${url}`);
      return direct;
    }
  } catch (err) {
    console.warn(
      `[LinkedIn] direct fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const viaSonar = await fetchWithPerplexity(url);
    if (viaSonar) {
      console.log(`[LinkedIn] perplexity fallback OK for ${url}`);
      return viaSonar;
    }
  } catch (err) {
    console.warn(
      `[LinkedIn] perplexity fallback failed: ${err instanceof Error ? err.message : String(err)}`,
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

async function fetchWithCookie(url: string): Promise<LinkedinProfile | null> {
  const cookie = process.env.LINKEDIN_COOKIE;
  if (!cookie) {
    console.log("[LinkedIn] LINKEDIN_COOKIE not set, skipping direct fetch");
    return null;
  }

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9,ru;q=0.8",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      Cookie: cookie,
      Referer: "https://www.linkedin.com/feed/",
    },
    redirect: "follow",
  });

  if (resp.status === 999) {
    throw new Error("LinkedIn returned 999 — cookie likely expired or rate-limited");
  }
  if (resp.status >= 400) {
    throw new Error(`LinkedIn HTTP ${resp.status}`);
  }

  const html = await resp.text();
  if (
    html.length < 5000 ||
    /Sign in to view|join LinkedIn to/i.test(html.slice(0, 4000))
  ) {
    throw new Error("LinkedIn returned auth wall (cookie not effective)");
  }

  const parsed = parseLinkedinHtml(html);
  if (!parsed.text || parsed.text.length < 200) {
    throw new Error(`parsed too short (${parsed.text.length} chars)`);
  }

  return {
    url,
    fetchedAt: new Date().toISOString(),
    source: "direct_cookie",
    headline: parsed.headline,
    location: parsed.location,
    text: parsed.text,
  };
}

function parseLinkedinHtml(html: string): {
  headline: string;
  location: string;
  text: string;
} {
  const $ = load(html);

  $("script, style, noscript").remove();

  const ogTitle = $('meta[property="og:title"]').attr("content") || "";
  const ogDescription =
    $('meta[property="og:description"]').attr("content") || "";

  let headline = "";
  let location = "";

  const headlineCandidate = $(".text-body-medium.break-words").first().text().trim();
  if (headlineCandidate) headline = headlineCandidate;
  if (!headline && ogDescription) {
    headline = ogDescription.split("·")[0].trim();
  }

  const locationCandidate = $(".text-body-small.inline.t-black--light.break-words")
    .first()
    .text()
    .trim();
  if (locationCandidate) location = locationCandidate;

  // Sections — main, code-fenced JSON-LD won't always be there for /in/
  // pages, so fall back to flattened body text.
  const lines: string[] = [];
  if (ogTitle) lines.push(`# ${ogTitle.replace(/\s*\|\s*LinkedIn$/i, "")}`);
  if (headline) lines.push(`Headline: ${headline}`);
  if (location) lines.push(`Location: ${location}`);
  lines.push("");

  const flat = $("main, .pv-profile-section, body")
    .first()
    .text()
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");

  if (flat) lines.push(flat);

  return {
    headline,
    location,
    text: lines.join("\n").slice(0, 12000),
  };
}

const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";

async function fetchWithPerplexity(url: string): Promise<LinkedinProfile | null> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    console.log("[LinkedIn] PERPLEXITY_API_KEY not set, skipping fallback");
    return null;
  }

  const prompt = `Открой публичный профиль LinkedIn: ${url}

Верни сводку ТОЛЬКО на основе того, что есть на самой странице (не выдумывай). Структура:

Headline: <текущая должность и компания, одной строкой>
Location: <город, страна>
Summary: <раздел About, 2-5 предложений>

Experience:
- Компания, Должность, Период (mm.yyyy – mm.yyyy / present), Локация
  Краткое описание роли + ключевые буллеты, если они опубликованы

Education:
- Учебное заведение, степень, специальность, годы

Skills: <топ 10-20 опубликованных скиллов через запятую>
Certifications: <список с датами>

Если страница недоступна или поля не указаны — пиши "не указано". Никаких преамбул, только структурированный текст.`;

  const resp = await fetch(PERPLEXITY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1500,
      temperature: 0.1,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Perplexity HTTP ${resp.status}: ${await resp.text()}`);
  }

  const data = (await resp.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (text.length < 200) {
    throw new Error(`Perplexity returned too little content (${text.length} chars)`);
  }

  const headlineMatch = text.match(/Headline:\s*([^\n]+)/i);
  const locationMatch = text.match(/Location:\s*([^\n]+)/i);

  return {
    url,
    fetchedAt: new Date().toISOString(),
    source: "perplexity",
    headline: headlineMatch?.[1]?.trim() ?? "",
    location: locationMatch?.[1]?.trim() ?? "",
    text,
  };
}
