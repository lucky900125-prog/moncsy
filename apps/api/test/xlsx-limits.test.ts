import { crc32, deflateRawSync } from "node:zlib";
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

  it("refuses a value beyond the row or column limit instead of building arrays that long", async () => {
    await expect(parse(await statementWorkbook((ws) => (ws.getCell("A100001").value = "x")))).rejects.toThrow(/more than 100000 rows/);
    await expect(parse(await statementWorkbook((ws) => (ws.getCell("GT2").value = "x")))).rejects.toThrow(/more than 200 columns/);
  });
});
