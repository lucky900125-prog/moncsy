import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockProvider } from "../src/ai/index.js";
import { categorize } from "../src/revolut/categorize.js";
import { parseStatementFile } from "../src/statements/index.js";

// Every reader categorises each transaction it builds, so the calls count the rows it read one by one.
vi.mock("../src/revolut/categorize.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/revolut/categorize.js")>();
  return { ...real, categorize: vi.fn(real.categorize) };
});

const opts = { defaultCurrency: "HUF", timeZone: "Europe/Budapest" };
const day = (i: number) => String((i % 28) + 1).padStart(2, "0");
const lines = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i)).join("");

const formats: [string, string, (n: number) => string][] = [
  ["CSV", "kivonat.csv", (n) => "Dátum;Összeg;Partner;Közlemény\n" + lines(n, (i) => `2026.10.${day(i)};-${i + 1};Bolt ${i};Vásárlás ${i}\n`)],
  [
    "Revolut CSV",
    "revolut.csv",
    (n) =>
      "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n" +
      lines(n, (i) => `CARD_PAYMENT,Current,2026-10-${day(i)} 10:00:00,2026-10-${day(i)} 10:00:01,Bolt ${i},-${i + 1}.00,0.00,HUF,COMPLETED,1000.00\n`),
  ],
  [
    "OFX",
    "kivonat.ofx",
    (n) =>
      "OFXHEADER:100\n<OFX><CURDEF>HUF<BANKTRANLIST>\n" +
      lines(n, (i) => `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>202610${day(i)}<TRNAMT>-${i + 1}.50<FITID>F${i}<NAME>Bolt ${i}</STMTTRN>\n`) +
      "</BANKTRANLIST></OFX>",
  ],
  [
    "MT940",
    "kivonat.sta",
    (n) =>
      ":20:STMT\n:25:HU/1\n:28C:1/1\n:60F:C261001HUF100000,00\n" +
      lines(n, (i) => `:61:2610${day(i)}10${day(i)}D${i + 1},00NTRFNONREF//B${i}\n:86:Bolt ${i}\n`) +
      ":62F:C261031HUF0,00\n",
  ],
  [
    "CAMT",
    "kivonat.xml",
    (n) =>
      '<?xml version="1.0"?><Document><BkToCstmrStmt><Stmt><Acct><Ccy>HUF</Ccy></Acct>\n' +
      lines(n, (i) => `<Ntry><Amt Ccy="HUF">${i + 1}.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-10-${day(i)}</Dt></BookgDt></Ntry>\n`) +
      "</Stmt></BkToCstmrStmt></Document>",
  ],
];

const read = (filename: string, text: string) => parseStatementFile({ filename, data: Buffer.from(text) }, opts, new MockProvider());

beforeEach(() => {
  vi.mocked(categorize).mockClear();
});

describe("the statement row limit is checked before the rows are read", () => {
  it.each(formats)("refuses a %s statement of 20 001 rows without reading one of them", async (_format, filename, make) => {
    await expect(read(filename, make(20_001))).rejects.toMatchObject({
      statusCode: 413,
      message: expect.stringMatching(/^The statement has 20001 rows; more than 20000 are not read at once/),
    });
    expect(vi.mocked(categorize)).not.toHaveBeenCalled();
  });

  it.each(formats)("still reads a %s statement of 20 000 rows", async (_format, filename, make) => {
    const r = await read(filename, make(20_000));
    expect(r.transactions).toHaveLength(20_000);
    expect(r.errors).toEqual([]);
  });
});
