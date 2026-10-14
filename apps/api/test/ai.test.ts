import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../src/ai/anthropic.js";
import { createAIProvider, type AIProvider } from "../src/ai/index.js";
import { OllamaProvider } from "../src/ai/ollama.js";
import { OpenAIProvider } from "../src/ai/openai.js";
import { loadConfig } from "../src/config.js";
import { FAKE_JPEG, multipart, testApp } from "./helpers.js";

/** A provider that returns canned text, for exercising the strict-JSON validation. */
function canned(text: string): AIProvider {
  return { name: "canned", model: "canned-1", complete: async () => text, vision: async () => text };
}

afterEach(() => vi.unstubAllGlobals());

describe("POST /api/receipts/scan (mock provider)", () => {
  it("returns the mock receipt with a valid suggested category", async () => {
    const app = await testApp();
    const r = await app.inject({ method: "POST", url: "/api/receipts/scan", ...multipart("blokk.jpg", "image/jpeg", FAKE_JPEG) });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ merchant: "SPAR Magyarország Kft.", date: "2026-10-12", total: 4785, currency: "HUF", suggestedCategoryId: "groceries" });
    expect(body.items).toHaveLength(5);
    expect(body.items.reduce((s: number, i: { total: number }) => s + i.total, 0)).toBe(4785);
    expect(body.confidence).toBeGreaterThan(0);
    await app.close();
  });

  it("accepts PDFs by magic bytes even with a generic content type", async () => {
    const app = await testApp();
    const r = await app.inject({ method: "POST", url: "/api/receipts/scan", ...multipart("szamla", "application/octet-stream", Buffer.from("%PDF-1.7\n...")) });
    expect(r.statusCode).toBe(200);
    await app.close();
  });

  it("rejects unsupported types (415), missing files (415/400) and uploads over 10 MB (413)", async () => {
    const app = await testApp();
    const txt = await app.inject({ method: "POST", url: "/api/receipts/scan", ...multipart("a.txt", "text/plain", "hello") });
    expect(txt.statusCode).toBe(415);
    const notMultipart = await app.inject({ method: "POST", url: "/api/receipts/scan", payload: { a: 1 } });
    expect(notMultipart.statusCode).toBe(415);
    const wrongField = await app.inject({ method: "POST", url: "/api/receipts/scan", ...multipart("a.jpg", "image/jpeg", FAKE_JPEG, "image") });
    expect(wrongField.statusCode).toBe(400);
    const big = Buffer.concat([FAKE_JPEG, Buffer.alloc(10 * 1024 * 1024 + 1)]);
    const tooBig = await app.inject({ method: "POST", url: "/api/receipts/scan", ...multipart("big.jpg", "image/jpeg", big) });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error).toMatch(/10 MB/);
    await app.close();
  });

  it("returns 502 when the model's JSON is invalid or has the wrong shape", async () => {
    for (const [text, msg] of [
      ["Sure! Here is the receipt: {merchant: SPAR}", /invalid JSON/],
      [JSON.stringify({ merchant: "X", date: "12/10/2026", total: "4 785 Ft", currency: "HUF", items: [], suggestedCategoryId: null, confidence: 2 }), /does not match/],
    ] as const) {
      const app = await testApp({ ai: canned(text) });
      const r = await app.inject({ method: "POST", url: "/api/receipts/scan", ...multipart("a.jpg", "image/jpeg", FAKE_JPEG) });
      expect(r.statusCode).toBe(502);
      expect(r.json().error).toMatch(msg);
      await app.close();
    }
  });

  it("accepts fenced JSON, maps 'Ft' to HUF and drops unknown category ids", async () => {
    const answer = "```json\n" + JSON.stringify({ merchant: "Lidl", date: "2026-10-01", total: 990, currency: "Ft", items: [{ name: "Kenyér", unitPrice: 990, total: 990 }], suggestedCategoryId: "made-up", confidence: 0.5 }) + "\n```";
    const app = await testApp({ ai: canned(answer) });
    const r = await app.inject({ method: "POST", url: "/api/receipts/scan", ...multipart("a.png", "image/png", FAKE_JPEG) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ currency: "HUF", suggestedCategoryId: null, items: [{ name: "Kenyér", quantity: 1 }] });
    await app.close();
  });
});

