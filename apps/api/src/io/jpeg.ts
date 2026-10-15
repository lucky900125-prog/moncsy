/**
 * A JPEG without the metadata a camera or phone writes into it: EXIF (where and when the photo was taken, the device,
 * a thumbnail), XMP, IPTC and comments can all name a place or a person, and none of it helps reading a receipt.
 * Only what decoding uses stays: the JFIF header (APP0), an ICC colour profile (APP2), Adobe's colour transform
 * (APP14) and every non-APP marker. The EXIF orientation is kept in a minimal EXIF block of its own, so the image is
 * shown the same way as before. Anything after the image's end marker (a second picture, a gain map) is left out too.
 * Pixel data is copied byte for byte. Throws for a file whose markers cannot be followed.
 */
export function stripJpegMetadata(data: Buffer): Buffer {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new Error("no JPEG start marker");
  const out: Buffer[] = [data.subarray(0, 2)];
  let orientation: number | null = null;
  // Where the first EXIF block was, so the orientation goes back to the same place among the segments.
  let exifAt = -1;
  let scanned = false;
  let p = 2;
  for (;;) {
    if (p >= data.length || data[p] !== 0xff) throw new Error(`no marker at byte ${p}`);
    // A marker may be preceded by any number of 0xFF fill bytes.
    while (data[p] === 0xff) p++;
    if (p >= data.length) throw new Error("ends inside a marker");
    const marker = data[p]!;
    p++;
    if (marker === 0xd9) {
      if (!scanned) throw new Error("no image data before the end marker");
      out.push(Buffer.from([0xff, 0xd9]));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(Buffer.from([0xff, marker]));
      continue;
    }
    if (p + 2 > data.length) throw new Error(`segment 0x${marker.toString(16)} at byte ${p - 2} has no length`);
    const length = data.readUInt16BE(p);
    if (length < 2 || p + length > data.length) throw new Error(`segment 0x${marker.toString(16)} at byte ${p - 2} runs past the end`);
    const segment = Buffer.concat([Buffer.from([0xff, marker]), data.subarray(p, p + length)]);
    const payload = data.subarray(p + 2, p + length);
    p += length;
    if (marker === 0xe1 && payload.subarray(0, 6).toString("latin1") === "Exif\0\0") {
      orientation ??= exifOrientation(payload.subarray(6));
      if (exifAt < 0) exifAt = out.length;
      continue;
    }
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      if (keepApp(marker, payload)) out.push(segment);
      continue;
    }
    out.push(segment);
    if (marker !== 0xda) continue;
    scanned = true;
    // Entropy-coded data follows a start of scan, up to the next marker that is not a stuffed 0xFF00 or a restart.
    const start = p;
    for (;;) {
      p = data.indexOf(0xff, p);
      if (p < 0 || p + 1 >= data.length) throw new Error("ends inside the image data");
      const next = data[p + 1]!;
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) p += 2;
      else if (next === 0xff) p += 1;
      else break;
    }
    out.push(data.subarray(start, p));
  }
  if (orientation !== null) out.splice(exifAt, 0, orientationExif(orientation));
  return Buffer.concat(out);
}

/** APP0 JFIF/JFXX, an APP2 ICC profile and APP14 Adobe are read by decoders; every other APPn and COM is metadata. */
function keepApp(marker: number, payload: Buffer): boolean {
  if (marker === 0xe0) return true;
  if (marker === 0xe2) return payload.subarray(0, 12).toString("latin1") === "ICC_PROFILE\0";
  if (marker === 0xee) return payload.subarray(0, 5).toString("latin1") === "Adobe";
  return false;
}

/** The Orientation tag (0x0112) of IFD0 in a TIFF structure, or null when it is absent or cannot be read. */
function exifOrientation(tiff: Buffer): number | null {
  if (tiff.length < 8) return null;
  const order = tiff.subarray(0, 2).toString("latin1");
  if (order !== "II" && order !== "MM") return null;
  const u16 = (at: number) => (order === "II" ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (order === "II" ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return null;
    // SHORT (3), one value, stored in the first two bytes of the value field.
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** An APP1 EXIF block holding nothing but the orientation: a big-endian TIFF header and a one-entry IFD0. */
function orientationExif(orientation: number): Buffer {
  const b = Buffer.alloc(36);
  b.writeUInt16BE(0xffe1, 0);
  b.writeUInt16BE(34, 2);
  b.write("Exif\0\0MM", 4, "latin1");
  b.writeUInt16BE(0x002a, 12);
  b.writeUInt32BE(8, 14);
  b.writeUInt16BE(1, 18);
  b.writeUInt16BE(0x0112, 20);
  b.writeUInt16BE(3, 22);
  b.writeUInt32BE(1, 24);
  b.writeUInt16BE(orientation, 28);
  // The value field's other two bytes (30-31) and the next-IFD offset (32-35) stay zero.
  return b;
}
