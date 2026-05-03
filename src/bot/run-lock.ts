/**
 * U3: in-memory anti-double-click lock для тяжёлых операций бота.
 *
 * Проблема: пока Phase 1 / Phase 2 / Final analysis крутятся (десятки
 * секунд — пара минут), куратор может «кликнуть ещё раз», бот стартует
 * вторую копию, в state перезаписывается результат, попадаем в гонку.
 *
 * Решение — простая map с парой `(participantId, kind)`. Lock держится
 * только в памяти текущего инстанса бота (рестарт = отпуск всех замков —
 * сознательно, чтобы зависшие после краша lock'и не блокировали навсегда).
 *
 * Использование:
 *
 *     await withRunLock(participantId, "shortlist", ctx, async () => {
 *       await startShortlist(participantId, ctx);
 *     });
 *
 * Если lock уже занят — повторный клик отвечает информативным toast'ом
 * (`Уже идёт … подожди`) и НЕ выполняет fn.
 */

import type { Context } from "telegraf";

type LockKey = string; // `${participantId}:${kind}`
const activeLocks = new Map<LockKey, { startedAt: number; kind: string }>();

function key(pid: string, kind: string): LockKey {
  return `${pid}:${kind}`;
}

/**
 * Известные «виды» тяжёлых операций. Текстовая константа — в toast'е
 * показываем человекочитаемое имя.
 */
export const RUN_KINDS = {
  shortlist: "предварительный анализ",
  deep: "глубокий анализ (Phase 2)",
  final: "финальный анализ",
  idealResume: "генерация идеального резюме",
  linkedin: "LinkedIn-пак",
} as const;

export type RunKind = keyof typeof RUN_KINDS;

export function isLocked(pid: string, kind: RunKind): boolean {
  return activeLocks.has(key(pid, kind));
}

export function tryAcquireRunLock(pid: string, kind: RunKind): boolean {
  const k = key(pid, kind);
  if (activeLocks.has(k)) return false;
  activeLocks.set(k, { startedAt: Date.now(), kind });
  return true;
}

export function releaseRunLock(pid: string, kind: RunKind): void {
  activeLocks.delete(key(pid, kind));
}

/**
 * Обёртка-помощник: пытается захватить lock, если занят — отвечает
 * toast'ом и возвращает `null`. Иначе выполняет fn, гарантированно
 * отпуская lock в `finally` (даже если внутри случилось исключение).
 */
export async function withRunLock<T>(
  participantId: string,
  kind: RunKind,
  ctx: Context | null,
  fn: () => Promise<T>,
): Promise<T | null> {
  if (!tryAcquireRunLock(participantId, kind)) {
    const label = RUN_KINDS[kind];
    if (ctx) {
      await ctx
        .answerCbQuery(`⏳ Уже идёт ${label}, подожди до завершения.`)
        .catch(() => undefined);
    }
    console.log(
      `[run-lock] DUP click ignored: ${participantId}:${kind} already running`,
    );
    return null;
  }
  try {
    return await fn();
  } finally {
    releaseRunLock(participantId, kind);
  }
}
