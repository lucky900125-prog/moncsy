import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/ai/index.js";
import { revolutDate } from "../src/revolut/csv.js";
import { parseStatementFile } from "../src/statements/index.js";
import { parseStatementDate } from "../src/statements/values.js";

const TZ = "Europe/Budapest";
const parse = (filename: string, data: Buffer | string) =>
  parseStatementFile({ filename, data: typeof data === "string" ? Buffer.from(data) : data }, { defaultCurrency: "HUF", timeZone: TZ }, new MockProvider());

describe("statement edge cases from the fourth review round", () => {
  it("reads a date cell that is a formula as the date it shows (BE-13)", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Kivonat");
    ws.addRow(["Dátum", "Partner", "Összeg", "Deviza"]);
    ws.addRow([{ formula: "DATE(2026,10,14)", result: new Date(Date.UTC(2026, 9, 14)) }, "Lidl", -3250, "HUF"]);
    const r = await parse("export.xlsx", Buffer.from(await wb.xlsx.writeBuffer()));
    expect(r.errors).toEqual([]);
    expect(r.transactions).toMatchObject([{ merchant: "Lidl", date: "2026-10-14T10:00:00.000Z" }]);
  });

  it("reads a Revolut workbook from the sheet it recognised, behind a cover sheet (BE-14)", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Cover").addRow(["Revolut"]);
    const ws = wb.addWorksheet("Statement");
    ws.addRow(["Type", "Product", "Started Date", "Completed Date", "Description", "Amount", "Fee", "Currency", "State", "Balance"]);
    ws.addRow(["CARD_PAYMENT", "Current", "2026-10-01 08:15:42", "2026-10-01 09:00:00", "Spar", -4785, 0, "HUF", "COMPLETED", 1000]);
    ws.addRow(["CARD_PAYMENT", "Current", "2026-10-02 08:15:42", "2026-10-02 09:00:00", "Lidl", -1000, 0, "HUF", "COMPLETED", 0]);
    const r = await parse("account-statement.xlsx", Buffer.from(await wb.xlsx.writeBuffer()));
    expect(r.format).toBe("revolut");
    expect(r.transactions.map((t) => t.merchant)).toEqual(["Spar", "Lidl"]);
  });

  it("keeps the last OFX transaction when its block is never closed (BE-15)", async () => {
    const ofx = `OFXHEADER:100
DATA:OFXSGML

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>EUR
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261003<TRNAMT>-12.50<FITID>A1<NAME>Lidl
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261004<TRNAMT>100.00<FITID>A2<NAME>Refund
`;
    const r = await parse("bank.ofx", ofx);
    expect(r.transactions.map((t) => t.merchant)).toEqual(["Lidl", "Refund"]);
  });

  it("refuses a day or a time the calendar does not have, instead of rolling it over (BE-16)", () => {
    expect(() => parseStatementDate("31.02.2026", "dmy", TZ)).toThrow(/invalid date "31.02.2026"/);
    expect(() => parseStatementDate("2026-10-14 99:99", "ymd", TZ)).toThrow(/invalid date/);
    expect(() => revolutDate("2026-02-30 10:00:00", TZ)).toThrow(/invalid date "2026-02-30 10:00:00"/);
    expect(() => revolutDate("2026-10-14 24:00:00", TZ)).toThrow(/invalid date/);
    expect(parseStatementDate("29.02.2028", "dmy", TZ)).toBe("2028-02-29T11:00:00.000Z");
  });

  it("reads a Revolut date cell that holds an Excel serial number as that day (BE-17)", () => {
    expect(revolutDate(46309, TZ)).toBe("2026-10-13T22:00:00.000Z");
    expect(() => revolutDate("46309", TZ)).toThrow(/invalid date "46309"/);
  });
});
