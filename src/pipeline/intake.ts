import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  rawQuestionnaireSchema,
  toAnalysisInput,
  type AnalysisInput,
} from "../schemas/participant.js";
import type { PipelineState } from "../schemas/pipeline-state.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import {
  downloadFromGoogleDrive,
  extractResumeText,
} from "../services/file-service.js";
import {
  runClientSummary,
  type AnalysisPipelineInput,
} from "./run-analysis.js";
import type { Direction } from "../schemas/analysis-outputs.js";
import { getBot } from "../bot/bot-instance.js";
import { saveMap, loadMap } from "../services/state-store.js";
import { normalizeNick, parseNamedValues } from "../services/intake-mapper.js";
import { KNOWN_ROLES } from "../services/known-roles.js";

export { parseNamedValues };

const STORE_NAME = "pipelineStates";
export const pipelineStates: Map<string, PipelineState> = loadMap<PipelineState>(STORE_NAME);

export interface ResumeVersion {
  id: string;
  createdAt: string;
  source: "telegram_document" | "telegram_text" | "google_drive_url";
  sourceFileName?: string;
  mimeType?: string;
  textLength: number;
  text: string;
}

export interface SaveResumeVersionInput {
  participantId: string;
  text: string;
  source: ResumeVersion["source"];
  sourceFileName?: string;
  mimeType?: string;
}

export interface SelectedTargetRole {
  id: string;
  selectedAt: string;
  source: "shortlist" | "deep" | "resume";
  roleSlug: string;
  title: string;
  bucket: Direction["bucket"];
  offIndex?: boolean;
  marketEvidence?: string;
  direction?: unknown;
}

type ClientSummaryWithTargets = ClientSummary;
const KNOWN_ROLE_SET = new Set<string>(KNOWN_ROLES);

console.log(`[Intake] Loaded ${pipelineStates.size} pipeline states from disk`);

function persistPipelineStates(): void {
  saveMap(STORE_NAME, pipelineStates);
}

export function getPipelineState(id: string): PipelineState | undefined {
  return pipelineStates.get(id);
}

export function getAllPipelineStates(): PipelineState[] {
  return Array.from(pipelineStates.values());
}

export function updatePipelineStage(
  id: string,
  stage: PipelineState["stage"],
  extraOutputs?: Record<string, unknown>,
): void {
  const state = pipelineStates.get(id);
  if (!state) return;
  state.stage = stage;
  state.updatedAt = new Date().toISOString();
  if (extraOutputs) {
    const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
    Object.assign(outputs, extraOutputs);
    state.stageOutputs = outputs;
  }
  persistPipelineStates();
}

export function saveResumeVersion(input: SaveResumeVersionInput): ResumeVersion | null {
  const state = pipelineStates.get(input.participantId);
  if (!state) return null;

  const text = input.text.trim();
  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const analysisInput = outputs.analysisInput as AnalysisInput | undefined;
  const pipelineInput = outputs.pipelineInput as AnalysisPipelineInput | undefined;
  const previousVersions = Array.isArray(outputs.resumeVersions)
    ? (outputs.resumeVersions as ResumeVersion[])
    : [];

  const version: ResumeVersion = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    source: input.source,
    ...(input.sourceFileName ? { sourceFileName: input.sourceFileName } : {}),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    textLength: text.length,
    text,
  };

  outputs.resumeVersions = [...previousVersions, version];
  outputs.activeResumeVersionId = version.id;

  if (analysisInput) {
    (analysisInput as Record<string, unknown>).resumeText = text;
  }
  if (pipelineInput) {
    pipelineInput.resumeText = text;
  }

  state.stageOutputs = outputs;
  state.updatedAt = version.createdAt;
  persistPipelineStates();

  return version;
}

function selectedTargetId(direction: Pick<Direction, "roleSlug" | "bucket">): string {
  return `${direction.roleSlug}|${direction.bucket}`;
}

