import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { MockProvider, type AIProvider } from "../src/ai/index.js";
import { decodeText, detectDelimiter, parseStatementFile } from "../src/statements/index.js";
import { detectMapping, parseTabular } from "../src/statements/tabular.js";
import { detectDateOrder, detectDecimal, parseAmount, parseStatementDate } from "../src/statements/values.js";
import { multipart, testApp } from "./helpers.js";

const TZ = "Europe/Budapest";
const opts = { defaultCurrency: "HUF", timeZone: TZ };
const ai = new MockProvider();
const parse = (filename: string, data: Buffer | string, extra = {}) =>
  parseStatementFile({ filename, data: typeof data === "string" ? Buffer.from(data) : data }, { ...opts, ...extra }, ai);

describe("statement values", () => {
  it("reads amounts in Hungarian, English and accounting notation", () => {
    expect(parseAmount("1 234,56", ",")).toBe(1234.56);
    expect(parseAmount("-1.234,56", ",")).toBe(-1234.56);
    expect(parseAmount("1,234.56", ".")).toBe(1234.56);
    expect(parseAmount("1234,56-", ",")).toBe(-1234.56);
    expect(parseAmount("(12.50)", ".")).toBe(-12.5);
    expect(parseAmount("-12 000 Ft", ",")).toBe(-12000);
    expect(parseAmount("HUF 5 000", ",")).toBe(5000);
    expect(parseAmount("", ",")).toBeNull();
    expect(() => parseAmount("n/a", ",")).toThrow(/not an amount/);
  });

  it("judges the decimal separator from the whole column", () => {
    expect(detectDecimal(["1.234", "12.000", "-500"])).toBe(","); // dots are thousands
    expect(detectDecimal(["12.50", "3.99"])).toBe(".");
    expect(detectDecimal(["1,234.00", "5.00"])).toBe(".");
    expect(detectDecimal(["-4 785,00", "120"])).toBe(",");
  });

  it("reads a yyyymmdd number as a date, not as an Excel serial", () => {
    expect(parseStatementDate(20261014, "dmy", TZ)).toBe("2026-10-14T10:00:00.000Z");
    expect(parseStatementDate(46309, "dmy", TZ)).toBe("2026-10-14T10:00:00.000Z");
    expect(() => parseStatementDate(3_000_000, "dmy", TZ)).toThrow(/invalid date/);
    expect(() => parseStatementDate(0, "dmy", TZ)).toThrow(/invalid date/);
  });

  it("reads dates year-first, day-first and month-first, as local time", () => {
    expect(detectDateOrder(["2026.10.14."])).toBe("ymd");
    expect(detectDateOrder(["01/02/2026", "25/02/2026"])).toBe("dmy");
    expect(detectDateOrder(["02/25/2026"])).toBe("mdy");
    // Date only -> local noon (10:00Z in CEST)
    expect(parseStatementDate("2026.10.14.", "ymd", TZ)).toBe("2026-10-14T10:00:00.000Z");
    expect(parseStatementDate("14.10.2026 08:15", "dmy", TZ)).toBe("2026-10-14T06:15:00.000Z");
    expect(parseStatementDate("20261014", "ymd", TZ)).toBe("2026-10-14T10:00:00.000Z");
    expect(parseStatementDate(new Date(Date.UTC(2026, 0, 5)), "ymd", TZ)).toBe("2026-01-05T11:00:00.000Z"); // CET
    expect(() => parseStatementDate("31.31.2026", "dmy", TZ)).toThrow(/invalid date/);
  });

  it("reads the Hungarian Excel date with a space after each dot", async () => {
    expect(detectDateOrder(["2026. 10. 14."])).toBe("ymd");
    expect(parseStatementDate("2026. 10. 14.", "dmy", TZ)).toBe("2026-10-14T10:00:00.000Z");
    expect(parseStatementDate("2026. 10. 14. 8:15", "dmy", TZ)).toBe("2026-10-14T06:15:00.000Z");
    expect(parseStatementDate("14. 10. 2026", "dmy", TZ)).toBe("2026-10-14T10:00:00.000Z");
    // What a hu-HU Excel writes when the sheet is saved as CSV.
    const r = await parse("kivonat.csv", "Dátum;Összeg;Partner\n2026. 10. 14.;-4 785;Spar\n2026. 10. 15. 8:15;685 000;Példa Kft.\n");
    expect(r.errors).toEqual([]);
    expect(r.transactions.map((t) => [t.date, t.amount])).toEqual([
      ["2026-10-14T10:00:00.000Z", -4785],
      ["2026-10-15T06:15:00.000Z", 685000],
    ]);
  });

  it("decodes Windows-1250 exports and finds the delimiter", () => {
    const cp1250 = Buffer.from([0x4b, 0xf6, 0x7a, 0x6c, 0x65, 0x6d, 0xe9, 0x6e, 0x79]); // "Közlemény"
    expect(decodeText(cp1250)).toBe("Közlemény");
    expect(decodeText(Buffer.from("\uFEFFDátum", "utf8"))).toBe("Dátum");
    expect(detectDelimiter('a;b;c\n1;"x;y";3\n')).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2\n")).toBe("\t");
  });

  it("maps Hungarian and English header names to roles", () => {
    expect(detectMapping(["Könyvelés dátuma", "Értéknap", "Összeg (HUF)", "Partner neve", "Közlemény", "Egyenleg"])).toEqual({
      date: "Könyvelés dátuma",
      valueDate: "Értéknap",
      amount: "Összeg (HUF)",
      counterparty: "Partner neve",
      description: "Közlemény",
      balance: "Egyenleg",
    });
    expect(detectMapping(["Date", "Description", "Paid out", "Paid in", "Balance"])).toMatchObject({
      date: "Date",
      debit: "Paid out",
      credit: "Paid in",
      description: "Description",
    });
    // German exports often label the booking text just "Text".
    expect(detectMapping(["Buchungstag", "Valuta", "Auftraggeber/Empfänger", "Text", "Betrag", "Währung"])).toEqual({
      date: "Buchungstag",
      valueDate: "Valuta",
      counterparty: "Auftraggeber/Empfänger",
      description: "Text",
      amount: "Betrag",
      currency: "Währung",
    });
  });
});

