import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { applyImport } from "../src/io/common.js";
import { exportXlsx, parseXlsx } from "../src/io/xlsx.js";
import { exportXml, parseXml } from "../src/io/xml.js";
import { Repository } from "../src/repository.js";
import { multipart, testApp } from "./helpers.js";

/** Data that exercises every shared field and the awkward cases (unicode, XML entities, floats, nulls). */
async function populate(repo: Repository) {
  const pets = await repo.createCategory({ name: "Kisállat & co <3", icon: "paw-print", color: "#a3b18a", budget: 15000.5 });
  const vet = await repo.createCategory({ name: "Állatorvos \"Dr. Bő\"", icon: "stethoscope", color: "#b5a68f", parentId: pets.id });
  await repo.updateCategory("groceries", { budget: 80000 });
  await repo.createTransaction({
    amount: -4785.25,
    currency: "HUF",
    date: "2026-10-12T10:30:15.123Z",
    merchant: "SPAR <Árpád> & Társa",
    note: "Line1\nLine2 'quoted' \"double\"",
    categoryId: "groceries",
    source: "receipt",
    items: [
      { name: "Tej 2,8% <1l>", quantity: 2, unitPrice: 389, total: 778 },
      { name: "Alma", quantity: 1.5, unitPrice: 599.99, total: 899.985 },
    ],
  });
  await repo.createTransaction({ amount: 450000, currency: "HUF", date: "2026-10-01T00:00:00.000Z", merchant: "Munkabér", categoryId: "income", source: "manual" });
  await repo.createTransaction({ amount: -0.1, currency: "EUR", date: "2026-10-02T12:00:00.000Z", merchant: "123", categoryId: null, source: "revolut", externalId: "revolut:abc" });
  await repo.createTransaction({ amount: -9000, currency: "HUF", date: "2026-10-03T00:00:00.000Z", merchant: "", note: "", categoryId: vet.id, source: "import", items: [] });
}

const snapshot = async (repo: Repository) => ({
  categories: await repo.listCategories(),
  transactions: await repo.listTransactions(),
});

describe.each([
  ["xlsx", async (r: Repository) => parseXlsx(await exportXlsx(await snapshot(r)))],
  ["xml", async (r: Repository) => parseXml(exportXml(await snapshot(r)))],
] as const)("%s round-trip", (_name, roundTrip) => {
  it("is lossless into an empty database and idempotent on re-import", async () => {
    const src = new Repository(await openDb(":memory:"));
    await populate(src);
    const payload = await roundTrip(src);

    const dst = new Repository(await openDb(":memory:"));
    const r1 = await applyImport(dst, payload);
    expect(r1.errors).toEqual([]);
    // 12 seeded categories already exist -> skipped; 2 custom categories + 4 transactions imported
    expect(r1).toMatchObject({ imported: 6, skipped: 12 });

    const a = await snapshot(src);
    const b = await snapshot(dst);
    // Built-in categories are not overwritten by import, so compare the custom ones plus all transactions.
    expect(b.categories.filter((c) => c.isCustom)).toEqual(a.categories.filter((c) => c.isCustom));
    expect(b.transactions).toEqual(a.transactions);

    const r2 = await applyImport(dst, payload);
    expect(r2).toEqual({ imported: 0, skipped: 18, errors: [] });
  });
});

