import { Marked } from "marked";

const gdocMarked = new Marked({
  renderer: {
    heading({ text, depth }: { text: string; depth: number }) {
      const sizes: Record<number, string> = {
        1: "font-size:24px;font-weight:bold;margin:24px 0 12px 0;color:#1a1a1a;",
        2: "font-size:20px;font-weight:bold;margin:20px 0 10px 0;color:#2d2d2d;",
        3: "font-size:16px;font-weight:bold;margin:16px 0 8px 0;color:#3d3d3d;",
      };
      const style = sizes[depth] || sizes[3];
      return `<h${depth} style="${style}">${text}</h${depth}>`;
    },
    table(token: { header: { text: string }[]; rows: { text: string }[][] }) {
      const tableStyle = "border-collapse:collapse;width:100%;margin:12px 0;";
      const thStyle = "border:1px solid #999;padding:8px 12px;background:#e8e8e8;font-weight:bold;text-align:left;";
      const tdStyle = "border:1px solid #bbb;padding:8px 12px;text-align:left;";

      let html = `<table style="${tableStyle}"><thead><tr>`;
      for (const cell of token.header) {
        html += `<th style="${thStyle}">${cell.text}</th>`;
      }
      html += "</tr></thead><tbody>";
      for (const row of token.rows) {
        html += "<tr>";
        for (const cell of row) {
          html += `<td style="${tdStyle}">${cell.text}</td>`;
        }
        html += "</tr>";
      }
      html += "</tbody></table>";
      return html;
    },
    paragraph({ text }: { text: string }) {
      return `<p style="margin:8px 0;line-height:1.5;">${text}</p>`;
    },
    list(token: { ordered: boolean; items: { text: string }[] }) {
      const tag = token.ordered ? "ol" : "ul";
      const style = "margin:8px 0;padding-left:24px;";
      let inner = "";
      for (const item of token.items) {
        inner += `<li style="margin:4px 0;line-height:1.5;">${item.text}</li>`;
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
 *    (runs under the user's account, no SA quota issues)
 * 2. Fallback: create via Drive API with the service account
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

async function createViaAppsScript(
  webAppUrl: string,
  title: string,
  markdownContent: string,
): Promise<string> {
  const htmlBody = await markdownToGdocHtml(markdownContent);
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || "";

  const resp = await fetch(webAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      html: htmlBody,
      folderId,
      secret: process.env.WEBHOOK_SECRET || "",
    }),
    redirect: "follow",
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Apps Script error ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as { url?: string; error?: string };
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
