import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { Repository } from "../src/repository.js";
import { BusinessApiRevolutProvider } from "../src/revolut/business-api.js";
import { categorize } from "../src/revolut/categorize.js";
import { parseStatementCsv, statementExternalId, toTransactions } from "../src/revolut/csv.js";
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
  it("parses the app's CSV export, skipping exchanges and non-completed rows", () => {
    const { rows, errors } = parseStatementCsv(CSV);
    expect(rows).toHaveLength(10);
    expect(errors).toEqual(['Row 12: invalid Amount "abc"']);
    expect(rows[0]).toMatchObject({ type: "CARD_PAYMENT", startedDate: "2026-10-01T08:15:42.000Z", completedDate: "2026-10-02T09:01:10.000Z", amount: -4785, currency: "HUF" });

    const { txs, ignored } = toTransactions(rows);
    expect(ignored).toBe(3); // 2 exchange legs + 1 pending
    expect(txs).toHaveLength(7);
    const spar = txs[0]!;
    expect(spar).toMatchObject({ date: "2026-10-02T09:01:10.000Z", amount: -4785, merchant: "Spar", categoryId: "groceries" });
    expect(spar.externalId).toBe(statementExternalId("2026-10-02T09:01:10.000Z", -4785, "Spar"));
    const atm = txs.find((t) => t.merchant.startsWith("Cash"))!;
    expect(atm.amount).toBe(-20500); // fee deducted
    expect(atm.note).toContain("díj: 500 HUF");
    expect(txs.map((t) => t.categoryId)).toEqual(["groceries", "restaurant", "income", null, "transport", "other", "subscriptions"]);
  });

  it("keyword categorizer handles accents and case", () => {
    expect(categorize("TESCO GLOBAL ÁRUHÁZAK", -1)).toBe("groceries");
    expect(categorize("Bolt Food", -1)).toBe("restaurant");
    expect(categorize("Bolt.eu ride", -1)).toBe("transport");
    expect(categorize("BENU Gyógyszertár", -1)).toBe("health");
    expect(categorize("Card refund Zara", 5000, "CARD_REFUND")).toBe("clothing");
    expect(categorize("Random shop", -1)).toBeNull();
  });
});

describe("POST /api/revolut/import-statement", () => {
  it("imports, then skips everything on re-import (dedupe on externalId)", async () => {
    const app = await testApp();
    const first = await app.inject({ method: "POST", url: "/api/revolut/import-statement", ...multipart("statement.csv", "text/csv", CSV) });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ imported: 7, skipped: 3 });
    const txs = app.deps.repo.listTransactions();
    expect(txs).toHaveLength(7);
    expect(txs.every((t) => t.source === "revolut" && t.externalId?.startsWith("revolut:"))).toBe(true);

    const again = await app.inject({ method: "POST", url: "/api/revolut/import-statement", ...multipart("statement.csv", "text/csv", CSV) });
    expect(again.json()).toMatchObject({ imported: 0, skipped: 10 });
    expect(app.deps.repo.listTransactions()).toHaveLength(7);

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
    const repo = new Repository(openDb(":memory:"));
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
    expect(repo.listTransactions()[0]).toMatchObject({ merchant: "Lidl", amount: -42.1, categoryId: "groceries", externalId: "revolut-biz:tx-1:l1" });
    expect(await p.sync()).toEqual({ imported: 0, skipped: 2 });
  });

  it("business-api mode without a token reports disconnected", async () => {
    const p = new BusinessApiRevolutProvider(new Repository(openDb(":memory:")), undefined, "production");
    expect((await p.status()).connected).toBe(false);
    await expect(p.sync()).rejects.toThrow(/REVOLUT_BUSINESS_TOKEN/);
  });
});
