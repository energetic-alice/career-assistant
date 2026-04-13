import { marked } from "marked";

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
  const htmlBody = await marked(markdownContent);
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

  const htmlBody = await marked(markdownContent);
  const htmlDocument = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body>${htmlBody}</body></html>`;

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
