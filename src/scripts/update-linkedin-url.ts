import "dotenv/config";

import type { PipelineState } from "../schemas/pipeline-state.js";
import type { ClientSummary } from "../schemas/client-summary.js";

/**
 * One-off: обновить `clientSummary.linkedinUrl` у одного клиента в проде.
 *
 * Юзкейс — клиент сменил slug LinkedIn (например, был
 * `linkedin.com/in/olga-kravchenko-87b98a1a9`, стал
 * `linkedin.com/in/olga-kravchenko-frontend`). Старый URL у нас зашит
 * в `clientSummary.linkedinUrl`, и при следующем запуске LinkedIn-pack
 * `buildLinkedinPackInputs` пойдёт в Apify по битому slug-у.
 *
 * Что делает скрипт:
 *   1. GET /api/participants → находим state по nick'у.
 *   2. Подменяем `stageOutputs.clientSummary.linkedinUrl`.
 *   3. POST /api/admin/upsert-states (точечно, без затирания остальных).
 *   4. Кеш `data/documents/<participantId>/linkedin-profile.json` инвалидируется
 *      автоматически в `loadCachedLinkedin` — нормализованные URL не совпадут.
 *
 * Запуск:
 *   npx tsx src/scripts/update-linkedin-url.ts <@nick> <newUrl>
 *
 * Пример:
 *   npx tsx src/scripts/update-linkedin-url.ts \
 *     @olenka_kravchenko https://www.linkedin.com/in/olga-kravchenko-frontend/
 */

const PROD_URL =
  process.env.PROD_URL || "https://career-assistant-w7z3.onrender.com";
const SECRET = process.env.WEBHOOK_SECRET || "ca-webhook-2025-secret";

async function fetchProdStates(): Promise<PipelineState[]> {
  const res = await fetch(`${PROD_URL}/api/participants`);
  if (!res.ok) throw new Error(`GET /api/participants → ${res.status}`);
  return (await res.json()) as PipelineState[];
}

async function upsert(state: PipelineState): Promise<void> {
  const res = await fetch(`${PROD_URL}/api/admin/upsert-states`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-secret": SECRET,
    },
    body: JSON.stringify({ states: { [state.participantId]: state } }),
  });
  if (!res.ok) {
    throw new Error(
      `POST upsert-states → ${res.status}: ${await res.text()}`,
    );
  }
  const json = (await res.json()) as {
    added: number;
    updated: number;
    total: number;
  };
  console.log(
    `[update-linkedin] upsert ok: added=${json.added} updated=${json.updated} total=${json.total}`,
  );
}

async function main(): Promise<void> {
  const argNick = process.argv[2];
  const argUrl = process.argv[3];
  if (!argNick || !argUrl) {
    console.error(
      "Usage: npx tsx src/scripts/update-linkedin-url.ts <@nick> <newUrl>\n" +
        "Example: npx tsx src/scripts/update-linkedin-url.ts " +
        "@olenka_kravchenko https://www.linkedin.com/in/olga-kravchenko-frontend/",
    );
    process.exit(1);
  }
  if (!/^https?:\/\//i.test(argUrl)) {
    console.error("New URL must start with http:// or https://");
    process.exit(1);
  }

  const norm = argNick.replace(/^@/, "").toLowerCase();
  const all = await fetchProdStates();
  const state = all.find(
    (s) => (s.telegramNick ?? "").replace(/^@/, "").toLowerCase() === norm,
  );
  if (!state) {
    console.error(`Client @${norm} not found on prod`);
    process.exit(1);
  }

  const outputs = (state.stageOutputs ?? {}) as Record<string, unknown>;
  const summary = outputs.clientSummary as ClientSummary | undefined;
  const oldUrl = summary?.linkedinUrl ?? null;
  console.log(
    `[update-linkedin] client: @${state.telegramNick}  pid=${state.participantId}`,
  );
  console.log(`[update-linkedin] old URL: ${oldUrl ?? "(empty)"}`);
  console.log(`[update-linkedin] new URL: ${argUrl}`);

  if (!summary) {
    console.error(
      "Нет clientSummary в stageOutputs — нечего обновлять. Запусти Phase 0 сначала.",
    );
    process.exit(1);
  }

  const updatedState: PipelineState = {
    ...state,
    stageOutputs: {
      ...(state.stageOutputs ?? {}),
      clientSummary: {
        ...summary,
        linkedinUrl: argUrl,
      },
    },
    updatedAt: new Date().toISOString(),
  };

  await upsert(updatedState);
  console.log(
    "[update-linkedin] done. На следующем запуске LinkedIn-pack кеш " +
      "(data/documents/<pid>/linkedin-profile.json) автоматически " +
      "инвалидируется (URL mismatch) и Apify дёрнется свежо.",
  );
}

main().catch((err) => {
  console.error("[update-linkedin] fatal:", err);
  process.exit(1);
});
