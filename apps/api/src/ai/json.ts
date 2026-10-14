import type { z } from "zod";
import { HttpError } from "../errors.js";

/**
 * Parses a model's answer as strict JSON and validates it. Tolerates only a surrounding
 * Markdown code fence; anything else that does not parse or validate is a 502.
 */
export function parseModelJson<T extends z.ZodType>(provider: string, raw: string, schema: T): z.infer<T> {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1]!;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new HttpError(502, `AI provider "${provider}" returned invalid JSON: ${(e as Error).message}`, {
      raw: raw.slice(0, 1000),
    });
  }
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new HttpError(502, `AI provider "${provider}" returned JSON that does not match the expected shape: ${issues.join("; ")}`, {
      issues,
      raw: raw.slice(0, 1000),
    });
  }
  return r.data;
}
