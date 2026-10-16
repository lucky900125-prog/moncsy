/** The AI service and model picked in Settings, sent with every analysis and receipt scan; none means the server's default. */
export type AiChoice = { provider: string; model: string };

const KEY = "moncsy-ai";

export function getAiChoice(): AiChoice | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<AiChoice> | null;
    return v && typeof v.provider === "string" && typeof v.model === "string" ? { provider: v.provider, model: v.model } : null;
  } catch {
    return null; // blocked storage or an unreadable value: the server's default
  }
}

/** Throws when the browser blocks storage, so the caller can say the choice was not kept. */
export function saveAiChoice(c: AiChoice | null) {
  if (c) localStorage.setItem(KEY, JSON.stringify(c));
  else localStorage.removeItem(KEY);
}
