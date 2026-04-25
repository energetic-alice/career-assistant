/**
 * Простой in-memory реестр ForceReply-prompts.
 *
 * Использование:
 *   1) Бот шлёт сообщение с `force_reply` и регистрирует prompt:
 *        const msg = await ctx.reply("Введи причину…", { reply_markup: { force_reply: true } });
 *        registerPendingReply(chatId, msg.message_id, { kind: "shortlist:reject", participantId, slotId });
 *   2) Глобальный text-handler (см. telegram-bot.ts) при получении сообщения с
 *      `reply_to_message` смотрит, нет ли pending для этого reply_to → если есть,
 *      вызывает соответствующий обработчик.
 *
 * State в памяти процесса — после рестарта prompts теряются. Для админ-флоу
 * это допустимо (админ просто нажмёт кнопку ещё раз).
 */

type PendingReplyMeta =
  | {
      kind: "shortlist:reject" | "deep:reject";
      participantId: string;
      slotId: string;
    }
  | {
      kind: "resume:update";
      participantId: string;
    };

export type PendingReply = PendingReplyMeta & {
  participantId: string;
  /** ISO-таймштамп создания (для очистки старых). */
  createdAt: string;
};

const pending = new Map<string, PendingReply>();

function key(chatId: number | string, messageId: number): string {
  return `${chatId}:${messageId}`;
}

export function registerPendingReply(
  chatId: number | string,
  messageId: number,
  meta: PendingReplyMeta,
): void {
  pending.set(key(chatId, messageId), {
    ...meta,
    createdAt: new Date().toISOString(),
  });
}

export function takePendingReply(
  chatId: number | string,
  messageId: number,
  kind?: PendingReply["kind"],
): PendingReply | undefined {
  const k = key(chatId, messageId);
  const value = pending.get(k);
  if (kind && value?.kind !== kind) return undefined;
  if (value) pending.delete(k);
  return value;
}

/**
 * Очистить prompts старше N минут (вызывается лениво при каждой регистрации,
 * чтобы Map не разрастался при долгих сессиях).
 */
function gc(maxAgeMs = 60 * 60 * 1000): void {
  const now = Date.now();
  for (const [k, v] of pending.entries()) {
    if (now - new Date(v.createdAt).getTime() > maxAgeMs) {
      pending.delete(k);
    }
  }
}

// Periodic GC (раз в 30 мин), без блокировки event loop.
setInterval(gc, 30 * 60 * 1000).unref?.();
