import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { postJson } from "../src/ai/http.js";
import { parseModelJson } from "../src/ai/json.js";
import { HttpError, messageWithCauses } from "../src/errors.js";
import { multipart, testApp } from "./helpers.js";

const REVOLUT = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2026-07-01 12:00:00,2026-07-01 12:05:00,Spar,-4785.00,0.00,HUF,COMPLETED,1000.00
`;

const thrown = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("did not throw");
};

describe("model answers stay out of the log (review round 5, A2)", () => {
  it("logs only the length and the kind of an answer that is not JSON", () => {
    const err = thrown(() => parseModelJson("openai", "Sure! {merchant: SPAR, total: 4785}", z.object({ merchant: z.string() })));
    expect(err.statusCode).toBe(502);
    const logged = messageWithCauses(err);
    expect(logged).not.toMatch(/SPAR|4785|Sure/);
    expect(logged).toMatch(/35 characters/);
    expect(logged).toMatch(/SyntaxError/);
  });

  it("logs only the length of an answer whose JSON has the wrong shape", () => {
    const err = thrown(() => parseModelJson("openai", '{"merchant": 42, "secret": "SPAR"}', z.object({ merchant: z.string() })));
    expect(messageWithCauses(err)).not.toMatch(/SPAR/);
    expect(messageWithCauses(err)).toMatch(/\d+ characters/);
  });
});

describe("provider bodies in the log (review round 5, A2/A3)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("logs only the length of a 2xx body that is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Sure! SPAR 4785 Ft", { status: 200 })));
    const err = (await postJson("openai", "https://ai.invalid/v1", {}, {}, 1000).catch((e: unknown) => e)) as HttpError;
    expect(err.statusCode).toBe(502);
    expect(messageWithCauses(err)).not.toMatch(/SPAR|4785/);
    expect(messageWithCauses(err)).toMatch(/18 characters/);
  });

  it("keeps at most 500 characters of a provider's error text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(3000), { status: 400 })));
    const err = (await postJson("openai", "https://ai.invalid/v1", {}, {}, 1000).catch((e: unknown) => e)) as HttpError;
    expect((err.cause as Error).message.length).toBeLessThanOrEqual("openai answered: ".length + 500);
  });
});

describe("Revolut statements use the configured STATEMENT_TZ (A4)", () => {
  it("in the Revolut import and in the statement preview", async () => {
    const app = await testApp({ config: { statementTz: "UTC" } });
    const imported = await app.inject({ method: "POST", url: "/api/revolut/import-statement", ...multipart("r.csv", "text/csv", REVOLUT) });
    expect(imported.json()).toMatchObject({ imported: 1 });
    expect((await app.inject("/api/transactions")).json()).toMatchObject([{ date: "2026-07-01T12:05:00.000Z" }]);
    const preview = await app.inject({ method: "POST", url: "/api/statements/parse", ...multipart("r.csv", "text/csv", REVOLUT) });
    expect(preview.json()).toMatchObject({ format: "revolut", transactions: [{ date: "2026-07-01T12:05:00.000Z" }] });
    await app.close();
  });
});
