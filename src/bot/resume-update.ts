import type { Context, Telegraf } from "telegraf";
import { downloadFromGoogleDrive, extractResumeText } from "../services/file-service.js";
import { normalizeNick } from "../services/intake-mapper.js";
import {
  addSelectedTargetRole,
  getAllPipelineStates,
  saveResumeVersion,
  type ResumeVersion,
} from "../pipeline/intake.js";
import { matchRoleToSlug } from "../services/role-matcher.js";
import { registerPendingReply, takePendingReply } from "./pending-reply.js";

type TelegramDocument = {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
};

type TelegramPhoto = {
  file_id?: string;
  file_size?: number;
};

type TelegramUser = {
  username?: string;
};

type ForwardOrigin = {
  type?: string;
  sender_user?: TelegramUser;
  sender_user_name?: string;
};

type ResumeMessage = {
  text?: string;
  caption?: string;
  document?: TelegramDocument;
  photo?: TelegramPhoto[];
  forward_from?: TelegramUser;
  forward_origin?: ForwardOrigin;
  reply_to_message?: { message_id?: number };
};

type ResumeSource = {
  text: string;
  source: ResumeVersion["source"];
  sourceFileName?: string;
  mimeType?: string;
};

const DRIVE_URL_RE = /https?:\/\/(?:drive|docs)\.google\.com\/[^\s<>)"]+/i;

function getMessage(ctx: Context): ResumeMessage | undefined {
  return ctx.message as ResumeMessage | undefined;
}

function getForwardedUsername(message: ResumeMessage): string {
  const legacy = message.forward_from?.username;
  const modern = message.forward_origin?.sender_user?.username;
  return normalizeNick(modern || legacy || "");
}

function getMentionedNick(text: string): string {
  const mention = /@([a-zA-Z0-9_]{3,32})/.exec(text);
  if (mention) return normalizeNick(mention[1]);

  const tme = /(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]{3,32})/i.exec(text);
  return tme ? normalizeNick(tme[1]) : "";
}

function findParticipantByNick(rawNick: string): {
  participantId: string;
  nick: string;
  duplicateCount: number;
} | null {
  const nick = normalizeNick(rawNick);
  if (!nick) return null;

  const matches = getAllPipelineStates().filter(
    (s) => normalizeNick(s.telegramNick) === nick,
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return {
    participantId: matches[0].participantId,
    nick,
    duplicateCount: matches.length,
  };
}

async function downloadTelegramFile(
  ctx: Context,
  document: TelegramDocument,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!document.file_id) {
    throw new Error("В Telegram-документе нет file_id");
  }

  const link = await ctx.telegram.getFileLink(document.file_id);
  const response = await fetch(link);
  if (!response.ok) {
    throw new Error(`Не удалось скачать файл из Telegram: HTTP ${response.status}`);
  }

  const mimeType =
    document.mime_type ||
    response.headers.get("content-type") ||
    "application/octet-stream";

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType,
  };
}

function cleanResumeText(raw: string): string {
  return raw
    .replace(/^\/resume(?:@\w+)?\s+@\w+\s*/i, "")
    .replace(/^@\w+\s*/i, "")
    .trim();
}

async function extractResumeSource(
  ctx: Context,
  message: ResumeMessage,
): Promise<ResumeSource | null> {
  if (message.document) {
    const { buffer, mimeType } = await downloadTelegramFile(ctx, message.document);
    const text = await extractResumeText(buffer, mimeType);
    return {
      text,
      source: "telegram_document",
      sourceFileName: message.document.file_name,
      mimeType,
    };
  }

  if (message.photo && message.photo.length > 0) {
    const photo = [...message.photo].sort(
      (a, b) => (b.file_size ?? 0) - (a.file_size ?? 0),
    )[0];
    const { buffer } = await downloadTelegramFile(ctx, {
      file_id: photo.file_id,
      mime_type: "image/jpeg",
    });
    const text = await extractResumeText(buffer, "image/jpeg");
    return {
      text,
      source: "telegram_document",
      sourceFileName: "telegram-photo.jpg",
      mimeType: "image/jpeg",
    };
  }

  const body = [message.caption, message.text].filter(Boolean).join("\n").trim();
  const driveUrl = DRIVE_URL_RE.exec(body)?.[0];
  if (driveUrl) {
    const { buffer, mimeType } = await downloadFromGoogleDrive(driveUrl);
    const text = await extractResumeText(buffer, mimeType);
    return {
      text,
      source: "google_drive_url",
      sourceFileName: driveUrl,
      mimeType,
    };
  }

  const text = cleanResumeText(body);
  if (text.length >= 200) {
    return {
      text,
      source: "telegram_text",
      mimeType: "text/plain",
    };
  }

  return null;
}

