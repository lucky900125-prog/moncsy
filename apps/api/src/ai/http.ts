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
    // The provider's own error text goes to the server log (as the cause), not to the client (SEC-API-09).
    const cause = new Error(`${provider} answered: ${text.slice(0, 500)}`);
    throw new HttpError(502, `AI provider "${provider}" returned HTTP ${res.status} (${providerHint(res.status)})`, undefined, { cause });
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    // A 2xx body can carry the model's answer, so only its length is logged.
    const cause = new Error(`${(e as Error).name}; the body was ${text.length} characters`);
    throw new HttpError(502, `AI provider "${provider}" returned a body that is not JSON`, undefined, { cause });
  }
}

/** What the owner can do about a provider's status, said without repeating the provider's text. */
function providerHint(status: number): string {
  if (status === 401 || status === 403) return "check the API key";
  if (status === 404) return "check AI_MODEL and AI_BASE_URL";
  if (status === 429) return "rate limit or quota reached; try again later";
  if (status >= 500) return "the provider failed; try again later";
  return "the provider refused the request; the server log has its answer";
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
