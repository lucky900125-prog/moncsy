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

function pickRevolutMode(env: NodeJS.ProcessEnv): RevolutMode {
  const explicit = env.REVOLUT_MODE?.trim().toLowerCase();
  if (explicit === "business-api" || explicit === "open-banking" || explicit === "csv") return explicit;
  if (explicit) throw new Error(`Unknown REVOLUT_MODE "${explicit}" (expected business-api|open-banking|csv)`);
  return env.REVOLUT_BUSINESS_TOKEN ? "business-api" : "csv";
}

function pickPort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT?.trim();
  if (!raw) return 8787;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT "${raw}" (expected an integer 0-65535)`);
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const provider = pickAIProvider(env);
  const apiKey =
    env.AI_API_KEY ||
    (provider === "anthropic" ? env.ANTHROPIC_API_KEY : provider === "openai" ? env.OPENAI_API_KEY : undefined);
  return {
    port: pickPort(env),
    host: env.HOST || "127.0.0.1",
    dbPath: env.DB_PATH || "./data/expense.db",
    corsOrigin: env.CORS_ORIGIN || "http://localhost:5173,http://localhost:4173",
    defaultCurrency: (env.DEFAULT_CURRENCY || "HUF").toUpperCase(),
    ai: {
      provider,
      model: env.AI_MODEL || undefined,
      apiKey: apiKey || undefined,
      baseUrl: env.AI_BASE_URL || undefined,
      anthropicFallbacks: (env.ANTHROPIC_FALLBACKS || "on").toLowerCase() !== "off",
    },
    revolut: {
      mode: pickRevolutMode(env),
      businessToken: env.REVOLUT_BUSINESS_TOKEN || undefined,
      env: env.REVOLUT_ENV === "sandbox" ? "sandbox" : "production",
    },
  };
}
