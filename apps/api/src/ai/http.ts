import { HttpError } from "../errors.js";

/** POST JSON with a timeout; any transport or non-2xx failure becomes a 502 naming the provider. */
export async function postJson(
  provider: string,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new HttpError(502, `AI provider "${provider}" request failed: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(502, `AI provider "${provider}" returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, `AI provider "${provider}" returned a non-JSON HTTP body: ${text.slice(0, 200)}`);
  }
}

/**
 * The model stopped at the token limit, so its JSON is incomplete. That is a property of the input (a long statement,
 * a dense receipt), not a failure of the provider, so it is a 422 that says what to do instead of a 502.
 */
export function cutOff(provider: string, maxTokens: number | undefined): HttpError {
  return new HttpError(
    422,
    `The AI answer was cut off at ${maxTokens ? `${maxTokens} tokens` : "the provider's token limit"} (${provider}): ` +
      "the document or question needs a longer answer than one request gives. " +
      "Split the document into smaller parts; for a bank statement, export it as CSV or XLSX instead.",
  );
}

export function unsupportedMedia(provider: string, mime: string, hint = ""): HttpError {
  return new HttpError(415, `AI provider "${provider}" cannot read ${mime} files${hint ? `: ${hint}` : ""}`);
}
