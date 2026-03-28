import { marked } from "marked";

/**
 * Creates a Google Doc from Markdown content, returns the shareable URL.
 * Uses Google Drive API to upload HTML (auto-converted to native Google Doc format).
 */
export async function createGoogleDoc(
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
    fields: "id,webViewLink",
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

  const webViewLink = file.data.webViewLink;
  if (!webViewLink) {
    return `https://docs.google.com/document/d/${fileId}/edit`;
  }

  return webViewLink;
}
