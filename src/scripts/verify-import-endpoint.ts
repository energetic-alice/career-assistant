import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { registerIntakeRoutes } from "../pipeline/intake.js";

const SEED = path.resolve(process.cwd(), "data/pipelineStates.seed.json");

process.env.ALLOW_SEED_IMPORT = "true";
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "test-secret";
process.env.DATA_DIR = path.resolve(process.cwd(), "data/__test"); // isolate from real store

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

async function main(): Promise<void> {
  const app = Fastify({ logger: false });
  await registerIntakeRoutes(app);

  const body = JSON.parse(fs.readFileSync(SEED, "utf-8"));

  console.log("Test 1: wrong secret should 401");
  const r1 = await app.inject({
    method: "POST",
    url: "/api/admin/import-seed",
    headers: { "x-webhook-secret": "wrong" },
    payload: body,
  });
  console.log("  status:", r1.statusCode, r1.json());

  console.log("\nTest 2: correct secret should 200 + apply");
  const r2 = await app.inject({
    method: "POST",
    url: "/api/admin/import-seed",
    headers: { "x-webhook-secret": process.env.WEBHOOK_SECRET! },
    payload: body,
  });
  console.log("  status:", r2.statusCode, r2.json());

  console.log("\nTest 3: GET /api/participants should return", Object.keys(body).length);
  const r3 = await app.inject({ method: "GET", url: "/api/participants" });
  const list = r3.json() as unknown[];
  console.log("  count:", list.length);

  console.log("\nTest 4: persistence — check written file");
  const fp = path.join(process.env.DATA_DIR!, "pipelineStates.json");
  const persisted = JSON.parse(fs.readFileSync(fp, "utf-8"));
  console.log("  persisted count:", Object.keys(persisted).length);

  console.log("\nTest 5: ALLOW_SEED_IMPORT=false should 403");
  process.env.ALLOW_SEED_IMPORT = "false";
  const r5 = await app.inject({
    method: "POST",
    url: "/api/admin/import-seed",
    headers: { "x-webhook-secret": process.env.WEBHOOK_SECRET! },
    payload: body,
  });
  console.log("  status:", r5.statusCode, r5.json());

  await app.close();
  fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
  console.log("\n✅ All tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
