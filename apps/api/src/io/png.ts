import { crc32 } from "node:zlib";
import { exifOrientation, orientationTiff } from "./exif.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Ancillary chunks a decoder uses for colour, transparency, pixel size or animation. */
const DECODING = new Set(["tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "cICP", "mDCV", "cLLI", "mDCv", "cLLi", "sBIT", "bKGD", "hIST", "pHYs", "sPLT", "acTL", "fcTL", "fdAT"]);

/**
 * A PNG without its metadata: eXIf, text (tEXt, zTXt, iTXt, which carry XMP too), tIME and every other ancillary chunk
 * a decoder does not use are dropped, and so is anything after IEND. Critical chunks always stay (a decoder that does
 * not know one cannot show the image anyway). The EXIF orientation is kept in a minimal eXIf chunk of its own, as for
 * a JPEG. Kept chunks are copied byte for byte. Throws for a file whose chunks cannot be followed.
 */
export function stripPngMetadata(data: Buffer): Buffer {
  if (!data.subarray(0, 8).equals(SIGNATURE)) throw new Error("no PNG signature");
  const out: Buffer[] = [SIGNATURE];
  let orientation: number | null = null;
  // Where the first eXIf chunk was, so the orientation goes back to the same place among the chunks.
  let exifAt = -1;
  for (let p = 8, type = ""; type !== "IEND"; ) {
    if (p + 12 > data.length) throw new Error(`chunk at byte ${p} runs past the end`);
    const length = data.readUInt32BE(p);
    type = data.toString("latin1", p + 4, p + 8);
    const end = p + 12 + length;
    if (end > data.length) throw new Error(`chunk "${type}" at byte ${p} runs past the end`);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error(`no chunk type at byte ${p + 4}`);
    if (p === 8 && type !== "IHDR") throw new Error("the first chunk is not IHDR");
    const chunk = data.subarray(p, end);
    p = end;
    if (type === "eXIf") {
      orientation ??= exifOrientation(chunk.subarray(8, 8 + length));
      if (exifAt < 0) exifAt = out.length;
    } else if (isCritical(type) || DECODING.has(type)) {
      out.push(chunk);
    }
  }
  if (orientation !== null) out.splice(exifAt, 0, chunk("eXIf", orientationTiff(orientation)));
  return Buffer.concat(out);
}

/** An upper-case first letter marks a chunk the image cannot be decoded without. */
const isCritical = (type: string) => (type.charCodeAt(0) & 0x20) === 0;

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
