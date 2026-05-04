import crypto from "node:crypto";
import type { Context, Telegraf } from "telegraf";
import { Markup } from "telegraf";

import { getBot } from "./bot-instance.js";
import {
  getPipelineState,
  updatePipelineStage,
  type ResumeVersion,
} from "../pipeline/intake.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import type { LinkedinPackArtifact } from "../schemas/linkedin-pack.js";
import { linkedinPackArtifactSchema } from "../schemas/linkedin-pack.js";
import {
  buildLinkedinPackInputs,
  LinkedinPackInputError,
} from "../services/linkedin-pack/build-inputs.js";
import { runLinkedinPack } from "../services/linkedin-pack/run-pack.js";
import { renderLinkedinPack } from "../services/linkedin-pack/renderer.js";
import { createGoogleDoc } from "../services/google-docs-service.js";
import { normalizeNick } from "../services/intake-mapper.js";
import { withRunLock } from "./run-lock.js";

/**
 * Telegram-handler для LinkedIn Pack MVP.
 *
 * Callback'и:
 *   - `linkedin:run:<pid>`    — запустить (или перезапустить) генерацию.
 *   - `linkedin:open:<pid>`   — тост со ссылкой (на самом деле URL уходит через
 *                               Markup.button.url, этот callback — no-op fallback).
 *   - `linkedin:sent:<pid>`   — куратор пометил что отправил клиенту. Необратимо.
 *
 * Stage storage:
 *   - `stageOutputs.linkedinPack` = LinkedinPackArtifact (последняя версия).
 */

export const STORE_KEY = "linkedinPack";

type InlineKeyboardMarkup = ReturnType<typeof Markup.inlineKeyboard>["reply_markup"];

