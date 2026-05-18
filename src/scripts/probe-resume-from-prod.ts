import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import {
  buildResumePackInputs,
  ResumePackInputError,
  type BuildResumePackInputsArgs,
  type ResumePackInput,
} from "../services/resume-pack/build-inputs.js";
import { runResumePack } from "../services/resume-pack/run-pack.js";
import { renderResumePack } from "../services/resume-pack/renderer.js";
import {
  fetchResumeFromGoogleDoc,
  GoogleDocFetchError,
} from "../services/resume-pack/google-doc-fetcher.js";
import { isGoogleDriveUrl } from "../services/file-service.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import type { ResumeVersion } from "../pipeline/intake.js";

/**
 * Запуск Resume Pack pipeline (Phase 1 — audit). Два режима:
 *
 * 1. **Из прода по нику клиента** — дёргает `/api/participants` на проде,
 *    берёт actual stageOutputs (clientSummary + resumeVersions) и гонит
 *    через `runResumePack`. Использует production-кеш LinkedIn для
 *    cross-check.
 *
 *      npx tsx src/scripts/probe-resume-from-prod.ts @olenka_kravchenko
 *
 * 2. **По прямой ссылке на Google Doc / Google Drive** — скачивает резюме
 *    через публичный export (для open-share ссылок) или через Drive API
 *    (service account), извлекает текст (`extractResumeText` —
 *    Claude vision для PDF, mammoth для DOCX) и прогоняет аудит **без**
 *    clientSummary (внешний человек, анкеты нет). Не использует LinkedIn.
 *
 *      npx tsx src/scripts/probe-resume-from-prod.ts \
 *        'https://docs.google.com/document/d/1isK4ynTgpX8sz5dTT8M8W6x1X5xUO_Ff/edit?usp=sharing'
 *
 * В обоих случаях результат сохраняется в:
 *   - Markdown: `./probe-output/resume-pack-prod-<id>.md`
 *   - JSON:     `./probe-output/resume-pack-prod-<id>.json`
 *
 * Где `<id>` = nick (для режима 1) или `external-<docFileId-8chars>` (для режима 2).
 */

const PROD_URL =
  process.env.PROD_URL ?? "https://career-assistant-w7z3.onrender.com";

interface PipelineStateFromProd {
  participantId: string;
  telegramNick: string;
  stage: string;
  stageOutputs?: {
    clientSummary?: ClientSummary;
    resumeVersions?: ResumeVersion[];
    activeResumeVersionId?: string | null;
  };
}

async function fetchProdState(
  nick: string,
): Promise<PipelineStateFromProd | null> {
  const res = await fetch(`${PROD_URL}/api/participants`);
  if (!res.ok) throw new Error(`GET /api/participants → ${res.status}`);
  const all = (await res.json()) as PipelineStateFromProd[];
  const norm = nick.replace(/^@/, "").toLowerCase();
  return (
    all.find(
      (s) =>
        (s.telegramNick ?? "").replace(/^@/, "").toLowerCase() === norm,
    ) ?? null
  );
}

/**
 * Сборка `ResumePackInput` из URL Google Doc (внешний человек, анкеты нет).
 * LinkedIn cross-check недоступен — у нас нет ни URL, ни LinkedIn кеша.
 */
async function buildInputFromGoogleDoc(url: string): Promise<{
  input: ResumePackInput;
  fileId: string;
}> {
  console.log(`[probe-resume-prod] → fetchResumeFromGoogleDoc()`);
  const fetched = await fetchResumeFromGoogleDoc(url);
  console.log(
    `[probe-resume-prod] downloaded via ${fetched.source}, mime=${fetched.mimeType}, text=${fetched.text.length} chars (file ${fetched.fileId})`,
  );

  const shortId = fetched.fileId.slice(0, 8);
  const input: ResumePackInput = {
    participantId: `external-${shortId}`,
    nick: `external-${shortId}`,
    clientSummary: null,
    resume: {
      text: fetched.text,
      versionId: null,
    },
    linkedin: null,
    linkedinUrl: null,
  };
  return { input, fileId: fetched.fileId };
}

