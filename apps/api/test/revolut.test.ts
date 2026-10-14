import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { Repository } from "../src/repository.js";
import { BusinessApiRevolutProvider } from "../src/revolut/business-api.js";
import { categorize } from "../src/revolut/categorize.js";
import { parseStatementCsv, parseStatementXlsx, revolutDate, statementExternalId, toTransactions } from "../src/revolut/csv.js";
import { OpenBankingRevolutProvider } from "../src/revolut/open-banking.js";
import { multipart, testApp } from "./helpers.js";

const CSV = `﻿Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2026-10-01 08:15:42,2026-10-02 09:01:10,Spar,-4785.00,0.00,HUF,COMPLETED,120215.00
CARD_PAYMENT,Current,2026-10-02 12:30:00,2026-10-03 10:00:00,Wolt,-6490.00,0.00,HUF,COMPLETED,113725.00
TOPUP,Current,2026-10-03 07:00:00,2026-10-03 07:00:05,Top-Up by *1234,200000.00,0.00,HUF,COMPLETED,313725.00
TRANSFER,Current,2026-10-04 18:00:00,2026-10-04 18:00:01,To Kovács Anna,-15000.00,0.00,HUF,COMPLETED,298725.00
EXCHANGE,Current,2026-10-05 10:00:00,2026-10-05 10:00:00,Exchanged to EUR,-40000.00,0.00,HUF,COMPLETED,258725.00
EXCHANGE,Current,2026-10-05 10:00:00,2026-10-05 10:00:00,Exchanged from HUF,100.00,0.00,EUR,COMPLETED,100.00
CARD_PAYMENT,Current,2026-10-06 20:00:00,,Netflix.com,-4.99,0.00,EUR,PENDING,
CARD_PAYMENT,Current,2026-10-07 09:00:00,2026-10-07 09:00:00,BKK Automata,-950.00,0.00,HUF,COMPLETED,257775.00
ATM,Current,2026-10-08 11:00:00,2026-10-08 11:00:00,Cash at OTP ATM,-20000.00,500.00,HUF,COMPLETED,237275.00
CARD_PAYMENT,Current,2026-10-09 13:00:00,2026-10-09 13:00:00,Spotify,-11.99,0.00,EUR,COMPLETED,88.01
CARD_PAYMENT,Current,2026-10-10 13:00:00,2026-10-10 13:00:00,Broken row,abc,0.00,EUR,COMPLETED,88.01
`;

