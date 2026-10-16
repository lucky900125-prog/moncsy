import type { AIProviderConfig, AppConfig } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { MockProvider } from "./mock.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";
import type { AIProvider } from "./types.js";

export type { AIProvider, ChatMessage, CompleteOptions } from "./types.js";
export { MockProvider } from "./mock.js";

/** One adapter for one provider and model. */
export function createProviderFor(
  p: Pick<AIProviderConfig, "name" | "apiKey" | "baseUrl">,
  model: string | undefined,
  cfg: Pick<AppConfig["ai"], "anthropicFallbacks">,
  env: NodeJS.ProcessEnv = process.env,
): AIProvider {
  const settings = {
    model,
    apiKey: p.apiKey,
    baseUrl: p.baseUrl,
    timeoutMs: Number(env.AI_TIMEOUT_MS) > 0 ? Number(env.AI_TIMEOUT_MS) : undefined,
    anthropicFallbacks: cfg.anthropicFallbacks,
    // AI_JSON_MODE is the openai provider's switch. Gemini's compatibility page documents no json_object mode, so it is
    // not sent there; the prompt asks for JSON either way.
    jsonMode: p.name === "openai" && (env.AI_JSON_MODE || "on").toLowerCase() !== "off",
  };
  switch (p.name) {
    case "anthropic":
      return new AnthropicProvider(settings);
    case "openai":
      return new OpenAIProvider(settings);
    case "gemini":
      return new OpenAIProvider(settings, "gemini");
    case "ollama":
      return new OllamaProvider(settings);
    case "mock":
      return new MockProvider();
  }
}

/** The default provider with its default model. */
export function createAIProvider(cfg: AppConfig["ai"], env: NodeJS.ProcessEnv = process.env): AIProvider {
  return createProviderFor({ name: cfg.provider, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl }, cfg.model, cfg, env);
}
