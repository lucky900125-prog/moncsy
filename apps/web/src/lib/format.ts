import { format, isToday, isYesterday } from "date-fns";
import { hu } from "date-fns/locale";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const fmtCache = new Map<string, Intl.NumberFormat>();

export function money(amount: number, currency = "HUF", opts: { sign?: boolean; compact?: boolean } = {}) {
  const key = `${currency}-${opts.compact}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat("hu-HU", {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "HUF" ? 0 : 2,
      notation: opts.compact ? "compact" : "standard",
    });
    fmtCache.set(key, f);
  }
  const s = f.format(Math.abs(amount));
  if (!opts.sign) return amount < 0 ? `−${s}` : s;
  return amount < 0 ? `−${s}` : `+${s}`;
}

export function dayLabel(iso: string) {
  const d = new Date(iso);
  if (isToday(d)) return "Ma";
  if (isYesterday(d)) return "Tegnap";
  return cap(format(d, "MMMM d., EEEE", { locale: hu }));
}

export function monthLabel(d: Date) {
  return format(d, "yyyy. LLLL", { locale: hu });
}

export function shortDate(iso: string) {
  return format(new Date(iso), "MMM d.", { locale: hu });
}