async function buildInputFromProdNick(nick: string): Promise<{
  input: ResumePackInput;
  nick: string;
}> {
  console.log(`[probe-resume-prod] fetching state from ${PROD_URL}…`);
  const state = await fetchProdState(nick);
  if (!state) {
    throw new Error(`Client @${nick} not found on prod`);
  }

  const outputs = state.stageOutputs ?? {};
  const clientSummary = outputs.clientSummary ?? null;
  const resumeVersions = Array.isArray(outputs.resumeVersions)
    ? outputs.resumeVersions
    : [];

  console.log(
    `[probe-resume-prod] client: @${state.telegramNick}  pid=${state.participantId}  stage=${state.stage}`,
  );
  console.log(
    `[probe-resume-prod] clientSummary: ${
      clientSummary ? "present" : "—"
    }  resumeVersions: ${resumeVersions.length}  activeResumeId: ${
      outputs.activeResumeVersionId ?? "—"
    }`,
  );

  const args: BuildResumePackInputsArgs = {
    participantId: state.participantId,
    nick: state.telegramNick,
    clientSummary,
    resumeVersions,
    activeResumeVersionId: outputs.activeResumeVersionId ?? null,
  };

  const input = await buildResumePackInputs(args);
  return { input, nick: state.telegramNick };
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      "Usage:\n" +
        "  npx tsx src/scripts/probe-resume-from-prod.ts <@nick>\n" +
        "  npx tsx src/scripts/probe-resume-from-prod.ts <google-doc-url>\n\n" +
        "Examples:\n" +
        "  npx tsx src/scripts/probe-resume-from-prod.ts @olenka_kravchenko\n" +
        "  npx tsx src/scripts/probe-resume-from-prod.ts 'https://docs.google.com/document/d/<ID>/edit?usp=sharing'",
    );
    process.exit(1);
  }

  const isUrl = isGoogleDriveUrl(arg);

  const t0 = Date.now();
  let input: ResumePackInput;
  let outputSlug: string;

  try {
    if (isUrl) {
      const built = await buildInputFromGoogleDoc(arg);
      input = built.input;
      outputSlug = `external-${built.fileId.slice(0, 8)}`;
    } else {
      const built = await buildInputFromProdNick(arg);
      input = built.input;
      outputSlug = built.nick.replace(/^@/, "");
    }
  } catch (err) {
    if (
      err instanceof ResumePackInputError ||
      err instanceof GoogleDocFetchError
    ) {
      console.error(`[probe-resume-prod] input error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  console.log(
    `\n[probe-resume-prod] inputs ready · resume=${input.resume.text.length} chars · linkedin=${
      input.linkedin
        ? `${input.linkedin.source} (${input.linkedin.text.length} chars)`
        : "—"
    }`,
  );

  console.log(`\n[probe-resume-prod] → runResumePack()`);
  const result = await runResumePack(input);
  const ms = Date.now() - t0;
  console.log(
    `\n[probe-resume-prod] pack generated in ${(ms / 1000).toFixed(1)}s ` +
      `(audit=${(result.timings.auditMs / 1000).toFixed(1)}s)`,
  );

  const a = result.data.audit;
  console.log(
    `[probe-resume-prod] audit: ${a.passCount} pass · ${a.failCount} fail · ${a.unknownCount} unknown / ${a.totalCount} items  ` +
      `targetMarket=${result.data.meta.targetMarket ?? "—"}`,
  );

  const md = renderResumePack(result.data);

  const outDir = path.join(process.cwd(), "probe-output");
  fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, `resume-pack-prod-${outputSlug}.md`);
  const jsonPath = path.join(outDir, `resume-pack-prod-${outputSlug}.json`);
  fs.writeFileSync(mdPath, md, "utf-8");
  fs.writeFileSync(jsonPath, JSON.stringify(result.data, null, 2), "utf-8");
  console.log(`\n[probe-resume-prod] saved:\n  ${mdPath}\n  ${jsonPath}`);

  console.log(`\n=== MARKDOWN PREVIEW (first 80 lines) ===\n`);
  console.log(md.split("\n").slice(0, 80).join("\n"));
  console.log(`\n=== (truncated) ===`);
}

main().catch((err) => {
  console.error("[probe-resume-prod] fatal:", err);
  process.exit(1);
});
