import "dotenv/config";
import { writeFile } from "node:fs/promises";

/**
 * Пробный запуск актора `apimaestro/linkedin-profile-full-sections-scraper`
 * для сравнения с нашим текущим `apimaestro/linkedin-profile-detail`.
 *
 * Цель: проверить, присылает ли он реально полные секции
 * (skills, languages, certifications, projects, recommendations, honors)
 * и остались ли `basic_info.profile_picture_url` / `background_picture_url`,
 * которые мы сейчас используем для vision.
 *
 * Стоит ~$0.01 за запуск.
 */

const FULL_ACTOR = "apimaestro/linkedin-profile-full-sections-scraper";

async function main(): Promise<void> {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error("APIFY_API_TOKEN not set");

  const username = process.argv[2] || "alicecybergirl";
  console.log(`[test] running ${FULL_ACTOR} for ${username}`);

  const endpoint =
    `https://api.apify.com/v2/acts/${encodeURIComponent(FULL_ACTOR)}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&timeout=180`;

  const t0 = Date.now();
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username], includeEmail: false }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${body}`);
  }
  const items = (await resp.json()) as unknown;
  const ms = Date.now() - t0;
  console.log(`[test] done in ${(ms / 1000).toFixed(1)}s`);

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("empty dataset");
  }
  const item = items[0] as Record<string, unknown>;

  console.log("\n── Top-level keys ──");
  console.log(Object.keys(item));

  const basic = (item["basic_info"] as Record<string, unknown>) || {};
  console.log("\n── basic_info keys ──");
  console.log(Object.keys(basic));
  console.log("profile_picture_url:", basic["profile_picture_url"] ? "OK" : "MISSING");
  console.log("background_picture_url:", basic["background_picture_url"] ? "OK" : "MISSING");

  for (const key of [
    "skills",
    "languages",
    "certifications",
    "projects",
    "recommendations",
    "honors",
    "honors_and_awards",
    "volunteer",
    "posts",
  ]) {
    const v = item[key];
    if (Array.isArray(v)) {
      console.log(`${key}: array len=${v.length}`);
      if (v.length > 0) {
        console.log(`  sample[0]:`, JSON.stringify(v[0]).slice(0, 300));
      }
    } else if (v !== undefined) {
      console.log(`${key}: ${typeof v}`);
    }
  }

  const exp = item["experience"];
  if (Array.isArray(exp) && exp.length > 0) {
    console.log(`\n── experience[0] ──`);
    const e0 = exp[0] as Record<string, unknown>;
    console.log("keys:", Object.keys(e0));
    console.log("skills:", e0["skills"]);
  }

  const out = `probe-output/apify-full-${username}.json`;
  await writeFile(out, JSON.stringify(item, null, 2), "utf-8");
  console.log(`\n[test] full dataset saved to ${out}`);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(1);
});
