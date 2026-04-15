/**
 * Google Apps Script — установить в таблице, связанной с Google Form.
 *
 * Две функции:
 * 1. onFormSubmit(e) — триггер: отправляет анкету на сервер через webhook
 * 2. doPost(e) — веб-приложение: создаёт Google Doc из HTML (вызывается сервером)
 *
 * Инструкция:
 * 1. Открыть Google Sheets → Расширения → Apps Script
 * 2. Вставить этот код
 * 3. Заменить WEBHOOK_URL и WEBHOOK_SECRET на реальные значения
 * 4. Настроить триггер для onFormSubmit:
 *    Triggers → Add Trigger → onFormSubmit → From spreadsheet → On form submit
 * 5. Деплой как веб-приложение для doPost:
 *    Deploy → New deployment → Web app →
 *    Execute as: Me → Who has access: Anyone → Deploy
 *    Скопировать URL и добавить в Render как APPS_SCRIPT_DOC_URL
 */

const WEBHOOK_URL = "https://YOUR-SERVER.com/api/webhook/new-participant";
const WEBHOOK_SECRET = "your-webhook-secret-here";

/* ── Триггер: отправка анкеты на сервер ── */

function onFormSubmit(e) {
  try {
    const namedValues = e.namedValues;

    const options = {
      method: "post",
      contentType: "application/json",
      headers: {
        "X-Webhook-Secret": WEBHOOK_SECRET,
      },
      payload: JSON.stringify({ namedValues: namedValues }),
      muteHttpExceptions: true,
    };

    const response = UrlFetchApp.fetch(WEBHOOK_URL, options);
    const code = response.getResponseCode();

    if (code !== 200) {
      Logger.log(
        "Webhook error: " + code + " — " + response.getContentText(),
      );
    } else {
      Logger.log("Webhook success: " + response.getContentText());
    }
  } catch (error) {
    Logger.log("Webhook exception: " + error.toString());
  }
}

/* ── Веб-приложение: создание Google Doc из HTML ── */
/*
 * Использует Drive REST API v3 напрямую через UrlFetchApp.
 * НЕ требует включения Drive API advanced service.
 * Достаточно стандартного DriveApp scope.
 */

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    if (data.secret !== WEBHOOK_SECRET) {
      return ContentService.createTextOutput(
        JSON.stringify({ error: "unauthorized" }),
      ).setMimeType(ContentService.MimeType.JSON);
    }

    var title = data.title || "Карьерный анализ";
    var html = data.html || "";
    var folderId = data.folderId || "";

    var fullHtml =
      "<!DOCTYPE html><html><head><meta charset='utf-8'></head><body>" +
      html +
      "</body></html>";

    var metadata = {
      name: title,
      mimeType: "application/vnd.google-apps.document",
    };
    if (folderId) {
      metadata.parents = [folderId];
    }

    var boundary = "----GASBoundary" + Utilities.getUuid();
    var payload =
      "--" + boundary + "\r\n" +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(metadata) + "\r\n" +
      "--" + boundary + "\r\n" +
      "Content-Type: text/html; charset=UTF-8\r\n\r\n" +
      fullHtml + "\r\n" +
      "--" + boundary + "--";

    var resp = UrlFetchApp.fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
      {
        method: "post",
        contentType: "multipart/related; boundary=" + boundary,
        payload: Utilities.newBlob(payload).getBytes(),
        headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true,
      },
    );

    if (resp.getResponseCode() !== 200) {
      throw new Error("Drive API " + resp.getResponseCode() + ": " + resp.getContentText());
    }

    var file = JSON.parse(resp.getContentText());
    var url = "https://docs.google.com/document/d/" + file.id + "/edit";

    return ContentService.createTextOutput(
      JSON.stringify({ url: url }),
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    Logger.log("doPost error: " + error.toString());
    return ContentService.createTextOutput(
      JSON.stringify({ error: error.toString() }),
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

/* Ссылка на DriveApp нужна, чтобы OAuth запросил scope drive.file */
function _ensureDriveScope() { DriveApp.getRootFolder(); }
