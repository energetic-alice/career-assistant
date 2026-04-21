import XLSX from "xlsx";
import path from "node:path";

const files = [
  "/Users/alisatsvetkova/_projects/career-assistant/Анкета новая.xlsx",
  "/Users/alisatsvetkova/_projects/career-assistant/Анкета старая.xlsx",
];

for (const file of files) {
  console.log(`\n=== ${path.basename(file)} ===`);
  const wb = XLSX.readFile(file);
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    if (rows.length === 0) continue;
    const nickKey = Object.keys(rows[0]).find((k) => /телеграм|telegram|ник/i.test(k));
    console.log(`  sheet: "${sheetName}" rows=${rows.length} nickCol="${nickKey}"`);
    if (!nickKey) continue;
    for (let i = 0; i < rows.length; i++) {
      const v = String(rows[i][nickKey] ?? "");
      if (/alice/i.test(v) || /энерджет/i.test(v) || /energetic/i.test(v)) {
        console.log(`  → row ${i}: nick="${v}"`);
      }
    }
  }
}
