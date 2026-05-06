import { Marked, marked } from "marked";

function inline(raw: string): string {
  return marked.parseInline(raw) as string;
}

const gdocMarked = new Marked({
  renderer: {
    heading({ text, depth }: { text: string; depth: number }) {
      const sizes: Record<number, string> = {
        1: "font-size:24px;font-weight:bold;margin:24px 0 12px 0;color:#1a1a1a;",
        2: "font-size:20px;font-weight:bold;margin:20px 0 10px 0;color:#2d2d2d;",
        3: "font-size:16px;font-weight:bold;margin:16px 0 8px 0;color:#3d3d3d;",
      };
      const style = sizes[depth] || sizes[3];
      return `<h${depth} style="${style}">${inline(text)}</h${depth}>`;
    },
    table(token: { header: { text: string }[]; rows: { text: string }[][] }) {
      const tableStyle = "border-collapse:collapse;width:100%;margin:12px 0;";
      const thStyle = "border:1px solid #999;padding:8px 12px;background:#e8e8e8;font-weight:bold;text-align:left;";
      const tdStyle = "border:1px solid #bbb;padding:8px 12px;text-align:left;";

      let html = `<table style="${tableStyle}"><thead><tr>`;
      for (const cell of token.header) {
        html += `<th style="${thStyle}">${inline(cell.text)}</th>`;
      }
      html += "</tr></thead><tbody>";
      for (const row of token.rows) {
        html += "<tr>";
        for (const cell of row) {
          html += `<td style="${tdStyle}">${inline(cell.text)}</td>`;
        }
        html += "</tr>";
      }
      html += "</tbody></table>";
      return html;
    },
    paragraph({ text }: { text: string }) {
      return `<p style="margin:8px 0;line-height:1.5;">${inline(text)}</p>`;
    },
    list(token: { ordered: boolean; items: { text: string }[] }) {
      const tag = token.ordered ? "ol" : "ul";
      const style = "margin:8px 0;padding-left:24px;";
      let inner = "";
      for (const item of token.items) {
        inner += `<li style="margin:4px 0;line-height:1.5;">${inline(item.text)}</li>`;
      }
      return `<${tag} style="${style}">${inner}</${tag}>`;
    },
    strong({ text }: { text: string }) {
      return `<strong style="font-weight:bold;">${text}</strong>`;
    },
    em({ text }: { text: string }) {
      return `<em style="font-style:italic;">${text}</em>`;
    },
    hr() {
      return '<hr style="border:none;border-top:1px solid #ccc;margin:16px 0;">';
    },
  },
});

async function markdownToGdocHtml(md: string): Promise<string> {
  return gdocMarked.parse(md) as Promise<string>;
}

/**
 * Creates a Google Doc from Markdown content.
 *
 * Strategy:
 * 1. If APPS_SCRIPT_DOC_URL is set → create via Google Apps Script web app
 *    (runs under user's account — обходит storage quota service account'а)
 * 2. Иначе fallback: Drive API через service account. Внимание: у обычного
 *    service account собственный Drive storage 0 GB, поэтому fallback
 *    реально работает только если SA добавлен в Shared Drive с ролью
 *    Content Manager — иначе вернёт `storageQuotaExceeded`.
 */
export async function createGoogleDoc(
  title: string,
  markdownContent: string,
): Promise<string> {
  const appsScriptUrl = process.env.APPS_SCRIPT_DOC_URL;
  if (appsScriptUrl) {
    return createViaAppsScript(appsScriptUrl, title, markdownContent);
  }
  return createViaDriveApi(title, markdownContent);
}

