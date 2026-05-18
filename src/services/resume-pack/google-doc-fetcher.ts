import {
  downloadFromGoogleDrive,
  extractDriveFileId,
  extractResumeText,
  isGoogleDriveUrl,
  sniffMimeType,
} from "../file-service.js";

/**
 * Скачивание резюме по ссылке на Google Doc / Google Drive.
 *
 * Используется в probe-режиме, когда Алиса даёт ссылку на конкретный
 * Google Document с резюме, а не nick клиента в проде. Поведение:
 *
 *   1. Сначала пробуем **публичный export** через
 *      `https://docs.google.com/document/d/<id>/export?format=docx` —
 *      работает для документов, расшаренных как "Anyone with the link
 *      can view". Auth не нужен, быстро.
 *   2. Если публичный export недоступен (приватный документ, redirect
 *      на login, 401/403/404) — фоллбек на `downloadFromGoogleDrive`
 *      (Drive API через service account). Требует, чтобы документ был
 *      расшарен на email service account'а (или сам файл лежал в
 *      доступном для SA шейре).
 *   3. Если оба варианта упали — кидаем ошибку с понятным сообщением.
 *
 * Поддерживает оба типа ссылок:
 *   - `https://docs.google.com/document/d/<ID>/edit?...` (Google Doc — native)
 *   - `https://drive.google.com/file/d/<ID>/view?...` (PDF / DOCX uploaded to Drive)
 */

export interface GoogleDocFetchResult {
  /** Распарсенный текст резюме (готов к подаче в audit-промпт). */
  text: string;
  /** Mime после экстракции (для логов). */
  mimeType: string;
  /** Каким путём скачали (диагностика). */
  source: "public_export_docx" | "public_export_pdf" | "drive_api";
  /** ID файла в Drive — пригодится для composing participantId='external-<id>'. */
  fileId: string;
}

export class GoogleDocFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleDocFetchError";
  }
}

/**
 * Попытаться скачать как DOCX через публичный export-URL.
 * Работает только для документов типа `application/vnd.google-apps.document`
 * (нативные Google Docs), расшаренных по ссылке.
 *
 * Drive перенаправляет нас на финальный CDN-URL; следуем redirect'ам.
 * Если документ приватный — Google возвращает HTML-страницу логина с
 * `Content-Type: text/html`, что мы и используем как сигнал «не публично».
 */
async function tryPublicExportDocx(
  fileId: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const url = `https://docs.google.com/document/d/${fileId}/export?format=docx`;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("text/html")) {
      // Google вернул страницу логина — документ приватный.
      return null;
    }
    const ab = await res.arrayBuffer();
    const buffer = Buffer.from(ab);
    if (buffer.length < 200) return null;
    // Validate magic bytes — DOCX = ZIP signature 0x504B (PK).
    const sniffed = sniffMimeType(buffer);
    if (
      sniffed ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      return { buffer, mimeType: sniffed };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Запасной публичный export — как PDF. Иногда документ открыт «по ссылке»,
 * но именно DOCX-export запрещён (зависит от настроек шары и владельца).
 * PDF чаще проходит.
 */
async function tryPublicExportPdf(
  fileId: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const url = `https://docs.google.com/document/d/${fileId}/export?format=pdf`;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("text/html")) return null;
    const ab = await res.arrayBuffer();
    const buffer = Buffer.from(ab);
    if (buffer.length < 200) return null;
    const sniffed = sniffMimeType(buffer);
    if (sniffed === "application/pdf") return { buffer, mimeType: sniffed };
    return null;
  } catch {
    return null;
  }
}

export async function fetchResumeFromGoogleDoc(
  url: string,
): Promise<GoogleDocFetchResult> {
  if (!isGoogleDriveUrl(url)) {
    throw new GoogleDocFetchError(
      `URL не похож на ссылку Google Drive / Google Docs: ${url}`,
    );
  }
  const fileId = extractDriveFileId(url);
  if (!fileId) {
    throw new GoogleDocFetchError(
      `Не удалось извлечь file ID из URL: ${url}`,
    );
  }

  // 1) Публичный DOCX-export (быстро, без auth)
  const docxPublic = await tryPublicExportDocx(fileId);
  if (docxPublic) {
    const text = await extractResumeText(docxPublic.buffer, docxPublic.mimeType);
    return {
      text,
      mimeType: docxPublic.mimeType,
      source: "public_export_docx",
      fileId,
    };
  }

  // 2) Публичный PDF-export (тоже без auth, на случай если DOCX заблочен)
  const pdfPublic = await tryPublicExportPdf(fileId);
  if (pdfPublic) {
    const text = await extractResumeText(pdfPublic.buffer, pdfPublic.mimeType);
    return {
      text,
      mimeType: pdfPublic.mimeType,
      source: "public_export_pdf",
      fileId,
    };
  }

  // 3) Drive API через service account (требует доступа SA к документу)
  try {
    const { buffer, mimeType } = await downloadFromGoogleDrive(url);
    const text = await extractResumeText(buffer, mimeType);
    return { text, mimeType, source: "drive_api", fileId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new GoogleDocFetchError(
      `Не удалось скачать документ ни через публичный export, ни через Drive API.\n` +
        `File ID: ${fileId}\n` +
        `Drive API error: ${msg}\n\n` +
        `Если документ приватный — расшарь его на "Anyone with the link can view" ` +
        `или добавь email service-account'а в Share.`,
    );
  }
}
