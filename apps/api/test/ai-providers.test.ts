import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../src/ai/openai.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { FAKE_JPEG, multipart } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const KEYS = { ANTHROPIC_API_KEY: "a-secret", GEMINI_API_KEY: "g-secret" };
const RECEIPT = '{"merchant":"Spar","date":"2026-10-14","total":100,"currency":"HUF","items":[],"suggestedCategoryId":null,"confidence":0.9}';
const ANALYSIS = '{"summary":"ok","insights":[]}';

/** Answers in the shape of whichever provider was called: Anthropic messages, or OpenAI-style chat completions. */
function stubProviders(answer: string) {
  const fetchMock = vi.fn(async (url: string) =>
    url.includes("api.anthropic.com")
      ? Response.json({ content: [{ type: "text", text: answer }], stop_reason: "end_turn" })
      : Response.json({ choices: [{ message: { content: answer }, finish_reason: "stop" }] }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function app(env: NodeJS.ProcessEnv = KEYS, dailyLimit?: number) {
  const base = loadConfig(env);
  const config = { ...base, dbPath: ":memory:", ai: { ...base.ai, ...(dailyLimit === undefined ? {} : { dailyLimit }) } };
  return buildApp({ db: await openDb(":memory:"), config });
}

describe("AI providers and models", () => {
  it("offers every provider with a key, the default first, Gemini on its OpenAI-compatible endpoint", () => {
    const all = loadConfig({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", GEMINI_API_KEY: "g" }).ai;
    expect(all.provider).toBe("anthropic");
    expect(all.providers.map((p) => [p.name, p.models[0], p.apiKey])).toEqual([
      ["anthropic", "claude-sonnet-5-5", "a"],
      ["openai", "gpt-6-luna", "o"],
      ["gemini", "gemini-3.5-flash-lite", "g"],
    ]);
    expect(all.providers[2]!.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta/openai");

    const gemini = loadConfig({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "g", AI_MODEL: "gemini-3.8-flash" }).ai;
    expect(gemini.providers.map((p) => p.name)).toEqual(["gemini"]);
    expect(gemini.providers[0]!.models).toEqual(["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.1-flash-lite"]);
    // A model named in AI_MODEL joins the list; another endpoint for the default provider takes any model name.
    const router = loadConfig({ AI_PROVIDER: "openai", AI_BASE_URL: "https://openrouter.ai/api/v1", AI_API_KEY: "k", AI_MODEL: "x/y" }).ai;
    expect(router.providers[0]).toMatchObject({ name: "openai", models: ["x/y", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"], customModel: true });
    expect(loadConfig({ AI_PROVIDER: "mock" }).ai.providers.map((p) => p.name)).toEqual(["mock"]);
    expect(() => loadConfig({ AI_PROVIDER: "gemini" })).toThrow("AI_PROVIDER=gemini requires GEMINI_API_KEY (or AI_API_KEY)");
    expect(() => loadConfig({ AI_PROVIDER: "mock", GEMINI_API_KEY: "g" })).toThrow(/AI_PROVIDER=mock, but GEMINI_API_KEY is set/);
    expect(loadConfig({ GEMINI_API_KEY: "g" }).ai.provider).toBe("gemini");
  });

  it("lists the providers for the settings, without any key", async () => {
    const a = await app();
    const res = await a.inject("/api/ai/providers");
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/a-secret|g-secret/);
    const body = res.json();
    expect(body.default).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(body.providers.map((p: { id: string; configured: boolean; keyEnv: string | null }) => [p.id, p.configured, p.keyEnv])).toEqual([
      ["anthropic", true, "ANTHROPIC_API_KEY"],
      ["openai", false, "OPENAI_API_KEY"],
      ["gemini", true, "GEMINI_API_KEY"],
      ["ollama", false, null],
    ]);
    expect(body.providers[2]).toEqual({
      id: "gemini",
      label: "Google Gemini",
      configured: true,
      models: ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.1-flash-lite"],
      defaultModel: "gemini-3.5-flash-lite",
      customModel: false,
      keyEnv: "GEMINI_API_KEY",
    });
    await a.close();
  });

  it("runs an analysis, a receipt scan and a PDF statement on the provider and model the request names", async () => {
    const fetchMock = stubProviders(ANALYSIS);
    const a = await app();
    const res = await a.inject({ method: "POST", url: "/api/ai/analyze", payload: { from: "2026-10-01", to: "2026-10-31", provider: "gemini", model: "gemini-3.8-flash" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ provider: "gemini", model: "gemini-3.8-flash" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer g-secret");
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe("gemini-3.8-flash");
    // Not on Gemini's compatibility page, so not sent; the system prompt asks for JSON.
    expect(sent.response_format).toBeUndefined();

    // Without a choice: the default.
    expect((await a.inject({ method: "POST", url: "/api/ai/analyze", payload: { from: "2026-10-01", to: "2026-10-31" } })).json()).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    });
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe("https://api.anthropic.com/v1/messages");

    stubProviders(RECEIPT);
    const scan = await a.inject({ method: "POST", url: "/api/receipts/scan", ...multipart("b.jpg", "image/jpeg", FAKE_JPEG, "file", { provider: "anthropic", model: "claude-haiku-5-5" }) });
    expect(scan.statusCode).toBe(200);
    const scanFetch = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(scanFetch[1].body as string).model).toBe("claude-haiku-5-5");

    const pdf = await a.inject({
      method: "POST",
      url: "/api/statements/parse",
      ...multipart("k.pdf", "application/pdf", Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(32)]), "file", { provider: "openai" }),
    });
    expect(pdf.statusCode).toBe(400);
    expect(pdf.json().error).toBe('AI provider "openai" is not set up on this server: OPENAI_API_KEY is not set');
    await a.close();
  });

  it("refuses a provider or model the server does not offer with 400, never another one quietly", async () => {
    const fetchMock = stubProviders(ANALYSIS);
    const a = await app();
    const ask = async (extra: Record<string, string>) =>
      (await a.inject({ method: "POST", url: "/api/ai/analyze", payload: { from: "2026-10-01", to: "2026-10-31", ...extra } })).json();
    expect(await ask({ provider: "openai" })).toMatchObject({ error: 'AI provider "openai" is not set up on this server: OPENAI_API_KEY is not set' });
    expect(await ask({ provider: "grok" })).toMatchObject({ error: 'Unknown AI provider "grok" (expected anthropic|openai|gemini|ollama|mock)' });
    expect(await ask({ provider: "ollama" })).toMatchObject({
      error: 'AI provider "ollama" is not set up on this server: only the default provider (AI_PROVIDER) can be ollama',
    });
    expect(await ask({ provider: "anthropic", model: "gpt-6-luna" })).toMatchObject({
      error: 'Model "gpt-6-luna" is not offered for anthropic (choose one of: claude-sonnet-5-5, claude-opus-5-5, claude-haiku-5-5)',
    });
    // A model without a provider is the default provider's.
    expect(await ask({ model: "gemini-3.8-flash" })).toMatchObject({ error: expect.stringMatching(/^Model "gemini-3.8-flash" is not offered for anthropic/) });
    expect(fetchMock).not.toHaveBeenCalled();
    await a.close();
  });

  it("counts one daily limit across every provider", async () => {
    stubProviders(ANALYSIS);
    const a = await app(KEYS, 1);
    const ask = (provider: string) => a.inject({ method: "POST", url: "/api/ai/analyze", payload: { from: "2026-10-01", to: "2026-10-31", provider } });
    expect((await ask("gemini")).statusCode).toBe(200);
    expect((await ask("anthropic")).statusCode).toBe(429);
    await a.close();
  });

  it("openai: max_completion_tokens and the default temperature on OpenAI's own endpoint, max_tokens elsewhere", async () => {
    const fetchMock = stubProviders("{}");
    await new OpenAIProvider({ apiKey: "k" }).complete([{ role: "user", content: "x" }], { maxTokens: 100, temperature: 0 });
    await new OpenAIProvider({ apiKey: "k", baseUrl: "https://openrouter.ai/api/v1" }).complete([{ role: "user", content: "x" }], { maxTokens: 100, temperature: 0 });
    const [official, other] = fetchMock.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
    expect([official.model, official.max_completion_tokens, official.max_tokens, official.temperature]).toEqual(["gpt-6-luna", 100, undefined, undefined]);
    expect([other.max_tokens, other.temperature, other.max_completion_tokens]).toEqual([100, 0, undefined]);
  });
});
