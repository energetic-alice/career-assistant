import XLSX from "xlsx";
import { writeFileSync } from "node:fs";

const file = "/Users/alisatsvetkova/_projects/career-assistant/Анкета новая.xlsx";
const wb = XLSX.readFile(file);
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
const headers = Object.keys(rows[0]);

const targetNick = "energetic_alice";
const row = rows.find((r) => String(r["Твой ник в телеграм"] ?? "").toLowerCase().includes(targetNick));
if (!row) throw new Error(`Не нашёл @${targetNick}`);

const namedValues: Record<string, string[]> = {};
for (const h of headers) {
  // Google Forms webhook отдаёт значения в виде массивов строк
  namedValues[h] = [String(row[h] ?? "")];
}
// Гарантируем что ник содержит '@' как у Маргариты
const nickH = "Твой ник в телеграм";
const nickVal = namedValues[nickH][0].trim();
namedValues[nickH] = [nickVal.startsWith("@") ? nickVal : `@${nickVal}`];

const payload = { namedValues };
const out = "/Users/alisatsvetkova/_projects/career-assistant/app/data/alice-payload.json";
writeFileSync(out, JSON.stringify(payload, null, 2), "utf-8");
console.log(`Saved payload → ${out}`);
console.log(`Headers: ${headers.length}`);
console.log(`Nick: ${namedValues[nickH][0]}`);