// Apps Script web app периодически отдаёт HTML-страницу ошибки (Página não
// encontrada / unauthorized) вместо JSON — нерегулярный glitch на стороне
// Google: истекает auth-токен в кэше googleusercontent.com, перегружен прокси
// после долгого простоя. Локально и со свежего deployment — мгновенно отдаёт
// JSON. Поэтому делаем 3 попытки с экспоненциальным бэкоффом: одного retry
// обычно хватает, второго — на крайний случай.
const APPS_SCRIPT_RETRIES = 3;
const APPS_SCRIPT_BACKOFF_MS = [0, 2_000, 5_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createViaAppsScript(
  webAppUrl: string,
  title: string,
  markdownContent: string,
): Promise<string> {
  const htmlBody = await markdownToGdocHtml(markdownContent);
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || "";
  const payload = JSON.stringify({
    title,
    html: htmlBody,
    folderId,
    secret: process.env.WEBHOOK_SECRET || "",
  });

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < APPS_SCRIPT_RETRIES; attempt++) {
    if (APPS_SCRIPT_BACKOFF_MS[attempt] > 0) {
      await sleep(APPS_SCRIPT_BACKOFF_MS[attempt]);
    }
    try {
      return await callAppsScriptOnce(webAppUrl, payload, attempt + 1);
    } catch (err) {
      lastError = err as Error;
      console.warn(
        `[createViaAppsScript] attempt ${attempt + 1}/${APPS_SCRIPT_RETRIES} failed: ${lastError.message.slice(0, 200)}`,
      );
    }
  }
  throw lastError ?? new Error("Apps Script: unknown failure");
}

async function callAppsScriptOnce(
  webAppUrl: string,
  payload: string,
  attemptNum: number,
): Promise<string> {
  const resp = await fetch(webAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    redirect: "follow",
  });

  // ВСЕГДА читаем body как текст — Apps Script может вернуть 200 OK с
  // HTML-страницей-ошибкой, и тогда `resp.json()` падает с криптовым
  // `Unexpected token '<'`. По тексту мы умеем отдать диагностический preview.
  const text = await resp.text();
  const contentType = resp.headers.get("content-type") || "";

  if (!resp.ok) {
    const preview = text.slice(0, 300).replace(/\s+/g, " ");
    throw new Error(
      `Apps Script HTTP ${resp.status} (attempt ${attemptNum}, ct=${contentType}, redirected=${resp.redirected}): ${preview}`,
    );
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    const preview = trimmed.slice(0, 200).replace(/\s+/g, " ");
    throw new Error(
      `Apps Script returned non-JSON (attempt ${attemptNum}, ct=${contentType}, redirected=${resp.redirected}, finalUrl=${resp.url.slice(0, 120)}): ${preview}…`,
    );
  }

  let data: { url?: string; error?: string };
  try {
    data = JSON.parse(trimmed) as { url?: string; error?: string };
  } catch (err) {
    throw new Error(
      `Apps Script malformed JSON (attempt ${attemptNum}): ${(err as Error).message}. Body: ${trimmed.slice(0, 200)}`,
    );
  }

  if (data.error) throw new Error(`Apps Script: ${data.error}`);
  if (!data.url) throw new Error("Apps Script did not return a URL");
  return data.url;
}

async function createViaDriveApi(
  title: string,
  markdownContent: string,
): Promise<string> {
  const { google } = await import("googleapis");
  const { getGoogleAuth } = await import("./google-auth.js");

  const auth = await getGoogleAuth(["https://www.googleapis.com/auth/drive.file"]);
  const drive = google.drive({ version: "v3", auth });

  const htmlBody = await markdownToGdocHtml(markdownContent);
  const htmlDocument = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:20px;">${htmlBody}</body></html>`;

  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  const file = await drive.files.create({
    requestBody: {
      name: title,
      mimeType: "application/vnd.google-apps.document",
      ...(folderId ? { parents: [folderId] } : {}),
    },
    media: {
      mimeType: "text/html",
      body: htmlDocument,
    },
    fields: "id",
  });

  const fileId = file.data.id;
  if (!fileId) {
    throw new Error("Google Drive did not return a file ID");
  }

  await drive.permissions.create({
    fileId,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
  });

  return `https://docs.google.com/document/d/${fileId}/edit`;
}
