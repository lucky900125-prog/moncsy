import type { AppConfig } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { MockProvider } from "./mock.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";
import type { AIProvider } from "./types.js";

export type { AIProvider, ChatMessage, CompleteOptions } from "./types.js";
export { MockProvider } from "./mock.js";

export function createAIProvider(cfg: AppConfig["ai"], env: NodeJS.ProcessEnv = process.env): AIProvider {
  const settings = {
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    timeoutMs: Number(env.AI_TIMEOUT_MS) > 0 ? Number(env.AI_TIMEOUT_MS) : undefined,
    anthropicFallbacks: cfg.anthropicFallbacks,
    jsonMode: (env.AI_JSON_MODE || "on").toLowerCase() !== "off",
  };
  switch (cfg.provider) {
    case "anthropic":
      return new AnthropicProvider(settings);
    case "openai":
      return new OpenAIProvider(settings);
    case "ollama":
      return new OllamaProvider(settings);
    case "mock":
      return new MockProvider();
  }
}
