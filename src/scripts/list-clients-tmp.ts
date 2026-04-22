import "dotenv/config";

interface Pipe { telegramNick?: string; stage?: string; stageOutputs?: { clientSummary?: any } }

async function main(): Promise<void> {
  const PROD_URL = process.env.PROD_URL || "https://career-assistant-w7z3.onrender.com";
  const res = await fetch(`${PROD_URL}/api/participants`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const states = (await res.json()) as Pipe[];

  const withSummary = states.filter((s) => s.stageOutputs?.clientSummary);
  console.log(`Всего клиентов: ${states.length}, с clientSummary: ${withSummary.length}\n`);
  for (const s of withSummary) {
    const cs = s.stageOutputs!.clientSummary;
    const nick = (s.telegramNick || "").replace(/^@/, "");
    const cur = cs.currentProfessionSlug || "<non-IT>";
    const des = (cs.desiredDirectionSlugs ?? []).map((d: any) => d.slug).join(",") || "∅";
    const target = (cs.targetMarketRegions ?? []).join(",") || "—";
    const stage = (s.stage || "—").padEnd(24);
    console.log(`@${nick.padEnd(22)} | stage=${stage} | cur=${cur.padEnd(22)} | des=${des.padEnd(40)} | tgt=${target}`);
  }
}
main();
