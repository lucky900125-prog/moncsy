import { describe, expect, it } from "vitest";
import { testApp } from "./helpers.js";

describe("POST /api/transactions", () => {
  it("accepts note: null (what the web and mobile forms send for an empty note) and stores no note", async () => {
    // The Transaction contract omits `note` when there is none (shared Transaction.note?: string).
    const app = await testApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/transactions",
      payload: { amount: -1200, currency: "HUF", date: "2026-10-14", merchant: "Spar", note: null, categoryId: "groceries" },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).not.toHaveProperty("note");

    const listed = await app.inject({ url: "/api/transactions" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);
    expect(listed.json()[0]).not.toHaveProperty("note");
  });

  it("still rejects a non-string note", async () => {
    const app = await testApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/transactions",
      payload: { amount: -1200, currency: "HUF", date: "2026-10-14", merchant: "Spar", note: 42 },
    });
    expect(r.statusCode).toBe(400);
  });
});
