import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { DEFAULT_CATEGORIES } from "@et/shared";
import { openDb } from "../src/db.js";
import { Repository } from "../src/repository.js";
import { testApp } from "./helpers.js";

let repo: Repository;
beforeEach(async () => {
  repo = new Repository(await openDb(":memory:"));
});

describe("seeding", () => {
  it("seeds the 12 default Hungarian categories once", async () => {
    const cats = await repo.listCategories();
    expect(cats.map((c) => c.name)).toEqual(DEFAULT_CATEGORIES.map((c) => c.name));
    expect(cats.every((c) => !c.isCustom && /^#[0-9a-f]{6}$/.test(c.color))).toBe(true);
    expect(cats.find((c) => c.id === "groceries")?.name).toBe("Élelmiszer");
  });

  it("re-seeds only what is missing on later opens and keeps user edits", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "moncsy-")), "t.db");
    const first = await openDb(path);
    await first.run("DELETE FROM categories WHERE id = 'travel'");
    await first.run("UPDATE categories SET name = 'Kaja' WHERE id = 'groceries'");
    first.close();
    const again = new Repository(await openDb(path));
    expect((await again.getCategory("travel"))?.name).toBe("Utazás");
    expect((await again.getCategory("groceries"))?.name).toBe("Kaja");
    expect(await again.listCategories()).toHaveLength(DEFAULT_CATEGORIES.length);
  });
});

describe("categories", () => {
  it("creates, updates and deletes a custom category; deleting nulls transactions", async () => {
    const c = await repo.createCategory({ name: "Kisállat", icon: "paw-print", color: "#a3b18a", budget: 15000 });
    expect(c).toMatchObject({ name: "Kisállat", isCustom: true, budget: 15000, parentId: null });
    const sub = await repo.createCategory({ name: "Állatorvos", icon: "stethoscope", color: "#b5a68f", parentId: c.id });
    expect(sub.parentId).toBe(c.id);

    const u = await repo.updateCategory(c.id, { name: "Háziállat", budget: null });
    expect(u).toMatchObject({ name: "Háziállat", budget: null, icon: "paw-print" });

    const tx = await repo.createTransaction({ amount: -5000, currency: "HUF", date: "2026-10-01", merchant: "Fressnapf", categoryId: c.id, source: "manual" });
    await repo.deleteCategory(c.id);
    expect(await repo.getCategory(c.id)).toBeNull();
    expect((await repo.getTransaction(tx.id))?.categoryId).toBeNull();
    expect((await repo.getCategory(sub.id))?.parentId).toBeNull();
  });

  it("refuses to delete a built-in category and rejects unknown parents", async () => {
    await expect(repo.deleteCategory("groceries")).rejects.toThrow(/built in/);
    await expect(repo.createCategory({ name: "X", icon: "x", color: "#000000", parentId: "nope" })).rejects.toThrow(/unknown category/);
    await expect(repo.updateCategory("missing", { name: "Y" })).rejects.toThrow(/not found/);
  });
});

describe("transactions", () => {
  it("creates, reads, updates and deletes", async () => {
    const t = await repo.createTransaction({
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

    const u = await repo.updateTransaction(t.id, { amount: -5000, note: null, categoryId: null, items: null });
    expect(u.amount).toBe(-5000);
    expect(u.note).toBeUndefined();
    expect(u.items).toBeUndefined();
    expect(u.categoryId).toBeNull();
    expect(u.merchant).toBe("SPAR");

    await repo.deleteTransaction(t.id);
    expect(await repo.getTransaction(t.id)).toBeNull();
    await expect(repo.deleteTransaction(t.id)).rejects.toThrow(/not found/);
  });

  it("filters by date range (inclusive date-only end), category and accent-insensitive-case search", async () => {
    const mk = (date: string, merchant: string, categoryId: string | null) =>
      repo.createTransaction({ amount: -100, currency: "HUF", date, merchant, categoryId, source: "manual" });
    await mk("2026-09-30T23:00:00Z", "Szeptemberi", null);
    await mk("2026-10-01T00:00:00Z", "Élelmiszer Bolt", "groceries");
    await mk("2026-10-31T22:00:00Z", "BKK Bérlet", "transport");
    await mk("2026-11-01T00:00:00Z", "Novemberi", null);

    expect((await repo.listTransactions({ from: "2026-10-01", to: "2026-10-31" })).map((t) => t.merchant)).toEqual(["BKK Bérlet", "Élelmiszer Bolt"]);
    expect(await repo.listTransactions({ categoryId: "transport" })).toHaveLength(1);
    expect(await repo.listTransactions({ categoryId: "none" })).toHaveLength(2);
    expect((await repo.listTransactions({ q: "élelmiszer" }))[0]?.merchant).toBe("Élelmiszer Bolt");
  });

  it("rejects duplicate externalIds and unknown categories", async () => {
    await repo.createTransaction({ amount: 1, currency: "EUR", date: "2026-01-01", merchant: "a", categoryId: null, source: "import", externalId: "x1" });
    await expect(repo.createTransaction({ amount: 1, currency: "EUR", date: "2026-01-01", merchant: "a", categoryId: null, source: "import", externalId: "x1" })).rejects.toThrow(/already exists/);
    await expect(repo.createTransaction({ amount: 1, currency: "EUR", date: "2026-01-01", merchant: "a", categoryId: "zzz", source: "manual" })).rejects.toThrow(
      /unknown category/,
    );
  });
});

describe("db", () => {
  it("runs a query issued while a transaction is about to start outside it, not inside it", async () => {
    const db = await openDb(":memory:");
    await db.exec("CREATE TABLE t (v TEXT)");
    const failing = db.tx(async (t) => {
      await t.run("INSERT INTO t VALUES ('in tx')");
      await t.run("SELECT 1");
      throw new Error("tx fails");
    });
    // Issued in the same turn as the transaction: it must not be swept into it and rolled back with it.
    expect(await db.run("INSERT INTO t VALUES ('outside')")).toEqual({ changes: 1 });
    await expect(failing).rejects.toThrow("tx fails");
    expect(await db.all("SELECT v FROM t")).toEqual([{ v: "outside" }]);
    db.close();
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
