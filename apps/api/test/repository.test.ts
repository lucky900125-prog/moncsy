import { describe, expect, it, beforeEach } from "vitest";
import { openDb, DEFAULT_CATEGORIES } from "../src/db.js";
import { Repository } from "../src/repository.js";
import { testApp } from "./helpers.js";

let repo: Repository;
beforeEach(() => {
  repo = new Repository(openDb(":memory:"));
});

describe("seeding", () => {
  it("seeds the 12 default Hungarian categories once", () => {
    const cats = repo.listCategories();
    expect(cats.map((c) => c.name)).toEqual(DEFAULT_CATEGORIES.map((c) => c.name));
    expect(cats.every((c) => !c.isCustom && /^#[0-9a-f]{6}$/.test(c.color))).toBe(true);
    expect(cats.find((c) => c.id === "groceries")?.name).toBe("Élelmiszer");
  });
});

describe("categories", () => {
  it("creates, updates and deletes a custom category; deleting nulls transactions", () => {
    const c = repo.createCategory({ name: "Kisállat", icon: "paw-print", color: "#a3b18a", budget: 15000 });
    expect(c).toMatchObject({ name: "Kisállat", isCustom: true, budget: 15000, parentId: null });
    const sub = repo.createCategory({ name: "Állatorvos", icon: "stethoscope", color: "#b5a68f", parentId: c.id });
    expect(sub.parentId).toBe(c.id);

    const u = repo.updateCategory(c.id, { name: "Háziállat", budget: null });
    expect(u).toMatchObject({ name: "Háziállat", budget: null, icon: "paw-print" });

    const tx = repo.createTransaction({ amount: -5000, currency: "HUF", date: "2026-10-01", merchant: "Fressnapf", categoryId: c.id, source: "manual" });
    repo.deleteCategory(c.id);
    expect(repo.getCategory(c.id)).toBeNull();
    expect(repo.getTransaction(tx.id)?.categoryId).toBeNull();
    expect(repo.getCategory(sub.id)?.parentId).toBeNull();
  });

  it("refuses to delete a built-in category and rejects unknown parents", () => {
    expect(() => repo.deleteCategory("groceries")).toThrow(/built in/);
    expect(() => repo.createCategory({ name: "X", icon: "x", color: "#000000", parentId: "nope" })).toThrow(/unknown category/);
    expect(() => repo.updateCategory("missing", { name: "Y" })).toThrow(/not found/);
  });
});

describe("transactions", () => {
  it("creates, reads, updates and deletes", () => {
    const t = repo.createTransaction({
      amount: -4785,
      currency: "huf",
      date: "2026-10-12T10:30:00+02:00",
      merchant: "SPAR",
      note: "heti bevásárlás",
      categoryId: "groceries",
      source: "receipt",
      items: [{ name: "Tej", quantity: 2, unitPrice: 389, total: 778 }],
    });
    expect(t).toMatchObject({ currency: "HUF", date: "2026-10-12T08:30:00.000Z", externalId: null, source: "receipt" });
    expect(t.items).toHaveLength(1);

    const u = repo.updateTransaction(t.id, { amount: -5000, note: null, categoryId: null, items: null });
    expect(u.amount).toBe(-5000);
    expect(u.note).toBeUndefined();
    expect(u.items).toBeUndefined();
    expect(u.categoryId).toBeNull();
    expect(u.merchant).toBe("SPAR");

    repo.deleteTransaction(t.id);
    expect(repo.getTransaction(t.id)).toBeNull();
    expect(() => repo.deleteTransaction(t.id)).toThrow(/not found/);
  });

  it("filters by date range (inclusive date-only end), category and accent-insensitive-case search", () => {
    const mk = (date: string, merchant: string, categoryId: string | null) =>
      repo.createTransaction({ amount: -100, currency: "HUF", date, merchant, categoryId, source: "manual" });
    mk("2026-09-30T23:00:00Z", "Szeptemberi", null);
    mk("2026-10-01T00:00:00Z", "Élelmiszer Bolt", "groceries");
    mk("2026-10-31T22:00:00Z", "BKK Bérlet", "transport");
    mk("2026-11-01T00:00:00Z", "Novemberi", null);

    expect(repo.listTransactions({ from: "2026-10-01", to: "2026-10-31" }).map((t) => t.merchant)).toEqual(["BKK Bérlet", "Élelmiszer Bolt"]);
    expect(repo.listTransactions({ categoryId: "transport" })).toHaveLength(1);
    expect(repo.listTransactions({ categoryId: "none" })).toHaveLength(2);
    expect(repo.listTransactions({ q: "élelmiszer" })[0]?.merchant).toBe("Élelmiszer Bolt");
  });

  it("rejects duplicate externalIds and unknown categories", () => {
    repo.createTransaction({ amount: 1, currency: "EUR", date: "2026-01-01", merchant: "a", categoryId: null, source: "import", externalId: "x1" });
    expect(() =>
      repo.createTransaction({ amount: 1, currency: "EUR", date: "2026-01-01", merchant: "a", categoryId: null, source: "import", externalId: "x1" }),
    ).toThrow(/already exists/);
    expect(() => repo.createTransaction({ amount: 1, currency: "EUR", date: "2026-01-01", merchant: "a", categoryId: "zzz", source: "manual" })).toThrow(
      /unknown category/,
    );
  });
});

describe("HTTP CRUD", () => {
  it("serves the category and transaction endpoints", async () => {
    const app = await testApp();
    expect((await app.inject("/api/health")).json()).toMatchObject({ status: "ok", ai: { provider: "mock" } });

    const created = await app.inject({ method: "POST", url: "/api/categories", payload: { name: "Ajándék", icon: "gift", color: "#c9a0a0" } });
    expect(created.statusCode).toBe(201);
    const cat = created.json();
    expect(cat.isCustom).toBe(true);

    const bad = await app.inject({ method: "POST", url: "/api/categories", payload: { name: "", icon: "x", color: "red" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/Invalid category/);

    const patched = await app.inject({ method: "PATCH", url: `/api/categories/${cat.id}`, payload: { budget: 20000 } });
    expect(patched.json().budget).toBe(20000);

    const tx = await app.inject({
      method: "POST",
      url: "/api/transactions",
      payload: { amount: -12990, currency: "HUF", date: "2026-10-05", merchant: "Libri", categoryId: cat.id },
    });
    expect(tx.statusCode).toBe(201);
    expect(tx.json()).toMatchObject({ source: "manual", categoryId: cat.id });
    const id = tx.json().id;

    const list = await app.inject(`/api/transactions?from=2026-10-01&to=2026-10-31&q=libri`);
    expect(list.json()).toHaveLength(1);

    const upd = await app.inject({ method: "PATCH", url: `/api/transactions/${id}`, payload: { merchant: "Libri Allee" } });
    expect(upd.json().merchant).toBe("Libri Allee");

    expect((await app.inject({ method: "DELETE", url: "/api/categories/groceries" })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/api/categories/${cat.id}` })).statusCode).toBe(204);
    expect((await app.inject(`/api/transactions`)).json()[0].categoryId).toBeNull();
    expect((await app.inject({ method: "DELETE", url: `/api/transactions/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/transactions/${id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/api/transactions/nope`, payload: {} })).statusCode).toBe(404);
    await app.close();
  });
});
