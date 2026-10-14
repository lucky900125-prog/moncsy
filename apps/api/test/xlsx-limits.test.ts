import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/ai/index.js";
import { MAX_XLSX_UNPACKED_BYTES } from "../src/io/xlsx.js";
import { UnpackedTooLargeError, assertUnpackedSize } from "../src/io/zip.js";
import { parseStatementFile } from "../src/statements/index.js";
import { multipart, testApp } from "./helpers.js";

/**
 * A ZIP archive of deflated entries: local headers, then the central directory, then its end record. An entry may carry
 * a central extra field; declaredCount is the entry count the end record states.
 */
function zip(entries: [string, Buffer, Buffer?][], declaredCount = entries.length): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data, extra = Buffer.alloc(0)] of entries) {
    const body = deflateRawSync(data);
    const fname = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fname.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(crc32(data), 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(fname.length, 28);
    dir.writeUInt16LE(extra.length, 30);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, fname, body);
    central.push(dir, fname, extra);
    offset += local.length + fname.length + body.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(declaredCount, 8);
  end.writeUInt16LE(declaredCount, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBytes, end]);
}

/** The entries of a ZIP archive written by zip() or by ExcelJS (deflated or stored, no ZIP64). */
function unzip(data: Buffer): [string, Buffer][] {
  let eocd = data.length - 22;
  while (data.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = data.readUInt32LE(eocd + 16);
  const entries: [string, Buffer][] = [];
  for (let n = data.readUInt16LE(eocd + 10); n > 0; n--) {
    const nameLength = data.readUInt16LE(p + 28);
    const name = data.subarray(p + 46, p + 46 + nameLength).toString();
    const local = data.readUInt32LE(p + 42);
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const body = data.subarray(start, start + data.readUInt32LE(p + 20));
    entries.push([name, data.readUInt16LE(p + 10) === 8 ? inflateRawSync(body) : Buffer.from(body)]);
    p += 46 + nameLength + data.readUInt16LE(p + 30) + data.readUInt16LE(p + 32);
  }
  return entries;
}

/** A small, valid statement workbook with one part's XML rewritten. */
async function rewritten(part: string, edit: (xml: string) => string): Promise<Buffer> {
  const entries = unzip(await statementWorkbook(() => {}));
  expect(entries.some(([name]) => name === part), part).toBe(true);
  return zip(entries.map(([name, data]) => [name, name === part ? Buffer.from(edit(data.toString())) : data]));
}

const SHEET = "xl/worksheets/sheet1.xml";
const merge = (ref: string) => (x: string) => x.replace("</sheetData>", `</sheetData><mergeCells count="1"><mergeCell ref="${ref}"/></mergeCells>`);
const validation = (sqref: string) => (x: string) =>
  x.replace(/<\/sheetData>(<mergeCells.*<\/mergeCells>)?/, `$&<dataValidations count="1"><dataValidation type="whole" sqref="${sqref}"><formula1>1</formula1></dataValidation></dataValidations>`);
const name = (ref: string) => (x: string) => x.replace("</sheets>", `</sheets><definedNames><definedName name="n">Kivonat!${ref}</definedName></definedNames>`);

/** Each a few kilobytes, each describing the whole sheet: ExcelJS builds an object per cell for every one of them. */
const amplifiers: [string, () => Promise<Buffer>, RegExp][] = [
  ["a merge over the whole sheet", () => rewritten(SHEET, merge("A52:XFD1048576")), /^The XLSX file merges \d+ cells/],
  ["a column range of 50 million", () => rewritten(SHEET, (x) => x.replace("<sheetData>", '<cols><col min="1" max="50000000" width="10"/></cols><sheetData>')), /describes column 50000000/],
  ["a validation over the whole sheet", () => rewritten(SHEET, validation("A1:XFD1048576")), /has data validation on \d+ cells/],
  // More than the reading thread holds beside the data, so refused with a message rather than after running out.
  ["a validation over a whole column", () => rewritten(SHEET, validation("D1:D1048576")), /has data validation on 1048576 cells/],
  ["a defined name over the whole sheet", () => rewritten("xl/workbook.xml", name("$A$1:$XFD$1048576")), /defined names cover \d+ cells/],
];

/**
 * The whole-sheet merge and name, and a far column range, written in forms ExcelJS and JSZip read the same as the plain
 * ones (each checked against ExcelJS 4.4.0 with a small range): the pre-filter has to read them as they do.
 */
const WHOLE = "A52:XFD1048576";
const mergeTag = (attributes: string) => (x: string) => x.replace("</sheetData>", `</sheetData><mergeCells count="1"><mergeCell ${attributes}/></mergeCells>`);
/** The workbook with its sheet's merge as given, the sheet then stored under another name in the ZIP. */
const sheetEntry = async (edit: (x: string) => string, entry: (data: Buffer) => [string, Buffer, Buffer?]) =>
  zip(unzip(await rewritten(SHEET, edit)).map(([n, d]) => (n === SHEET ? entry(d) : [n, d])));
/** An Info-ZIP Unicode Path extra field (0x7075): JSZip takes the entry's name from it when its CRC matches the raw name. */
const unicodePath = (raw: string, name: string) => {
  const u = Buffer.from(name);
  const field = Buffer.alloc(9 + u.length);
  field.writeUInt16LE(0x7075, 0);
  field.writeUInt16LE(5 + u.length, 2);
  field.writeUInt8(1, 4);
  field.writeUInt32LE(crc32(Buffer.from(raw)), 5);
  u.copy(field, 9);
  return field;
};
const MERGES = /^The XLSX file merges \d+ cells/;
const NAMES = /^The XLSX file's defined names cover \d+ cells/;
const disguised: [string, () => Promise<Buffer>, RegExp][] = [
  ["single quotes", () => rewritten(SHEET, mergeTag(`ref='${WHOLE}'`)), MERGES],
  ["spaces around =", () => rewritten(SHEET, mergeTag(`ref = "${WHOLE}"`)), MERGES],
  ["a character reference", () => rewritten(SHEET, mergeTag('ref="A52:&#88;F&#x44;1048576"')), MERGES],
  ["a > in an attribute before it", () => rewritten(SHEET, mergeTag(`x='>' ref="${WHOLE}"`)), MERGES],
  ["ref= in the value of an attribute before it", () => rewritten(SHEET, mergeTag(`x='ref="A1"' ref="${WHOLE}"`)), MERGES],
  ["a part name with a leading /", () => sheetEntry(merge(WHOLE), (d) => [`/${SHEET}`, d]), MERGES],
  ["a part name from a Unicode path field", () => sheetEntry(merge(WHOLE), (d) => ["zz.bin", d, unicodePath("zz.bin", SHEET)]), MERGES],
  [
    "a sheet after the entries the end record counts",
    async () => {
      const entries = unzip(await rewritten(SHEET, merge(WHOLE)));
      const sheet = entries.splice(entries.findIndex(([n]) => n === SHEET), 1);
      return zip([...entries, ...sheet], entries.length);
    },
    MERGES,
  ],
  ["a column range that starts far out", () => rewritten(SHEET, (x) => x.replace("<sheetData>", '<cols><col min="50000000" max="1"/></cols><sheetData>')), /describes column 50000000/],
  ["a defined name split by a comment", () => rewritten("xl/workbook.xml", name("$A$1<!-- - -->:$XFD$1048576")), NAMES],
  ["a defined name with character references", () => rewritten("xl/workbook.xml", name("$A$1:&#36;XFD&#36;1048576")), NAMES],
];

/** A few kilobytes that unpack to more than the limit, as a worksheet. */
const bomb = () => zip([["xl/worksheets/sheet1.xml", Buffer.alloc(MAX_XLSX_UNPACKED_BYTES + 1024 * 1024, " ")]]);

async function statementWorkbook(extra: (ws: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Kivonat");
  ws.addRow(["Dátum", "Összeg", "Partner"]);
  for (let i = 1; i <= 50; i++) ws.addRow([`2026.10.${String((i % 28) + 1).padStart(2, "0")}`, -100 * i, `Bolt ${i}`]);
  extra(ws);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const parse = (data: Buffer) =>
  parseStatementFile({ filename: "kivonat.xlsx", data }, { defaultCurrency: "HUF", timeZone: "Europe/Budapest" }, new MockProvider());

describe("uploaded XLSX limits", () => {
  it("measures what a ZIP really unpacks to", async () => {
    expect(bomb().length).toBeLessThan(64 * 1024);
    expect(() => assertUnpackedSize(bomb(), MAX_XLSX_UNPACKED_BYTES)).toThrow(UnpackedTooLargeError);
    // A header that understates the size does not help: what inflating produces is counted.
    const lying = bomb();
    lying.writeUInt32LE(10, lying.length - 22 - 46 - "xl/worksheets/sheet1.xml".length + 24);
    expect(() => assertUnpackedSize(lying, MAX_XLSX_UNPACKED_BYTES)).toThrow(UnpackedTooLargeError);
    const normal = await statementWorkbook(() => {});
    expect(() => assertUnpackedSize(normal, MAX_XLSX_UNPACKED_BYTES)).not.toThrow();
    expect(() => assertUnpackedSize(Buffer.from("PK not really"), MAX_XLSX_UNPACKED_BYTES)).toThrow(/no ZIP directory/);
  });

  it("answers 413 for a workbook that unpacks to too much, on every route that reads XLSX", async () => {
    const app = await testApp();
    for (const url of ["/api/statements/parse", "/api/import", "/api/revolut/import-statement"]) {
      const res = await app.inject({ method: "POST", url, ...multipart("kivonat.xlsx", "application/octet-stream", bomb()) });
      expect(res.statusCode, url).toBe(413);
      expect(res.json().error).toMatch(/unpacks to more than 20 MB/);
    }
    await app.close();
  });

  it("reads only cells with a value, so a formatted cell at the sheet's far corner costs nothing", async () => {
    const data = await statementWorkbook((ws) => {
      ws.getCell("XFD1048576").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF0000" } };
    });
    expect(data.length).toBeLessThan(10 * 1024);
    const r = await parse(data);
    expect(r.transactions).toHaveLength(50);
  });

  it("refuses a small workbook that describes the whole sheet before reading it, on every route", async () => {
    const app = await testApp();
    const started = performance.now();
    for (const [what, build, message] of amplifiers) {
      const data = await build();
      expect(data.length, what).toBeLessThan(16 * 1024);
      for (const url of ["/api/statements/parse", "/api/import", "/api/revolut/import-statement"]) {
        const res = await app.inject({ method: "POST", url, ...multipart("kivonat.xlsx", "application/octet-stream", data) });
        expect([413, 400], `${what}, ${url}: ${res.body}`).toContain(res.statusCode);
        expect(res.json().error, `${what}, ${url}`).toMatch(message);
      }
    }
    // Counted, not loaded: reading any of them takes ExcelJS seconds of CPU before it runs out of memory.
    expect(performance.now() - started).toBeLessThan(10_000);
    expect((await app.inject("/api/health")).statusCode).toBe(200);
    // What legitimate files do is read as usual: a merged header, validation on a table's column, columns formatted
    // to the sheet's end.
    const usual = await rewritten(SHEET, (x) =>
      validation("D2:D10000")(merge("D1:E1")(x)).replace("<sheetData>", '<cols><col min="4" max="16384" width="10" hidden="1"/></cols><sheetData>'),
    );
    expect((await parse(usual)).transactions).toHaveLength(50);
    await app.close();
  });

  it.each(disguised)("refuses a whole-sheet range before reading it when it is written with %s", async (_what, build, message) => {
    await expect(parse(await build())).rejects.toThrow(message);
  });

  it("measures an entry after the ones the end record counts, as JSZip loads it", async () => {
    const normal = unzip(await statementWorkbook(() => {}));
    const behind = zip([...normal, ["xl/worksheets/sheet2.xml", Buffer.alloc(MAX_XLSX_UNPACKED_BYTES + 1024 * 1024, " ")]], normal.length);
    expect(() => assertUnpackedSize(behind, MAX_XLSX_UNPACKED_BYTES)).toThrow(UnpackedTooLargeError);
    // An end record that counts more entries than the directory has is still a damaged archive.
    expect(() => assertUnpackedSize(zip(normal, normal.length + 1), MAX_XLSX_UNPACKED_BYTES)).toThrow(/damaged ZIP directory/);
  });

  it("reads a workbook in a thread whose memory runs out instead of the server's", async () => {
    // Every range within its own limit, together more than the reading thread may use.
    const data = await (async () => {
      const entries = unzip(await rewritten(SHEET, (x) => validation("A1:A200000")(merge("D60:H20059")(x))));
      return zip(entries.map(([n, d]) => [n, n === "xl/workbook.xml" ? Buffer.from(name("$B$1:$B$200000")(d.toString())) : d]));
    })();
    const app = await testApp();
    const res = await app.inject({ method: "POST", url: "/api/statements/parse", ...multipart("kivonat.xlsx", "application/octet-stream", data) });
    expect(res.statusCode, res.body).toBe(413);
    expect(res.json().error).toMatch(/needs more than \d+ MB to read/);
    expect((await app.inject("/api/health")).statusCode).toBe(200);
    expect((await parse(await statementWorkbook(() => {}))).transactions).toHaveLength(50);
    await app.close();
  });

  it("refuses a value beyond the row or column limit instead of building arrays that long", async () => {
    await expect(parse(await statementWorkbook((ws) => (ws.getCell("A100001").value = "x")))).rejects.toThrow(/more than 100000 rows/);
    await expect(parse(await statementWorkbook((ws) => (ws.getCell("GT2").value = "x")))).rejects.toThrow(/more than 200 columns/);
  });
});
