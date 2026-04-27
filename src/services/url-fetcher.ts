import {
  downloadFromGoogleDrive,
  isGoogleDriveUrl,
  sniffMimeType,
} from "./file-service.js";

/**
 * Universal "give me a buffer for a resume from a URL".
 *
 * Routes:
 *   - drive.google.com / docs.google.com → downloadFromGoogleDrive (handles
 *     native Google Docs export and binary alt:media).
 *   - any other http(s) URL → plain fetch + Content-Type from headers
 *     (with magic-bytes sniffing fallback when the server lies).
 *
 * Caller is expected to pass returned `{buffer, mimeType}` into
 * `extractResumeText` from file-service.
 */

export interface FetchedResumeBlob {
  buffer: Buffer;
  mimeType: string;
  sourceUrl: string;
  fileName?: string;
}

const MAX_RESUME_BYTES = 25 * 1024 * 1024;

export async function fetchResumeFromUrl(url: string): Promise<FetchedResumeBlob> {
  if (isGoogleDriveUrl(url)) {
    const { buffer, mimeType } = await downloadFromGoogleDrive(url);
    return { buffer, mimeType, sourceUrl: url };
  }

  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "career-assistant-bot/1.0 (+https://github.com/alisatsvetkova/career-assistant)",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Не удалось скачать ${url}: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.byteLength > MAX_RESUME_BYTES) {
    throw new Error(
      `Файл по ссылке слишком большой (${buffer.byteLength} байт, лимит ${MAX_RESUME_BYTES}).`,
    );
  }

  const headerCT = response.headers.get("content-type") || "";
  let mimeType = headerCT.split(";")[0].trim() || "application/octet-stream";

  if (
    mimeType === "application/octet-stream" ||
    mimeType === "binary/octet-stream" ||
    !mimeType.includes("/")
  ) {
    const sniffed = sniffMimeType(buffer);
    if (sniffed) mimeType = sniffed;
  }

  const cd = response.headers.get("content-disposition") || "";
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  const fileName = m ? decodeURIComponent(m[1]) : undefined;

  return { buffer, mimeType, sourceUrl: url, fileName };
}

const URL_RE_GLOBAL = /https?:\/\/[^\s<>)"'\]]+/gi;

/** Extract every http(s) URL from a free-form string (forwarded message body). */
export function findUrls(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(URL_RE_GLOBAL)) {
    out.add(m[0].replace(/[.,;:!?)]+$/, ""));
  }
  return Array.from(out);
}
