import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseModelJson } from "../src/ai/json.js";
import { OpenAIProvider } from "../src/ai/openai.js";
import { requestLogFields } from "../src/app.js";
import { HttpError } from "../src/errors.js";
import { testApp } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

describe("HTTP hardening", () => {
  it("tells browsers not to store, sniff or refer API answers, errors included (SEC-API-10)", async () => {
    const app = await testApp();
    for (const url of ["/api/health", "/api/nincs-ilyen"]) {
      const res = await app.inject(url);
      expect(res.headers, url).toMatchObject({ "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    }
    await app.close();
  });

  it("keeps the AI provider's own error text out of the answer and in the log (SEC-API-09)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"message":"Incorrect API key provided: sk-pro***XYZ"}}', { status: 401 })));
    const err = await new OpenAIProvider({ apiKey: "k" }).complete([{ role: "user", content: "x" }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(502);
    expect((err as HttpError).message).toMatch(/returned HTTP 401.*API key/);
    expect((err as HttpError).message).not.toMatch(/sk-pro/);
    expect(String(((err as HttpError).cause as Error).message)).toMatch(/sk-pro/);
  });

  it("does not send the model's raw answer back to the client (SEC-API-09)", () => {
    const err = (() => {
      try {
        parseModelJson("openai", "Sure! {merchant: SPAR}", z.object({ merchant: z.string() }));
      } catch (e) {
        return e as HttpError;
      }
    })()!;
    expect(err.statusCode).toBe(502);
    expect(JSON.stringify({ error: err.message, details: err.details })).not.toMatch(/SPAR/);
    expect(String((err.cause as Error).message)).not.toMatch(/SPAR/);
  });

  it("logs the path of a request without its query string (RUN-10)", () => {
    const fields = requestLogFields({ method: "GET", url: "/api/transactions?q=gy%C3%B3gyszer&from=2026-10-01", ip: "10.0.0.1" });
    expect(fields).toEqual({ method: "GET", url: "/api/transactions", remoteAddress: "10.0.0.1" });
  });
});
