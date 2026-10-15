import { exifOrientation, orientationTiff } from "./exif.js";

/** Chunks a decoder reads; EXIF, XMP and every unknown chunk are dropped. */
const DECODING = new Set(["VP8X", "VP8 ", "VP8L", "ALPH", "ANIM", "ANMF", "ICCP"]);
const IMAGE = new Set(["VP8 ", "VP8L", "ANMF"]);
/** VP8X flag bits that announce an EXIF and an XMP chunk. */
const EXIF_FLAG = 0x08;
const XMP_FLAG = 0x04;

/**
 * A WebP without its metadata: the EXIF and XMP chunks, unknown chunks and anything after the RIFF end are dropped,
 * and the VP8X flags and the RIFF size are corrected to match. The EXIF orientation is kept in a minimal EXIF chunk of
 * its own, as for a JPEG. Kept chunks are copied byte for byte. Throws for a file whose chunks cannot be followed.
 */
export function stripWebpMetadata(data: Buffer): Buffer {
  if (data.length < 12 || data.toString("latin1", 0, 4) !== "RIFF" || data.toString("latin1", 8, 12) !== "WEBP") {
    throw new Error("no RIFF WEBP header");
  }
  const riffEnd = 8 + data.readUInt32LE(4);
  if (riffEnd > data.length) throw new Error("the file is shorter than its RIFF header says");
  const out: Buffer[] = [];
  let vp8x: Buffer | null = null;
  let hasImage = false;
  let orientation: number | null = null;
  let exifAt = -1;
  for (let p = 12; p < riffEnd; ) {
    if (p + 8 > riffEnd) throw new Error(`chunk at byte ${p} runs past the end`);
    const type = data.toString("latin1", p, p + 4);
    const size = data.readUInt32LE(p + 4);
    const end = p + 8 + size;
    if (end > riffEnd) throw new Error(`chunk "${type}" at byte ${p} runs past the end`);
    const chunk = data.subarray(p, end);
    // An odd-sized chunk is followed by a padding byte; a writer that left the last one out is forgiven.
    p = end + (size & 1);
    if (type === "EXIF") {
      orientation ??= exifOrientation(chunk.subarray(8));
      if (exifAt < 0) exifAt = out.length;
      continue;
    }
    if (!DECODING.has(type)) continue;
    if (type === "VP8X") {
      if (size < 10) throw new Error("the VP8X chunk is too short");
      vp8x = Buffer.concat([chunk, Buffer.alloc(size & 1)]);
      out.push(vp8x);
      continue;
    }
    if (IMAGE.has(type)) hasImage = true;
    out.push(size & 1 ? Buffer.concat([chunk, Buffer.alloc(1)]) : chunk);
  }
  if (!hasImage) throw new Error("no image data");
  if (vp8x) {
    // The flags byte follows the chunk header; only an extended file can say it has an EXIF chunk.
    vp8x[8] = (vp8x[8]! & ~(EXIF_FLAG | XMP_FLAG)) | (orientation !== null ? EXIF_FLAG : 0);
    if (orientation !== null) out.splice(exifAt, 0, chunk("EXIF", orientationTiff(orientation)));
  }
  const body = Buffer.concat(out);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length + 4, 4);
  head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
}

/** A chunk with an even-sized payload. */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, "latin1");
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data]);
}
