export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteOptions {
  /** Ask the provider for a JSON-only answer (uses the provider's JSON mode where it has one). */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  /** Text completion. Returns the raw text of the model's answer. */
  complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<string>;
  /** Single image/PDF + instruction. Returns the raw text of the model's answer. */
  vision(imageBase64: string, mime: string, prompt: string, opts?: CompleteOptions): Promise<string>;
}

export interface ProviderSettings {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Anthropic only: send the server-side refusal fallback (`fallbacks: "default"`). */
  anthropicFallbacks?: boolean;
  /** OpenAI-compatible only: send response_format json_object when json is requested. */
  jsonMode?: boolean;
}
