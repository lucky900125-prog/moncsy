export type AIProviderName = "anthropic" | "openai" | "ollama" | "mock";
export type RevolutMode = "business-api" | "open-banking" | "csv";

export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  corsOrigin: string;
  defaultCurrency: string;
  ai: {
    provider: AIProviderName;
    model: string | undefined;
    apiKey: string | undefined;
    baseUrl: string | undefined;
    anthropicFallbacks: boolean;
  };
  revolut: {
    mode: RevolutMode;
    businessToken: string | undefined;
    env: "production" | "sandbox";
  };
}

function pickAIProvider(env: NodeJS.ProcessEnv): AIProviderName {
  const explicit = env.AI_PROVIDER?.trim().toLowerCase();
  if (explicit === "anthropic" || explicit === "openai" || explicit === "ollama" || explicit === "mock") {
    return explicit;
  }
  if (explicit) throw new Error(`Unknown AI_PROVIDER "${explicit}" (expected anthropic|openai|ollama|mock)`);
  // No explicit provider: use a real one only when a key is present, otherwise the offline mock.
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.OPENAI_API_KEY) return "openai";
  return "mock";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const provider = pickAIProvider(env);
  const apiKey =
    env.AI_API_KEY ||
    (provider === "anthropic" ? env.ANTHROPIC_API_KEY : provider === "openai" ? env.OPENAI_API_KEY : undefined);
  const revolutMode = (env.REVOLUT_MODE || (env.REVOLUT_BUSINESS_TOKEN ? "business-api" : "csv")) as RevolutMode;
  if (!["business-api", "open-banking", "csv"].includes(revolutMode)) {
    throw new Error(`Unknown REVOLUT_MODE "${revolutMode}" (expected business-api|open-banking|csv)`);
  }
  return {
    port: Number(env.PORT || 8787),
    host: env.HOST || "0.0.0.0",
    dbPath: env.DB_PATH || "./data/expense.db",
    corsOrigin: env.CORS_ORIGIN || "*",
    defaultCurrency: (env.DEFAULT_CURRENCY || "HUF").toUpperCase(),
    ai: {
      provider,
      model: env.AI_MODEL || undefined,
      apiKey: apiKey || undefined,
      baseUrl: env.AI_BASE_URL || undefined,
      anthropicFallbacks: (env.ANTHROPIC_FALLBACKS || "on").toLowerCase() !== "off",
    },
    revolut: {
      mode: revolutMode,
      businessToken: env.REVOLUT_BUSINESS_TOKEN || undefined,
      env: env.REVOLUT_ENV === "sandbox" ? "sandbox" : "production",
    },
  };
}
