/**
 * Быстрая валидация market whitelist hard-gate без полного прогона Phase 1.
 *
 * Берёт state клиентов с прода, читает `clientSummary.physicalCountry /
 * citizenships / targetMarketRegions / englishLevel`, пересчитывает
 * `accessibleMarkets` по новому `computeAccessibleMarkets` (с english-гейтом),
 * сверяет с тем что лежит в проде, и показывает `shouldWarnUsWithoutUsPresence`.
 *
 * Запуск:
 *   NICKS=olena_lugovaya,nadindalinkevich,olboyarshinova \
 *     npx tsx src/scripts/probe-market-whitelist.ts
 *
 * Без NICKS — прогонит всех КА2-клиентов с прода.
 */

import "dotenv/config";
import type { PipelineState } from "../schemas/pipeline-state.js";
import type { ClientSummary } from "../schemas/client-summary.js";
import {
  computeAccessibleMarkets,
  shouldShowUkDataAsEuProxy,
  shouldWarnUsWithoutUsPresence,
} from "../services/market-access.js";
import { normalizeNick } from "../services/intake-mapper.js";

const PROD_URL =
  process.env.PROD_URL ?? "https://career-assistant-w7z3.onrender.com";
const NICKS = (process.env.NICKS ?? "")
  .split(",")
  .map((s) => normalizeNick(s.trim()))
  .filter(Boolean);
const ONLY_PROGRAM = process.env.ONLY_PROGRAM ?? "КА2";

async function main() {
  console.log(`PROD_URL:     ${PROD_URL}`);
  console.log(`ONLY_PROGRAM: ${ONLY_PROGRAM}`);
  if (NICKS.length) console.log(`NICKS:        ${NICKS.join(", ")}`);
  console.log();

  const res = await fetch(`${PROD_URL}/api/participants`);
  if (!res.ok) throw new Error(`GET /api/participants → ${res.status}`);
  const all = (await res.json()) as PipelineState[];
  console.log(`Загружено ${all.length} клиентов с прода.\n`);

  for (const s of all) {
    const nick = normalizeNick(s.telegramNick);
    if (NICKS.length && !NICKS.includes(nick)) continue;
    const outs = (s.stageOutputs ?? {}) as Record<string, unknown>;
    const program = (outs.program as string | undefined) ?? "—";
    if (!NICKS.length && ONLY_PROGRAM && program !== ONLY_PROGRAM) continue;

    const cs = outs.clientSummary as ClientSummary | undefined;
    if (!cs) {
      console.log(`  @${nick.padEnd(22)} ${program.padEnd(5)} — нет clientSummary, skip`);
      continue;
    }

    const oldAccess = cs.accessibleMarkets ?? [];
    const targets = cs.targetMarketRegions ?? [];
    const country = cs.physicalCountry ?? "";
    const citizenships = cs.citizenships ?? [];
    const eng = cs.englishLevel ?? "";

    const newAccess = computeAccessibleMarkets({
      citizenships,
      physicalCountry: country,
      targetMarketRegions: targets,
      englishLevel: eng,
    });
    const ukProxy = shouldShowUkDataAsEuProxy(newAccess);
    const warnUs = shouldWarnUsWithoutUsPresence({
      targetMarketRegions: targets,
      physicalCountry: country,
    });

    const eq = JSON.stringify([...oldAccess].sort()) === JSON.stringify([...newAccess].sort());
    const mark = eq ? "=" : "≠";

    console.log(
      `\n@${nick} (${program})  ${cs.firstNameLatin ?? ""} ${cs.lastNameLatin ?? ""}`,
    );
    console.log(
      `  location=${country || "—"} | citizenships=[${citizenships.join(", ") || "—"}] | english=${eng || "—"}`,
    );
    console.log(`  target=[${targets.join(", ") || "—"}]`);
    console.log(`  access(old)=[${oldAccess.join(", ") || "∅"}]`);
    console.log(`  access(new)=[${newAccess.join(", ") || "∅"}]  ${mark}`);
    if (ukProxy) console.log(`  UK as EU-proxy: YES`);
    if (warnUs) console.log(`  US strategic alert: YES (клиент хотел US, но не в США)`);
    if (!eq) {
      const removed = oldAccess.filter((r) => !newAccess.includes(r));
      const added = newAccess.filter((r) => !oldAccess.includes(r));
      if (removed.length) console.log(`  removed: [${removed.join(", ")}]`);
      if (added.length) console.log(`  added:   [${added.join(", ")}]`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