describe("POST /api/ai/analyze", () => {
  async function seeded(ai?: AIProvider) {
    const app = await testApp({ ai });
    const add = (amount: number, date: string, merchant: string, categoryId: string | null) =>
      app.deps.repo.createTransaction({ amount, currency: "HUF", date, merchant, categoryId, source: "manual" });
    add(400000, "2026-09-01", "Munkabér", "income");
    add(-60000, "2026-09-05", "Tesco", "groceries");
    add(-150000, "2026-09-10", "Albérlet", "housing");
    add(400000, "2026-10-01", "Munkabér", "income");
    add(-90000, "2026-10-05", "Tesco", "groceries");
    add(-150000, "2026-10-10", "Albérlet", "housing");
    add(-12000, "2026-10-12", "Wolt", "restaurant");
    return app;
  }

  it("aggregates the range and returns the mock provider's insights", async () => {
    const calls: string[] = [];
    const mock = (await import("../src/ai/mock.js")).MockProvider;
    const spy = new mock();
    const orig = spy.complete.bind(spy);
    spy.complete = async (msgs, opts) => {
      calls.push(msgs.map((m) => m.content).join("\n"));
      return orig(msgs, opts);
    };
    const app = await seeded(spy);
    const r = await app.inject({ method: "POST", url: "/api/ai/analyze", payload: { from: "2026-09-01", to: "2026-10-31", question: "Hol spórolhatok?" } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ provider: "mock", model: "mock-1" });
    expect(body.summary).toContain("7 tranzakció");
    expect(body.insights[0]).toMatchObject({ title: "Legnagyobb kiadás: Lakhatás", severity: "warning" });
    expect(body.insights.some((i: { title: string; detail: string }) => i.title === "Nőttek a kiadások" && i.detail.includes("20.0%"))).toBe(true);

    // The provider sees the aggregate, never raw transaction rows.
    const sent = calls[0]!;
    expect(sent).toContain("Hol spórolhatok?");
    const agg = JSON.parse(sent.match(/<aggregate>([\s\S]*)<\/aggregate>/)![1]!);
    expect(agg.totals).toEqual({ income: 800000, expense: 462000, net: 338000, count: 7 });
    expect(agg.monthOverMonth).toMatchObject({ previousMonth: "2026-09", currentMonth: "2026-10", expenseChangePct: 20 });
    expect(agg.topMerchants[0]).toEqual({ merchant: "Albérlet", expense: 300000, count: 2 });
    expect(sent).not.toMatch(/"id":/);
    await app.close();
  });

  it("validates the request and maps bad model output to 502", async () => {
    const app = await seeded(canned(JSON.stringify({ summary: "ok", insights: [{ title: "t", detail: "d", severity: "critical" }] })));
    expect((await app.inject({ method: "POST", url: "/api/ai/analyze", payload: { from: "x" } })).statusCode).toBe(400);
    const r = await app.inject({ method: "POST", url: "/api/ai/analyze", payload: { from: "2026-09-01", to: "2026-10-31" } });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/insights\.0\.severity/);
    await app.close();
  });
});

describe("provider adapters (fetch stubbed, no network)", () => {
  it("selects mock by default when no key is set", () => {
    const cfg = loadConfig({});
    expect(cfg.ai.provider).toBe("mock");
    expect(createAIProvider(cfg.ai).name).toBe("mock");
    expect(loadConfig({ ANTHROPIC_API_KEY: "k" }).ai.provider).toBe("anthropic");
    expect(() => loadConfig({ AI_PROVIDER: "gemini" })).toThrow(/Unknown AI_PROVIDER/);
  });

  it("validates PORT and REVOLUT_MODE instead of starting with NaN or an unknown mode", () => {
    expect(loadConfig({}).port).toBe(8787);
    expect(loadConfig({ PORT: " 3000 " }).port).toBe(3000);
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/Invalid PORT "abc"/);
    expect(() => loadConfig({ PORT: "70000" })).toThrow(/Invalid PORT/);
    expect(loadConfig({ REVOLUT_MODE: " CSV " }).revolut.mode).toBe("csv");
    expect(loadConfig({ REVOLUT_BUSINESS_TOKEN: "t" }).revolut.mode).toBe("business-api");
    expect(() => loadConfig({ REVOLUT_MODE: "wise" })).toThrow(/Unknown REVOLUT_MODE "wise"/);
  });

  it("anthropic: Messages API request shape, image/PDF blocks, refusal handling", async () => {
    const fetchMock = vi.fn(async () => Response.json({ content: [{ type: "text", text: '{"a":1}' }], stop_reason: "end_turn" }));
    vi.stubGlobal("fetch", fetchMock);
    const p = new AnthropicProvider({ apiKey: "sk-test" });
    expect(p.model).toBe("claude-sonnet-5-5");
    expect(await p.complete([{ role: "system", content: "sys" }, { role: "user", content: "hi" }], { json: true })).toBe('{"a":1}');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }], fallbacks: "default" });
    expect(body.system).toMatch(/^sys\n\nRespond with a single JSON object/);
    expect(body.temperature).toBeUndefined();

    await p.vision("QUJD", "application/pdf", "read");
    const pdfBody = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(pdfBody.messages[0].content[0]).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "QUJD" } });
    await expect(p.vision("QUJD", "image/heic", "read")).rejects.toMatchObject({ statusCode: 415 });

    fetchMock.mockResolvedValueOnce(Response.json({ content: [], stop_reason: "refusal", stop_details: { category: "cyber" } }));
    await expect(p.complete([{ role: "user", content: "x" }])).rejects.toMatchObject({ statusCode: 502 });
    fetchMock.mockResolvedValueOnce(new Response("overloaded", { status: 529 }));
    await expect(p.complete([{ role: "user", content: "x" }])).rejects.toThrow(/HTTP 529/);
  });

  it("openai-compatible: base URL, bearer auth, json mode and image_url parts", async () => {
    const fetchMock = vi.fn(async () => Response.json({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAIProvider({ apiKey: "or-key", baseUrl: "https://openrouter.ai/api/v1/", model: "some/model" });
    await p.vision("QUJD", "image/png", "read", { json: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer or-key");
    const body = JSON.parse(init.body as string);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages.at(-1).content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } });
    // Local servers (LM Studio) need no key.
    expect(() => new OpenAIProvider({ baseUrl: "http://localhost:1234/v1" })).not.toThrow();
    expect(() => new OpenAIProvider({})).toThrow(/OPENAI_API_KEY/);
  });

  it("ollama: /api/chat with images and format=json", async () => {
    const fetchMock = vi.fn(async () => Response.json({ message: { content: "{}" }, done: true }));
    vi.stubGlobal("fetch", fetchMock);
    const p = new OllamaProvider({});
    await p.vision("QUJD", "image/jpeg", "read", { json: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/api/chat");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "llama3.2-vision", stream: false, format: "json", messages: [{ images: ["QUJD"] }] });
    await expect(p.vision("QUJD", "application/pdf", "read")).rejects.toMatchObject({ statusCode: 415 });
  });
});
