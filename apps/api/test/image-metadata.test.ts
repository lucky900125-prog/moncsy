import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { AIProvider } from "../src/ai/index.js";
import { stripHeifMetadata } from "../src/io/heif.js";
import { stripPngMetadata } from "../src/io/png.js";
import { stripWebpMetadata } from "../src/io/webp.js";
import { multipart, testApp } from "./helpers.js";

/** Big-endian TIFF: IFD0 with Orientation 6 and the camera Make, as a phone writes it. */
const PHONE_TIFF = Buffer.from("4d4d002a000000080002011200030000000100060000010f000200000011000000260000000053656372657450686f6e654d616b657200", "hex");
/** The TIFF the orientation is kept in: a one-entry IFD0. */
const ORIENTATION_6 = Buffer.from("4d4d002a00000008000101120003000000010006000000000000", "hex");
const XMP = '<x:xmpmeta><rdf:Description exif:GPSLatitude="47,29.55N" photoshop:City="Budapest"/></x:xmpmeta>';
const LEAKS = ["SecretPhoneMaker", "Budapest", "Kovacs", "xmpmeta", "GPS"];

const leaksIn = (b: Buffer) => LEAKS.filter((l) => b.includes(l));

function pngChunk(type: string, data: Buffer | string): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1")]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length - 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR = pngChunk("IHDR", Buffer.from("00000010000000100806000000", "hex"));
const ICCP = pngChunk("iCCP", "sRGB\0\0profile");
const IDAT = pngChunk("IDAT", "compressed pixels");
const IEND = pngChunk("IEND", "");

function webpChunk(type: string, data: Buffer | string): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, "latin1");
  const head = Buffer.alloc(8);
  head.write(type, 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, Buffer.alloc(body.length & 1)]);
}

function riff(chunks: Buffer[], trailer = Buffer.alloc(0)): Buffer {
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...chunks]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, trailer]);
}

/** VP8X with the given flags and a 16x16 canvas. */
const vp8x = (flags: number) => webpChunk("VP8X", Buffer.from([flags, 0, 0, 0, 15, 0, 0, 15, 0, 0]));
const ICC = 0x20;
const EXIF = 0x08;
const XMP_FLAG = 0x04;
const VP8 = webpChunk("VP8 ", "lossy pixels");

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

const u8 = (...v: number[]) => Buffer.from(v);
const u16 = (v: number) => Buffer.from([v >> 8, v & 0xff]);
const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v);
  return b;
};
const str = (s: string) => Buffer.from(s, "latin1");
/** A full box: version, 24-bit flags, then the body. */
const fullBox = (type: string, version: number, ...parts: Buffer[]) => box(type, u8(version, 0, 0, 0), ...parts);

const HEVC = str("hevc coded image data");
/** An Exif item as HEIF stores it: the offset of the TIFF header, then "Exif\0\0" and the TIFF. */
const EXIF_ITEM = Buffer.concat([u32(6), str("Exif\0\0"), PHONE_TIFF]);

/**
 * A HEIC as a phone lays it out: ftyp, meta (hdlr, iinf with the image, Exif and XMP items, iloc, idat) and mdat.
 * The image and the Exif item live in mdat (construction method 0), the XMP item in idat (method 1).
 */
function heic(): { file: Buffer; image: [number, number]; exif: [number, number]; xmp: [number, number] } {
  const build = (mdatAt: number) => {
    const iinf = fullBox(
      "iinf",
      0,
      u16(3),
      fullBox("infe", 2, u16(1), u16(0), str("hvc1"), str("\0")),
      fullBox("infe", 2, u16(2), u16(0), str("Exif"), str("\0")),
      fullBox("infe", 2, u16(3), u16(0), str("mime"), str("\0application/rdf+xml\0")),
    );
    // Version 1: offset and length are 4 bytes, no base offset, no extent index.
    const item = (id: number, method: number, offset: number, length: number) =>
      Buffer.concat([u16(id), u16(method), u16(0), u16(1), u32(offset), u32(length)]);
    const iloc = fullBox(
      "iloc",
      1,
      u8(0x44, 0x00),
      u16(3),
      item(1, 0, mdatAt + 8, HEVC.length),
      item(2, 0, mdatAt + 8 + HEVC.length, EXIF_ITEM.length),
      item(3, 1, 0, XMP.length),
    );
    const hdlr = fullBox("hdlr", 0, u32(0), str("pict"), Buffer.alloc(12), str("\0"));
    return Buffer.concat([
      box("ftyp", str("heic"), u32(0), str("mif1heic")),
      fullBox("meta", 0, hdlr, fullBox("pitm", 0, u16(1)), iinf, iloc, box("idat", str(XMP))),
    ]);
  };
  const head = build(build(0).length);
  const file = Buffer.concat([head, box("mdat", HEVC, EXIF_ITEM)]);
  const mdat = head.length + 8;
  const idat = file.indexOf(str(XMP));
  return { file, image: [mdat, HEVC.length], exif: [mdat + HEVC.length, EXIF_ITEM.length], xmp: [idat, XMP.length] };
}

