/** UTF-16 when it starts with a byte order mark: Excel's "Unicode text" export is written that way. */
export function utf16Encoding(data: Buffer): "utf-16le" | "utf-16be" | null {
  if (data[0] === 0xff && data[1] === 0xfe) return "utf-16le";
  if (data[0] === 0xfe && data[1] === 0xff) return "utf-16be";
  return null;
}

/**
 * UTF-16 with a byte order mark; otherwise UTF-8 when the bytes are valid UTF-8, otherwise Windows-1250,
 * the code page of older Hungarian bank exports.
 */
export function decodeText(data: Buffer): string {
  const utf16 = utf16Encoding(data);
  if (utf16) return new TextDecoder(utf16).decode(data).replace(/^﻿/, "");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1250").decode(data);
  }
}

/** The separator that splits the first lines into the same, largest number of fields. */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let best = ",";
  let bestScore = -1;
  for (const d of [";", ",", "\t", "|"]) {
    const counts = lines.map((l) => {
      let n = 0;
      let quoted = false;
      for (const ch of l) {
        if (ch === '"') quoted = !quoted;
        else if (ch === d && !quoted) n++;
      }
      return n;
    });
    // The most common count among lines that have any separator, times how many lines share it.
    const freq = new Map<number, number>();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
    const [count, lines_] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? [0, 0];
    const score = count * lines_;
    if (score > bestScore) [best, bestScore] = [d, score];
  }
  return best;
}
