import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { FAKE_JPEG, multipart, testApp } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("AI daily limit", () => {
  it("answers 429 once the day's AI calls are used up, on every route that calls the AI, and starts again the next day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T23:59:00Z"));
    const app = await testApp({ config: { ai: { ...loadConfig({}).ai, dailyLimit: 2 } } });
    const scan = () => app.inject({ method: "POST", url: "/api/receipts/scan", ...multipart("blokk.jpg", "image/jpeg", FAKE_JPEG) });
    const analyze = () => app.inject({ method: "POST", url: "/api/ai/analyze", payload: { from: "2026-10-01", to: "2026-10-31" } });
    const pdf = () =>
      app.inject({
        method: "POST",
        url: "/api/statements/parse",
        ...multipart("kivonat.pdf", "application/pdf", Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(32)])),
      });

    expect((await scan()).statusCode).toBe(200);
    expect((await analyze()).statusCode).toBe(200);
    for (const res of [await scan(), await analyze(), await pdf()]) {
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toBe("The AI limit of 2 calls a day (AI_DAILY_LIMIT) is used up; it starts again at 00:00 UTC");
    }
    // Everything that needs no AI still works.
    expect((await app.inject("/api/transactions")).statusCode).toBe(200);

    vi.setSystemTime(new Date("2026-10-15T00:00:01Z"));
    expect((await pdf()).statusCode).toBe(200);
    await app.close();
  });

  it("reads AI_DAILY_LIMIT, 100 by default, and refuses a value that is not a whole number", () => {
    expect(loadConfig({}).ai.dailyLimit).toBe(100);
    expect(loadConfig({ AI_DAILY_LIMIT: "0" }).ai.dailyLimit).toBe(0);
    expect(loadConfig({ AI_DAILY_LIMIT: " 500 " }).ai.dailyLimit).toBe(500);
    for (const bad of ["-1", "1.5", "lots"]) {
      expect(() => loadConfig({ AI_DAILY_LIMIT: bad }), bad).toThrow(`Invalid AI_DAILY_LIMIT "${bad}" (expected a whole number of AI calls a day, 0 or more)`);
    }
  });
});
