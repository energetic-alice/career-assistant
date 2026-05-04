import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Быстрый smoke-тест: умеет ли Claude сам скачивать картинку по URL
 * (вариант A), и работает ли fallback через base64 (вариант B).
 *
 * Запуск:
 *   npx tsx src/scripts/test-claude-vision.ts <image-url>
 *
 * По умолчанию прогоняет на LinkedIn-аватаре alicecybergirl (если URL
 * публично доступен) + fallback на unsplash.
 */

const MODEL = process.env.LINKEDIN_PACK_MODEL || "claude-sonnet-4-20250514";

async function tryUrlMode(url: string): Promise<void> {
  console.log(`\n── VARIANT A: image source "url" ──`);
  console.log(`[test] URL: ${url}`);
  const client = new Anthropic();
  const t0 = Date.now();
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url } as unknown as {
                type: "url";
                url: string;
              },
            },
            {
              type: "text",
              text: "Ты эксперт по LinkedIn-профилям. Кратко (1-2 предложения) оцени эту картинку как LinkedIn-аватар: деловая ли, нейтральный ли фон, селфи или нет. Отвечай по-русски.",
            },
          ],
        },
      ],
    });
    const ms = Date.now() - t0;
    const block = resp.content.find((b) => b.type === "text");
    console.log(
      `[test] OK in=${resp.usage.input_tokens} out=${resp.usage.output_tokens} ${(ms / 1000).toFixed(1)}s`,
    );
    console.log(`[test] answer:\n${block && block.type === "text" ? block.text : "(no text block)"}`);
  } catch (err) {
    console.error(
      `[test] VARIANT A failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function tryBase64Mode(url: string): Promise<void> {
  console.log(`\n── VARIANT B: fetch + base64 ──`);
  console.log(`[test] fetching ${url}`);
  const t0 = Date.now();
  let bytes: ArrayBuffer;
  let contentType = "image/jpeg";
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    contentType = resp.headers.get("content-type") || contentType;
    bytes = await resp.arrayBuffer();
    console.log(
      `[test] fetched ${(bytes.byteLength / 1024).toFixed(1)} KB content-type=${contentType}`,
    );
  } catch (err) {
    console.error(
      `[test] fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const b64 = Buffer.from(bytes).toString("base64");
  const client = new Anthropic();
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: contentType as
                  | "image/jpeg"
                  | "image/png"
                  | "image/gif"
                  | "image/webp",
                data: b64,
              },
            },
            {
              type: "text",
              text: "Ты эксперт по LinkedIn-профилям. Кратко (1-2 предложения) оцени эту картинку как LinkedIn-аватар: деловая ли, нейтральный ли фон, селфи или нет. Отвечай по-русски.",
            },
          ],
        },
      ],
    });
    const ms = Date.now() - t0;
    const block = resp.content.find((b) => b.type === "text");
    console.log(
      `[test] OK in=${resp.usage.input_tokens} out=${resp.usage.output_tokens} ${(ms / 1000).toFixed(1)}s`,
    );
    console.log(`[test] answer:\n${block && block.type === "text" ? block.text : "(no text block)"}`);
  } catch (err) {
    console.error(
      `[test] VARIANT B failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function main(): Promise<void> {
  const url =
    process.argv[2] ||
    "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400";

  await tryUrlMode(url);
  await tryBase64Mode(url);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(1);
});
