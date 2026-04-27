/**
 * Shared helpers for LLM → JSON pipelines:
 *   - strip ```json fences if Claude added them
 *   - safely parse with a useful error message
 */

export function unwrapJsonText(raw: string): string {
  let txt = raw.trim();
  if (txt.startsWith("```")) {
    txt = txt
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }
  return txt;
}

export function parseLlmJson<T = unknown>(raw: string, where: string): T {
  const txt = unwrapJsonText(raw);
  try {
    return JSON.parse(txt) as T;
  } catch (err) {
    throw new Error(
      `${where}: JSON parse failed (${err instanceof Error ? err.message : String(err)})\n` +
        `--- first 1000 chars of LLM output ---\n${txt.slice(0, 1000)}`,
    );
  }
}
