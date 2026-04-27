import Anthropic from "@anthropic-ai/sdk";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import yauzl from "yauzl";

const RESUME_EXTRACTION_PROMPT = `Извлеки полный текст из этого документа (резюме/CV).
Сохрани структуру: заголовки, должности, даты, списки навыков, достижения с цифрами.
Верни только извлеченный текст без комментариев.`;

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ODT_MIME = "application/vnd.oasis.opendocument.text";
const RTF_MIMES = new Set(["application/rtf", "text/rtf"]);
const DOC_MIMES = new Set(["application/msword", "application/x-msword"]);

/**
 * Map a `application/vnd.google-apps.*` mimeType to the best
 * binary export format for resume text extraction.
 */
function chooseGoogleExportMime(googleMime: string): {
  exportMime: string;
  asMime: string;
} {
  switch (googleMime) {
    case "application/vnd.google-apps.document":
      return { exportMime: DOCX_MIME, asMime: DOCX_MIME };
    case "application/vnd.google-apps.spreadsheet":
      return { exportMime: "text/csv", asMime: "text/plain" };
    case "application/vnd.google-apps.presentation":
      return { exportMime: "application/pdf", asMime: "application/pdf" };
    default:
      return { exportMime: "application/pdf", asMime: "application/pdf" };
  }
}

/** Sniff binary buffer signature to detect mime when content-type is missing. */
export function sniffMimeType(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;
  if (buffer.slice(0, 4).toString("ascii") === "%PDF") {
    return "application/pdf";
  }
  if (
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
  ) {
    return DOCX_MIME;
  }
  if (
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0
  ) {
    return "application/msword";
  }
  if (buffer.slice(0, 5).toString("ascii") === "{\\rtf") {
    return "application/rtf";
  }
  if (buffer.slice(0, 8).toString("ascii").startsWith("\xffd8\xff")) {
    return "image/jpeg";
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  return null;
}

function stripRtf(raw: string): string {
  return raw
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\'(?:[0-9a-fA-F]{2})/g, " ")
    .replace(/\\[a-zA-Z]+-?\d* ?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

function readZipEntry(buffer: Buffer, name: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error("zip open failed"));
        return;
      }
      let resolved = false;
      zipfile.on("entry", (entry) => {
        if (entry.fileName === name) {
          zipfile.openReadStream(entry, (sErr, stream) => {
            if (sErr || !stream) {
              resolve(null);
              return;
            }
            const chunks: Buffer[] = [];
            stream.on("data", (c: Buffer) => chunks.push(c));
            stream.on("end", () => {
              resolved = true;
              resolve(Buffer.concat(chunks).toString("utf-8"));
              zipfile.close();
            });
            stream.on("error", () => resolve(null));
          });
          return;
        }
        zipfile.readEntry();
      });
      zipfile.on("end", () => {
        if (!resolved) resolve(null);
      });
      zipfile.readEntry();
    });
  });
}

async function extractOdtText(buffer: Buffer): Promise<string> {
  const xml = await readZipEntry(buffer, "content.xml");
  if (!xml) throw new Error("ODT: no content.xml inside archive");
  return xml
    .replace(/<text:p[^>]*>/g, "\n")
    .replace(/<text:tab\/>/g, "\t")
    .replace(/<text:line-break\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract text from a PDF using Claude's native document understanding.
 * Falls back to pdf-parse if Claude fails.
 */
async function extractPdfWithClaude(buffer: Buffer): Promise<string> {
  try {
    const client = new Anthropic();
    const base64 = buffer.toString("base64");

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: base64,
              },
            },
            { type: "text", text: RESUME_EXTRACTION_PROMPT },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (textBlock && textBlock.type === "text") {
      return textBlock.text;
    }
    throw new Error("No text block in Claude response");
  } catch (err) {
    console.warn("Claude PDF extraction failed, falling back to pdf-parse:", err);
    const result = await pdfParse(buffer);
    return result.text;
  }
}