describe("tabular statements", () => {
  it("reads a Hungarian bank CSV with account details above the table", async () => {
    const csv = [
      "Számlaszám;11773016-12345678-00000000",
      "Időszak;2026.10.01.-2026.10.31.",
      "",
      "Könyvelés dátuma;Értéknap;Partner neve;Közlemény;Összeg (HUF);Egyenleg",
      "2026.10.02.;2026.10.02.;SPAR MAGYARORSZAG KFT;Kártyás vásárlás;-4 785,00;120 215,00",
      "2026.10.05.;2026.10.05.;Példa Kft.;Munkabér;685 000,00;805 215,00",
      "2026.10.06.;2026.10.06.;WOLT;;-6 490,00;798 725,00",
      "2026.10.06.;2026.10.06.;WOLT;;-6 490,00;792 235,00",
      "2026.10.07.;2026.10.07.;Hibás sor;;abc;0",
      ";;;Záró egyenleg;;792 235,00",
    ].join("\r\n");
    const r = await parse("kivonat.csv", csv);
    expect(r.format).toBe("csv");
    expect(r.currency).toBe("HUF");
    expect(r.mapping).toMatchObject({ date: "Könyvelés dátuma", amount: "Összeg (HUF)", counterparty: "Partner neve" });
    expect(r.errors).toEqual(['Row 9: not an amount: "abc"']);
    expect(r.ignored).toBe(1); // closing balance line without a date
    expect(r.transactions.map((t) => [t.merchant, t.amount, t.categoryId])).toEqual([
      ["SPAR MAGYARORSZAG KFT", -4785, "groceries"],
      ["Példa Kft.", 685000, "income"],
      ["WOLT", -6490, "restaurant"],
      ["WOLT", -6490, "restaurant"],
    ]);
    expect(r.transactions[0]).toMatchObject({ date: "2026-10-02T10:00:00.000Z", currency: "HUF", note: "Kártyás vásárlás", source: "import" });
    // Two identical rows stay two transactions with different ids.
    expect(new Set(r.transactions.map((t) => t.externalId)).size).toBe(4);
    // The same file gives the same ids, which is what makes a re-import a no-op.
    expect((await parse("kivonat.csv", csv)).transactions.map((t) => t.externalId)).toEqual(r.transactions.map((t) => t.externalId));
  });

  it("keeps rows of different statements apart when the reference column repeats", async () => {
    const head = "Dátum;Összeg;Partner;Azonosító\n";
    const sep = await parse("szept.csv", `${head}2026.09.02.;-1000;Tesco;123456\n2026.09.03.;-2000;Spar;123456\n`);
    const oct = await parse("okt.csv", `${head}2026.10.02.;-7777;MOL;123456\n2026.10.03.;-8888;Lidl;123456\n`);
    expect(sep.mapping).toMatchObject({ reference: "Azonosító" });
    const ids = [...sep.transactions, ...oct.transactions].map((t) => t.externalId);
    expect(new Set(ids).size).toBe(4);
    // The same file read twice still gives the same ids, so a second import skips it.
    expect((await parse("szept.csv", `${head}2026.09.02.;-1000;Tesco;123456\n2026.09.03.;-2000;Spar;123456\n`)).transactions.map((t) => t.externalId)).toEqual(
      sep.transactions.map((t) => t.externalId),
    );
  });

  it("keeps the first row of a file without a header once its columns are chosen by hand", async () => {
    const csv = "2026.10.01;-12000;Tesco\n2026.10.02;-500;BKK\n";
    const offered = await parse("kivonat.csv", csv);
    expect(offered.columns).toEqual(["2026.10.01", "-12000", "Tesco"]);
    expect(offered.transactions).toEqual([]);
    const mapped = await parse("kivonat.csv", csv, { mapping: { date: "2026.10.01", amount: "-12000", counterparty: "Tesco" } });
    expect(mapped.errors).toEqual([]);
    expect(mapped.transactions.map((t) => [t.merchant, t.amount])).toEqual([
      ["Tesco", -12000],
      ["BKK", -500],
    ]);
  });

  it("reads a long header cell with an unclosed parenthesis in linear time", () => {
    const cell = `Összeg ${"(".repeat(100_000)}`;
    const started = performance.now();
    expect(detectMapping(["Dátum", cell, "Partner"])).toMatchObject({ date: "Dátum", amount: cell });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("reports a direction it does not know when the amounts carry no sign", async () => {
    const unsigned = await parse("k.csv", "Dátum;Összeg;Irány;Partner\n2026.10.01;100;OUT;Tesco\n2026.10.02;50;IN;Bér\n2026.10.03;70;X;Rejtély\n");
    expect(unsigned.mapping).toMatchObject({ direction: "Irány" });
    expect(unsigned.transactions.map((t) => [t.merchant, t.amount])).toEqual([
      ["Tesco", -100],
      ["Bér", 50],
    ]);
    expect(unsigned.errors).toEqual([expect.stringMatching(/^Row 4: unknown direction "X"/)]);
    // With signed amounts the column only describes the transaction, and any value is fine.
    const signed = await parse("k.csv", "Dátum;Összeg;Irány;Partner\n2026.10.01;-100;Kártya;Tesco\n2026.10.02;50;Utalás;Bér\n");
    expect(signed.errors).toEqual([]);
    expect(signed.transactions.map((t) => t.amount)).toEqual([-100, 50]);
  });

  it("reads tab-separated text named .xls as text", async () => {
    const r = await parse("export.xls", "Dátum\tÖsszeg\tPartner\n2026.10.14\t-1500\tBKK\n");
    expect(r.format).toBe("csv");
    expect(r.transactions).toMatchObject([{ merchant: "BKK", amount: -1500 }]);
  });

  it("reads separate debit and credit columns and a direction column", () => {
    const debitCredit = parseTabular(
      [
        ["Date", "Description", "Paid out", "Paid in", "Currency"],
        ["14/10/2026", "TESCO STORES", "12.40", "", "GBP"],
        ["15/10/2026", "Salary", "", "2,500.00", "GBP"],
      ],
      opts,
    );
    expect(debitCredit.transactions.map((t) => [t.amount, t.currency])).toEqual([
      [-12.4, "GBP"],
      [2500, "GBP"],
    ]);
    const direction = parseTabular(
      [
        ["Dátum", "Összeg", "T/J", "Közlemény"],
        ["2026-10-01", "1500", "T", "BKK"],
        ["2026-10-02", "2000", "J", "Visszautalás"],
      ],
      opts,
    );
    expect(direction.transactions.map((t) => t.amount)).toEqual([-1500, 2000]);
  });

  it("returns the columns for hand mapping when nothing is recognised, and uses the chosen mapping", () => {
    const rows = [
      ["Mikor", "Mennyi", "Kinek"],
      ["2026.10.01", "-100", "Valaki"],
    ];
    const first = parseTabular(rows, opts);
    expect(first.transactions).toEqual([]);
    expect(first.columns).toEqual(["Mikor", "Mennyi", "Kinek"]);
    expect(first.errors[0]).toMatch(/choose them by hand/);
    const mapped = parseTabular(rows, { ...opts, mapping: { date: "Mikor", amount: "Mennyi", counterparty: "Kinek" } });
    expect(mapped.transactions).toMatchObject([{ merchant: "Valaki", amount: -100 }]);
    expect(() => parseTabular(rows, { ...opts, mapping: { date: "Nincs ilyen" } })).toThrow(/No row has all the chosen columns/);
  });

  it("reads an XLSX statement with real dates and numbers on the busiest sheet", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Info").addRow(["Bank", "Példa Bank"]);
    const ws = wb.addWorksheet("Tranzakciók");
    ws.addRow(["Számla", "12345"]);
    ws.addRow([]);
    ws.addRow(["Tranzakció dátuma", "Kedvezményezett neve", "Összeg", "Deviza"]);
    ws.addRow([new Date(Date.UTC(2026, 9, 3, 14, 20)), "Lidl", -3250.5, "HUF"]);
    ws.addRow([new Date(Date.UTC(2026, 9, 4)), "MÁV", -1200, "HUF"]);
    const r = await parse("export.xlsx", Buffer.from(await wb.xlsx.writeBuffer()));
    expect(r.format).toBe("xlsx");
    expect(r.errors).toEqual([]);
    expect(r.transactions).toMatchObject([
      { merchant: "Lidl", amount: -3250.5, date: "2026-10-03T12:20:00.000Z", categoryId: "groceries" },
      { merchant: "MÁV", amount: -1200, date: "2026-10-04T10:00:00.000Z", categoryId: "transport" },
    ]);
  });

  it("routes a Revolut export to the Revolut reader", async () => {
    const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2026-10-01 08:15:42,2026-10-02 09:01:10,Spar,-4785.00,0.00,HUF,COMPLETED,120215.00
CARD_PAYMENT,Current,2026-10-06 20:00:00,,Netflix.com,-4.99,0.00,EUR,PENDING,`;
    const r = await parse("account-statement.csv", csv);
    expect(r.format).toBe("revolut");
    expect(r.ignored).toBe(1);
    expect(r.transactions).toMatchObject([{ merchant: "Spar", amount: -4785, source: "revolut" }]);
    expect(r.transactions[0]!.externalId).toMatch(/^revolut:/);
  });

  it("refuses old .xls and a moncsy export XML with a pointer to what to do", async () => {
    const xls = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(32)]);
    await expect(parse("old.xls", xls)).rejects.toThrow(/save it as \.xlsx or \.csv/);
    await expect(parse("x.xml", '<?xml version="1.0"?><expenses version="1"/>')).rejects.toThrow(/Import \(XLSX \/ XML\)/);
  });
});

describe("structured statement formats", () => {
  it("reads ISO 20022 camt.053, skipping pending entries", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
 <BkToCstmrStmt><Stmt>
  <Acct><Id><IBAN>HU42117730161111101800000000</IBAN></Id><Ccy>HUF</Ccy></Acct>
  <Ntry><Amt Ccy="HUF">4785.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts>
   <BookgDt><Dt>2026-10-02</Dt></BookgDt><AcctSvcrRef>REF-1</AcctSvcrRef>
   <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>SPAR Magyarország Kft.</Nm></Cdtr></RltdPties>
    <RmtInf><Ustrd>Kártyás vásárlás</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
  <Ntry><Amt Ccy="HUF">685000</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
   <BookgDt><DtTm>2026-10-05T09:00:00</DtTm></BookgDt>
   <NtryDtls><TxDtls><RltdPties><Dbtr><Pty><Nm>Példa Kft.</Nm></Pty></Dbtr></RltdPties></TxDtls></NtryDtls></Ntry>
  <Ntry><Amt Ccy="HUF">100</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>PDNG</Sts><BookgDt><Dt>2026-10-06</Dt></BookgDt></Ntry>
 </Stmt></BkToCstmrStmt>
</Document>`;
    const r = await parse("statement.xml", xml);
    expect(r.format).toBe("camt");
    expect(r.ignored).toBe(1);
    expect(r.errors).toEqual([]);
    expect(r.transactions).toMatchObject([
      { merchant: "SPAR Magyarország Kft.", amount: -4785, note: "Kártyás vásárlás", categoryId: "groceries", date: "2026-10-02T10:00:00.000Z" },
      { merchant: "Példa Kft.", amount: 685000, categoryId: "income", date: "2026-10-05T07:00:00.000Z" },
    ]);
  });

  it("reads SGML OFX", async () => {
    const ofx = `OFXHEADER:100
DATA:OFXSGML

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>EUR
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261003120000[0:GMT]<TRNAMT>-12.50<FITID>A1<NAME>Lidl<MEMO>card
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261004<TRNAMT>100.00<FITID>A2<NAME>Refund
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const r = await parse("bank.ofx", ofx);
    expect(r.format).toBe("ofx");
    expect(r.transactions).toMatchObject([
      { merchant: "Lidl", amount: -12.5, currency: "EUR", note: "card" },
      { merchant: "Refund", amount: 100, currency: "EUR" },
    ]);
  });

  it("reads OFX decimal commas, and the currency of the amount rather than the original one", async () => {
    const ofx = `OFXHEADER:100
DATA:OFXSGML

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>HUF
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261003<TRNAMT>-12,50<FITID>B1<NAME>Lidl<CURRENCY><CURRATE>385<CURSYM>EUR</CURRENCY>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261004<TRNAMT>-3850.00<FITID>B2<NAME>Shop Berlin<ORIGCURRENCY><CURRATE>0.0026<CURSYM>EUR</ORIGCURRENCY>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261005<TRNAMT>1234,56<FITID>B3<NAME>Refund
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const r = await parse("bank.ofx", ofx);
    expect(r.errors).toEqual([]);
    expect(r.transactions).toMatchObject([
      { merchant: "Lidl", amount: -12.5, currency: "EUR" },
      { merchant: "Shop Berlin", amount: -3850, currency: "HUF" },
      { merchant: "Refund", amount: 1234.56, currency: "HUF" },
    ]);
  });

  it("gives each statement of a multi-account OFX its own currency, and honours a date's offset", async () => {
    const ofx = `OFXHEADER:100
DATA:OFXSGML

<OFX><BANKMSGSRSV1>
<STMTTRNRS><STMTRS><CURDEF>HUF<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261003233000[0:GMT]<TRNAMT>-4785<FITID>H1<NAME>Spar
</BANKTRANLIST></STMTRS></STMTTRNRS>
<STMTTRNRS><STMTRS><CURDEF>EUR<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261003183000.000[-5:EST]<TRNAMT>-12.50<FITID>E1<NAME>Lidl
</BANKTRANLIST></STMTRS></STMTTRNRS>
</BANKMSGSRSV1></OFX>`;
    const r = await parse("bank.ofx", ofx);
    expect(r.errors).toEqual([]);
    expect(r.transactions).toMatchObject([
      { merchant: "Spar", currency: "HUF", date: "2026-10-03T23:30:00.000Z" },
      { merchant: "Lidl", currency: "EUR", date: "2026-10-03T23:30:00.000Z" },
    ]);
  });

  it("reads a CAMT booking time with an offset as that instant", async () => {
    const xml = `<?xml version="1.0"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Acct><Ccy>HUF</Ccy></Acct>
<Ntry><Amt Ccy="HUF">100</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><DtTm>2026-10-31T23:30:00Z</DtTm></BookgDt></Ntry>
<Ntry><Amt Ccy="HUF">200</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><DtTm>2026-10-31T23:30:00</DtTm></BookgDt></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
    const r = await parse("camt.xml", xml);
    expect(r.errors).toEqual([]);
    expect(r.transactions.map((t) => t.date)).toEqual(["2026-10-31T23:30:00.000Z", "2026-10-31T22:30:00.000Z"]);
  });

  it("reads MT940 with :86: details", async () => {
    const mt = `:20:STMT
:25:11773016/1111101800000000
:28C:00001/001
:60F:C261001HUF120000,00
:61:2610021002D4785,00NTRFNONREF//B1
:86:SPAR 1234 BUDAPEST KARTYAS VASARLAS
:61:2610052610C685000,00NTRFNONREF//B2
:86:?20MUNKABER?32PELDA KFT
:62F:C261031HUF800215,00
-`;
    const r = await parse("stmt.sta", mt);
    expect(r.format).toBe("mt940");
    expect(r.errors).toEqual([]);
    expect(r.transactions).toMatchObject([
      { amount: -4785, currency: "HUF", merchant: "SPAR 1234 BUDAPEST KARTYAS VASARLAS", categoryId: "groceries" },
      { amount: 685000, merchant: "PELDA KFT", note: "MUNKABER PELDA KFT" },
    ]);
  });

  it("reads MT940 whole amounts written with a bare decimal comma", async () => {
    const mt = ":20:STMT\n:25:HU/1\n:28C:1/1\n:60F:C261001HUF100000,00\n:61:2610021002D12000,NTRFNONREF//B1\n:86:MOL\n:62F:C261002HUF88000,00\n";
    const r = await parse("k.sta", mt);
    expect(r.errors).toEqual([]);
    expect(r.transactions).toMatchObject([{ amount: -12000, currency: "HUF" }]);
  });

  it("reports an unreadable PDF row and keeps the rest, with ids that do not depend on the model's wording", async () => {
    const answer = (description: string) =>
      JSON.stringify({
        currency: "HUF",
        transactions: [
          { date: "2026-10-02", amount: -4785, counterparty: "SPAR", description },
          { date: null, amount: -100, counterparty: null, description: "olvashatatlan" },
          { date: "2026-10-03", amount: null, counterparty: "BKK", description: null },
        ],
      });
    const stub = (text: string): AIProvider => ({ name: "stub", model: "stub-1", complete: async () => text, vision: async () => text });
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(32)]);
    const first = await parseStatementFile({ filename: "k.pdf", data: pdf }, opts, stub(answer("Kártyás vásárlás")));
    expect(first.transactions).toHaveLength(1);
    expect(first.errors).toEqual(["Transaction 2: unreadable date", "Transaction 3: unreadable amount"]);
    const again = await parseStatementFile({ filename: "k.pdf", data: pdf }, opts, stub(answer("Kartyas vasarlas 1234")));
    expect(again.transactions[0]!.externalId).toBe(first.transactions[0]!.externalId);
  });

  it("reads a PDF statement through the AI provider", async () => {
    const r = await parse("kivonat.pdf", Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(32)]));
    expect(r.format).toBe("pdf");
    expect(r.transactions.map((t) => [t.merchant, t.amount, t.categoryId])).toEqual([
      ["SPAR 1234 Budapest", -4785, "groceries"],
      ["Példa Kft.", 685000, "income"],
      ["MVM Next", -12990, "utilities"],
    ]);
  });
});

describe("HTTP /statements", () => {
  const CSV = "Dátum;Partner;Összeg\n2026.10.02.;SPAR;-4 785\n2026.10.03.;BKK;-950\n";

  it("parses, imports, and skips the same rows on a second import", async () => {
    const app = await testApp();
    const parsed = await app.inject({ method: "POST", url: "/api/statements/parse", ...multipart("k.csv", "text/csv", CSV) });
    expect(parsed.statusCode).toBe(200);
    const preview = parsed.json();
    expect(preview.transactions).toHaveLength(2);

    const first = await app.inject({ method: "POST", url: "/api/statements/import", payload: { transactions: preview.transactions } });
    expect(first.json()).toEqual({ imported: 2, skipped: 0, errors: [] });
    const again = await app.inject({ method: "POST", url: "/api/statements/import", payload: { transactions: preview.transactions } });
    expect(again.json()).toEqual({ imported: 0, skipped: 2, errors: [] });
    expect(await app.deps.repo.listTransactions()).toHaveLength(2);

    const bad = await app.inject({
      method: "POST",
      url: "/api/statements/import",
      payload: { transactions: [{ ...preview.transactions[0], externalId: "stmt:new", categoryId: "deleted-cat" }, { amount: "x" }] },
    });
    expect(bad.json().imported).toBe(1);
    expect(bad.json().errors[0]).toMatch(/^Row 2: /);
    expect((await app.deps.repo.listTransactions()).find((t) => t.externalId === "stmt:new")?.categoryId).toBeNull();
    await app.close();
  });

  it("reads a header-less file whose hand-picked amount column starts with a non-amount, instead of failing with 500", async () => {
    const app = await testApp();
    const body = "2026.10.01;abc;Tesco\n2026.10.02;-500;BKK\n";
    const boundary = "----etbad";
    const payload = Buffer.from(
      [
        `--${boundary}\r\nContent-Disposition: form-data; name="mapping"\r\n\r\n${JSON.stringify({ date: "2026.10.01", amount: "abc", counterparty: "Tesco" })}\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.csv"\r\nContent-Type: text/csv\r\n\r\n${body}\r\n`,
        `--${boundary}--\r\n`,
      ].join(""),
    );
    const r = await app.inject({
      method: "POST",
      url: "/api/statements/parse",
      payload,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    expect(r.statusCode, r.body).toBe(200);
    // The first row is not a transaction (no amount), so it is the header; the second row is read.
    expect(r.json().transactions).toMatchObject([{ merchant: "BKK", amount: -500 }]);
    await app.close();
  });

  it("takes a hand-made mapping and a currency sent before the file", async () => {
    const app = await testApp();
    const body = "Mikor;Mennyi;Kinek\n2026.10.01;-100;Valaki\n";
    const boundary = "----etmap";
    const payload = Buffer.from(
      [
        `--${boundary}\r\nContent-Disposition: form-data; name="mapping"\r\n\r\n${JSON.stringify({ date: "Mikor", amount: "Mennyi", counterparty: "Kinek" })}\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="currency"\r\n\r\neur\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.csv"\r\nContent-Type: text/csv\r\n\r\n${body}\r\n`,
        `--${boundary}--\r\n`,
      ].join(""),
    );
    const r = await app.inject({
      method: "POST",
      url: "/api/statements/parse",
      payload,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().transactions).toMatchObject([{ merchant: "Valaki", amount: -100, currency: "EUR" }]);
    await app.close();
  });
});