export async function handleResumeUpdateMessage(
  ctx: Context,
  options: { participantId?: string } = {},
): Promise<boolean> {
  const message = getMessage(ctx);
  if (!message) return false;

  const body = [message.caption, message.text].filter(Boolean).join("\n");
  const participant =
    options.participantId
      ? {
          participantId: options.participantId,
          nick:
            normalizeNick(
              getAllPipelineStates().find((s) => s.participantId === options.participantId)
                ?.telegramNick ?? "",
            ) || "client",
          duplicateCount: 1,
        }
      : findParticipantByNick(getForwardedUsername(message)) ??
        findParticipantByNick(getMentionedNick(body));

  const looksLikeForward = Boolean(message.forward_from || message.forward_origin);
  const hasResumePayload = Boolean(
    message.document ||
      message.photo?.length ||
      DRIVE_URL_RE.test(body) ||
      getMentionedNick(body),
  );
  if (!participant) {
    if (looksLikeForward || hasResumePayload) {
      await ctx.reply(
        "Не смогла определить клиента по форварду. Если у клиента скрыт username, отправь так: /resume @nick, а следующим сообщением файл/ссылку/текст резюме.",
      );
      return true;
    }
    return false;
  }

  try {
    await ctx.reply(`Нашла клиента @${participant.nick}. Парсю резюме…`);
    const source = await extractResumeSource(ctx, message);
    if (!source || !source.text.trim()) {
      await ctx.reply(
        "Не нашла в сообщении резюме. Пришли PDF/DOCX/TXT/картинку, ссылку Google Drive или текст резюме.",
      );
      return true;
    }

    const version = saveResumeVersion({
      participantId: participant.participantId,
      text: source.text,
      source: source.source,
      sourceFileName: source.sourceFileName,
      mimeType: source.mimeType,
    });

    if (!version) {
      await ctx.reply(`Клиент @${participant.nick} не найден в state.`);
      return true;
    }

    const duplicateNote =
      participant.duplicateCount > 1
        ? `\nНайдено ${participant.duplicateCount} записей с этим ником, обновила самую свежую.`
        : "";

    await ctx.reply(
      `Готово: сохранила новую активную версию резюме для @${participant.nick} (${version.textLength} символов).${duplicateNote}\n\nДля уже сгенерированного анализа я ничего не перезапускала автоматически. Чтобы применить новое резюме, перезапусти нужную фазу анализа.`,
    );

    const roleMatch = await matchRoleToSlug(source.text.slice(0, 5000));
    if (roleMatch && roleMatch.confidence >= 0.85) {
      await ctx.reply(
        `Похоже, резюме уже упаковано под <code>${roleMatch.slug}</code>. Добавить это направление в clientSummary.selectedTargetRoles?`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: `🎯 Добавить ${roleMatch.slug}`,
                  callback_data: `resume_target:${participant.participantId}:${roleMatch.slug}`,
                },
              ],
            ],
          },
        },
      );
    }
    return true;
  } catch (err) {
    console.error("[resume-update] failed:", err);
    await ctx.reply(
      `Не удалось обновить резюме: ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
  }
}

export function registerResumeUpdate(bot: Telegraf): void {
  bot.action(/^resume_target:([^:]+):([^:]+)$/, async (ctx) => {
    const [, participantId, roleSlug] = (ctx.match as RegExpExecArray);
    let result: ReturnType<typeof addSelectedTargetRole>;
    try {
      result = addSelectedTargetRole({
        participantId,
        roleSlug,
        title: roleSlug,
        source: "resume",
      });
    } catch (err) {
      await ctx.answerCbQuery("Некорректный target slug.");
      await ctx.reply(
        `Не могу добавить <code>${roleSlug}</code>: ${
          err instanceof Error ? err.message : "slug не прошёл проверку"
        }`,
        { parse_mode: "HTML" },
      );
      return;
    }

    if (!result) {
      await ctx.answerCbQuery("Клиент не найден.");
      return;
    }
    await ctx.answerCbQuery(result.added ? "Добавлено в упаковку." : "Уже было выбрано.");
    await ctx.reply(
      `${result.added ? "🎯 Добавила" : "Уже есть"} в clientSummary.selectedTargetRoles: <code>${roleSlug}</code>\n` +
        `Всего выбранных направлений: <b>${result.roles.length}</b>.`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("resume", async (ctx) => {
    const text = (ctx.message as { text?: string } | undefined)?.text ?? "";
    const arg = text.replace(/^\/resume(@\w+)?\s*/i, "").trim();
    const participant = findParticipantByNick(arg);

    if (!participant) {
      await ctx.reply(
        "Использование: /resume @nick\nПосле команды ответь следующим сообщением с PDF/DOCX/TXT/картинкой, ссылкой Google Drive или текстом резюме.",
      );
      return;
    }

    const prompt = await ctx.reply(
      `Ок, жду новое резюме для @${participant.nick}: файл, Google Drive ссылку или текст.`,
      { reply_markup: { force_reply: true, selective: true } },
    );
    if (ctx.chat?.id != null) {
      registerPendingReply(ctx.chat.id, prompt.message_id, {
        kind: "resume:update",
        participantId: participant.participantId,
      });
    }
  });

  bot.on("message", async (ctx, next) => {
    const message = getMessage(ctx);
    if (!message) return next();

    const text = message.text?.trim() ?? "";
    if (text.startsWith("/")) return next();

    const replyMessageId = message.reply_to_message?.message_id;
    if (replyMessageId != null && ctx.chat?.id != null) {
      const pending = takePendingReply(ctx.chat.id, replyMessageId, "resume:update");
      if (pending) {
        await handleResumeUpdateMessage(ctx, { participantId: pending.participantId });
        return;
      }
    }

    const handled = await handleResumeUpdateMessage(ctx);
    if (!handled) return next();
  });
}
