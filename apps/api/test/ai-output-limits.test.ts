import { describe, expect, it } from "vitest";
import type { Category } from "@et/shared";
import type { AIProvider } from "../src/ai/index.js";
import { aggregate, analyze } from "../src/services/analyze.js";
import { scanReceipt } from "../src/services/receipt.js";
import { parsePdfStatement } from "../src/statements/pdf.js";

const canned = (answer: unknown): AIProvider => {
  const text = JSON.stringify(answer);
  return { name: "canned", model: "canned-1", complete: async () => text, vision: async () => text };
};

const categories: Category[] = [{ id: "groceries", name: "Élelmiszer", icon: "shopping-cart", color: "#22c55e", isCustom: false }];
const line = { name: "Tej 1l", quantity: 1, unitPrice: 389, total: 389, product: "tej", brand: "Mizo", packSize: 1, packUnit: "l" };
const receipt = (over: Record<string, unknown> = {}) => ({
  merchant: "SPAR",
  date: "2026-10-12",
  total: 389,
  currency: "HUF",
  items: [line],
  suggestedCategoryId: "groceries",
  confidence: 0.9,
  rawText: "SPAR\nTej 1l 389\nÖSSZESEN 389 Ft",
  ...over,
});
const scan = (answer: unknown) => scanReceipt(canned(answer), categories, "QUJD", "image/jpeg");

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(32)]);
const readPdf = (answer: unknown) => parsePdfStatement(canned(answer), PDF, "HUF", "Europe/Budapest");
const rows = [
  { date: "2026-10-01", amount: -4785, currency: null, counterparty: "SPAR", description: "Kártyás vásárlás" },
  { date: "2026-10-03", amount: 685000, currency: null, counterparty: "Példa Kft.", description: "Munkabér" },
  { date: "2026-10-05", amount: -12990.5, currency: null, counterparty: "MVM Next", description: "Áramdíj" },
];

describe("receipt scan: the model's answer is bounded", () => {
  it.each([
    ["more lines than any receipt has", receipt({ items: Array.from({ length: 501 }, () => line) }), /items: Too big/],
    ["a merchant longer than a transaction can store", receipt({ merchant: "S".repeat(201) }), /merchant: Too big/],
    ["an overlong line name", receipt({ items: [{ ...line, name: "T".repeat(201) }] }), /items\.0\.name: Too big/],
    ["an overlong raw text", receipt({ rawText: "x".repeat(20_001) }), /rawText: Too big/],
    ["an overlong category id", receipt({ suggestedCategoryId: "g".repeat(201) }), /suggestedCategoryId: Too big/],
  ])("refuses %s", async (_what, answer, issue) => {
    const err = await scan(answer).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 502 });
    expect((err as Error).message).toMatch(issue);
  });

  it("drops a product or brand longer than a saved line takes, and keeps the line", async () => {
    const r = await scan(receipt({ items: [{ ...line, product: "t".repeat(121), brand: "M".repeat(121) }] }));
    expect(r.items).toMatchObject([{ name: "Tej 1l", total: 389, product: null, brand: null }]);
  });

  it("still reads a receipt at the limits", async () => {
    const r = await scan(receipt({ merchant: "S".repeat(200), items: Array.from({ length: 500 }, () => line), rawText: "x".repeat(20_000) }));
    expect(r.items).toHaveLength(500);
    expect(r.merchant).toHaveLength(200);
  });
});

