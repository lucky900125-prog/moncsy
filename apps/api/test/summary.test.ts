import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { Repository } from "../src/repository.js";
import { testApp } from "./helpers.js";

async function seed(repo: Repository) {
  const add = (amount: number, currency: string, date: string, categoryId: string | null) =>
    repo.createTransaction({ amount, currency, date, merchant: "m", categoryId, source: "manual" });
  await add(450000, "HUF", "2026-10-01", "income");
  await add(-12500.5, "HUF", "2026-10-02", "groceries");
  await add(-8999.5, "HUF", "2026-10-15", "groceries");
  await add(-180000, "HUF", "2026-10-05", "housing");
  await add(-3500, "HUF", "2026-10-20", null);
  await add(2000, "HUF", "2026-10-21", "groceries"); // refund
  await add(-25, "EUR", "2026-10-10", "travel"); // other currency: never mixed into HUF totals
  await add(-99999, "HUF", "2026-09-30T23:59:59Z", "groceries"); // outside range
}

describe("summary", () => {
  it("computes income, expense and signed per-category totals for one currency", async () => {
    const repo = new Repository(await openDb(":memory:"));
    await seed(repo);
    const s = await repo.summary("2026-10-01", "2026-10-31", undefined, "HUF");
    expect(s.currency).toBe("HUF");
    expect(s.income).toBe(452000);
    expect(s.expense).toBe(205000);
    expect(s.byCategory).toEqual([
      { categoryId: "housing", total: -180000, count: 1 },
      { categoryId: "groceries", total: -19500, count: 3 },
      { categoryId: null, total: -3500, count: 1 },
      { categoryId: "income", total: 450000, count: 1 },
    ]);
    const eur = await repo.summary("2026-10-01", "2026-10-31", "eur", "HUF");
    expect(eur).toMatchObject({ currency: "EUR", income: 0, expense: 25, byCategory: [{ categoryId: "travel", total: -25, count: 1 }] });
  });

  it("returns zeros and the default currency for an empty range", async () => {
    const repo = new Repository(await openDb(":memory:"));
    expect(await repo.summary("2020-01-01", "2020-01-31", undefined, "HUF")).toMatchObject({ currency: "HUF", income: 0, expense: 0, byCategory: [] });
  });

  it("is served at GET /api/summary and validates the query", async () => {
    const app = await testApp();
    await seed(app.deps.repo);
    const r = await app.inject("/api/summary?from=2026-10-01&to=2026-10-31");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ income: 452000, expense: 205000, from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T23:59:59.999Z" });
    expect((await app.inject("/api/summary?from=nope&to=2026-10-31")).statusCode).toBe(400);
    expect((await app.inject("/api/summary")).statusCode).toBe(400);
    await app.close();
  });
});