describe("import errors", () => {
  it("reports bad XML rows individually and imports the rest", async () => {
    const xml = `<?xml version="1.0"?>
<expenses version="1">
  <transactions>
    <transaction><date>2026-10-01</date><amount>-100</amount><currency>HUF</currency><merchant>OK</merchant></transaction>
    <transaction><date>not a date</date><amount>-100</amount><currency>HUF</currency><merchant>Bad date</merchant></transaction>
    <transaction><date>2026-10-02</date><amount>abc</amount><currency>HUF</currency><merchant>Bad amount</merchant></transaction>
    <transaction><date>2026-10-03</date><amount>-5</amount><currency>HUF</currency><merchant>Bad cat</merchant><categoryId>nope</categoryId></transaction>
  </transactions>
</expenses>`;
    const repo = new Repository(await openDb(":memory:"));
    const r = await applyImport(repo, parseXml(xml));
    expect(r.imported).toBe(1);
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toMatch(/transaction #2.*date/);
    expect(r.errors[1]).toMatch(/transaction #3.*amount/);
    expect(r.errors[2]).toMatch(/unknown categoryId "nope"/);
    expect((await repo.listTransactions())[0]).toMatchObject({ merchant: "OK", source: "import", categoryId: null });
  });

  it("accepts a hand-made XLSX with a category name instead of an id", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Transactions");
    ws.addRow(["date", "amount", "currency", "merchant", "category"]);
    ws.addRow([new Date("2026-10-04T09:00:00Z"), -2500, "HUF", "Wolt", "Étterem"]);
    ws.addRow(["2026-10-05", "-1 000", "HUF", "Bad", ""]);
    ws.addRow(["2026-10-06", -300, "HUF", "Unknown", "Nincs ilyen"]);
    const repo = new Repository(await openDb(":memory:"));
    const r = await applyImport(repo, await parseXlsx(Buffer.from(await wb.xlsx.writeBuffer())));
    expect(r.imported).toBe(1);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatch(/Transactions row 3: amount/);
    expect(r.errors[1]).toMatch(/Transactions row 4: unknown category "Nincs ilyen"/);
    expect((await repo.listTransactions())[0]).toMatchObject({ merchant: "Wolt", categoryId: "restaurant", date: "2026-10-04T09:00:00.000Z" });
  });

  it("reports a category that is its own parent as a row error and imports the rest", async () => {
    const xml = `<?xml version="1.0"?>
<expenses version="1">
  <categories>
    <category id="loop"><name>Hurok</name><icon>x</icon><color>#123456</color><parentId>loop</parentId></category>
    <category id="ok"><name>Rendes</name><icon>x</icon><color>#123456</color></category>
  </categories>
  <transactions>
    <transaction><date>2026-10-01</date><amount>-100</amount><currency>HUF</currency><merchant>OK</merchant></transaction>
  </transactions>
</expenses>`;
    const repo = new Repository(await openDb(":memory:"));
    const r = await applyImport(repo, parseXml(xml));
    expect(r).toMatchObject({ imported: 3, skipped: 0 });
    expect(r.errors).toEqual([expect.stringMatching(/cannot be its own parent; imported without parent/)]);
    expect(await repo.getCategory("loop")).toMatchObject({ name: "Hurok", parentId: null });
    expect(await repo.listTransactions()).toHaveLength(1);
  });

  it("commits nothing when SQLite rolls the import back by itself, and says why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moncsy-full-"));
    try {
      const db = await openDb(join(dir, "full.db"));
      const repo = new Repository(db);
      const pages = (await db.get<{ page_count: number }>("PRAGMA page_count"))!.page_count;
      // A real SQLITE_FULL, as on a nearly full disk: the file may grow by only a few pages.
      await db.get(`PRAGMA max_page_count = ${pages + 20}`);
      const row = (merchant: string, extra: Record<string, unknown> = {}) => ({
        where: merchant,
        data: { amount: "-1", currency: "HUF", date: "2026-10-01", merchant, ...extra },
      });
      const items = Array.from({ length: 400 }, () => ({ name: "x".repeat(500), quantity: 1, unitPrice: 1, total: 1 }));
      const payload = { categories: [], transactions: [row("before"), row("too big", { items }), row("after-1"), row("after-2")] };
      await expect(applyImport(repo, payload)).rejects.toThrow(/rolled back by SQLite after an earlier error: database or disk is full/);
      await db.get("PRAGMA max_page_count = 1073741823");
      expect(await repo.listTransactions()).toEqual([]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed XML with a 400", async () => {
    expect(() => parseXml("<expenses><transactions></expenses>")).toThrow(/Invalid XML/);
  });
});

describe("HTTP /export and /import", () => {
  it("downloads XLSX and XML and re-imports them through the API", async () => {
    const app = await testApp();
    await populate(app.deps.repo);

    const x = await app.inject("/api/export?format=xlsx");
    expect(x.statusCode).toBe(200);
    expect(x.headers["content-type"]).toContain("spreadsheetml");
    expect(x.headers["content-disposition"]).toMatch(/attachment; filename="expenses-.*\.xlsx"/);
    expect(x.rawPayload.subarray(0, 2).toString()).toBe("PK");

    const m = await app.inject("/api/export?format=xml&from=2026-10-02&to=2026-10-12");
    expect(m.headers["content-type"]).toContain("application/xml");
    expect(m.payload).toContain("<expenses");
    expect(m.payload).toContain("SPAR &lt;Árpád&gt; &amp; Társa");
    expect(parseXml(m.payload).transactions).toHaveLength(3);

    const fresh = await testApp();
    const r1 = await fresh.inject({ method: "POST", url: "/api/import", ...multipart("backup.xlsx", "application/octet-stream", x.rawPayload) });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ imported: 6, errors: [] });
    const r2 = await fresh.inject({ method: "POST", url: "/api/import", ...multipart("backup.xml", "text/xml", m.payload) });
    expect(r2.json()).toEqual({ imported: 0, skipped: 17, errors: [] });

    const bad = await fresh.inject({ method: "POST", url: "/api/import", ...multipart("notes.txt", "text/plain", "hello") });
    expect(bad.statusCode).toBe(415);
    await app.close();
    await fresh.close();
  });
});
