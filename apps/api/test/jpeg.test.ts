import { describe, expect, it } from "vitest";
import { stripJpegMetadata } from "../src/io/jpeg.js";
import { FAKE_JPEG } from "./helpers.js";

const segment = (marker: number, payload: Buffer | string) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "latin1");
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xff00 | marker, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
};

/**
 * An APP1 EXIF block as a phone writes it, in either byte order: IFD0 with Make, Orientation and a GPS IFD pointer,
 * and a GPS IFD with the latitude reference.
 */
function phoneExif(order: "II" | "MM", orientation: number): Buffer {
  const t = Buffer.alloc(80);
  const u16 = (v: number, at: number) => (order === "II" ? t.writeUInt16LE(v, at) : t.writeUInt16BE(v, at));
  const u32 = (v: number, at: number) => (order === "II" ? t.writeUInt32LE(v, at) : t.writeUInt32BE(v, at));
  t.write(order, 0, "latin1");
  u16(0x2a, 2);
  u32(8, 4);
  u16(3, 8);
  // Make: ASCII, 17 bytes, at offset 50.
  u16(0x010f, 10), u16(2, 12), u32(17, 14), u32(50, 18);
  // Orientation: SHORT, 1 value.
  u16(0x0112, 22), u16(3, 24), u32(1, 26), u16(orientation, 30);
  // GPS IFD pointer: LONG, at offset 68.
  u16(0x8825, 34), u16(4, 36), u32(1, 38), u32(68, 42);
  u32(0, 46);
  t.write("SecretPhoneMaker\0", 50, "latin1");
  // GPS IFD: GPSLatitudeRef "N".
  u16(1, 68), u16(1, 70), u16(2, 72), u32(2, 74), t.write("N\0", 78, "latin1");
  return segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), t]));
}

/** FAKE_JPEG with segments inserted after its APP0 (JFIF, 18 bytes after SOI) and bytes appended after its end. */
const withSegments = (segments: Buffer[], trailer = Buffer.alloc(0)) =>
  Buffer.concat([FAKE_JPEG.subarray(0, 20), ...segments, FAKE_JPEG.subarray(20), trailer]);

/** The minimal EXIF block the orientation is kept in. */
const orientationOnly = (orientation: number) =>
  Buffer.from(`ffe100224578696600004d4d002a0000000800010112000300000001000${orientation}000000000000`, "hex");

const metadata = [
  segment(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:Description exif:GPSLatitude="47,29.55N" photoshop:City="Budapest"/></x:xmpmeta>'),
  segment(0xed, "Photoshop 3.0\x008BIM\x04\x04\0\0\0\0\0\x10\x1c\x02\x5a\0\x08Budapest"),
  segment(0xfe, "owner: Kovacs Anna"),
  segment(0xe2, "MPF\0II*\0"),
  segment(0xec, "Ducky\0\x01\0\x04\0\0\0\x50"),
];

describe("stripping a JPEG's metadata", () => {
  it.each(["II", "MM"] as const)("drops EXIF (%s), XMP, IPTC, comments and a trailing image, and keeps the orientation and every image byte", (order) => {
    const trailer = withSegments([phoneExif(order, 3)]);
    const photo = withSegments([phoneExif(order, 6), ...metadata], trailer);
    const out = stripJpegMetadata(photo);
    expect(out).toEqual(withSegments([orientationOnly(6)]));
    for (const leak of ["SecretPhoneMaker", "Budapest", "Kovacs", "xmpmeta", "MPF"]) expect(out.includes(leak), leak).toBe(false);
  });

  it("keeps what decoders read: the JFIF header, an ICC profile and Adobe's colour transform", () => {
    const kept = [segment(0xe2, "ICC_PROFILE\0\x01\x01profile-bytes"), segment(0xee, "Adobe\0\x64\0\0\0\0\x01")];
    expect(stripJpegMetadata(withSegments(kept))).toEqual(withSegments(kept));
  });

  it("leaves a JPEG without metadata as it is, fill bytes before a marker included", () => {
    expect(stripJpegMetadata(FAKE_JPEG)).toEqual(FAKE_JPEG);
    const filled = Buffer.concat([FAKE_JPEG.subarray(0, 20), Buffer.from([0xff, 0xff]), FAKE_JPEG.subarray(20)]);
    expect(stripJpegMetadata(filled)).toEqual(FAKE_JPEG);
  });

  it("drops an EXIF block whose orientation cannot be read, rather than keeping any of it", () => {
    const broken = segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0XX", "latin1"), Buffer.from("SecretPhoneMaker")]));
    expect(stripJpegMetadata(withSegments([broken]))).toEqual(FAKE_JPEG);
  });

  it.each([
    ["no start marker", Buffer.from("not a jpeg at all"), /no JPEG start marker/],
    ["a segment longer than the file", FAKE_JPEG.subarray(0, 30), /runs past the end/],
    ["a file cut inside the image data", FAKE_JPEG.subarray(0, FAKE_JPEG.length - 4), /ends inside the image data/],
    ["an end marker before any image data", Buffer.from([0xff, 0xd8, 0xff, 0xd9]), /no image data before the end marker/],
    ["bytes where a marker belongs", Buffer.concat([FAKE_JPEG.subarray(0, 20), Buffer.from("xx"), FAKE_JPEG.subarray(20)]), /no marker at byte 20/],
  ])("refuses %s", (_what, data, message) => {
    expect(() => stripJpegMetadata(data)).toThrow(message);
  });
});
