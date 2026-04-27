import crypto from "node:crypto";
import { pipelineStates, getAllPipelineStates } from "./intake.js";
import { saveMap } from "../services/state-store.js";
import type { PipelineState } from "../schemas/pipeline-state.js";

/**
 * Free-form client notes — anything we can dump in for context.
 *
 * Storage shape (per client):
 *   state.stageOutputs.clientNotes: ClientNote[]
 *
 * Design choices (locked in with user):
 *   - No LLM classification, no role/company attribution. Raw is raw.
 *   - Globally injected into every prompt (no per-company filtering).
 *   - Soft-delete via `archived = true` so we keep history.
 */

export interface ClientNote {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** "telegram_forward" | "manual_command" | "system" */
  source: ClientNoteSource;
  /** Free text the user wanted us to remember. */
  text: string;
  /** Optional pointer to who said it (forwarded sender username). */
  authorUsername?: string;
  /** Optional pointer to who entered it into the bot (operator). */
  enteredByUsername?: string;
  /** True when the note is hidden from prompts/UI but kept on disk. */
  archived?: boolean;
}

export type ClientNoteSource =
  | "telegram_forward"
  | "manual_command"
  | "system";

const STORE_NAME = "pipelineStates";

function persist(): void {
  saveMap(STORE_NAME, pipelineStates);
}

function getOutputs(state: PipelineState): Record<string, unknown> {
  state.stageOutputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  return state.stageOutputs as Record<string, unknown>;
}

function readNotes(state: PipelineState): ClientNote[] {
  const outputs = getOutputs(state);
  const raw = outputs.clientNotes;
  if (!Array.isArray(raw)) return [];
  return raw as ClientNote[];
}

function writeNotes(state: PipelineState, notes: ClientNote[]): void {
  const outputs = getOutputs(state);
  outputs.clientNotes = notes;
  state.updatedAt = new Date().toISOString();
  persist();
}

export interface AddClientNoteInput {
  participantId: string;
  text: string;
  source: ClientNoteSource;
  authorUsername?: string;
  enteredByUsername?: string;
}

export function addClientNote(input: AddClientNoteInput): ClientNote | null {
  const state = pipelineStates.get(input.participantId);
  if (!state) return null;
  const text = input.text.trim();
  if (!text) return null;

  const now = new Date().toISOString();
  const note: ClientNote = {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    source: input.source,
    text,
    ...(input.authorUsername ? { authorUsername: input.authorUsername } : {}),
    ...(input.enteredByUsername ? { enteredByUsername: input.enteredByUsername } : {}),
  };

  const notes = readNotes(state);
  notes.push(note);
  writeNotes(state, notes);
  return note;
}

export function listClientNotes(
  participantId: string,
  options: { includeArchived?: boolean } = {},
): ClientNote[] {
  const state = pipelineStates.get(participantId);
  if (!state) return [];
  const notes = readNotes(state);
  if (options.includeArchived) return [...notes];
  return notes.filter((n) => !n.archived);
}

export function archiveClientNote(
  participantId: string,
  noteId: string,
): ClientNote | null {
  const state = pipelineStates.get(participantId);
  if (!state) return null;
  const notes = readNotes(state);
  const note = notes.find((n) => n.id === noteId);
  if (!note) return null;
  note.archived = true;
  note.updatedAt = new Date().toISOString();
  writeNotes(state, notes);
  return note;
}

export function deleteClientNote(participantId: string, noteId: string): boolean {
  const state = pipelineStates.get(participantId);
  if (!state) return false;
  const notes = readNotes(state);
  const next = notes.filter((n) => n.id !== noteId);
  if (next.length === notes.length) return false;
  writeNotes(state, next);
  return true;
}

/**
 * Render notes as a single block for direct injection into LLM prompts.
 * Returns `null` when the client has no active notes.
 *
 * The block is intentionally short & literal — we want the LLM to treat
 * it as additional context, not as instructions.
 */
export function renderClientNotesForPrompt(
  participantId: string,
): string | null {
  const notes = listClientNotes(participantId);
  if (notes.length === 0) return null;

  const lines = notes.map((n, i) => {
    const date = n.createdAt.slice(0, 10);
    const author = n.authorUsername ? ` [@${n.authorUsername}]` : "";
    const safe = n.text.replace(/\s+/g, " ").trim().slice(0, 800);
    return `(${i + 1}) ${date}${author}: ${safe}`;
  });

  return [
    "ДОПОЛНИТЕЛЬНЫЕ ЗАМЕТКИ О КЛИЕНТЕ (raw, без интерпретации):",
    ...lines,
  ].join("\n");
}

/** Find a participant by Telegram nick (any case, optional @). */
export function findParticipantIdByNick(rawNick: string): string | null {
  const nick = rawNick.replace(/^@/, "").trim().toLowerCase();
  if (!nick) return null;
  const match = getAllPipelineStates().find(
    (s) => (s.telegramNick ?? "").replace(/^@/, "").toLowerCase() === nick,
  );
  return match ? match.participantId : null;
}