function escapeHtml(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isAdminCtx(ctx: Context): boolean {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (chatId == null) return false;
  const adminId =
    process.env.TELEGRAM_ADMIN_CHAT_ID ?? process.env.ADMIN_CHAT_ID ?? null;
  if (adminId == null) return true;
  return String(chatId) === String(adminId);
}

// ── UI helpers ──────────────────────────────────────────────────────────────

/**
 * Возвращает true если для клиента можно стартовать LinkedIn Pack:
 * есть `clientSummary` и хотя бы одно из (LinkedIn URL, резюме).
 */
export function canRunLinkedinPack(outputs: Record<string, unknown>): boolean {
  const cs = outputs.clientSummary as ClientSummary | undefined;
  if (!cs) return false;
  const hasLinkedin = typeof cs.linkedinUrl === "string" && cs.linkedinUrl.trim().length > 0;
  const resumes = outputs.resumeVersions as ResumeVersion[] | undefined;
  const hasResume = Array.isArray(resumes) && resumes.length > 0;
  return hasLinkedin || hasResume;
}

/**
 * Кнопки для блока "LinkedIn-пак" в карточке клиента. Возвращает массив
 * рядов (каждый ряд — массив кнопок), который admin-review встроит в общую
 * клавиатуру.
 */
export function linkedinPackKeyboardRows(
  participantId: string,
  stage: string,
  outputs: Record<string, unknown>,
): Array<Array<ReturnType<typeof Markup.button.callback> | ReturnType<typeof Markup.button.url>>> {
  if (!canRunLinkedinPack(outputs)) return [];

  const artifact = outputs[STORE_KEY] as LinkedinPackArtifact | undefined;
  const hasArtifact = !!artifact?.url;

  const rows: Array<Array<ReturnType<typeof Markup.button.callback> | ReturnType<typeof Markup.button.url>>> = [];

  if (stage === "linkedin_generating") {
    rows.push([
      Markup.button.callback(
        "⚙️ LinkedIn-пак собирается…",
        `linkedin:noop:${participantId}`,
      ),
    ]);
    return rows;
  }

  const runLabel = hasArtifact
    ? "🔁 Перегенерировать LinkedIn-пак"
    : "🔗 LinkedIn-пак (аудит + headline)";
  rows.push([
    Markup.button.callback(runLabel, `linkedin:run:${participantId}`),
  ]);

  if (hasArtifact && artifact?.url) {
    rows.push([Markup.button.url("📄 Открыть LinkedIn-пак", artifact.url)]);
  }

  if (stage === "linkedin_ready") {
    rows.push([
      Markup.button.callback(
        "✅ Отметить как отправлен клиенту",
        `linkedin:sent:${participantId}`,
      ),
    ]);
  }

  return rows;
}

// ── Handlers ────────────────────────────────────────────────────────────────

async function handleRun(participantId: string, ctx: Context): Promise<void> {
  if (!isAdminCtx(ctx)) {
    await ctx.answerCbQuery("⛔ Только для админа.").catch(() => undefined);
    return;
  }
  const state = getPipelineState(participantId);
  if (!state) {
    await ctx.answerCbQuery("Клиент не найден.").catch(() => undefined);
    return;
  }
  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const cs = outputs.clientSummary as ClientSummary | undefined;
  if (!cs) {
    await ctx.answerCbQuery(
      "Нужен clientSummary — запусти сначала Phase 0.",
      { show_alert: true },
    ).catch(() => undefined);
    return;
  }

  const resumeVersions = Array.isArray(outputs.resumeVersions)
    ? (outputs.resumeVersions as ResumeVersion[])
    : [];
  const activeResumeVersionId = outputs.activeResumeVersionId as string | undefined;
  const nick = normalizeNick(state.telegramNick);
  const chatId = ctx.chat?.id;
  if (chatId == null) {
    await ctx.answerCbQuery("Не вижу чата.").catch(() => undefined);
    return;
  }

  // Отвечаем на callback СРАЗУ — pipeline долгий (15-40 сек), иначе
  // Telegram выдаст "query is too old".
  await ctx.answerCbQuery("⚙️ Собираю LinkedIn-пак…").catch(() => undefined);

  await withRunLock(participantId, "linkedin", ctx, async () => {
    updatePipelineStage(participantId, "linkedin_generating");

    let inputs;
    try {
      inputs = await buildLinkedinPackInputs({
        participantId,
        nick,
        clientSummary: cs,
        resumeVersions,
        activeResumeVersionId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[linkedin-pack] build-inputs failed for ${participantId}: ${msg}`);
      updatePipelineStage(participantId, "linkedin_failed", {
        linkedinPackError: msg,
      });
      if (err instanceof LinkedinPackInputError) {
        await getBot().telegram.sendMessage(chatId, `⚠️ ${msg}`);
      } else {
        await getBot().telegram.sendMessage(
          chatId,
          `❌ LinkedIn-пак: сбор входных данных упал: <code>${escapeHtml(msg)}</code>`,
          { parse_mode: "HTML" },
        );
      }
      return;
    }

    const progress = await getBot().telegram.sendMessage(
      chatId,
      `⚙️ <b>LinkedIn-пак для @${escapeHtml(nick)}</b>\n` +
        `Источники: ${inputs.linkedin ? "LinkedIn" : "—"} + ${inputs.resume ? "резюме" : "—"}.\n` +
        `Фаза 1/3: аудит по чек-листу…`,
      { parse_mode: "HTML" },
    );

    try {
      const result = await runLinkedinPack(inputs, {
        onProgress: async (stage, audit) => {
          const label =
            stage === "headline"
              ? `Аудит готов (${audit.passCount} ✅ · ${audit.failCount} ❌${audit.unknownCount > 0 ? ` · ${audit.unknownCount} ❓` : ""} из ${audit.totalCount}). Фаза 2/3: headline-варианты…`
              : `Фаза 3/3: готовим полный текст профиля (About, Experience, настройки, контент-план)…`;
          try {
            await getBot().telegram.editMessageText(
              chatId,
              progress.message_id,
              undefined,
              `⚙️ <b>LinkedIn-пак для @${escapeHtml(nick)}</b>\n${label}`,
              { parse_mode: "HTML" },
            );
          } catch {
            // не страшно, следующий шаг идёт в отдельном сообщении
          }
        },
      });
      const pack = result.data;

      const docTitle = `LinkedIn пак — @${nick}`;
      const markdown = renderLinkedinPack(pack);
      const url = await createGoogleDoc(docTitle, markdown);

      const artifactRaw = {
        id: crypto.randomUUID(),
        url,
        generatedAt: pack.meta.generatedAt,
        version:
          ((outputs[STORE_KEY] as LinkedinPackArtifact | undefined)?.version ?? 0) + 1,
        data: pack,
      };
      const artifact = linkedinPackArtifactSchema.parse(artifactRaw);

      updatePipelineStage(participantId, "linkedin_ready", {
        [STORE_KEY]: artifact,
      });

      try {
        await getBot().telegram.deleteMessage(chatId, progress.message_id);
      } catch {
        // progress-сообщение оставляем как есть если удалить нельзя
      }

      const top = pack.audit.topPriorities.slice(0, 3);
      const a = pack.audit;
      const auditLine =
        `Аудит: <b>${a.passCount} ✅ · ${a.failCount} ❌` +
        (a.unknownCount > 0 ? ` · ${a.unknownCount} ❓` : "") +
        `</b> из ${a.totalCount} пунктов`;
      const summary = [
        `✅ <b>LinkedIn-пак готов</b> для @${escapeHtml(nick)} (v${artifact.version}).`,
        auditLine,
        top.length > 0 ? `Топ-приоритеты:\n${top.map((p) => `• ${escapeHtml(p)}`).join("\n")}` : "",
        `Гугл-док: ${url}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      await getBot().telegram.sendMessage(chatId, summary, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: readyKeyboard(participantId, url).reply_markup,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[linkedin-pack] run failed for ${participantId}:`, err);
      updatePipelineStage(participantId, "linkedin_failed", {
        linkedinPackError: msg,
      });
      try {
        await getBot().telegram.editMessageText(
          chatId,
          progress.message_id,
          undefined,
          `❌ <b>LinkedIn-пак упал</b>\n<code>${escapeHtml(msg).slice(0, 2000)}</code>`,
          { parse_mode: "HTML" },
        );
      } catch {
        await getBot().telegram.sendMessage(
          chatId,
          `❌ LinkedIn-пак упал: <code>${escapeHtml(msg).slice(0, 2000)}</code>`,
          { parse_mode: "HTML" },
        );
      }
    }
  });
}

async function handleSent(participantId: string, ctx: Context): Promise<void> {
  if (!isAdminCtx(ctx)) {
    await ctx.answerCbQuery("⛔ Только для админа.").catch(() => undefined);
    return;
  }
  const state = getPipelineState(participantId);
  if (!state) {
    await ctx.answerCbQuery("Клиент не найден.").catch(() => undefined);
    return;
  }
  if (state.stage !== "linkedin_ready") {
    await ctx.answerCbQuery(
      `Неподходящий статус: ${state.stage}. Кнопка работает только из linkedin_ready.`,
      { show_alert: true },
    ).catch(() => undefined);
    return;
  }
  updatePipelineStage(participantId, "linkedin_sent");
  await ctx.answerCbQuery("✅ Отмечено как отправлено клиенту.").catch(() => undefined);
}

function readyKeyboard(participantId: string, url: string): {
  reply_markup: InlineKeyboardMarkup;
} {
  return {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.url("📄 Открыть LinkedIn-пак", url)],
      [
        Markup.button.callback(
          "✅ Отметить как отправлен клиенту",
          `linkedin:sent:${participantId}`,
        ),
      ],
    ]).reply_markup,
  };
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Диспетчер `linkedin:<action>:<pid>` callback'ов.
 * Возвращает true если обработал.
 */
export async function dispatchLinkedinCallback(
  data: string,
  ctx: Context,
): Promise<boolean> {
  const [ns, action, participantId] = data.split(":");
  if (ns !== "linkedin" || !action || !participantId) return false;

  switch (action) {
    case "noop":
      await ctx.answerCbQuery().catch(() => undefined);
      return true;
    case "run":
      await handleRun(participantId, ctx);
      return true;
    case "sent":
      await handleSent(participantId, ctx);
      return true;
    default:
      return false;
  }
}

export function registerLinkedinPack(_bot: Telegraf): void {
  // No-op: dispatch живёт в admin-review → callback_query.
}
