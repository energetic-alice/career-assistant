import Anthropic from "@anthropic-ai/sdk";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

const RESUME_EXTRACTION_PROMPT = `Извлеки полный текст из этого документа (резюме/CV).
Сохрани структуру: заголовки, должности, даты, списки навыков, достижения с цифрами.
Верни только извлеченный текст без комментариев.`;

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

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
 * Supports PDF, DOCX, plain text, and images (PNG, JPEG, GIF, WEBP).
 */
export async function extractResumeText(
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  if (mimeType === "application/pdf") {
    return extractPdfWithClaude(buffer);
  }

  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (mimeType === "text/plain") {
    return buffer.toString("utf-8");
  }

  if (IMAGE_MIME_TYPES.has(mimeType)) {
    return extractImageWithClaude(buffer, mimeType);
  }

  throw new Error(`Unsupported resume format: ${mimeType}`);
}

/**
 * Download a file from Google Drive by its file URL.
 * Expects a service account with access to the Drive folder.
 * Returns buffer + mimeType.
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
  const mimeType = meta.data.mimeType ?? "application/octet-stream";

  const response = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" },
  );

  return {
    buffer: Buffer.from(response.data as ArrayBuffer),
    mimeType,
  };
}

function extractDriveFileId(url: string): string | null {
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
