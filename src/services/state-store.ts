import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || (process.env.RENDER ? "/var/data" : path.join(process.cwd(), "data"));
const DOCS_DIR = path.join(DATA_DIR, "documents");

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureDocsDir(): void {
  if (!fs.existsSync(DOCS_DIR)) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
  }
}

function filePath(name: string): string {
  return path.join(DATA_DIR, `${name}.json`);
}

export function saveDocument(participantId: string, filename: string, content: string): string {
  ensureDocsDir();
  const participantDir = path.join(DOCS_DIR, participantId);
  if (!fs.existsSync(participantDir)) {
    fs.mkdirSync(participantDir, { recursive: true });
  }
  const fp = path.join(participantDir, filename);
  fs.writeFileSync(fp, content, "utf-8");
  console.log(`[StateStore] Saved document: ${fp}`);
  return fp;
}

export function loadDocument(
  participantId: string,
  filename: string,
): { content: string; mtime: Date } | null {
  const fp = path.join(DOCS_DIR, participantId, filename);
  if (!fs.existsSync(fp)) return null;
  try {
    const content = fs.readFileSync(fp, "utf-8");
    const { mtime } = fs.statSync(fp);
    return { content, mtime };
  } catch (err) {
    console.warn(`[StateStore] loadDocument failed for ${fp}:`, err);
    return null;
  }
}

export function saveMap<V>(name: string, map: Map<string, V>): void {
  try {
    ensureDir();
    const entries = Object.fromEntries(map);
    fs.writeFileSync(filePath(name), JSON.stringify(entries, null, 2), "utf-8");
  } catch (err) {
    console.error(`[StateStore] Failed to save ${name}:`, err);
  }
}

export function loadMap<V>(name: string): Map<string, V> {
  try {
    const fp = filePath(name);
    if (!fs.existsSync(fp)) return new Map();
    const raw = fs.readFileSync(fp, "utf-8");
    const obj = JSON.parse(raw) as Record<string, V>;
    return new Map(Object.entries(obj));
  } catch (err) {
    console.error(`[StateStore] Failed to load ${name}:`, err);
    return new Map();
  }
}