describe("stripping a PNG's metadata (review round 5, A6)", () => {
  it("drops eXIf, text and time chunks and anything after IEND, keeps the orientation and every image chunk", () => {
    const photo = Buffer.concat([
      PNG_SIGNATURE,
      IHDR,
      pngChunk("tEXt", "Author\0Kovacs Anna"),
      pngChunk("eXIf", PHONE_TIFF),
      pngChunk("zTXt", "Comment\0\0xmpmeta"),
      pngChunk("iTXt", `XML:com.adobe.xmp\0\0\0\0\0${XMP}`),
      pngChunk("tIME", Buffer.from("07ea0a0f0c0000", "hex")),
      pngChunk("prVt", "private chunk with GPS"),
      ICCP,
      IDAT,
      IEND,
      str("trailing Budapest"),
    ]);
    const out = stripPngMetadata(photo);
    expect(out).toEqual(Buffer.concat([PNG_SIGNATURE, IHDR, pngChunk("eXIf", ORIENTATION_6), ICCP, IDAT, IEND]));
    expect(leaksIn(out)).toEqual([]);
  });

  it("leaves a PNG without metadata as it was, and refuses one whose chunks cannot be followed", () => {
    const clean = Buffer.concat([PNG_SIGNATURE, IHDR, IDAT, IEND]);
    expect(stripPngMetadata(clean)).toEqual(clean);
    expect(() => stripPngMetadata(clean.subarray(0, clean.length - 6))).toThrow(/runs past the end/);
    expect(() => stripPngMetadata(Buffer.concat([PNG_SIGNATURE, IDAT, IEND]))).toThrow(/IHDR/);
    expect(() => stripPngMetadata(str("not a png at all"))).toThrow(/no PNG signature/);
  });
});

describe("stripping a WebP's metadata (review round 5, A6)", () => {
  it("drops EXIF, XMP, unknown chunks and anything after the RIFF end, keeps the orientation and fixes the header", () => {
    const photo = riff(
      [vp8x(ICC | EXIF | XMP_FLAG), webpChunk("ICCP", "icc"), VP8, webpChunk("EXIF", PHONE_TIFF), webpChunk("XMP ", XMP), webpChunk("PRIV", "GPS")],
      str("trailing Budapest"),
    );
    const out = stripWebpMetadata(photo);
    expect(out).toEqual(riff([vp8x(ICC | EXIF), webpChunk("ICCP", "icc"), VP8, webpChunk("EXIF", ORIENTATION_6)]));
    expect(leaksIn(out)).toEqual([]);
  });

  it("reads an EXIF chunk written with the JPEG prefix, and clears the flag when no orientation is left", () => {
    const prefixed = riff([vp8x(EXIF), VP8, webpChunk("EXIF", Buffer.concat([str("Exif\0\0"), PHONE_TIFF]))]);
    expect(stripWebpMetadata(prefixed)).toEqual(riff([vp8x(EXIF), VP8, webpChunk("EXIF", ORIENTATION_6)]));
    const noOrientation = riff([vp8x(EXIF | XMP_FLAG), VP8, webpChunk("EXIF", str("MM\0*\0\0\0\x08\0\0SecretPhoneMaker")), webpChunk("XMP ", XMP)]);
    expect(stripWebpMetadata(noOrientation)).toEqual(riff([vp8x(0), VP8]));
  });

  it("leaves a simple WebP as it was, and refuses one whose chunks cannot be followed", () => {
    const simple = riff([VP8]);
    expect(stripWebpMetadata(simple)).toEqual(simple);
    expect(() => stripWebpMetadata(simple.subarray(0, simple.length - 4))).toThrow(/shorter than its RIFF header/);
    expect(() => stripWebpMetadata(riff([vp8x(0)]))).toThrow(/no image data/);
    expect(() => stripWebpMetadata(str("RIFF\0\0\0\0WAVE"))).toThrow(/no RIFF WEBP header/);
  });
});

