/**
 * Google Apps Script — установить в Google Form ИЛИ в таблице, связанной с Form.
 *
 * Функции:
 * 1. onFormSubmit(e) — trigger: отправляет анкету на сервер через webhook.
 *    Работает и с Form trigger (`e.response`), и со Sheet trigger (`e.namedValues`).
 * 2. resendAllFromForm() — вручную переотправляет ВСЕ ответы из самой формы,
 *    обходя Google Sheets. Это rescue-путь, если Forms показывает 16 ответов,
 *    а связанная таблица получила только часть.
 * 3. doPost(e) — web app: роутер по data.action.
 *      action = "create_from_html" (default) — создаёт Google Doc из HTML.
 *      action = "fill_template" — копирует Resume Template и заполняет
 *        плейсхолдеры/блоки (используется генератором идеального резюме).
 * 4. createIdealResumeTemplate() — однократно создаёт пустой Doc
 *    с плейсхолдерами {{full_name}}, {{summary}}, {{skills_block}} и т.д.
 *    После выполнения смотри Logs → копируй ID в IDEAL_RESUME_TEMPLATE_DOC_ID.
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
 *
 * Подготовка к идеальному резюме (один раз):
 * 6. Run → createIdealResumeTemplate → дай разрешения → смотри Logs.
 * 7. Скопированный ID положи в Render env как IDEAL_RESUME_TEMPLATE_DOC_ID.
 *    После этого endpoint action=fill_template начинает работать.
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

/* ── Self-heal: установка/восстановление onFormSubmit-триггера ── */
/*
 * Google периодически тихо отключает installable triggers (после серии ошибок
 * подряд, после смены OAuth-сессии, при копировании проекта и т.д.). Без
 * триггера новые ответы формы НЕ долетают до webhook'а — sheet растёт, а наш
 * бот молчит. Эти три функции лечат проблему:
 *
 *   1. installFormTrigger() — нажми вручную один раз. Сносит ВСЕ существующие
 *      триггеры на onFormSubmit и ставит ровно один правильный (spreadsheet
 *      → on form submit). Идемпотентно: можно дёргать сколько угодно раз.
 *   2. ensureFormTrigger() — то же, но НЕ пересоздаёт, если триггер уже жив.
 *      Ничего не делает в норме, лечит только если триггер пропал.
 *   3. installAutoHeal() — запусти один раз. Поставит time-based триггер
 *      раз в час, который вызывает ensureFormTrigger(). Дальше система
 *      сама себя чинит, даже если onFormSubmit отвалится.
 */

function installFormTrigger() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error("Run this from the spreadsheet-bound Apps Script project.");
  }

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "onFormSubmit") {
      ScriptApp.deleteTrigger(t);
      Logger.log("Deleted stale onFormSubmit trigger: " + t.getUniqueId());
    }
  });

  const trigger = ScriptApp.newTrigger("onFormSubmit")
    .forSpreadsheet(ss)
    .onFormSubmit()
    .create();

  Logger.log("Installed onFormSubmit trigger: " + trigger.getUniqueId());
  return trigger.getUniqueId();
}

function ensureFormTrigger() {
  const alive = ScriptApp.getProjectTriggers().some(function (t) {
    return (
      t.getHandlerFunction() === "onFormSubmit" &&
      t.getEventType() === ScriptApp.EventType.ON_FORM_SUBMIT
    );
  });

  if (alive) {
    Logger.log("ensureFormTrigger: trigger is alive, nothing to do");
    return;
  }

  Logger.log("ensureFormTrigger: trigger missing, reinstalling...");
  installFormTrigger();
}

function installAutoHeal() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "ensureFormTrigger") {
      ScriptApp.deleteTrigger(t);
    }
  });

  const heal = ScriptApp.newTrigger("ensureFormTrigger")
    .timeBased()
    .everyHours(1)
    .create();

  Logger.log("Installed hourly self-heal trigger: " + heal.getUniqueId());
  return heal.getUniqueId();
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
      return jsonResponse({ error: "unauthorized" });
    }

    switch (data.action) {
      case "fill_template":
        return jsonResponse(handleFillTemplate(data));
      case "create_from_html":
      default:
        return jsonResponse(handleCreateFromHtml(data));
    }
  } catch (error) {
    Logger.log("doPost error: " + error.toString());
    return jsonResponse({ error: error.toString() });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleCreateFromHtml(data) {
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
  return { url: "https://docs.google.com/document/d/" + file.id + "/edit", id: file.id };
}

/* ── Идеальное резюме: создание шаблона с плейсхолдерами ── */

/**
 * Создаёт пустой Google Doc с плейсхолдерами и стилями для идеального резюме.
 * Запустить ОДИН РАЗ из Apps Script UI:
 *   Run → createIdealResumeTemplate
 * После выполнения смотри Logs — там URL и ID созданного дока.
 * ID добавь в Render env как IDEAL_RESUME_TEMPLATE_DOC_ID.
 *
 * Дальше шаблон копируется при каждой генерации (action=fill_template).
 */
function createIdealResumeTemplate() {
  var doc = DocumentApp.create("Resume Template — Ideal Resume v1");
  var body = doc.getBody();
  body.clear();

  // Header — name (large bold), title (italic), contact line (small grey)
  var nameP = body.appendParagraph("{{full_name}}");
  nameP.setHeading(DocumentApp.ParagraphHeading.HEADING_1);
  nameP.editAsText().setBold(true).setFontSize(20);

  var titleP = body.appendParagraph("{{title}}");
  titleP.editAsText().setItalic(true).setFontSize(13);

  var contactP = body.appendParagraph("{{contact_line}}");
  contactP.editAsText().setFontSize(10).setForegroundColor("#666666");

  body.appendParagraph("{{summary}}").editAsText().setFontSize(11);

  appendSectionHeading(body, "Skills");
  body.appendParagraph("{{skills_block}}");

  appendSectionHeading(body, "Experience");
  body.appendParagraph("{{experience_block}}");

  appendSectionHeading(body, "Certifications");
  body.appendParagraph("{{certifications_block}}");

  appendSectionHeading(body, "Education");
  body.appendParagraph("{{education_block}}");

  appendSectionHeading(body, "Languages");
  body.appendParagraph("{{languages_block}}");

  // Make link-shareable
  var file = DriveApp.getFileById(doc.getId());
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    Logger.log("setSharing skipped: " + err);
  }

  Logger.log("=== Resume template created ===");
  Logger.log("URL:   " + doc.getUrl());
  Logger.log("ID:    " + doc.getId());
  Logger.log("Add to Render env as IDEAL_RESUME_TEMPLATE_DOC_ID");
  Logger.log("================================");
  return doc.getId();
}

