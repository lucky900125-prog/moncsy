import { describe, expect, it } from "vitest";
import type { Transaction } from "@et/shared";
import { buildProductStats, rankStores, storeName } from "@et/shared/products";
import { assertSafeExposure, loadConfig } from "../src/config.js";
import { productAggregate } from "../src/services/analyze.js";
import { FAKE_JPEG, multipart, testApp } from "./helpers.js";

describe("API token", () => {
  it("guards every route except /health when API_TOKEN is set", async () => {
    const app = await testApp({ config: { apiToken: "s3cret-token" } });
    const open = await app.inject("/api/health");
    expect(open.statusCode).toBe(200);
    expect(open.json()).toEqual({ status: "ok", time: expect.any(String), auth: "token" });
    const authed = await app.inject({ url: "/api/health", headers: { authorization: "Bearer s3cret-token" } });
    expect(authed.json()).toMatchObject({ auth: "token", ai: { provider: "mock" } });
    for (const [method, url] of [
      ["GET", "/api/categories"],
      ["GET", "/api/transactions"],
      ["GET", "/api/export?format=xml"],
      ["POST", "/api/revolut/sync"],
      ["POST", "/api/ai/analyze"],
      ["POST", "/api/statements/import"],
      ["GET", "/api/products"],
    ] as const) {
      const r = await app.inject({ method, url });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
    expect((await app.inject({ url: "/api/categories", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/categories", headers: { authorization: "s3cret-token" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/categories", headers: { authorization: "Bearer s3cret-token" } })).statusCode).toBe(200);
    // CORS preflight carries no credentials and must not be refused.
    const pre = await app.inject({
      method: "OPTIONS",
      url: "/api/categories",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
    });
    expect(pre.statusCode).toBe(204);
    // The deployed web app runs on another origin, so edits and deletes need the preflight to allow them.
    const preDelete = await app.inject({
      method: "OPTIONS",
      url: "/api/transactions/x",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "DELETE", "access-control-request-headers": "authorization" },
    });
    expect(preDelete.headers["access-control-allow-methods"]).toMatch(/PATCH/);
    expect(preDelete.headers["access-control-allow-methods"]).toMatch(/DELETE/);
    await app.close();
  });

  it("refuses to listen beyond localhost without a token unless told to", () => {
    expect(assertSafeExposure(loadConfig({ HOST: "127.0.0.1" }), {})).toBeNull();
    expect(() => assertSafeExposure(loadConfig({ HOST: "0.0.0.0" }), {})).toThrow(/API_TOKEN is not set/);
    expect(assertSafeExposure(loadConfig({ HOST: "0.0.0.0", API_TOKEN: "x" }), {})).toBeNull();
    expect(assertSafeExposure(loadConfig({ HOST: "0.0.0.0" }), { ALLOW_NO_AUTH: "1" })).toMatch(/anyone who can reach this port/);
  });
});

const tx = (id: string, merchant: string, date: string, items: Transaction["items"], currency = "HUF"): Transaction => ({
  id,
  amount: -(items ?? []).reduce((s, i) => s + i.total, 0),
  currency,
  date,
  merchant,
  categoryId: "groceries",
  source: "receipt",
  items,
});

