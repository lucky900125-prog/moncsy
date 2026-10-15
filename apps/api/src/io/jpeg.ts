import { exifOrientation, orientationTiff } from "./exif.js";

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

/** An APP1 EXIF block holding nothing but the orientation. */
function orientationExif(orientation: number): Buffer {
  return Buffer.concat([Buffer.from("ffe10022457869660000", "hex"), orientationTiff(orientation)]);
}
