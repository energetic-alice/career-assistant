import type { Context, Telegraf } from "telegraf";
import {
  addClientNote,
  archiveClientNote,
  deleteClientNote,
  findParticipantIdByNick,
  listClientNotes,
} from "../pipeline/client-notes.js";
import { getAllPipelineStates } from "../pipeline/intake.js";
import { normalizeNick } from "../services/intake-mapper.js";

const NICK_RE = /@([a-zA-Z0-9_]{3,32})/;
const RM_RE = /^rm\s+(\S+)/i;

function operatorUsername(ctx: Context): string | undefined {
  const u = (ctx.from as { username?: string } | undefined)?.username;
  return u || undefined;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * /note @nick текст заметки
 * /note rm <noteId>
 *
 * Если @nick опущен — ищем nick по форварду reply_to_message.forward_origin.
 */
export async function handleNoteCommand(ctx: Context): Promise<void> {
  const text = (ctx.message as { text?: string } | undefined)?.text ?? "";
  const arg = text.replace(/^\/note(?:@\w+)?\s*/i, "").trim();

  if (!arg) {
    await ctx.reply(
      "Использование:\n" +
        "  /note @nick текст заметки\n" +
        "  /note rm &lt;noteId&gt;  — удалить (нужен @nick в reply на карточку клиента)\n" +
        "  /notes @nick           — показать все заметки клиента\n\n" +
        "Также: любой пересланный текст без файлов и ссылок я сохраню как заметку для клиента, чьим username он подписан.",
      { parse_mode: "HTML" },
    );
    return;
  }

  const rm = RM_RE.exec(arg);
  if (rm) {
    const noteId = rm[1];
    const states = getAllPipelineStates();
    let removed: { participantId: string; nick: string } | null = null;
    for (const s of states) {
      if (deleteClientNote(s.participantId, noteId)) {
        removed = { participantId: s.participantId, nick: s.telegramNick ?? s.participantId };
        break;
      }
    }
    if (removed) {
      await ctx.reply(`Удалила заметку ${noteId} у @${removed.nick}.`);
    } else {
      await ctx.reply(`Не нашла заметку ${noteId} ни у одного клиента.`);
    }
    return;
  }

  const nickMatch = NICK_RE.exec(arg);
  if (!nickMatch) {
    await ctx.reply("Не вижу @nick. Пример: /note @clientnick текст заметки");
    return;
  }
  const nick = normalizeNick(nickMatch[1]);
  const body = arg.replace(NICK_RE, "").trim();
  if (!body) {
    await ctx.reply(`Пустая заметка для @${nick}. Добавь текст после @nick.`);
    return;
  }

  const participantId = findParticipantIdByNick(nick);
  if (!participantId) {
    await ctx.reply(`Не нашла клиента с ником @${nick} в state.`);
    return;
  }

  const note = addClientNote({
    participantId,
    text: body,
    source: "manual_command",
    enteredByUsername: operatorUsername(ctx),
  });
  if (!note) {
    await ctx.reply("Не удалось сохранить заметку.");
    return;
  }
  await ctx.reply(
    `Сохранила заметку для @${nick} (id: <code>${escapeHtml(note.id.slice(0, 8))}</code>).\n` +
      `Сейчас активных заметок: <b>${listClientNotes(participantId).length}</b>.`,
    { parse_mode: "HTML" },
  );
}

/** /notes @nick — выводит все активные заметки клиента. */
export async function handleNotesListCommand(ctx: Context): Promise<void> {
  const text = (ctx.message as { text?: string } | undefined)?.text ?? "";
  const nickMatch = NICK_RE.exec(text);
  if (!nickMatch) {
    await ctx.reply("Использование: /notes @nick");
    return;
  }
  const nick = normalizeNick(nickMatch[1]);
  const participantId = findParticipantIdByNick(nick);
  if (!participantId) {
    await ctx.reply(`Не нашла клиента с ником @${nick}.`);
    return;
  }

  const notes = listClientNotes(participantId);
  if (notes.length === 0) {
    await ctx.reply(`У @${nick} пока нет заметок.`);
    return;
  }

  const lines = notes.map((n, i) => {
    const date = n.createdAt.slice(0, 16).replace("T", " ");
    const author = n.authorUsername ? ` от @${n.authorUsername}` : "";
    return `${i + 1}. <code>${escapeHtml(n.id.slice(0, 8))}</code> — ${date}${author}\n   ${escapeHtml(n.text.slice(0, 400))}`;
  });

  await ctx.reply(`Заметки @${nick} (${notes.length}):\n\n${lines.join("\n\n")}`, {
    parse_mode: "HTML",
  });
}

/** /note_archive <noteId> — мягкое удаление. */
export async function handleNoteArchiveCommand(ctx: Context): Promise<void> {
  const text = (ctx.message as { text?: string } | undefined)?.text ?? "";
  const arg = text.replace(/^\/note_archive(?:@\w+)?\s*/i, "").trim();
  if (!arg) {
    await ctx.reply("Использование: /note_archive <noteId>");
    return;
  }
  for (const s of getAllPipelineStates()) {
    const archived = archiveClientNote(s.participantId, arg);
    if (archived) {
      await ctx.reply(`Заметка ${arg.slice(0, 8)} у @${s.telegramNick} архивирована.`);
      return;
    }
  }
  await ctx.reply(`Не нашла заметку ${arg.slice(0, 8)}.`);
}

export function registerNotesCommands(bot: Telegraf): void {
  bot.command("note", handleNoteCommand);
  bot.command("notes", handleNotesListCommand);
  bot.command("note_archive", handleNoteArchiveCommand);
}
