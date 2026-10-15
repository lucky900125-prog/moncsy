import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { HttpError } from "../src/errors.js";
import { applyImport } from "../src/io/common.js";
import { Repository } from "../src/repository.js";
import { testApp } from "./helpers.js";

const tx = (externalId: string) => ({ amount: -1200, currency: "HUF", date: "2026-10-14", merchant: "Spar", note: null, categoryId: "groceries", source: "manual" as const, externalId });
const cat = (name: string) => ({ name, icon: "tag", color: "#112233" });

afterEach(() => vi.restoreAllMocks());

describe("data integrity", () => {
  // The race is between the externalId check and the insert, so it is driven at the repository, where two calls interleave.
  it("two concurrent creates with the same externalId give one transaction and a 409, never a 500 (BE-5)", async () => {
    const repo = new Repository(await openDb(":memory:"));
    const out = await Promise.allSettled([repo.createTransaction(tx("bank:1")), repo.createTransaction(tx("bank:1"))]);
    expect(out.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    const err = out.find((o) => o.status === "rejected")!.reason;
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(409);
  });

  it("two concurrent updates to the same externalId give one change and a 409, never a 500 (BE-5)", async () => {
    const repo = new Repository(await openDb(":memory:"));
    const a = await repo.createTransaction(tx("bank:a"));
    const b = await repo.createTransaction(tx("bank:b"));
    const out = await Promise.allSettled([a, b].map((t) => repo.updateTransaction(t.id, { externalId: "bank:same" })));
    expect(out.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    const err = out.find((o) => o.status === "rejected")!.reason;
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(409);
  });

  it("refuses a parent that would make a loop (BE-7)", async () => {
    const app = await testApp();
    const a = (await app.inject({ method: "POST", url: "/api/categories", payload: cat("A") })).json();
    const b = (await app.inject({ method: "POST", url: "/api/categories", payload: { ...cat("B"), parentId: a.id } })).json();
    const c = (await app.inject({ method: "POST", url: "/api/categories", payload: { ...cat("C"), parentId: b.id } })).json();
    const res = await app.inject({ method: "PATCH", url: `/api/categories/${a.id}`, payload: { parentId: c.id } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/loop/);
    expect((await app.inject({ method: "GET", url: "/api/categories" })).json().find((x: { id: string }) => x.id === a.id).parentId).toBeNull();
  });

  it("an import whose parents form a loop imports the categories and reports the loop (BE-7)", async () => {
    const repo = new Repository(await openDb(":memory:"));
    const res = await applyImport(repo, {
      categories: [
        { where: "row 1", data: { id: "x", ...cat("X"), parentId: "y" } },
        { where: "row 2", data: { id: "y", ...cat("Y"), parentId: "x" } },
      ],
      transactions: [],
    });
    expect(res.imported).toBe(2);
    expect(res.errors).toEqual([expect.stringMatching(/^row 2: .*loop.*imported without parent$/)]);
    expect((await repo.getCategory("x"))!.parentId).toBe("y");
    expect((await repo.getCategory("y"))!.parentId).toBeNull();
  });

  it("an import cannot create a built-in category that can never be deleted (BE-8)", async () => {
    const repo = new Repository(await openDb(":memory:"));
    const res = await applyImport(repo, { categories: [{ where: "row 1", data: { id: "mine", ...cat("Mine"), isCustom: false } }], transactions: [] });
    expect(res.imported).toBe(1);
    expect(res.errors).toEqual([expect.stringMatching(/^row 1: .*imported as a custom category$/)]);
    expect((await repo.getCategory("mine"))!.isCustom).toBe(true);
    await expect(repo.deleteCategory("mine")).resolves.toBeUndefined();
  });

  it("an import that fails inside the database imports nothing and says so (BE-11)", async () => {
    const repo = new Repository(await openDb(":memory:"));
    const real = Repository.prototype.createTransaction;
    let n = 0;
    vi.spyOn(Repository.prototype, "createTransaction").mockImplementation(function (this: Repository, ...args) {
      if (++n === 2) throw new Error("database or disk is full");
      return real.apply(this, args);
    });
    const err = await applyImport(repo, {
      categories: [{ where: "row 1", data: { id: "new", ...cat("New") } }],
      transactions: [
        { where: "row 1", data: tx("bank:1") },
        { where: "row 2", data: tx("bank:2") },
      ],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(500);
    expect((err as HttpError).message).toMatch(/nothing was imported.*database or disk is full/i);
    expect(await repo.listTransactions()).toEqual([]);
    expect(await repo.getCategory("new")).toBeNull();
  });
});