describe("Revolut statement parsing", () => {
  it("parses the app's CSV export, skipping exchanges and non-completed rows", async () => {
    const { rows, errors } = parseStatementCsv(CSV);
    expect(rows).toHaveLength(10);
    expect(errors).toEqual(['Row 12: invalid Amount "abc"']);
    expect(rows[0]).toMatchObject({ type: "CARD_PAYMENT", startedDate: "2026-10-01T06:15:42.000Z", completedDate: "2026-10-02T07:01:10.000Z", amount: -4785, currency: "HUF" });

    const { txs, ignored } = toTransactions(rows);
    expect(ignored).toBe(3); // 2 exchange legs + 1 pending
    expect(txs).toHaveLength(7);
    const spar = txs[0]!;
    expect(spar).toMatchObject({ date: "2026-10-02T07:01:10.000Z", amount: -4785, merchant: "Spar", categoryId: "groceries" });
    expect(spar.externalId).toBe(statementExternalId("2026-10-02T07:01:10.000Z", -4785, "Spar"));
    const atm = txs.find((t) => t.merchant.startsWith("Cash"))!;
    expect(atm.amount).toBe(-20500); // fee deducted
    expect(atm.note).toContain("díj: 500 HUF");
    expect(txs.map((t) => t.categoryId)).toEqual(["groceries", "restaurant", "income", null, "transport", "other", "subscriptions"]);
  });

  it("keyword categorizer handles accents and case", async () => {
    expect(categorize("TESCO GLOBAL ÁRUHÁZAK", -1)).toBe("groceries");
    expect(categorize("Bolt Food", -1)).toBe("restaurant");
    expect(categorize("Bolt.eu ride", -1)).toBe("transport");
    expect(categorize("BENU Gyógyszertár", -1)).toBe("health");
    expect(categorize("Card refund Zara", 5000, "CARD_REFUND")).toBe("clothing");
    expect(categorize("Random shop", -1)).toBeNull();
    // Rule words are matched against accent-stripped input, so the rules themselves must be accent-free.
    expect(categorize("Fővárosi Vízművek Zrt.", -5000)).toBe("utilities");
  });

  it("treats a header-only statement as empty, not as broken rows", async () => {
    expect(parseStatementCsv("Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n")).toEqual({ rows: [], errors: [] });
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Statement").addRow(["Type", "Product", "Started Date", "Completed Date", "Description", "Amount", "Fee", "Currency", "State", "Balance"]);
    expect(await parseStatementXlsx(Buffer.from(await wb.xlsx.writeBuffer()))).toEqual({ rows: [], errors: [] });
    expect(() => parseStatementCsv("")).toThrow(/Not a Revolut statement/);
  });

  it("reads a description with a stray quote instead of failing the whole file", async () => {
    const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2026-10-01 08:15:42,2026-10-02 09:01:10,Spar 5" cable,-4785.00,0.00,HUF,COMPLETED,120215.00
`;
    const { rows, errors } = parseStatementCsv(csv);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.description)).toEqual(['Spar 5" cable']);

    const app = await testApp();
    for (const url of ["/api/revolut/import-statement", "/api/statements/parse"]) {
      const r = await app.inject({ method: "POST", url, ...multipart("statement.csv", "text/csv", csv) });
      expect(r.statusCode, `${url}: ${r.body}`).toBe(200);
    }
    await app.close();
  });
});

describe("POST /api/revolut/import-statement", () => {
  it("imports, then skips everything on re-import (dedupe on externalId)", async () => {
    const app = await testApp();
    const first = await app.inject({ method: "POST", url: "/api/revolut/import-statement", ...multipart("statement.csv", "text/csv", CSV) });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ imported: 7, skipped: 3 });
    const txs = await app.deps.repo.listTransactions();
    expect(txs).toHaveLength(7);
    expect(txs.every((t) => t.source === "revolut" && t.externalId?.startsWith("revolut:"))).toBe(true);

    const again = await app.inject({ method: "POST", url: "/api/revolut/import-statement", ...multipart("statement.csv", "text/csv", CSV) });
    expect(again.json()).toMatchObject({ imported: 0, skipped: 10 });
    expect(await app.deps.repo.listTransactions()).toHaveLength(7);

    const status = (await app.inject("/api/revolut/status")).json();
    expect(status).toMatchObject({ connected: true, mode: "csv" });
    expect(status.accounts).toEqual(
      expect.arrayContaining([
        { id: "Current:HUF", name: "Current (HUF)", currency: "HUF", balance: 237275 },
        { id: "Current:EUR", name: "Current (EUR)", currency: "EUR", balance: 88.01 },
      ]),
    );
    const sync = await app.inject({ method: "POST", url: "/api/revolut/sync" });
    expect(sync.statusCode).toBe(400);
    await app.close();
  });

  it("imports the Excel variant of the statement", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Statement");
    ws.addRow(["Type", "Product", "Started Date", "Completed Date", "Description", "Amount", "Fee", "Currency", "State", "Balance"]);
    ws.addRow(["CARD_PAYMENT", "Current", "2026-10-01 08:15:42", "2026-10-02 09:01:10", "Spar", -4785, 0, "HUF", "COMPLETED", 120215]);
    ws.addRow(["CARD_PAYMENT", "Current", new Date("2026-10-03T10:00:00Z"), new Date("2026-10-03T10:00:00Z"), "Lidl", -2100, 0, "HUF", "COMPLETED", 118115]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const app = await testApp();
    const r = await app.inject({ method: "POST", url: "/api/revolut/import-statement", ...multipart("statement.xlsx", "application/octet-stream", buf) });
    expect(r.json()).toMatchObject({ imported: 2, skipped: 0 });
    // Same Spar row as the CSV variant -> same externalId -> deduped across formats.
    const csv = await app.inject({ method: "POST", url: "/api/revolut/import-statement", ...multipart("s.csv", "text/csv", CSV) });
    expect(csv.json()).toMatchObject({ imported: 6, skipped: 4 });
    await app.close();
  });

  it("rejects files that are not Revolut statements", async () => {
    const app = await testApp();
    const r = await app.inject({ method: "POST", url: "/api/revolut/import-statement", ...multipart("x.csv", "text/csv", "a,b\n1,2\n") });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/Not a Revolut statement/);
    await app.close();
  });
});

describe("revolutDate", () => {
  it("reads statement wall-clock times as Europe/Budapest, DST-aware", async () => {
    expect(revolutDate("2026-10-31 23:30:00")).toBe("2026-10-31T22:30:00.000Z");
    expect(revolutDate("2026-07-01 12:00:00")).toBe("2026-07-01T10:00:00.000Z");
    expect(revolutDate(new Date(Date.UTC(2026, 6, 1, 12, 0, 0)))).toBe("2026-07-01T10:00:00.000Z");
    expect(revolutDate("2026-07-01 12:00:00", "UTC")).toBe("2026-07-01T12:00:00.000Z");
  });
});

describe("Revolut providers", () => {
  it("open-banking mode returns 501 with the AISP explanation", async () => {
    const app = await testApp({ revolut: new OpenBankingRevolutProvider() });
    expect((await app.inject("/api/revolut/status")).json()).toEqual({ connected: false, mode: "open-banking", lastSyncAt: null, accounts: [] });
    const r = await app.inject({ method: "POST", url: "/api/revolut/sync" });
    expect(r.statusCode).toBe(501);
    expect(r.json().error).toMatch(/AISP.*GoCardless.*Enable Banking/s);
    await app.close();
  });

  it("business-api mode maps accounts and transaction legs and dedupes on re-sync", async () => {
    const repo = new Repository(await openDb(":memory:"));
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://sandbox-b2b.revolut.com");
      if (url.pathname === "/api/1.0/accounts") {
        return Response.json([
          { id: "acc-1", name: "Main", balance: 1234.5, currency: "EUR", state: "active", public: false },
          { id: "acc-2", name: "Old", balance: 0, currency: "USD", state: "inactive", public: false },
        ]);
      }
      expect(url.pathname).toBe("/api/1.0/transactions");
      expect(url.searchParams.get("count")).toBe("1000");
      return Response.json([
        {
          id: "tx-1",
          type: "card_payment",
          state: "completed",
          created_at: "2026-10-10T10:00:00Z",
          completed_at: "2026-10-11T10:00:00Z",
          merchant: { name: "Lidl", city: "Budapest" },
          legs: [{ leg_id: "l1", account_id: "acc-1", amount: -42.1, fee: 0, currency: "EUR", description: "Lidl" }],
        },
        { id: "tx-2", type: "card_payment", state: "pending", created_at: "2026-10-12T10:00:00Z", legs: [] },
      ]);
    });
    const p = new BusinessApiRevolutProvider(repo, "tok", "sandbox", fetchImpl as unknown as typeof fetch);
    const st = await p.status();
    expect(st).toMatchObject({ connected: true, mode: "business-api", accounts: [{ id: "acc-1", name: "Main", currency: "EUR", balance: 1234.5 }] });
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ headers: { authorization: "Bearer tok" } });

    expect(await p.sync()).toEqual({ imported: 1, skipped: 1 });
    expect((await repo.listTransactions())[0]).toMatchObject({ merchant: "Lidl", amount: -42.1, categoryId: "groceries", externalId: "revolut-biz:tx-1:l1" });
    expect(await p.sync()).toEqual({ imported: 0, skipped: 2 });
    // The second sync must reach back to the still-pending tx-2, not just one day before the last sync.
    const txCalls = fetchImpl.mock.calls.map((c) => new URL(String(c[0]))).filter((u) => u.pathname.endsWith("/transactions"));
    expect(txCalls[1]!.searchParams.get("from")).toBe("2026-10-12T10:00:00.000Z");
  });

  it("business-api mode pages with `to` and counts a re-fetched boundary item once", async () => {
    const repo = new Repository(await openDb(":memory:"));
    const mk = (n: number) => ({
      id: `tx-${n}`,
      type: "card_payment",
      state: "completed",
      created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString(),
      legs: [{ leg_id: `l-${n}`, account_id: "acc-1", amount: -1, fee: 0, currency: "EUR" }],
    });
    const first = Array.from({ length: 1000 }, (_, n) => mk(n));
    const calls: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url);
      // Page 2 starts with the boundary item (created_at == `to`) again, as an inclusive `to` would return it.
      return Response.json(calls.length === 1 ? first : [first[999], mk(1000)]);
    });
    const p = new BusinessApiRevolutProvider(repo, "tok", "sandbox", fetchImpl as unknown as typeof fetch);
    expect(await p.sync()).toEqual({ imported: 1001, skipped: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.searchParams.get("to")).toBe(first[999]!.created_at);
    expect(await repo.listTransactions()).toHaveLength(1001);
  });

  it("business-api mode without a token reports disconnected", async () => {
    const p = new BusinessApiRevolutProvider(new Repository(await openDb(":memory:")), undefined, "production");
    expect((await p.status()).connected).toBe(false);
    await expect(p.sync()).rejects.toThrow(/REVOLUT_BUSINESS_TOKEN/);
  });
});
