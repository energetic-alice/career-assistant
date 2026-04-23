import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  downloadFromGoogleDrive,
  extractResumeText,
} from "../services/file-service.js";

/**
 * Изолированная диагностика: скачать и распарсить резюме Alisa
 * (или любого клиента из payload-файла) без Telegram/Phase0.
 *
 * Usage: npx tsx src/scripts/probe-alice-resume.ts [payloadFile]
 *        default payloadFile = ./data/alice-payload.json
 */

async function main() {
  const payloadPath = process.argv[2] ?? "./data/alice-payload.json";
  const raw = await readFile(resolve(payloadPath), "utf-8");
  const body = JSON.parse(raw) as { namedValues?: Record<string, string[]> };
  const nv = body.namedValues ?? {};

  const pick = (keys: string[]): string | undefined => {
    for (const k of Object.keys(nv)) {
      if (keys.some((q) => k.toLowerCase().includes(q.toLowerCase()))) {
        const v = nv[k];
        if (Array.isArray(v) && v[0]) return v[0];
        if (typeof v === "string") return v;
      }
    }
    return undefined;
  };

  const resumeUrl =
    pick(["Прикрепи свое резюме", "resume"])?.trim() ||
    pick(["Прикрепи свое резюме 2", "resume 2"])?.trim();
  const resumeUrl2 = nv["Прикрепи свое резюме в любом формате (можно несколько версий) 2"]?.[0];
  const url = resumeUrl2?.trim() || resumeUrl?.trim();

  console.log("Resume URL:", url || "(none)");
  if (!url) {
    console.log("No resume URL in payload");
    return;
  }

  try {
    console.log("Downloading from Google Drive...");
    const { buffer, mimeType } = await downloadFromGoogleDrive(url);
    console.log(`Downloaded ${buffer.length} bytes, mimeType=${mimeType}`);

    console.log("Extracting text...");
    const text = await extractResumeText(buffer, mimeType);
    console.log(`\n=== RESUME TEXT (${text.length} chars) ===\n`);
    console.log(text);
    console.log("\n=== END ===\n");

    // Поиск стеков
    const stacks = [
      "C#",
      ".NET",
      "dotnet",
      "Java",
      "Kotlin",
      "Swift",
      "JavaScript",
      "TypeScript",
      "JS/TS",
      "Python",
      "Go",
      "Golang",
      "Ruby",
      "PHP",
      "Rust",
      "C++",
      "React",
      "Vue",
      "Angular",
      "Node",
    ];
    const found = stacks.filter((s) =>
      new RegExp(`(^|[^a-zA-Z])${s.replace(/[+#.]/g, "\\$&")}([^a-zA-Z]|$)`, "i").test(text),
    );
    console.log(`Detected stack keywords: ${found.join(", ") || "(none)"}`);
  } catch (err) {
    console.error("FAILED:", err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) console.error(err.stack);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
