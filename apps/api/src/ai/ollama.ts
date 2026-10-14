import { HttpError } from "../errors.js";
import { cutOff, postJson, unsupportedMedia } from "./http.js";
import type { AIProvider, ChatMessage, CompleteOptions, ProviderSettings } from "./types.js";

interface OllamaChatResponse {
  message?: { content?: string };
  done_reason?: string;
}

/** Local Ollama server (POST {base}/api/chat). Use a vision model (e.g. llama3.2-vision, qwen2.5vl) for receipts. */
export class OllamaProvider implements AIProvider {
  readonly name = "ollama";
  readonly model: string;
  private readonly base: string;

  constructor(private readonly s: ProviderSettings) {
    this.base = (s.baseUrl ?? "http://localhost:11434").replace(/\/+$/, "");
    this.model = s.model ?? "llama3.2-vision";
  }

  complete(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<string> {
    return this.send(messages, opts);
  }

  async vision(imageBase64: string, mime: string, prompt: string, opts: CompleteOptions = {}): Promise<string> {
    if (!mime.startsWith("image/") || mime === "image/heic" || mime === "image/heif") {
      throw unsupportedMedia(this.name, mime, "Ollama accepts JPEG/PNG/WebP images only");
    }
    return this.send([{ role: "user", content: prompt, images: [imageBase64] }], opts);
  }

  private async send(messages: unknown[], opts: CompleteOptions): Promise<string> {
    const body: Record<string, unknown> = { model: this.model, messages, stream: false };
    if (opts.json) body.format = "json";
    const options: Record<string, number> = {};
    if (opts.temperature !== undefined) options.temperature = opts.temperature;
    if (opts.maxTokens) options.num_predict = opts.maxTokens;
    if (Object.keys(options).length) body.options = options;
    const res = (await postJson(this.name, `${this.base}/api/chat`, body, {}, this.s.timeoutMs ?? 180_000)) as OllamaChatResponse;
    if (res.done_reason === "length") throw cutOff(this.name, opts.maxTokens);
    const text = res.message?.content ?? "";
    if (!text.trim()) throw new HttpError(502, `AI provider "ollama" returned no text`);
    return text;
  }
}
