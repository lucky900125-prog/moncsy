import type { AIProviderName } from "../config.js";

export interface CatalogEntry {
  label: string;
  /** the variable that holds this provider's key; null when it needs none */
  keyEnv: string | null;
  /** the models offered for choice, the default first */
  models: string[];
  /** another model name may be asked for (a local server runs whatever was pulled into it) */
  customModel: boolean;
  /** endpoint when it is not the adapter's own */
  baseUrl?: string;
}

/**
 * The models each provider offers in the settings, checked against the providers' model pages on 2026-10-16:
 * platform.claude.com (effort and adaptive thinking on all three Claude models), developers.openai.com/api/docs/models
 * (featured models), ai.google.dev/gemini-api/docs/models (stable; the four without a paid-only Pro tier).
 * Gemini runs through its OpenAI-compatible endpoint (ai.google.dev/gemini-api/docs/openai).
 */
export const CATALOG: Record<AIProviderName, CatalogEntry> = {
  anthropic: {
    label: "Anthropic Claude",
    keyEnv: "ANTHROPIC_API_KEY",
    models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
    customModel: false,
  },
  openai: {
    label: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    models: ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"],
    customModel: false,
  },
  gemini: {
    label: "Google Gemini",
    keyEnv: "GEMINI_API_KEY",
    models: ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.1-flash-lite"],
    customModel: false,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  ollama: {
    label: "Ollama (local)",
    keyEnv: null,
    models: ["llama3.2-vision", "qwen2.5vl"],
    customModel: true,
  },
  mock: {
    label: "Mock (sample answers)",
    keyEnv: null,
    models: ["mock-1"],
    customModel: false,
  },
};

export const PROVIDER_NAMES = Object.keys(CATALOG) as AIProviderName[];
