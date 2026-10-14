// The ranges ExcelJS expands into one object per cell, counted in the reading thread before ExcelJS loads the workbook
// (io/xlsx-worker.ts). Like the worker, it imports nothing from the rest of the API: the worker loads it as it is, as
// JavaScript from dist/ and as TypeScript in development and tests.
import { createRequire } from "node:module";

/** A workbook refused for a range it describes: 413 for one too large to read, 400 for one past the sheet's end. */
export class XlsxLimitError extends Error {
  readonly status: 400 | 413;
  constructor(status: 400 | 413, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * ExcelJS builds an object for every cell of a merge, a data validation and a defined name, and a column object for
 * every column of a <col> range. A small file can name the whole sheet (17 billion cells) in any of them, so they are
 * counted before it is loaded. Legitimate files merge a few header cells and validate a table's column; a sheet has
 * 16384 columns. Each limit alone fits in the reader's heap beside a few thousand rows: validation or a name over a
 * whole column (1 048 576 cells) does not, so such a file is refused here, with a message, rather than after a while.
 */
const MAX_MERGED_CELLS = 100_000;
const MAX_VALIDATED_CELLS = 200_000;
const MAX_NAMED_CELLS = 200_000;
const MAX_COLUMN = 16_384;

// ExcelJS's own address parser, so a range is sized as ExcelJS will expand it: it skips stray characters, for one. It is
// an internal file, not part of ExcelJS's API, so package.json pins ExcelJS to one exact version.
const colCache = createRequire(import.meta.url)("exceljs/lib/utils/col-cache.js") as {
  decodeEx(ref: string): { top?: number; left?: number; bottom?: number; right?: number };
};

/** Cells ExcelJS makes of one reference ("A1:B2", "$A$1:$B$2", "Sheet1!A1:B2", "C3"). */
function cellsOf(ref: string): number {
  try {
    const r = colCache.decodeEx(ref);
    if (r.top === undefined) return 1;
    const cells = (r.bottom! - r.top + 1) * (r.right! - r.left! + 1);
    return Number.isFinite(cells) ? cells : 0;
  } catch {
    // ExcelJS cannot read it either: a merge or validation written so fails the load, and such a defined name is skipped.
    return 0;
  }
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const ENTITY = /&(?:#(\d+)|#x([\da-fA-F]+)|(amp|lt|gt|quot|apos));/y;

/**
 * XML's five named entities and its numeric character references, decoded as an XML parser reads them. A loop over the
 * ampersands rather than a replace with a callback: a value of millions of references is decoded in about half the time.
 */
function decodeXml(text: string): string {
  let amp = text.indexOf("&");
  if (amp < 0) return text;
  const parts: string[] = [];
  let from = 0;
  for (; amp >= 0; amp = text.indexOf("&", amp + 1)) {
    ENTITY.lastIndex = amp;
    const m = ENTITY.exec(text);
    if (!m) continue;
    const code = m[3] ? 0 : m[1] !== undefined ? Number(m[1]) : parseInt(m[2]!, 16);
    if (code > 0x10ffff) continue;
    parts.push(text.slice(from, amp), m[3] ? NAMED_ENTITIES[m[3]]! : String.fromCodePoint(code));
    from = ENTITY.lastIndex;
    amp = from - 1;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

/**
 * Where the tag whose attributes start at `from` closes: the next > outside quotes. XML allows a > inside a quoted value
 * but no <, so a < first means a broken tag (-1). A loop rather than a regex: no backtracking, however long the tag.
 */
function tagEnd(xml: string, from: number): number {
  let quote = "";
  for (let i = from; i < xml.length; i++) {
    const c = xml[i]!;
    if (c === "<") return -1;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

/** The attribute text of every opening <tag ...> in the XML (any namespace prefix), and where each tag ends. */
function* tags(xml: string, tag: string): Generator<{ attributes: string; end: number }> {
  const open = new RegExp(`<(?:\\w+:)?${tag}\\b`, "g");
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    const end = tagEnd(xml, open.lastIndex);
    if (end < 0) continue;
    yield { attributes: xml.slice(open.lastIndex, end), end };
    open.lastIndex = end + 1;
  }
}

/** The decoded values of an attribute on every <tag ...> in the XML, read pair by pair as a parser does. */
function* attributes(xml: string, tag: string, attribute: string): Generator<string> {
  for (const t of tags(xml, tag)) {
    for (const a of t.attributes.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      if (a[1] === attribute || a[1]!.endsWith(`:${attribute}`)) yield decodeXml(a[2] ?? a[3]!);
    }
  }
}

/** The text of every <tag>...</tag> in the XML, child tags left out, as ExcelJS joins the text it is given. */
function* texts(xml: string, tag: string): Generator<string> {
  const close = new RegExp(`</(?:\\w+:)?${tag}\\s*>`, "g");
  let after = 0;
  for (const t of tags(xml, tag)) {
    if (t.end < after || t.attributes.endsWith("/")) continue;
    close.lastIndex = t.end + 1;
    const c = close.exec(xml);
    if (!c) return;
    yield xml.slice(t.end + 1, c.index).replace(/<[^<>]*>/g, "");
    after = close.lastIndex;
  }
}

export function checkRanges(_name: string, content: Buffer): void {
  // Every part, whatever its name: ExcelJS drops a leading "/" and matches sheet names anywhere in the path, and JSZip can
  // take a name from an extra field, so the name says nothing reliable. Comments, CDATA and processing instructions go
  // first, as ExcelJS's parser passes over them: text around a comment is joined, and CDATA is not read at all. One left
  // open runs to the end, so a file of many unclosed ones is still read once, not once per opening.
  const xml = content.toString("utf8").replace(/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<\?[\s\S]*?(?:\?>|$)/g, "");
  let merged = 0;
  for (const ref of attributes(xml, "mergeCell", "ref")) merged += cellsOf(ref);
  if (merged > MAX_MERGED_CELLS) {
    throw new XlsxLimitError(413, `The XLSX file merges ${merged} cells; more than ${MAX_MERGED_CELLS} are not read. Unmerge them or save the sheet as CSV`);
  }
  let validated = 0;
  for (const sqref of attributes(xml, "dataValidation", "sqref")) for (const ref of sqref.split(/\s+/)) if (ref) validated += ref.includes(":") ? cellsOf(ref) : 1;
  if (validated > MAX_VALIDATED_CELLS) {
    throw new XlsxLimitError(413, `The XLSX file has data validation on ${validated} cells; more than ${MAX_VALIDATED_CELLS} are not read. Remove it or save the sheet as CSV`);
  }
  // ExcelJS makes a column object for every column up to the largest min and max, read with parseInt as here.
  for (const bound of [...attributes(xml, "col", "min"), ...attributes(xml, "col", "max")]) {
    const n = parseInt(bound, 10);
    if (n > MAX_COLUMN) throw new XlsxLimitError(400, `The XLSX file describes column ${n}; a sheet has ${MAX_COLUMN} columns`);
  }
  let named = 0;
  for (const text of texts(xml, "definedName")) for (const ref of decodeXml(text).split(",")) named += cellsOf(ref);
  if (named > MAX_NAMED_CELLS) {
    throw new XlsxLimitError(413, `The XLSX file's defined names cover ${named} cells; more than ${MAX_NAMED_CELLS} are not read. Delete the names or save the sheet as CSV`);
  }
}
