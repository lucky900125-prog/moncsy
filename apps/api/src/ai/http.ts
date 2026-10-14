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

export function unsupportedMedia(provider: string, mime: string, hint = ""): HttpError {
  return new HttpError(415, `AI provider "${provider}" cannot read ${mime} files${hint ? `: ${hint}` : ""}`);
}