export function isSelectedTargetRole(
  participantId: string,
  direction: Pick<Direction, "roleSlug" | "bucket">,
): boolean {
  const state = pipelineStates.get(participantId);
  const outputs = (state?.stageOutputs ?? {}) as Record<string, unknown>;
  const clientSummary = outputs.clientSummary as ClientSummaryWithTargets | undefined;
  const selected = Array.isArray(clientSummary?.selectedTargetRoles)
    ? clientSummary.selectedTargetRoles
    : Array.isArray(outputs.selectedTargetRoles)
      ? (outputs.selectedTargetRoles as SelectedTargetRole[])
    : [];
  return selected.some((r) => r.id === selectedTargetId(direction));
}

export function toggleSelectedTargetRole(
  participantId: string,
  direction: Direction,
  source: SelectedTargetRole["source"],
): { selected: boolean; roles: SelectedTargetRole[] } | null {
  const state = pipelineStates.get(participantId);
  if (!state) return null;

  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const clientSummary = outputs.clientSummary as ClientSummaryWithTargets | undefined;
  const previous = Array.isArray(clientSummary?.selectedTargetRoles)
    ? clientSummary.selectedTargetRoles
    : Array.isArray(outputs.selectedTargetRoles)
      ? (outputs.selectedTargetRoles as SelectedTargetRole[])
    : [];
  const id = selectedTargetId(direction);
  const exists = previous.some((r) => r.id === id);
  const known = KNOWN_ROLE_SET.has(direction.roleSlug);
  if (!exists && !known && (!direction.offIndex || !direction.marketEvidence?.trim())) {
    throw new Error(
      `Cannot select unknown roleSlug "${direction.roleSlug}" without offIndex=true and marketEvidence`,
    );
  }
  const roles = exists
    ? previous.filter((r) => r.id !== id)
    : [
        ...previous,
        {
          id,
          selectedAt: new Date().toISOString(),
          source,
          roleSlug: direction.roleSlug,
          title: direction.title,
          bucket: direction.bucket,
          ...(!known || direction.offIndex ? { offIndex: true } : {}),
          ...(direction.marketEvidence ? { marketEvidence: direction.marketEvidence } : {}),
          direction,
        },
      ];

  if (clientSummary) {
    clientSummary.selectedTargetRoles = roles;
    outputs.clientSummary = clientSummary;
  } else {
    outputs.selectedTargetRoles = roles;
  }
  state.stageOutputs = outputs;
  state.updatedAt = new Date().toISOString();
  persistPipelineStates();

  return { selected: !exists, roles };
}

export function addSelectedTargetRole(input: {
  participantId: string;
  roleSlug: string;
  title?: string;
  bucket?: Direction["bucket"];
  offIndex?: boolean;
  marketEvidence?: string;
  source: SelectedTargetRole["source"];
}): { added: boolean; roles: SelectedTargetRole[] } | null {
  const state = pipelineStates.get(input.participantId);
  if (!state) return null;

  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const clientSummary = outputs.clientSummary as ClientSummaryWithTargets | undefined;
  const previous = Array.isArray(clientSummary?.selectedTargetRoles)
    ? clientSummary.selectedTargetRoles
    : Array.isArray(outputs.selectedTargetRoles)
      ? (outputs.selectedTargetRoles as SelectedTargetRole[])
      : [];
  const roleSlug = input.roleSlug.trim();
  const bucket = input.bucket ?? "abroad";
  const known = KNOWN_ROLE_SET.has(roleSlug);
  if (!known && (!input.offIndex || !input.marketEvidence?.trim())) {
    throw new Error(
      `Cannot add unknown roleSlug "${roleSlug}" without offIndex=true and marketEvidence`,
    );
  }
  const id = `${roleSlug}|${bucket}`;
  if (previous.some((r) => r.id === id)) {
    return { added: false, roles: previous };
  }

  const roles: SelectedTargetRole[] = [
    ...previous,
    {
      id,
      selectedAt: new Date().toISOString(),
      source: input.source,
      roleSlug,
      title: input.title?.trim() || roleSlug,
      bucket,
      ...(!known || input.offIndex ? { offIndex: true } : {}),
      ...(input.marketEvidence ? { marketEvidence: input.marketEvidence } : {}),
    },
  ];

  if (clientSummary) {
    clientSummary.selectedTargetRoles = roles;
    outputs.clientSummary = clientSummary;
  } else {
    outputs.selectedTargetRoles = roles;
  }
  state.stageOutputs = outputs;
  state.updatedAt = new Date().toISOString();
  persistPipelineStates();

  return { added: true, roles };
}

