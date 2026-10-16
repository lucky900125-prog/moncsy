import type { AIProviderInfo, AIProvidersResponse } from "@et/shared";
import type { AIProviderConfig, AIProviderName, AppConfig } from "../config.js";
import { badRequest } from "../errors.js";
import { CATALOG, PROVIDER_NAMES } from "./catalog.js";
import { createProviderFor } from "./index.js";
import { DailyLimitedProvider, DailyQuota } from "./quota.js";
import type { AIProvider } from "./types.js";

/** A model name a custom choice may use: what providers' ids look like (claude-…, org/model, llama3.2:3b). */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/**
 * The providers this server can call, and the one adapter per provider and model that a request picks. A request that
 * names a provider without a key, or a model that is not offered, gets 400: it never falls back to another one quietly.
 */
export class AIRegistry {
  private readonly quota: DailyQuota;
  private readonly providers: AIProviderConfig[];
  private readonly made = new Map<string, AIProvider>();

  /** injected: tests and index.ts hand over the default adapter; it is then the default provider's default model. */
  constructor(
    private readonly cfg: AppConfig["ai"],
    injected?: AIProvider,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.quota = new DailyQuota(cfg.dailyLimit);
    const configured = cfg.providers?.length ? cfg.providers : [];
    if (injected) {
      const own = configured.find((p) => p.name === injected.name);
      const rest = configured.filter((p) => p.name !== injected.name);
      const models = own ? [injected.model, ...own.models.filter((m) => m !== injected.model)] : [injected.model];
      const first: AIProviderConfig = {
        name: injected.name as AIProviderName,
        apiKey: own?.apiKey,
        baseUrl: own?.baseUrl,
        models,
        customModel: own?.customModel ?? false,
      };
      this.providers = [first, ...rest];
      this.made.set(key(first.name, injected.model), new DailyLimitedProvider(injected, this.quota));
    } else {
      if (!configured.length) throw new Error("no AI provider is configured");
      this.providers = configured;
    }
  }

  /** The default provider and its default model. */
  get default(): AIProvider {
    return this.pick();
  }

  /** The adapter for a provider and model; either left out means the default. */
  pick(provider?: string, model?: string): AIProvider {
    const name = provider?.trim().toLowerCase() || this.providers[0]!.name;
    const p = this.providers.find((x) => x.name === name);
    if (!p) {
      if (!(name in CATALOG)) throw badRequest(`Unknown AI provider "${name}" (expected ${PROVIDER_NAMES.join("|")})`);
      const keyEnv = CATALOG[name as AIProviderName].keyEnv;
      throw badRequest(
        keyEnv
          ? `AI provider "${name}" is not set up on this server: ${keyEnv} is not set`
          : `AI provider "${name}" is not set up on this server: only the default provider (AI_PROVIDER) can be ${name}`,
      );
    }
    const m = model?.trim() || p.models[0]!;
    if (!p.models.includes(m)) {
      if (!p.customModel) throw badRequest(`Model "${m}" is not offered for ${p.name} (choose one of: ${p.models.join(", ")})`);
      if (!MODEL_NAME.test(m)) throw badRequest(`"${m}" is not a model name`);
    }
    const k = key(p.name, m);
    let made = this.made.get(k);
    if (!made) {
      made = new DailyLimitedProvider(createProviderFor(p, m, this.cfg, this.env), this.quota);
      this.made.set(k, made);
    }
    return made;
  }

  /** What the settings offer. Keys never leave the server: only the name of the variable that would hold one. */
  list(): AIProvidersResponse {
    const d = this.default;
    const providers: AIProviderInfo[] = PROVIDER_NAMES.filter((n) => n !== "mock" || this.providers.some((p) => p.name === "mock")).map((n) => {
      const c = CATALOG[n];
      const p = this.providers.find((x) => x.name === n);
      const models = p?.models ?? c.models;
      return { id: n, label: c.label, configured: !!p, models, defaultModel: models[0]!, customModel: p?.customModel ?? c.customModel, keyEnv: c.keyEnv };
    });
    return { default: { provider: d.name, model: d.model }, providers };
  }
}

function key(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}