describe("analysis: the model's answer is bounded", () => {
  const agg = aggregate([], categories, "2026-10-01", "2026-10-31", "HUF");
  const analysis = (over: Record<string, unknown> = {}) => ({
    summary: "Rendben.",
    insights: [{ title: "Élelmiszer", detail: "A legnagyobb tétel.", severity: "info" }],
    ...over,
  });
  const run = (answer: unknown) => analyze(canned(answer), { from: "2026-10-01", to: "2026-10-31" }, agg);

  it.each([
    ["an overlong summary", analysis({ summary: "s".repeat(4001) }), /summary: Too big/],
    ["an overlong insight title", analysis({ insights: [{ title: "t".repeat(201), detail: "d", severity: "info" }] }), /insights\.0\.title: Too big/],
    ["an overlong insight detail", analysis({ insights: [{ title: "t", detail: "d".repeat(2001), severity: "info" }] }), /insights\.0\.detail: Too big/],
  ])("refuses %s", async (_what, answer, issue) => {
    const err = await run(answer).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 502 });
    expect((err as Error).message).toMatch(issue);
  });

  it("still reads an analysis at the limits", async () => {
    const r = await run(analysis({ summary: "s".repeat(4000), insights: [{ title: "t".repeat(200), detail: "d".repeat(2000), severity: "warning" }] }));
    expect(r.summary).toHaveLength(4000);
  });
});

describe("PDF statement: the model's answer is bounded and checked against the balances", () => {
  it.each([
    ["more transactions than an import takes", { currency: "HUF", transactions: Array.from({ length: 20_001 }, () => rows[0]) }, /transactions: Too big/],
    ["an overlong counterparty", { currency: "HUF", transactions: [{ ...rows[0], counterparty: "c".repeat(1001) }] }, /transactions\.0\.counterparty: Too big/],
    ["an overlong description", { currency: "HUF", transactions: [{ ...rows[0], description: "d".repeat(4001) }] }, /transactions\.0\.description: Too big/],
    ["an overlong date", { currency: "HUF", transactions: [{ ...rows[0], date: `2026-10-01${" ".repeat(40)}` }] }, /transactions\.0\.date: Too big/],
  ])("refuses %s", async (_what, answer, issue) => {
    const err = await readPdf(answer).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 502 });
    expect((err as Error).message).toMatch(issue);
  });

  it("warns when the transactions do not account for the change in balance, and still lists them", async () => {
    // 150 000 + (-4785 + 685000 - 12990.50) = 817 224.50; the closing balance says 812 439.50, so one SPAR line is too many or misread.
    const r = await readPdf({ currency: "HUF", openingBalance: 150000, closingBalance: 812439.5, transactions: rows });
    expect(r.transactions).toHaveLength(3);
    expect(r.errors).toEqual([
      "The listed transactions add up to 667224.50 HUF, but the balance moved by 662439.50 HUF (from 150000.00 to 812439.50): " +
        "a row is missing, doubled or misread. Compare the list with the PDF before importing.",
    ]);
  });

  it("warns when the model listed the closing balance as a transaction", async () => {
    const r = await readPdf({
      currency: "HUF",
      openingBalance: 150000,
      closingBalance: 817224.5,
      transactions: [...rows, { date: "2026-10-31", amount: 817224.5, currency: null, counterparty: null, description: "Záró egyenleg" }],
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^The listed transactions add up to 1484449\.00 HUF, but the balance moved by 667224\.50 HUF/);
  });

  it("says nothing when the balances match, to the cent", async () => {
    const r = await readPdf({ currency: "HUF", openingBalance: 150000, closingBalance: 817224.5, transactions: rows });
    expect(r.errors).toEqual([]);
    expect(r.transactions).toHaveLength(3);
  });

  it("checks nothing it cannot check: a missing balance, an unreadable row, or a row in another currency", async () => {
    const off = { currency: "HUF", openingBalance: 150000, closingBalance: 1 };
    expect((await readPdf({ currency: "HUF", openingBalance: null, closingBalance: 1, transactions: rows })).errors).toEqual([]);
    expect((await readPdf({ currency: "HUF", transactions: rows })).errors).toEqual([]);
    expect((await readPdf({ ...off, transactions: [...rows, { ...rows[0], amount: null }] })).errors).toEqual(["Transaction 4: unreadable amount"]);
    expect((await readPdf({ ...off, transactions: [...rows, { ...rows[0], currency: "EUR", amount: -20 }] })).errors).toEqual([]);
  });
});