/**
 * Register intake webhook routes.
 */
export function registerIntakeRoutes(app: FastifyInstance) {
  app.post(
    "/api/webhook/new-participant",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const secret = request.headers["x-webhook-secret"];
      if (secret !== process.env.WEBHOOK_SECRET) {
        return reply.status(401).send({ error: "Invalid webhook secret" });
      }

      try {
        const body = request.body as {
          namedValues?: Record<string, string[]>;
          [key: string]: unknown;
        };

        request.log.info({ bodyKeys: Object.keys(body) }, "Webhook received");

        let rawData: Record<string, string>;
        let rawNamedValues: Record<string, string> | undefined;
        let unmappedFields: string[] = [];

        if (body.namedValues) {
          const parsed = parseNamedValues(body.namedValues);
          rawData = parsed.mapped;
          rawNamedValues = parsed.rawValues;
          unmappedFields = parsed.unmapped;

          if (unmappedFields.length > 0) {
            request.log.warn({ unmapped: unmappedFields }, "Unmapped form headers");
          }
          request.log.info({ mappedFields: Object.keys(rawData) }, "Parsed fields");
        } else {
          rawData = body as Record<string, string>;
        }

        const questionnaire = rawQuestionnaireSchema.parse(rawData);
        const analysisInput = toAnalysisInput(questionnaire);

        const nick = normalizeNick(questionnaire.telegramNick);
        const existing = Array.from(pipelineStates.values()).find(
          (s) => normalizeNick(s.telegramNick) === nick,
        );

        const participantId = existing?.participantId ?? crypto.randomUUID();
        const now = new Date().toISOString();

        // Сохраняем legacy-хвост (Google Doc + тариф из seed), чтобы повторный
        // intake того же клиента через новую анкету не стирал исторический анализ.
        const prevOutputs = (existing?.stageOutputs ?? {}) as Record<string, unknown>;
        const legacyDocUrl = prevOutputs.legacyDocUrl as string | undefined;
        const legacyTariff = prevOutputs.legacyTariff as string | undefined;
        const resumeVersions = prevOutputs.resumeVersions as unknown;
        const activeResumeVersionId = prevOutputs.activeResumeVersionId as string | undefined;
        const prevClientSummary = prevOutputs.clientSummary as
          | ClientSummaryWithTargets
          | undefined;
        const selectedTargetRoles =
          prevClientSummary?.selectedTargetRoles ?? prevOutputs.selectedTargetRoles;

        const state: PipelineState = {
          participantId,
          telegramNick: nick,
          stage: "intake_received",
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          stageOutputs: {
            rawQuestionnaire: questionnaire,
            analysisInput,
            ...(rawNamedValues ? { rawNamedValues } : {}),
            ...(unmappedFields.length > 0 ? { unmappedFields } : {}),
            ...(legacyDocUrl ? { legacyDocUrl } : {}),
            ...(legacyTariff ? { legacyTariff } : {}),
            ...(Array.isArray(resumeVersions) ? { resumeVersions } : {}),
            ...(activeResumeVersionId ? { activeResumeVersionId } : {}),
          },
        };

        if (existing) {
          request.log.info(
            { participantId, nick: questionnaire.telegramNick },
            "Re-processing existing participant",
          );
        }

        pipelineStates.set(participantId, state);
        persistPipelineStates();

        request.log.info(
          { participantId, nick: questionnaire.telegramNick },
          "New participant intake received",
        );

        processResumeAndRunAnalysis(
          participantId,
          questionnaire.resumeFileUrl,
          Array.isArray(selectedTargetRoles)
            ? (selectedTargetRoles as SelectedTargetRole[])
            : undefined,
        );

        return reply.status(200).send({
          success: true,
          participantId,
          stage: state.stage,
        });
      } catch (err) {
        request.log.error(err, "Intake webhook error");
        return reply.status(400).send({
          error: "Invalid questionnaire data",
          details: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  app.get(
    "/api/participants",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const states = getAllPipelineStates();
      return reply.send(states);
    },
  );

  app.get(
    "/api/participants/:id",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const state = getPipelineState(id);
      if (!state) {
        return reply.status(404).send({ error: "Participant not found" });
      }
      return reply.send(state);
    },
  );

  /**
   * One-off seed importer: overwrites pipelineStates with provided map.
   * Guarded by x-webhook-secret (same secret as the Google Form webhook).
   * Body: { [participantId]: PipelineState }
   */
  app.post(
    "/api/admin/import-seed",
    { bodyLimit: 32 * 1024 * 1024 }, // 32 MB — seed бывает жирноват
    async (request: FastifyRequest, reply: FastifyReply) => {
      const secret = request.headers["x-webhook-secret"];
      if (secret !== process.env.WEBHOOK_SECRET) {
        return reply.status(401).send({ error: "Invalid webhook secret" });
      }

      try {
        const body = request.body as Record<string, PipelineState>;
        if (!body || typeof body !== "object") {
          return reply.status(400).send({ error: "Body must be object" });
        }

        pipelineStates.clear();
        const byStage: Record<string, number> = {};
        for (const [id, state] of Object.entries(body)) {
          if (!state || typeof state !== "object") continue;
          pipelineStates.set(id, state);
          byStage[state.stage] = (byStage[state.stage] || 0) + 1;
        }
        persistPipelineStates();

        request.log.info(
          { imported: pipelineStates.size, byStage },
          "Seed import applied",
        );

        return reply.status(200).send({
          success: true,
          imported: pipelineStates.size,
          byStage,
        });
      } catch (err) {
        request.log.error(err, "Seed import error");
        return reply.status(500).send({
          error: "Seed import failed",
          details: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  /**
   * Upsert-partial: обновляет / добавляет только указанные participantId,
   * не трогая остальные state'ы на проде. Безопаснее import-seed для
   * точечных заливок свежих clientSummary из локального JSON.
   *
   * Body: { states: { [participantId]: PipelineState } }
   * Header: x-webhook-secret.
   */
  app.post(
    "/api/admin/upsert-states",
    { bodyLimit: 32 * 1024 * 1024 },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const secret = request.headers["x-webhook-secret"];
      if (secret !== process.env.WEBHOOK_SECRET) {
        return reply.status(401).send({ error: "Invalid webhook secret" });
      }

      try {
        const body = request.body as { states?: Record<string, PipelineState> };
        const states = body?.states;
        if (!states || typeof states !== "object") {
          return reply.status(400).send({ error: "body.states must be object" });
        }

        const updated: string[] = [];
        const added: string[] = [];
        for (const [id, state] of Object.entries(states)) {
          if (!state || typeof state !== "object" || !state.participantId) continue;
          const exists = pipelineStates.has(id);
          pipelineStates.set(id, state);
          (exists ? updated : added).push(id);
        }
        persistPipelineStates();

        request.log.info(
          { added: added.length, updated: updated.length, total: pipelineStates.size },
          "Upsert applied",
        );

        return reply.status(200).send({
          success: true,
          added: added.length,
          updated: updated.length,
          total: pipelineStates.size,
        });
      } catch (err) {
        request.log.error(err, "Upsert error");
        return reply.status(500).send({
          error: "Upsert failed",
          details: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}

function buildPipelineInput(
  analysisInput: AnalysisInput,
  resumeFileUrl?: string,
  rawNamedValues?: Record<string, string>,
): AnalysisPipelineInput {
  const { resumeText, linkedinUrl, linkedinSSI, ...questionnaireFields } = analysisInput;
  return {
    questionnaire: JSON.stringify(questionnaireFields, null, 2),
    resumeText: resumeText || "",
    linkedinUrl: linkedinUrl || "",
    linkedinSSI: linkedinSSI || "",
    resumeUrl: resumeFileUrl,
    ...(rawNamedValues ? { rawNamedValues } : {}),
  };
}

async function notifyAdminError(participantId: string, error: string): Promise<void> {
  try {
    const bot = getBot();
    const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (!chatId) return;
    await bot.telegram.sendMessage(
      chatId,
      `Ошибка в пайплайне для ${participantId}:\n${error}`,
    );
  } catch {
    console.error("[Intake] Failed to notify admin about error");
  }
}

/**
 * Background pipeline triggered after webhook intake:
 *   1) parse resume
 *   2) Phase 0: client summary (cheap Claude call for the Telegram card)
 *   3) prepare full pipelineInput and persist it
 *   4) notify admin (card + "Предварительный анализ" button) — STOP here
 *
 * Heavy Phase 1 is NOT auto-triggered; the consultant clicks the button in
 * Telegram, which calls handleAnalyze() in admin-review.ts.
 */
async function processResumeAndRunAnalysis(
  participantId: string,
  resumeFileUrl?: string,
  selectedTargetRoles?: SelectedTargetRole[],
) {
  const state = pipelineStates.get(participantId);
  if (!state) return;

  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const analysisInput = outputs.analysisInput as AnalysisInput;

  const alreadyHasResume = !!analysisInput.resumeText;

  if (resumeFileUrl && !alreadyHasResume) {
    try {
      const { buffer, mimeType } = await downloadFromGoogleDrive(resumeFileUrl);
      const resumeText = await extractResumeText(buffer, mimeType);
      (analysisInput as Record<string, unknown>).resumeText = resumeText;

      state.stage = "resume_parsed";
      state.updatedAt = new Date().toISOString();
      persistPipelineStates();
    } catch (err) {
      const msg = `Resume processing failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[Intake] ${msg}`);
      state.error = msg;
      state.updatedAt = new Date().toISOString();
      persistPipelineStates();
      await notifyAdminError(participantId, msg);
      return;
    }
  }

  // ── Phase 0: client summary (cheap, fast, used by the Telegram card) ──
  const rawNamedValues = outputs.rawNamedValues as
    | Record<string, string>
    | undefined;
  if (rawNamedValues && !outputs.clientSummary) {
    try {
      const clientSummary = await runClientSummary({
        rawNamedValues,
        resumeText: analysisInput.resumeText,
        linkedinUrl: analysisInput.linkedinUrl,
        linkedinSSI: analysisInput.linkedinSSI,
      }) as ClientSummaryWithTargets;
      if (selectedTargetRoles && selectedTargetRoles.length > 0) {
        clientSummary.selectedTargetRoles = selectedTargetRoles;
      }
      outputs.clientSummary = clientSummary;
      state.updatedAt = new Date().toISOString();
      persistPipelineStates();
    } catch (err) {
      console.error(
        `[Intake] Client summary failed for ${participantId}:`,
        err instanceof Error ? err.message : err,
      );
      // не валим пайплайн — карточка просто покажет fallback
    }
  }

  // Готовим (и сохраняем) input для последующего Phase 1, но НЕ запускаем.
  const pipelineInput = buildPipelineInput(
    analysisInput,
    resumeFileUrl,
    rawNamedValues,
  );
  outputs.pipelineInput = pipelineInput;
  state.stage = "awaiting_analysis";
  state.updatedAt = new Date().toISOString();
  persistPipelineStates();

  try {
    const { sendIntakeNotification } = await import("../bot/admin-review.js");
    await sendIntakeNotification(participantId);
    console.log(`[Intake] Intake notification sent for ${participantId}`);
  } catch (err) {
    const msg = `Intake notification failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[Intake] ${msg}`);
    await notifyAdminError(participantId, msg);
  }
}
