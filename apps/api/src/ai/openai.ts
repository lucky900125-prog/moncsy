import { HttpError } from "../errors.js";
import { cutOff, postJson } from "./http.js";
import type { AIProvider, ChatMessage, CompleteOptions, ProviderSettings } from "./types.js";

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
}

/**
 * OpenAI Chat Completions (POST {base}/chat/completions). Works with any OpenAI-compatible
 * server via AI_BASE_URL: OpenRouter (https://openrouter.ai/api/v1), Groq
 * (https://api.groq.com/openai/v1), LM Studio (http://localhost:1234/v1), vLLM, etc.
 */
export class OpenAIProvider implements AIProvider {
  readonly model: string;
  private readonly base: string;
  private readonly official: boolean;

  /** name: "gemini" for Google's OpenAI-compatible endpoint, which the same requests reach. */
  constructor(
    private readonly s: ProviderSettings,
    readonly name: "openai" | "gemini" = "openai",
  ) {
    this.base = (s.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.official = this.base.includes("api.openai.com");
    if (!s.apiKey && name === "openai" && this.official) {
      throw new Error("AI_PROVIDER=openai requires OPENAI_API_KEY (or AI_API_KEY)");
    }
    if (!s.apiKey && name === "gemini") throw new Error("AI_PROVIDER=gemini requires GEMINI_API_KEY (or AI_API_KEY)");
    this.model = s.model ?? (name === "gemini" ? "gemini-3.5-flash-lite" : "gpt-6-luna");
  }

  complete(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<string> {
    return this.send(messages, opts);
  }

  async vision(imageBase64: string, mime: string, prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const dataUrl = `data:${mime};base64,${imageBase64}`;
    // PDFs use the "file" content part (supported by OpenAI; some compatible servers ignore it).
    const media =
      mime === "application/pdf"
        ? { type: "file", file: { filename: "receipt.pdf", file_data: dataUrl } }
        : { type: "image_url", image_url: { url: dataUrl } };
    return this.send([{ role: "user", content: [{ type: "text", text: prompt }, media] }], opts);
  }

  private async send(messages: unknown[], opts: CompleteOptions): Promise<string> {
    const body: Record<string, unknown> = { model: this.model, messages };
    // OpenAI's own reasoning models (gpt-6) take max_completion_tokens and only the default temperature; max_tokens is
    // its deprecated name. Compatible servers (Gemini, OpenRouter, LM Studio) document max_tokens and temperature.
    if (this.official) {
      if (opts.maxTokens) body.max_completion_tokens = opts.maxTokens;
    } else {
      if (opts.maxTokens) body.max_tokens = opts.maxTokens;
      if (opts.temperature !== undefined) body.temperature = opts.temperature;
    }
    if (opts.json) {
      if (this.s.jsonMode !== false) body.response_format = { type: "json_object" };
      (messages as { role: string; content: unknown }[]).unshift({
        role: "system",
        content: "Respond with a single JSON object only: no prose, no Markdown code fences.",
      });
    }
    const headers: Record<string, string> = {};
    if (this.s.apiKey) headers.authorization = `Bearer ${this.s.apiKey}`;
    const res = (await postJson(this.name, `${this.base}/chat/completions`, body, headers, this.s.timeoutMs ?? 90_000)) as ChatCompletionResponse;
    const choice = res.choices?.[0];
    if (choice?.message?.refusal) throw new HttpError(502, `AI provider "${this.name}" refused: ${choice.message.refusal}`);
    if (choice?.finish_reason === "length") throw cutOff(this.name, opts.maxTokens);
    const text = choice?.message?.content ?? "";
    if (!text.trim()) throw new HttpError(502, `AI provider "${this.name}" returned no text`);
    return text;
  }
}