describe("products from receipt lines", () => {
  it("normalises store names", () => {
    expect(storeName("SPAR Magyarország Kft.")).toBe("Spar");
    expect(storeName("Spar")).toBe("Spar");
    expect(storeName("Lidl Magyarország Bt.")).toBe("Lidl");
    expect(storeName("Tesco-Global Áruházak Zrt.")).toBe("Tesco");
    expect(storeName("Lidl (demó)")).toBe("Lidl");
    expect(storeName("Bors GasztroBár")).toBe("Bors GasztroBár");
  });

  it("compares the same product across stores per litre, and ranks the stores", () => {
    const milk = (size: number, unit: "l" | "ml", price: number) => ({
      name: `Mizo tej ${size}${unit}`, quantity: 1, unitPrice: price, total: price, product: "tej", brand: "Mizo", packSize: size, packUnit: unit,
    });
    const bread = (price: number) => ({ name: "Kenyér", quantity: 1, unitPrice: price, total: price, product: "kenyér", brand: null, packSize: 500, packUnit: "g" as const });
    const stats = buildProductStats([
      tx("1", "SPAR Magyarország Kft.", "2026-10-01T10:00:00Z", [milk(1, "l", 429), bread(599)]),
      tx("2", "Lidl", "2026-10-03T10:00:00Z", [milk(1, "l", 379), bread(649)]),
      tx("3", "Lidl", "2026-10-08T10:00:00Z", [milk(500, "ml", 199)]),
      tx("4", "Tesco", "2026-10-09T10:00:00Z", [{ name: "Kedvezmény", quantity: 1, unitPrice: -100, total: -100 }]),
      tx("5", "Aldi", "2026-10-09T10:00:00Z", [{ name: "Banán", quantity: 1.2, unitPrice: 549, total: 659 }]),
    ]);
    expect(stats.map((p) => p.product)).toEqual(["Kenyér", "Tej", "Banán"]);
    const m = stats.find((p) => p.product === "Tej")!;
    expect(m).toMatchObject({ brand: "Mizo", baseUnit: "l", pack: null, purchases: 3, spent: 1007, cheapest: "Lidl", saving: 40.5 });
    // Lidl: 379/l and 199/0.5 l = 398/l -> 388.5/l on average; Spar 429/l
    expect(m.stores).toMatchObject([
      { store: "Lidl", purchases: 2, avgBasePrice: 388.5, lastUnitPrice: 199 },
      { store: "Spar", purchases: 1, avgBasePrice: 429 },
    ]);
    const b = stats.find((p) => p.product === "Kenyér")!;
    expect(b).toMatchObject({ pack: "500 g", cheapest: "Spar", saving: 100 });
    expect(stats.find((p) => p.product === "Banán")).toMatchObject({ baseUnit: null, cheapest: null, saving: null });
    expect(rankStores(stats)).toEqual([
      { store: "Lidl", cheapestFor: 1, compared: 2 },
      { store: "Spar", cheapestFor: 1, compared: 2 },
    ]);
  });

  it("keeps currencies and brands apart", () => {
    const item = (brand: string | null, price: number) => ({ name: "Vaj", quantity: 1, unitPrice: price, total: price, product: "vaj", brand });
    const stats = buildProductStats([
      tx("1", "Spar", "2026-10-01T10:00:00Z", [item("Président", 999), item(null, 699)]),
      tx("2", "Billa", "2026-10-02T10:00:00Z", [item("Président", 2.9)], "EUR"),
    ]);
    expect(stats).toHaveLength(3);
    expect(stats.every((p) => p.cheapest === null)).toBe(true);
  });
});

