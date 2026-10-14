import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/ai/index.js";
import { MAX_XLSX_UNPACKED_BYTES } from "../src/io/xlsx.js";
import { UnpackedTooLargeError, assertUnpackedSize } from "../src/io/zip.js";
import { parseStatementFile } from "../src/statements/index.js";
import { multipart, testApp } from "./helpers.js";

/** A ZIP archive of deflated entries: local headers, then the central directory, then its end record. */
function zip(entries: [string, Buffer][]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
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
    dir.writeUInt32LE(offset, 42);
    locals.push(local, fname, body);
    central.push(dir, fname);
    offset += local.length + fname.length + body.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
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
  ["a defined name over the whole sheet", () => rewritten("xl/workbook.xml", name("$A$1:$XFD$1048576")), /defined names cover \d+ cells/],
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
    // What legitimate files do is read as usual: a merged header, validation on a whole column, a print title,
    // columns formatted to the sheet's end.
    const usual = await rewritten(SHEET, (x) =>
      validation("D1:D1048576")(merge("D1:E1")(x)).replace("<sheetData>", '<cols><col min="4" max="16384" width="10" hidden="1"/></cols><sheetData>'),
    );
    expect((await parse(usual)).transactions).toHaveLength(50);
    await app.close();
  });

  it("reads a workbook in a thread whose memory runs out instead of the server's", async () => {
    // Every range within its own limit, together more than the reading thread may use.
    const data = await (async () => {
      const entries = unzip(await rewritten(SHEET, (x) => validation("A1:A1048576")(merge("D60:H20059")(x))));
      return zip(entries.map(([n, d]) => [n, n === "xl/workbook.xml" ? Buffer.from(name("$B$1:$B$1048576")(d.toString())) : d]));
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
