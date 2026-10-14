import { inflateRawSync } from "node:zlib";

/** The unpacked size went over the limit. */
export class UnpackedTooLargeError extends Error {}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * Inflates every entry of a ZIP archive (an XLSX is one) and throws once the output passes maxBytes.
 * Readers such as ExcelJS inflate each part fully in memory, and a few kilobytes of deflate can stand for gigabytes.
 * What is counted is what inflating actually produces, so a header that understates a size does not get past it.
 * Throws a plain Error for an archive that cannot be read this way (damaged, ZIP64, an unknown compression method).
 */
export function assertUnpackedSize(data: Buffer, maxBytes: number): void {
  // The end-of-central-directory record is 22 bytes plus a comment of at most 65535 bytes.
  const tailStart = Math.max(0, data.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = data.length - 22; i >= tailStart; i--) {
    if (data.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no ZIP directory");
  const count = data.readUInt16LE(eocd + 10);
  let p = data.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > data.length || data.readUInt32LE(p) !== CENTRAL) throw new Error("damaged ZIP directory");
    const method = data.readUInt16LE(p + 10);
    const compressed = data.readUInt32LE(p + 20);
    const local = data.readUInt32LE(p + 42);
    if (compressed === 0xffffffff || local === 0xffffffff) throw new Error("ZIP64 archives are not supported");
    p += 46 + data.readUInt16LE(p + 28) + data.readUInt16LE(p + 30) + data.readUInt16LE(p + 32);
    if (local + 30 > data.length || data.readUInt32LE(local) !== LOCAL) throw new Error("damaged ZIP entry");
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    if (start + compressed > data.length) throw new Error("damaged ZIP entry");
    const body = data.subarray(start, start + compressed);
    if (method === 0) {
      total += body.length;
    } else if (method === 8) {
      try {
        total += inflateRawSync(body, { maxOutputLength: maxBytes - total + 1 }).length;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") total = maxBytes + 1;
        else throw new Error(`damaged ZIP entry: ${(e as Error).message}`);
      }
    } else {
      throw new Error(`unsupported ZIP compression method ${method}`);
    }
    if (total > maxBytes) throw new UnpackedTooLargeError(`unpacks to more than ${maxBytes / 1024 / 1024} MB`);
  }
}
