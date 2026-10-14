import { HttpError } from "../errors.js";
import { postJson } from "./http.js";
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
  readonly name = "openai";
  readonly model: string;
  private readonly base: string;

  constructor(private readonly s: ProviderSettings) {
    this.base = (s.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    if (!s.apiKey && this.base.includes("api.openai.com")) {
      throw new Error("AI_PROVIDER=openai requires OPENAI_API_KEY (or AI_API_KEY)");
    }
    this.model = s.model ?? "gpt-4.1-mini";
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
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
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
    if (choice?.message?.refusal) throw new HttpError(502, `AI provider "openai" refused: ${choice.message.refusal}`);
    if (choice?.finish_reason === "length") throw new HttpError(502, `AI provider "openai" hit the token limit; the answer was truncated`);
    const text = choice?.message?.content ?? "";
    if (!text.trim()) throw new HttpError(502, `AI provider "openai" returned no text`);
    return text;
  }
}