async function extractImageWithClaude(buffer: Buffer, mimeType: string): Promise<string> {
  const client = new Anthropic();
  const base64 = buffer.toString("base64");

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
              data: base64,
            },
          },
          { type: "text", text: RESUME_EXTRACTION_PROMPT },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (textBlock && textBlock.type === "text") {
    return textBlock.text;
  }
  throw new Error("No text block in Claude response for image");
}

/**
 * Extract text from a resume buffer based on MIME type.
 *
 * Supports:
 *   - application/pdf
 *   - DOCX (OOXML)
 *   - DOC (legacy MS Word) — best-effort via mammoth, fallback error
 *   - RTF (text/rtf, application/rtf) — strip control words
 *   - ODT (OpenDocument) — read content.xml
 *   - text/plain, text/markdown, text/csv
 *   - image/* (PNG/JPEG/GIF/WEBP) — Claude Vision
 *   - application/octet-stream — magic-bytes sniff and re-dispatch
 */
export async function extractResumeText(
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  let mt = (mimeType || "").toLowerCase().split(";")[0].trim();

  if (mt === "application/octet-stream" || mt === "" || mt === "binary/octet-stream") {
    const sniffed = sniffMimeType(buffer);
    if (sniffed) mt = sniffed;
  }

  if (mt === "application/pdf") {
    return extractPdfWithClaude(buffer);
  }

  if (mt === DOCX_MIME) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (DOC_MIMES.has(mt)) {
    try {
      const result = await mammoth.extractRawText({ buffer });
      if (result.value && result.value.trim().length > 0) return result.value;
    } catch {
      // fall through
    }
    throw new Error(
      "Старый формат .doc плохо распознаётся. Пришли пожалуйста в .docx или .pdf.",
    );
  }

  if (RTF_MIMES.has(mt)) {
    return stripRtf(buffer.toString("utf-8"));
  }

  if (mt === ODT_MIME) {
    return extractOdtText(buffer);
  }

  if (mt === "text/plain" || mt === "text/markdown" || mt === "text/csv") {
    return buffer.toString("utf-8");
  }

  if (IMAGE_MIME_TYPES.has(mt)) {
    return extractImageWithClaude(buffer, mt);
  }

  throw new Error(`Unsupported resume format: ${mimeType}`);
}

/**
 * Download a file from Google Drive by its file URL.
 *
 * For binary files (PDF/DOCX/etc) uses `alt:"media"`.
 * For native Google formats (`application/vnd.google-apps.*`) uses
 * `files.export` with the appropriate export mimeType — otherwise Drive
 * returns "Only files with binary content can be downloaded."
 */
export async function downloadFromGoogleDrive(
  fileUrl: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const fileId = extractDriveFileId(fileUrl);
  if (!fileId) {
    throw new Error(`Cannot extract Google Drive file ID from: ${fileUrl}`);
  }

  const { google } = await import("googleapis");
  const { getGoogleAuth } = await import("./google-auth.js");

  const auth = await getGoogleAuth(["https://www.googleapis.com/auth/drive.readonly"]);
  const drive = google.drive({ version: "v3", auth });

  const meta = await drive.files.get({ fileId, fields: "mimeType,name" });
  const driveMime = meta.data.mimeType ?? "application/octet-stream";

  if (driveMime.startsWith("application/vnd.google-apps.")) {
    const { exportMime, asMime } = chooseGoogleExportMime(driveMime);
    const response = await drive.files.export(
      { fileId, mimeType: exportMime },
      { responseType: "arraybuffer" },
    );
    return {
      buffer: Buffer.from(response.data as ArrayBuffer),
      mimeType: asMime,
    };
  }

  const response = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" },
  );

  return {
    buffer: Buffer.from(response.data as ArrayBuffer),
    mimeType: driveMime,
  };
}

export function extractDriveFileId(url: string): string | null {
  const patterns = [
    /\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
    /open\?id=([a-zA-Z0-9_-]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

export function isGoogleDriveUrl(url: string): boolean {
  return /(^|\/)(drive|docs)\.google\.com\//i.test(url);
}