describe("POST /api/ai/analyze scope=products", () => {
  it("answers where to buy from saved receipt lines, and says so when there are none", async () => {
    const app = await testApp();
    const empty = await app.inject({ method: "POST", url: "/api/ai/analyze", payload: { from: "2026-10-01", to: "2026-10-31", scope: "products" } });
    expect(empty.statusCode).toBe(422);

    const scan = await app.inject({ method: "POST", url: "/api/receipts/scan", ...multipart("r.jpg", "image/jpeg", FAKE_JPEG) });
    const r = scan.json();
    expect(r.items[0]).toMatchObject({ product: "tej", brand: "Mizo", packSize: 1, packUnit: "l" });
    await app.deps.repo.createTransaction({ amount: -r.total, currency: "HUF", date: "2026-10-12", merchant: r.merchant, categoryId: "groceries", source: "receipt", items: r.items });
    const cheaper = r.items.map((i: { unitPrice: number; total: number }) => ({ ...i, unitPrice: i.unitPrice - 20, total: i.total - 20 }));
    await app.deps.repo.createTransaction({ amount: -4000, currency: "HUF", date: "2026-10-13", merchant: "Lidl", categoryId: "groceries", source: "receipt", items: cheaper });

    const res = await app.inject({ method: "POST", url: "/api/ai/analyze", payload: { from: "2026-10-01", to: "2026-10-31", scope: "products" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toMatch(/5 terméket vettél több boltban; ezek közül 5 esetben a Lidl/);
    expect(res.json().insights[0].title).toMatch(/: Lidl$/);
    await app.close();
  });

  it("narrows the products sent to the AI by name, brand and store", async () => {
    const line = (name: string, product: string, brand: string, unitPrice: number) => ({
      name, quantity: 1, unitPrice, total: unitPrice, product, brand, packSize: 1, packUnit: "l" as const,
    });
    const txs = [
      tx("a", "SPAR Magyarország Kft.", "2026-10-12T10:00:00.000Z", [line("MIZO TEJ 1L", "tej", "Mizo", 459), line("NATUR AQUA 1,5L", "ásványvíz", "Natur Aqua", 129)]),
      tx("b", "Lidl", "2026-10-13T10:00:00.000Z", [line("MIZO TEJ 1L", "tej", "Mizo", 419), line("PILOS TEJ 1L", "tej", "Pilos", 289)]),
    ];
    const names = (f: Parameters<typeof productAggregate>[3]) => productAggregate(txs, "2026-10-01", "2026-10-31", f).products.map((p) => `${p.product}/${p.brand}`).sort();
    expect(names(undefined)).toEqual(["Tej/Mizo", "Tej/Pilos", "Ásványvíz/Natur Aqua"].sort());
    expect(names({ q: "TEJ" })).toEqual(["Tej/Mizo", "Tej/Pilos"]);
    expect(names({ q: "asvanyviz" })).toEqual(["Ásványvíz/Natur Aqua"]);
    expect(names({ brand: "mizo" })).toEqual(["Tej/Mizo"]);
    // A store filter keeps the products bought there, with every store they were bought in.
    expect(names({ merchant: "SPAR Magyarország Kft." })).toEqual(["Tej/Mizo", "Ásványvíz/Natur Aqua"].sort());
    expect(productAggregate(txs, "", "", { merchant: "spar" }).products.find((p) => p.brand === "Mizo")!.stores.map((s) => s.store)).toEqual(["Lidl", "Spar"]);
    expect(productAggregate(txs, "", "", { brand: "Mizo" }).filter).toEqual({ brand: "Mizo" });
    expect(productAggregate(txs, "", "", { q: "" }).filter).toBeUndefined();

    const app = await testApp();
    for (const t of txs) await app.deps.repo.createTransaction({ ...t, id: undefined } as never);
    const ask = (products: unknown) =>
      app.inject({ method: "POST", url: "/api/ai/analyze", payload: { from: "2026-10-01", to: "2026-10-31", scope: "products", products } });
    expect((await ask({ brand: "Mizo" })).statusCode).toBe(200);
    const none = await ask({ brand: "Parmalat" });
    expect(none.statusCode).toBe(422);
    expect(none.json().error).toMatch(/match the product filter/);
    expect((await ask({ color: "red" })).statusCode).toBe(400);
    await app.close();
  });

  it("GET /api/products lists the products of saved receipts per store, within the range", async () => {
    const app = await testApp();
    expect((await app.inject("/api/products")).json()).toEqual({ products: [], stores: [] });
    const milk = (unitPrice: number) => [{ name: "MIZO TEJ 2,8% 1L", quantity: 1, unitPrice, total: unitPrice, product: "tej", brand: "Mizo", packSize: 1, packUnit: "l" as const }];
    await app.deps.repo.createTransaction({ amount: -459, currency: "HUF", date: "2026-10-12", merchant: "SPAR Magyarország Kft.", categoryId: "groceries", source: "receipt", items: milk(459) });
    await app.deps.repo.createTransaction({ amount: -419, currency: "HUF", date: "2026-10-13", merchant: "Lidl", categoryId: "groceries", source: "receipt", items: milk(419) });
    await app.deps.repo.createTransaction({ amount: -499, currency: "HUF", date: "2026-09-01", merchant: "Tesco", categoryId: "groceries", source: "receipt", items: milk(499) });

    const res = await app.inject("/api/products?from=2026-10-01&to=2026-10-31");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.products).toHaveLength(1);
    expect(body.products[0]).toMatchObject({ product: "Tej", brand: "Mizo", purchases: 2, cheapest: "Lidl", saving: 40 });
    expect(body.products[0].stores.map((s: { store: string }) => s.store)).toEqual(["Lidl", "Spar"]);
    expect(body.stores).toEqual([
      { store: "Lidl", cheapestFor: 1, compared: 1 },
      { store: "Spar", cheapestFor: 0, compared: 1 },
    ]);
    expect((await app.inject("/api/products")).json().products[0].purchases).toBe(3);
    expect((await app.inject("/api/products?from=nope")).statusCode).toBe(400);
    await app.close();
  });
});
