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

  it("sends the AI a photo without the place, device and owner its EXIF, XMP and comments name", async () => {
    // EXIF (big-endian TIFF): IFD0 with Orientation 6 and the camera Make.
    const tiff = Buffer.from("4d4d002a000000080002011200030000000100060000010f000200000011000000260000000053656372657450686f6e654d616b657200", "hex");
    const seg = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
    const photo = Buffer.concat([
      FAKE_JPEG.subarray(0, 20),
      seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff])),
      seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta photoshop:City="Budapest"/>', "latin1")),
      seg(0xfe, Buffer.from("owner: Kovacs Anna", "latin1")),
      FAKE_JPEG.subarray(20),
    ]);
    const seen: Buffer[] = [];
    const answer = JSON.stringify({ merchant: "Spar", date: "2026-10-01", total: 459, currency: "HUF", items: [], suggestedCategoryId: null, confidence: 0.9 });
    const app = await testApp({ ai: { ...canned(answer), vision: async (b64) => (seen.push(Buffer.from(b64, "base64")), answer) } });
    const r = await app.inject({ method: "POST", url: "/api/receipts/scan", ...multipart("blokk.jpg", "image/jpeg", photo) });
    expect(r.statusCode, r.body).toBe(200);
    expect(seen).toHaveLength(1);
    for (const leak of ["SecretPhoneMaker", "Budapest", "Kovacs", "xmpmeta"]) expect(seen[0]!.includes(leak), leak).toBe(false);
    // What decoding needs is all there: the image bytes as sent, and the orientation in an EXIF block of its own.
    expect(seen[0]!.subarray(0, 20)).toEqual(FAKE_JPEG.subarray(0, 20));
    expect(seen[0]!.subarray(56)).toEqual(FAKE_JPEG.subarray(20));
    expect(seen[0]!.subarray(20, 56).toString("hex")).toMatch(/^ffe10022457869660000.*01120003000000010006/);

    const broken = await app.inject({ method: "POST", url: "/api/receipts/scan", ...multipart("blokk.jpg", "image/jpeg", FAKE_JPEG.subarray(0, 200)) });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error).toMatch(/^The image is not a readable JPEG: /);
    expect(seen).toHaveLength(1);
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

  it("keeps the scan when only a product detail of a line is off", async () => {
    const item = { name: "Tej", unitPrice: 459, total: 459, product: "", brand: "", packSize: 0, packUnit: "L" };
    const answer = JSON.stringify({ merchant: "Spar", date: "2026-10-01", total: 459, currency: "HUF", items: [item], suggestedCategoryId: null, confidence: 0.9 });
    const app = await testApp({ ai: canned(answer) });
    const r = await app.inject({ method: "POST", url: "/api/receipts/scan", ...multipart("a.jpg", "image/jpeg", FAKE_JPEG) });
    expect(r.statusCode).toBe(200);
    expect(r.json().items).toMatchObject([{ name: "Tej", product: null, brand: null, packSize: null, packUnit: "l" }]);
    await app.close();
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
    await add(400000, "2026-09-01", "Munkabér", "income");
    await add(-60000, "2026-09-05", "Tesco", "groceries");
    await add(-150000, "2026-09-10", "Albérlet", "housing");
    await add(400000, "2026-10-01", "Munkabér", "income");
    await add(-90000, "2026-10-05", "Tesco", "groceries");
    await add(-150000, "2026-10-10", "Albérlet", "housing");
    await add(-12000, "2026-10-12", "Wolt", "restaurant");
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
  it("picks the provider by name or by key, and never falls back to the mock without being told to", async () => {
    const cfg = loadConfig({ AI_PROVIDER: "mock" });
    expect(cfg.ai.provider).toBe("mock");
    expect(createAIProvider(cfg.ai).name).toBe("mock");
    expect(loadConfig({ ANTHROPIC_API_KEY: "k" }).ai.provider).toBe("anthropic");
    expect(loadConfig({ OPENAI_API_KEY: "k" }).ai.provider).toBe("openai");
    expect(() => loadConfig({ AI_PROVIDER: "grok" })).toThrow(/Unknown AI_PROVIDER "grok" \(expected anthropic|openai|gemini|ollama|mock\)/);
    expect(() => loadConfig({})).toThrow(/No AI provider is set: put AI_PROVIDER=anthropic and ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ AI_PROVIDER: "", ANTHROPIC_API_KEY: "" })).toThrow(/No AI provider is set/);
    expect(() => loadConfig({ AI_PROVIDER: "mock", ANTHROPIC_API_KEY: "k" })).toThrow(
      "AI_PROVIDER=mock, but ANTHROPIC_API_KEY is set: set AI_PROVIDER to the provider of that key, or remove the key",
    );
    // A named provider without its key: the reason, at start.
    expect(() => createAIProvider(loadConfig({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "" }).ai)).toThrow(
      "AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY (or AI_API_KEY)",
    );
  });

  it("validates PORT and REVOLUT_MODE instead of starting with NaN or an unknown mode", () => {
    expect(loadConfig({ AI_PROVIDER: "mock" }).port).toBe(8787);
    expect(loadConfig({ AI_PROVIDER: "mock", PORT: " 3000 " }).port).toBe(3000);
    expect(() => loadConfig({ AI_PROVIDER: "mock", PORT: "abc" })).toThrow(/Invalid PORT "abc"/);
    expect(() => loadConfig({ AI_PROVIDER: "mock", PORT: "70000" })).toThrow(/Invalid PORT/);
    expect(loadConfig({ AI_PROVIDER: "mock", REVOLUT_MODE: " CSV " }).revolut.mode).toBe("csv");
    expect(loadConfig({ AI_PROVIDER: "mock", REVOLUT_BUSINESS_TOKEN: "t" }).revolut.mode).toBe("business-api");
    expect(() => loadConfig({ AI_PROVIDER: "mock", REVOLUT_MODE: "wise" })).toThrow(/Unknown REVOLUT_MODE "wise"/);
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

  it("anthropic: asks for adaptive thinking at medium effort, and a cut-off answer is a 422 that says why", async () => {
    // Thinking blocks come back first, with an empty text under Sonnet 5.5's default display.
    const fetchMock = vi.fn(async () =>
      Response.json({ content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "{}" }], stop_reason: "end_turn" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = new AnthropicProvider({ apiKey: "sk-test" });
    expect(await p.complete([{ role: "user", content: "hi" }], { json: true, maxTokens: 16000, temperature: 0 })).toBe("{}");
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "medium" }, max_tokens: 16000 });
    // Sonnet 5.5 answers 400 to any non-default temperature.
    expect(body.temperature).toBeUndefined();

    for (const stop of ["max_tokens", "model_context_window_exceeded"]) {
      fetchMock.mockResolvedValueOnce(Response.json({ content: [{ type: "text", text: '{"a":' }], stop_reason: stop }));
      const err = await p.vision("QUJD", "application/pdf", "read", { maxTokens: 16000 }).catch((e: unknown) => e);
      expect(err, stop).toMatchObject({ statusCode: 422 });
      expect((err as Error).message).toBe(
        'The AI answer was cut off at 16000 tokens (anthropic): the document or question needs a longer answer than one request gives. Split the document into smaller parts; for a bank statement, export it as CSV or XLSX instead.',
      );
    }
  });

  it("the other adapters report a cut-off answer the same way", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: '{"a":' }, finish_reason: "length" }] })));
    await expect(new OpenAIProvider({ apiKey: "k" }).complete([{ role: "user", content: "x" }], { maxTokens: 100 })).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringMatching(/^The AI answer was cut off at 100 tokens \(openai\)/),
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: { content: '{"a":' }, done: true, done_reason: "length" })));
    await expect(new OllamaProvider({}).complete([{ role: "user", content: "x" }], { maxTokens: 100 })).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringMatching(/^The AI answer was cut off at 100 tokens \(ollama\)/),
    });
  });

  it("leaves room for thinking: receipts and analyses may answer in 16000 tokens", async () => {
    const asked: { kind: string; maxTokens?: number }[] = [];
    const recording: AIProvider = {
      name: "recording",
      model: "r-1",
      complete: async (_m, o) => (asked.push({ kind: "complete", maxTokens: o?.maxTokens }), '{"summary":"x","insights":[]}'),
      vision: async (_i, _m, _p, o) => (asked.push({ kind: "vision", maxTokens: o?.maxTokens }), '{"merchant":"x","date":"2026-10-14","total":1,"currency":"HUF","items":[]}'),
    };
    const app = await testApp({ ai: recording });
    await app.inject({ method: "POST", url: "/api/receipts/scan", ...multipart("blokk.jpg", "image/jpeg", FAKE_JPEG) });
    await app.inject({ method: "POST", url: "/api/ai/analyze", payload: { from: "2026-10-01", to: "2026-10-31" } });
    expect(asked).toEqual([
      { kind: "vision", maxTokens: 16000 },
      { kind: "complete", maxTokens: 16000 },
    ]);
    await app.close();
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