function appendSectionHeading(body, label) {
  var p = body.appendParagraph(label);
  p.setHeading(DocumentApp.ParagraphHeading.HEADING_2);
  p.editAsText().setBold(true).setFontSize(14);
}

/* ── Идеальное резюме: заполнение шаблона ── */

/**
 * Запрос:
 *   {
 *     "action": "fill_template",
 *     "secret": "...",
 *     "templateId": "1ABC...",       // IDEAL_RESUME_TEMPLATE_DOC_ID
 *     "title":      "Resume — alice — DevOps",
 *     "folderId":   "...",            // optional, иначе My Drive
 *     "simple": {                     // simple {{key}} → string
 *       "full_name":    "...",
 *       "title":        "...",
 *       "contact_line": "...",
 *       "summary":      "..."
 *     },
 *     "blocks": {                     // {{key}} → array of styled paragraphs
 *       "skills_block":         [{ "text": "...", "style": "skill_line" }],
 *       "experience_block":     [{ "text": "...", "style": "company_header" }, ...],
 *       "certifications_block": [{ "text": "...", "style": "plain" }],
 *       "education_block":      [{ "text": "...", "style": "plain" }],
 *       "languages_block":      [{ "text": "...", "style": "plain" }]
 *     }
 *   }
 *
 * Поддерживаемые style:
 *   plain               — обычный параграф
 *   skill_line          — обычный параграф (Category: items)
 *   company_header      — bold, отступ сверху
 *   job_title           — italic
 *   project_line        — italic
 *   bullet              — маркер списка
 *   technologies        — мелкий серый текст
 *   spacer              — пустая строка
 */
function handleFillTemplate(data) {
  if (!data.templateId) throw new Error("templateId is required");

  var template = DriveApp.getFileById(data.templateId);
  var copyName = data.title || (template.getName() + " — copy");
  var copy = template.makeCopy(copyName);
  if (data.folderId) {
    try {
      var folder = DriveApp.getFolderById(data.folderId);
      folder.addFile(copy);
      DriveApp.getRootFolder().removeFile(copy);
    } catch (err) {
      Logger.log("folder move failed: " + err);
    }
  }

  var doc = DocumentApp.openById(copy.getId());
  var body = doc.getBody();

  var simple = data.simple || {};
  Object.keys(simple).forEach(function (key) {
    var pattern = "\\{\\{" + escapeForRegex(key) + "\\}\\}";
    body.replaceText(pattern, String(simple[key] == null ? "" : simple[key]));
  });

  var blocks = data.blocks || {};
  Object.keys(blocks).forEach(function (key) {
    insertBlockAtPlaceholder(body, "{{" + key + "}}", blocks[key] || []);
  });

  doc.saveAndClose();

  try {
    copy.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.EDIT);
  } catch (err) {
    Logger.log("setSharing skipped: " + err);
  }

  return {
    url: "https://docs.google.com/document/d/" + copy.getId() + "/edit",
    id: copy.getId(),
  };
}

function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function insertBlockAtPlaceholder(body, placeholder, paragraphs) {
  var found = body.findText(escapeForRegex(placeholder));
  if (!found) {
    Logger.log("placeholder not found: " + placeholder);
    return;
  }
  var elem = found.getElement();
  var paragraph = elem.getParent();
  while (paragraph && paragraph.getType() !== DocumentApp.ElementType.PARAGRAPH) {
    paragraph = paragraph.getParent();
  }
  if (!paragraph) {
    Logger.log("no paragraph for placeholder: " + placeholder);
    return;
  }
  var idx = body.getChildIndex(paragraph);
  body.removeChild(paragraph);

  for (var i = 0; i < paragraphs.length; i++) {
    var item = paragraphs[i] || {};
    var text = item.text == null ? "" : String(item.text);
    var style = item.style || "plain";
    if (style === "spacer" && !text) {
      body.insertParagraph(idx + i, "");
      continue;
    }
    if (style === "bullet") {
      var li = body.insertListItem(idx + i, text);
      li.setGlyphType(DocumentApp.GlyphType.BULLET);
      li.editAsText().setFontSize(11);
      continue;
    }
    var p = body.insertParagraph(idx + i, text);
    applyStyleToParagraph(p, style);
  }
}

function applyStyleToParagraph(p, style) {
  switch (style) {
    case "company_header":
      p.editAsText().setBold(true).setFontSize(11);
      p.setSpacingBefore(8);
      break;
    case "job_title":
      p.editAsText().setItalic(true).setFontSize(11);
      break;
    case "project_line":
      p.editAsText().setItalic(true).setFontSize(11);
      break;
    case "technologies":
      p.editAsText().setFontSize(10).setForegroundColor("#666666");
      break;
    case "skill_line":
    case "plain":
    default:
      p.editAsText().setFontSize(11);
      break;
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
