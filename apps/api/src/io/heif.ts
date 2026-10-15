/**
 * A HEIC/HEIF without its metadata: the bytes of every Exif item and every MIME item (XMP) are overwritten with zeros
 * where they are stored, in mdat or in the meta box's idat. Nothing moves, so every offset in the file stays valid
 * and the image items are untouched; the orientation of a HEIF comes from its irot/imir properties, not from Exif.
 * Throws for a file whose boxes or item locations cannot be followed, and for a metadata item stored in a way this
 * cannot reach (built from other items, or in another file).
 */
export function stripHeifMetadata(data: Buffer): Buffer {
  const meta = boxes(data, 0, data.length).find((b) => b.type === "meta");
  if (!meta) throw new Error("no meta box");
  const children = boxes(data, meta.body + 4, meta.end);
  const iinf = children.find((b) => b.type === "iinf");
  const iloc = children.find((b) => b.type === "iloc");
  const idat = children.find((b) => b.type === "idat");
  if (!iinf || !iloc) throw new Error("no item list in the meta box");
  const metadata = metadataItems(data, iinf);
  if (metadata.size === 0) return data;
  const out = Buffer.from(data);
  for (const item of locations(data, iloc)) {
    if (!metadata.has(item.id)) continue;
    if (item.dataReference !== 0) continue; // stored in another file, so not in this one either
    if (item.method === 2) throw new Error(`item ${item.id} is built from other items`);
    const [from, to] = item.method === 1 ? (idat ? [idat.body, idat.end] : [-1, -1]) : [0, data.length];
    if (from < 0) throw new Error(`item ${item.id} is in an idat box that is missing`);
    for (const e of item.extents) {
      const start = from + item.baseOffset + e.offset;
      // A length of 0 means the rest of the file, or of idat.
      const end = e.length === 0 ? to : start + e.length;
      if (start < from || end > to) throw new Error(`item ${item.id} runs past the end`);
      out.fill(0, start, end);
    }
  }
  return out;
}

interface Box {
  type: string;
  start: number;
  body: number;
  end: number;
}

function boxes(data: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  for (let p = from; p < to; ) {
    if (p + 8 > to) throw new Error(`box at byte ${p} runs past its parent`);
    const type = data.toString("latin1", p + 4, p + 8);
    let size = data.readUInt32BE(p);
    let body = p + 8;
    if (size === 1) {
      if (p + 16 > to) throw new Error(`box "${type}" at byte ${p} runs past its parent`);
      size = Number(data.readBigUInt64BE(p + 8));
      body = p + 16;
    } else if (size === 0) {
      size = to - p;
    }
    const end = p + size;
    if (end < body || end > to) throw new Error(`box "${type}" at byte ${p} runs past its parent`);
    out.push({ type, start: p, body, end });
    p = end;
  }
  return out;
}

/** Reads big-endian fields inside one box, refusing to read past its end. */
class Reader {
  constructor(
    private readonly data: Buffer,
    public p: number,
    private readonly end: number,
    private readonly box: string,
  ) {}

  uint(bytes: number): number {
    if (this.p + bytes > this.end) throw new Error(`the ${this.box} box runs past its end`);
    const at = this.p;
    this.p += bytes;
    if (bytes === 0) return 0;
    if (bytes === 1) return this.data[at]!;
    if (bytes === 2) return this.data.readUInt16BE(at);
    if (bytes === 4) return this.data.readUInt32BE(at);
    if (bytes === 8) return Number(this.data.readBigUInt64BE(at));
    throw new Error(`the ${this.box} box has a ${bytes}-byte field`);
  }

  /** Skips a null-terminated string. */
  string(): void {
    const nul = this.data.indexOf(0, this.p);
    if (nul < 0 || nul >= this.end) throw new Error(`the ${this.box} box runs past its end`);
    this.p = nul + 1;
  }
}

/** The ids of the Exif and MIME (XMP) items listed in iinf. */
function metadataItems(data: Buffer, iinf: Box): Set<number> {
  const version = data[iinf.body];
  const r = new Reader(data, iinf.body + 4, iinf.end, "iinf");
  r.uint(version === 0 ? 2 : 4);
  const ids = new Set<number>();
  for (const infe of boxes(data, r.p, iinf.end)) {
    if (infe.type !== "infe") continue;
    const v = data[infe.body]!;
    // Versions 0 and 1 have no item type; HEIF requires 2 or later.
    if (v < 2) continue;
    const e = new Reader(data, infe.body + 4, infe.end, "infe");
    const id = e.uint(v === 2 ? 2 : 4);
    e.uint(2);
    const type = data.toString("latin1", e.p, e.p + 4);
    e.uint(4);
    if (type === "Exif" || type === "mime") ids.add(id);
  }
  return ids;
}

interface Location {
  id: number;
  method: number;
  dataReference: number;
  baseOffset: number;
  extents: { offset: number; length: number }[];
}

function locations(data: Buffer, iloc: Box): Location[] {
  const version = data[iloc.body]!;
  if (version > 2) throw new Error(`iloc version ${version} is not supported`);
  const r = new Reader(data, iloc.body + 4, iloc.end, "iloc");
  const sizes = r.uint(1);
  const more = r.uint(1);
  const [offsetSize, lengthSize, baseOffsetSize] = [sizes >> 4, sizes & 0x0f, more >> 4];
  const indexSize = version === 0 ? 0 : more & 0x0f;
  const count = r.uint(version < 2 ? 2 : 4);
  const out: Location[] = [];
  for (let i = 0; i < count; i++) {
    const id = r.uint(version < 2 ? 2 : 4);
    const method = version === 0 ? 0 : r.uint(2) & 0x0f;
    const dataReference = r.uint(2);
    const baseOffset = r.uint(baseOffsetSize);
    const extents: Location["extents"] = [];
    for (let n = r.uint(2); n > 0; n--) {
      r.uint(indexSize);
      extents.push({ offset: r.uint(offsetSize), length: r.uint(lengthSize) });
    }
    out.push({ id, method, dataReference, baseOffset, extents });
  }
  return out;
}
