/** One formatter per time zone: building one costs far more than using it, and a statement converts every row. */
const tzFormats = new Map<string, Intl.DateTimeFormat>();

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffset(utcMs: number, timeZone: string): number {
  let format = tzFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    tzFormats.set(timeZone, format);
  }
  const parts = format.formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utcMs;
}

/** Date.UTC rolls 31 February over into March and 99:99 into later days; a statement date that needs that is wrong, not later. */
export function isCalendarDate(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): boolean {
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** Days since 1899-12-30, the Excel epoch, for cells that arrive as plain serial numbers; the wall-clock time is encoded as UTC. */
export function fromExcelSerial(n: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
}

/** Converts a wall-clock time in `timeZone` to a UTC instant (DST-aware). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - tzOffset(guess, timeZone);
  t = guess - tzOffset(t, timeZone);
  return new Date(t);
}
