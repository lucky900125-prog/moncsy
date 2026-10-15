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
    // The answer is the receipt or statement the owner sent, so neither it nor the parser's message (which quotes it)
    // goes to the client or to the server log: only its length and the kind of error do (SEC-API-09).
    throw new HttpError(502, `AI provider "${provider}" returned invalid JSON`, undefined, { cause: new Error(answerShape(raw, e)) });
  }
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new HttpError(
      502,
      `AI provider "${provider}" returned JSON that does not match the expected shape: ${issues.join("; ")}`,
      { issues },
      { cause: new Error(answerShape(raw)) },
    );
  }
  return r.data;
}

/** What the log may say about a model's answer without quoting it. */
function answerShape(raw: string, parseError?: unknown): string {
  const kind = parseError instanceof Error ? `${parseError.name}; ` : "";
  return `${kind}the answer was ${raw.length} characters`;
}
