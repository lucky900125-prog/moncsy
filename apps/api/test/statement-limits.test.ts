import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/ai/index.js";
import { parseStatementFile } from "../src/statements/index.js";
import { multipart, testApp } from "./helpers.js";

const opts = { defaultCurrency: "HUF", timeZone: "Europe/Budapest" };
const csv = (rows: number, pad = "") =>
  "Dátum;Összeg;Partner;Közlemény\n" +
  Array.from({ length: rows }, (_, i) => `2026.10.${String((i % 28) + 1).padStart(2, "0")};-${i + 1};Bolt ${i};Vásárlás ${i}${pad}\n`).join("");
const revolut = (rows: number, pad = "") =>
  "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n" +
  Array.from({ length: rows }, (_, i) => `CARD_PAYMENT,Current,2026-10-01 10:00:00,2026-10-01 10:00:01,Bolt ${i}${pad},-${i + 1}.00,0.00,HUF,COMPLETED,1000.00\n`).join("");

describe("text statement limits", () => {
  it("refuses a text statement over 4 MB by its size, on the preview and the Revolut import", async () => {
    const app = await testApp();
    const pad = " ".repeat(200);
    const big = csv(20_000, pad);
    expect(big.length).toBeGreaterThan(4 * 1024 * 1024);
    for (const [url, body] of [["/api/statements/parse", big], ["/api/revolut/import-statement", revolut(20_000, pad)]] as const) {
      const res = await app.inject({ method: "POST", url, ...multipart("kivonat.csv", "text/csv", body) });
      expect(res.statusCode, url).toBe(413);
      expect(res.json().error).toMatch(/^The statement is \d+\.\d MB; text statements \(CSV, OFX, MT940, CAMT\) of more than 4 MB are not read/);
    }
    expect((await app.inject("/api/transactions")).json()).toHaveLength(0);
    await app.close();
  });

  it("offers at most as many rows in a preview as one import takes, and imports no more from Revolut", async () => {
    const r = await parseStatementFile({ filename: "kivonat.csv", data: Buffer.from(csv(20_000)) }, opts, new MockProvider());
    expect(r.transactions).toHaveLength(20_000);
    await expect(parseStatementFile({ filename: "kivonat.csv", data: Buffer.from(csv(20_001)) }, opts, new MockProvider())).rejects.toThrow(
      /^The statement has 20001 rows; more than 20000 are not read at once/,
    );
    const app = await testApp();
    const res = await app.inject({ method: "POST", url: "/api/revolut/import-statement", ...multipart("revolut.csv", "text/csv", revolut(20_001)) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/has 20001 rows/);
    expect((await app.inject("/api/transactions")).json()).toHaveLength(0);
    await app.close();
  });

  it("finds each OFX transaction's currency in one pass, so a CURDEF per transaction is not quadratic", async () => {
    const tx = (i: number) => `<CURDEF>${i % 2 ? "EUR" : "HUF"}<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261014<TRNAMT>-${i}.50<FITID>F${i}<NAME>Bolt ${i}</STMTTRN>\n`;
    const ofx = "OFXHEADER:100\n<OFX>" + Array.from({ length: 20_000 }, (_, i) => tx(i)).join("") + "</OFX>";
    const started = performance.now();
    const r = await parseStatementFile({ filename: "k.ofx", data: Buffer.from(ofx) }, opts, new MockProvider());
    // Searching every CURDEF for every transaction took 4.4 s here; one pass takes a tenth of that.
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(r.transactions).toHaveLength(20_000);
    expect(r.transactions.slice(0, 3).map((t) => t.currency)).toEqual(["HUF", "EUR", "HUF"]);
  });
});
