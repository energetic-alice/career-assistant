/**
 * Google Apps Script — установить в таблице, связанной с Google Form.
 *
 * Инструкция:
 * 1. Открыть Google Sheets → Расширения → Apps Script
 * 2. Вставить этот код
 * 3. Заменить WEBHOOK_URL и WEBHOOK_SECRET на реальные значения
 * 4. Настроить триггер: Triggers → Add Trigger →
 *    - Function: onFormSubmit
 *    - Event source: From spreadsheet
 *    - Event type: On form submit
 */

const WEBHOOK_URL = "https://YOUR-SERVER.com/api/webhook/new-participant";
const WEBHOOK_SECRET = "your-webhook-secret-here";

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
