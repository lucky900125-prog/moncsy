/**
 * The Orientation tag (0x0112) of IFD0 in a TIFF structure, or null when it is absent or cannot be read.
 * PNG and WebP writers sometimes keep JPEG's "Exif\0\0" prefix in front of the TIFF header, so it is skipped.
 */
export function exifOrientation(blob: Buffer): number | null {
  const tiff = blob.subarray(0, 6).toString("latin1") === "Exif\0\0" ? blob.subarray(6) : blob;
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

/** A TIFF structure holding nothing but the orientation: a big-endian header and a one-entry IFD0. */
export function orientationTiff(orientation: number): Buffer {
  const b = Buffer.alloc(26);
  b.write("MM", 0, "latin1");
  b.writeUInt16BE(0x002a, 2);
  b.writeUInt32BE(8, 4);
  b.writeUInt16BE(1, 8);
  b.writeUInt16BE(0x0112, 10);
  b.writeUInt16BE(3, 12);
  b.writeUInt32BE(1, 14);
  b.writeUInt16BE(orientation, 18);
  // The value field's other two bytes (20-21) and the next-IFD offset (22-25) stay zero.
  return b;
}