describe("stripping a HEIC's metadata (review round 5, A6)", () => {
  it("zeroes the Exif and XMP items in mdat and idat and leaves every other byte as it was", () => {
    const { file, image, exif, xmp } = heic();
    expect(leaksIn(file)).toEqual(["SecretPhoneMaker", "Budapest", "xmpmeta", "GPS"]);
    const out = stripHeifMetadata(file);
    expect(out).toHaveLength(file.length);
    expect(leaksIn(out)).toEqual([]);
    expect(out.subarray(exif[0], exif[0] + exif[1]).every((b) => b === 0)).toBe(true);
    expect(out.subarray(xmp[0], xmp[0] + xmp[1]).every((b) => b === 0)).toBe(true);
    expect(out.subarray(image[0], image[0] + image[1])).toEqual(HEVC);
    const expected = Buffer.from(file);
    expected.fill(0, exif[0], exif[0] + exif[1]);
    expected.fill(0, xmp[0], xmp[0] + xmp[1]);
    expect(out).toEqual(expected);
    // The input is not changed in place.
    expect(leaksIn(file)).toHaveLength(4);
  });

  it("refuses a HEIC whose boxes cannot be followed or that has no item list", () => {
    const { file } = heic();
    expect(() => stripHeifMetadata(file.subarray(0, 60))).toThrow(/runs past/);
    expect(() => stripHeifMetadata(box("ftyp", str("heic"), u32(0)))).toThrow(/no meta box/);
  });
});

describe("POST /api/receipts/scan strips PNG, WebP and HEIC metadata (review round 5, A6)", () => {
  it("sends the AI each format without its metadata, and refuses one that cannot be read", async () => {
    const answer = JSON.stringify({ merchant: "Spar", date: "2026-10-01", total: 459, currency: "HUF", items: [], suggestedCategoryId: null, confidence: 0.9 });
    const seen: { mime: string; data: Buffer }[] = [];
    const ai: AIProvider = {
      name: "canned",
      model: "canned-1",
      complete: async () => answer,
      vision: async (b64, mime) => (seen.push({ mime, data: Buffer.from(b64, "base64") }), answer),
    };
    const app = await testApp({ ai });
    const photos: [string, string, Buffer][] = [
      ["blokk.png", "image/png", Buffer.concat([PNG_SIGNATURE, IHDR, pngChunk("eXIf", PHONE_TIFF), pngChunk("tEXt", "Author\0Kovacs Anna"), IDAT, IEND])],
      ["blokk.webp", "image/webp", riff([vp8x(EXIF | XMP_FLAG), VP8, webpChunk("EXIF", PHONE_TIFF), webpChunk("XMP ", XMP)])],
      ["blokk.heic", "image/heic", heic().file],
    ];
    for (const [name, mime, data] of photos) {
      const r = await app.inject({ method: "POST", url: "/api/receipts/scan", ...multipart(name, mime, data) });
      expect(r.statusCode, `${name}: ${r.body}`).toBe(200);
      expect(seen.at(-1)!.mime).toBe(mime);
      expect(leaksIn(seen.at(-1)!.data), name).toEqual([]);
    }
    for (const [name, mime, data, format] of [
      ["blokk.png", "image/png", Buffer.concat([PNG_SIGNATURE, IHDR]).subarray(0, 20), "PNG"],
      ["blokk.webp", "image/webp", riff([VP8]).subarray(0, 20), "WebP"],
      ["blokk.heic", "image/heic", heic().file.subarray(0, 60), "HEIC"],
    ] as const) {
      const r = await app.inject({ method: "POST", url: "/api/receipts/scan", ...multipart(name, mime, data) });
      expect(r.statusCode, name).toBe(400);
      expect(r.json().error).toMatch(new RegExp(`^The image is not a readable ${format}: `));
    }
    expect(seen).toHaveLength(3);
    await app.close();
  });
});
