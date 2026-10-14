import { HttpError } from "../errors.js";
import { postJson, unsupportedMedia } from "./http.js";
import type { AIProvider, ChatMessage, CompleteOptions, ProviderSettings } from "./types.js";

const DEFAULT_BASE = "https://api.anthropic.com";
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  model?: string;
}

/** Anthropic Messages API (POST /v1/messages) over plain fetch. */
export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly base: string;

  constructor(private readonly s: ProviderSettings) {
    if (!s.apiKey) throw new Error("AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY (or AI_API_KEY)");
    this.model = s.model ?? "claude-sonnet-5-5";
    this.base = (s.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  }

  async complete(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<string> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const rest = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
    return this.send(system, rest, opts);
  }

  async vision(imageBase64: string, mime: string, prompt: string, opts: CompleteOptions = {}): Promise<string> {
    let block: unknown;
    if (mime === "application/pdf") {
      block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: imageBase64 } };
    } else if (IMAGE_MIMES.has(mime)) {
      block = { type: "image", source: { type: "base64", media_type: mime, data: imageBase64 } };
    } else {
      throw unsupportedMedia(this.name, mime, "convert HEIC photos to JPEG or PNG first");
    }
    return this.send("", [{ role: "user", content: [block, { type: "text", text: prompt }] }], opts);
  }

  private async send(system: string, messages: unknown[], opts: CompleteOptions): Promise<string> {
    const headers: Record<string, string> = {
      "x-api-key": this.s.apiKey!,
      "anthropic-version": "2023-06-01",
    };
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: opts.maxTokens ?? 16000,
      messages,
    };
    const jsonRule = opts.json ? "Respond with a single JSON object only: no prose, no Markdown code fences." : "";
    const sys = [system, jsonRule].filter(Boolean).join("\n\n");
    if (sys) body.system = sys;
    // Server-side refusal fallback; only meaningful against Anthropic's own API.
    if (this.s.anthropicFallbacks !== false && this.base === DEFAULT_BASE) {
      headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
      body.fallbacks = "default";
    }
    const res = (await postJson(this.name, `${this.base}/v1/messages`, body, headers, this.s.timeoutMs ?? 90_000)) as AnthropicResponse;
    if (res.stop_reason === "refusal") {
      const why = res.stop_details?.explanation ?? res.stop_details?.category ?? "no details";
      throw new HttpError(502, `AI provider "anthropic" declined the request (${why})`);
    }
    if (res.stop_reason === "max_tokens") {
      throw new HttpError(502, `AI provider "anthropic" hit max_tokens; the answer was truncated`);
    }
    const text = (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    if (!text.trim()) throw new HttpError(502, `AI provider "anthropic" returned no text`);
    return text;
  }
}
