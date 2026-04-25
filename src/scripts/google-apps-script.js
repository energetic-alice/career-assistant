/**
 * Google Apps Script — установить в Google Form ИЛИ в таблице, связанной с Form.
 *
 * Три функции:
 * 1. onFormSubmit(e) — trigger: отправляет анкету на сервер через webhook.
 *    Работает и с Form trigger (`e.response`), и со Sheet trigger (`e.namedValues`).
 * 2. resendAllFromForm() — вручную переотправляет ВСЕ ответы из самой формы,
 *    обходя Google Sheets. Это rescue-путь, если Forms показывает 16 ответов,
 *    а связанная таблица получила только часть.
 * 3. doPost(e) — web app: создаёт Google Doc из HTML (вызывается сервером).
 *
 * Рекомендуемая настройка intake:
 * 1. Открыть Google Form → Extensions / Расширения → Apps Script
 * 2. Вставить этот код
 * 3. Заменить WEBHOOK_URL и WEBHOOK_SECRET на реальные значения.
 *    Если скрипт не bound к форме, заполнить FORM_ID.
 * 4. Настроить trigger:
 *    Triggers → Add Trigger → onFormSubmit → From form → On form submit
 *
 * Если скрипт уже живёт в Google Sheets, он тоже работает:
 *    Triggers → Add Trigger → onFormSubmit → From spreadsheet → On form submit
 *
 * Настройка создания Google Doc:
 * 5. Deploy как web app для doPost:
 *    Deploy → New deployment → Web app →
 *    Execute as: Me → Who has access: Anyone → Deploy
 *    Скопировать URL и добавить в Render как APPS_SCRIPT_DOC_URL
 */

const WEBHOOK_URL = "https://YOUR-SERVER.com/api/webhook/new-participant";
const WEBHOOK_SECRET = "your-webhook-secret-here";
// Optional: нужен только если скрипт НЕ привязан напрямую к Google Form.
const FORM_ID = "";

/* ── Триггер: отправка анкеты на сервер ── */

function onFormSubmit(e) {
  try {
    const namedValues = namedValuesFromEvent(e);
    sendNamedValuesToWebhook(namedValues, "onFormSubmit");
  } catch (error) {
    Logger.log("Webhook exception: " + error.toString());
  }
}

function namedValuesFromEvent(e) {
  if (e && e.namedValues) {
    return e.namedValues; // Spreadsheet trigger.
  }
  if (e && e.response) {
    return namedValuesFromFormResponse(e.response); // Form trigger.
  }
  throw new Error("Unsupported onFormSubmit event: no namedValues or response");
}

function namedValuesFromFormResponse(response) {
  const namedValues = {};
  const submittedAt = response.getTimestamp();
  namedValues.Timestamp = [
    Utilities.formatDate(
      submittedAt,
      Session.getScriptTimeZone(),
      "yyyy/MM/dd h:mm:ss a z",
    ),
  ];

  response.getItemResponses().forEach(function(itemResponse) {
    const title = itemResponse.getItem().getTitle();
    namedValues[title] = [formatFormResponseValue(itemResponse.getResponse())];
  });

  return namedValues;
}

function formatFormResponseValue(value) {
  if (Array.isArray(value)) {
    return value.map(formatSingleFormValue).join(", ");
  }
  return formatSingleFormValue(value);
}

function formatSingleFormValue(value) {
  if (value == null) return "";

  // File upload responses from form-bound triggers are usually Drive file IDs.
  // The backend expects a Drive URL, so convert IDs into open?id URLs.
  const s = String(value);
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s) && s.indexOf("http") !== 0) {
    return "https://drive.google.com/open?id=" + s;
  }
  return s;
}

function sendNamedValuesToWebhook(namedValues, source) {
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
  const body = response.getContentText();

  if (code !== 200) {
    Logger.log(source + " webhook error: " + code + " — " + body);
  } else {
    Logger.log(source + " webhook success: " + body);
  }
  return response;
}

function getTargetForm() {
  if (FORM_ID) return FormApp.openById(FORM_ID);
  const form = FormApp.getActiveForm();
  if (!form) {
    throw new Error("No active form. Set FORM_ID or run this from a form-bound script.");
  }
  return form;
}

/**
 * Rescue/backfill: переотправить ВСЕ ответы прямо из Google Form.
 * Использовать, когда во вкладке Responses видно 16 ответов, но linked Sheet
 * получил меньше строк. Сервер дедуплицирует по telegramNick.
 */
function resendAllFromForm() {
  const form = getTargetForm();
  const responses = form.getResponses();
  Logger.log("Form responses: " + responses.length);

  responses.forEach(function(response, index) {
    const namedValues = namedValuesFromFormResponse(response);
    const nick = namedValues["Твой ник в телеграм"]
      ? namedValues["Твой ник в телеграм"][0]
      : "response " + (index + 1);
    Logger.log("Sending response " + (index + 1) + ": " + nick);

    try {
      const webhookResponse = sendNamedValuesToWebhook(
        namedValues,
        "resendAllFromForm row " + (index + 1),
      );
      Logger.log(
        "Response " + (index + 1) + " (" + nick + "): " +
          webhookResponse.getResponseCode() + " " +
          webhookResponse.getContentText().substring(0, 200),
      );
    } catch (err) {
      Logger.log("Response " + (index + 1) + " ERROR: " + err.toString());
    }

    if (index < responses.length - 1) {
      Utilities.sleep(2000);
    }
  });

  Logger.log("Done. Sent " + responses.length + " form responses.");
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

/* ── Переотправка всех строк из таблицы (legacy rescue path) ── */

/**
 * Переотправить все заполненные строки из таблицы на сервер.
 * Запускать вручную из Apps Script (Run → resendAll).
 * Безопасно запускать повторно — сервер дедуплицирует по telegramNick.
 */
function resendAll() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var data = sheet.getDataRange().getValues();
  var headers = data[0];

  Logger.log("Headers: " + JSON.stringify(headers));
  Logger.log("Total rows (excl header): " + (data.length - 1));

  for (var i = 1; i < data.length; i++) {
    var namedValues = {};
    for (var j = 0; j < headers.length; j++) {
      var val = data[i][j];
      if (val instanceof Date) {
        val = Utilities.formatDate(val, Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm:ss");
      }
      namedValues[headers[j]] = [String(val)];
    }

    var nick = namedValues["Твой ник в телеграм"] ? namedValues["Твой ник в телеграм"][0] : "row " + i;
    Logger.log("Sending row " + i + ": " + nick);

    try {
      var response = sendNamedValuesToWebhook(namedValues, "resendAll row " + i);
      Logger.log("Row " + i + " (" + nick + "): " + response.getResponseCode() + " " + response.getContentText().substring(0, 200));
    } catch (err) {
      Logger.log("Row " + i + " ERROR: " + err.toString());
    }

    if (i < data.length - 1) {
      Utilities.sleep(2000);
    }
  }

  Logger.log("Done. Sent " + (data.length - 1) + " rows.");
}

/* Ссылка на DriveApp нужна, чтобы OAuth запросил scope drive.file */
function _ensureDriveScope() { DriveApp.getRootFolder(); }
