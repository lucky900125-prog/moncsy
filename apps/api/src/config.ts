import { readFileSync } from "node:fs";
import { CATALOG } from "./ai/catalog.js";

export type AIProviderName = "anthropic" | "openai" | "gemini" | "ollama" | "mock";

/** A provider this server can call: it has its key (or needs none), and the models it may be asked for. */
export interface AIProviderConfig {
  name: AIProviderName;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  /** the models offered, the default first */
  models: string[];
  customModel: boolean;
}
export type RevolutMode = "business-api" | "open-banking" | "csv";

export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  corsOrigin: string;
  /** when set, every /api route except /health needs "Authorization: Bearer <apiToken>" */
  apiToken: string | undefined;
  /** number of reverse proxies in front of the server whose X-Forwarded-For is trusted; 0 = none */
  trustProxyHops: number;
  defaultCurrency: string;
  /** time zone of the wall-clock times written in bank statements */
  statementTz: string;
  ai: {
    /** the default provider, used when a request names none */
    provider: AIProviderName;
    model: string | undefined;
    /** every provider with a key, the default first; only the mock when the default is the mock */
    providers: AIProviderConfig[];
    apiKey: string | undefined;
    baseUrl: string | undefined;
    anthropicFallbacks: boolean;
    /** AI calls allowed per UTC day; 0 turns the AI off */
    dailyLimit: number;
  };
  revolut: {
    mode: RevolutMode;
    businessToken: string | undefined;
    env: "production" | "sandbox";
  };
}

function pickAIProvider(env: NodeJS.ProcessEnv): AIProviderName {
  const explicit = env.AI_PROVIDER?.trim().toLowerCase();
  if (explicit && explicit in CATALOG) return explicit as AIProviderName;
  if (explicit) throw new Error(`Unknown AI_PROVIDER "${explicit}" (expected ${Object.keys(CATALOG).join("|")})`);
  // No explicit provider: a key picks it. Without one the API refuses to start rather than answer with the
  // mock's sample data, which looks like a working AI until someone reads the "mock" badge.
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.OPENAI_API_KEY) return "openai";
  if (env.GEMINI_API_KEY) return "gemini";
  throw new Error(
    "No AI provider is set: put AI_PROVIDER=anthropic and ANTHROPIC_API_KEY in .env (or openai with OPENAI_API_KEY, " +
      "or gemini with GEMINI_API_KEY), or AI_PROVIDER=mock for sample answers without a key",
  );
}

/**
 * The default provider takes AI_API_KEY, AI_BASE_URL and AI_MODEL; every other provider with its own key is offered too.
 * A model named in AI_MODEL that is not on the list joins it, since someone asked for it by name.
 */
function pickAIProviders(env: NodeJS.ProcessEnv, provider: AIProviderName): AIProviderConfig[] {
  const entry = (name: AIProviderName, isDefault: boolean): AIProviderConfig | null => {
    const c = CATALOG[name];
    const apiKey = (isDefault ? env.AI_API_KEY : undefined) || (c.keyEnv ? env[c.keyEnv] : undefined) || undefined;
    const baseUrl = (isDefault ? env.AI_BASE_URL : undefined) || c.baseUrl;
    if (!isDefault && (!c.keyEnv || !apiKey)) return null;
    const model = isDefault ? env.AI_MODEL?.trim() : undefined;
    const models = model && !c.models.includes(model) ? [model, ...c.models] : model ? [model, ...c.models.filter((m) => m !== model)] : c.models;
    // Another endpoint (OpenRouter, LM Studio) has models of its own, which no list here can name.
    return { name, apiKey, baseUrl, models, customModel: c.customModel || (isDefault && !!env.AI_BASE_URL) };
  };
  const first = entry(provider, true)!;
  if (provider === "mock") return [first];
  const others = (["anthropic", "openai", "gemini"] as const).filter((n) => n !== provider).map((n) => entry(n, false));
  return [first, ...others.filter((o): o is AIProviderConfig => o !== null)];
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

function pickProxyHops(env: NodeJS.ProcessEnv): number {
  const raw = env.TRUST_PROXY_HOPS?.trim();
  if (!raw) return 0;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) throw new Error(`Invalid TRUST_PROXY_HOPS "${raw}" (expected an integer 0-10)`);
  return hops;
}

function pickAIDailyLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.AI_DAILY_LIMIT?.trim();
  if (!raw) return 100;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`Invalid AI_DAILY_LIMIT "${raw}" (expected a whole number of AI calls a day, 0 or more)`);
  return limit;
}

/** Checked at start: an unknown zone would otherwise fail every statement import with a 500. */
function pickStatementTz(env: NodeJS.ProcessEnv): string {
  const tz = env.STATEMENT_TZ?.trim() || "Europe/Budapest";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    throw new Error(`Invalid STATEMENT_TZ "${tz}" (expected an IANA time zone such as Europe/Budapest)`);
  }
  return tz;
}

function pickDefaultCurrency(env: NodeJS.ProcessEnv): string {
  const raw = env.DEFAULT_CURRENCY?.trim() || "HUF";
  if (!/^[A-Za-z]{3}$/.test(raw)) throw new Error(`Invalid DEFAULT_CURRENCY "${raw}" (expected a three-letter ISO 4217 code such as HUF)`);
  return raw.toUpperCase();
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Without a token the API trusts every caller, which is only safe when nothing but this machine can reach it.
 * Listening on another address therefore needs API_TOKEN, or ALLOW_NO_AUTH=1 as an explicit, logged choice.
 */
export function assertSafeExposure(cfg: AppConfig, env: NodeJS.ProcessEnv = process.env): string | null {
  if (cfg.apiToken || LOOPBACK.has(cfg.host)) return null;
  if (env.ALLOW_NO_AUTH === "1") return `Listening on ${cfg.host} without API_TOKEN (ALLOW_NO_AUTH=1): anyone who can reach this port can read and change all data.`;
  throw new Error(
    `HOST=${cfg.host} exposes the API beyond this machine, but API_TOKEN is not set. Set API_TOKEN to a long random value ` +
      `(and enter it in the app's settings), or set ALLOW_NO_AUTH=1 to run without one on a network you trust.`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const provider = pickAIProvider(env);
  const apiKey =
    env.AI_API_KEY ||
    (CATALOG[provider].keyEnv ? env[CATALOG[provider].keyEnv!] : undefined);
  const keyNames = ["AI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"].filter((k) => env[k]);
  if (provider === "mock" && keyNames.length) {
    throw new Error(`AI_PROVIDER=mock, but ${keyNames.join(", ")} is set: set AI_PROVIDER to the provider of that key, or remove the key`);
  }
  // An OpenAI-compatible server elsewhere (LM Studio) may need no key; the official endpoints all do.
  const keyEnv = CATALOG[provider].keyEnv;
  if (keyEnv && !apiKey && !(provider === "openai" && env.AI_BASE_URL)) {
    throw new Error(`AI_PROVIDER=${provider} requires ${keyEnv} (or AI_API_KEY)`);
  }
  return {
    port: pickPort(env),
    host: env.HOST || "127.0.0.1",
    dbPath: env.DB_PATH || "./data/expense.db",
    corsOrigin: env.CORS_ORIGIN || "http://localhost:5173,http://localhost:4173",
    apiToken: (env.API_TOKEN_FILE ? readFileSync(env.API_TOKEN_FILE, "utf8") : env.API_TOKEN)?.trim() || undefined,
    trustProxyHops: pickProxyHops(env),
    defaultCurrency: pickDefaultCurrency(env),
    statementTz: pickStatementTz(env),
    ai: {
      provider,
      model: env.AI_MODEL || undefined,
      providers: pickAIProviders(env, provider),
      apiKey: apiKey || undefined,
      baseUrl: env.AI_BASE_URL || undefined,
      anthropicFallbacks: (env.ANTHROPIC_FALLBACKS || "on").toLowerCase() !== "off",
      dailyLimit: pickAIDailyLimit(env),
    },
    revolut: {
      mode: pickRevolutMode(env),
      businessToken: env.REVOLUT_BUSINESS_TOKEN || undefined,
      env: env.REVOLUT_ENV === "sandbox" ? "sandbox" : "production",
    },
  };
}
