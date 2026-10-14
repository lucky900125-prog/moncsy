import { format, isToday, isYesterday } from "date-fns";
import { hu } from "date-fns/locale";

export const BASE_CURRENCY = "HUF";

const fmtCache = new Map<string, Intl.NumberFormat>();

export function money(amount: number, currency = BASE_CURRENCY, sign = false) {
  let f = fmtCache.get(currency);
  if (!f) {
    f = new Intl.NumberFormat("hu-HU", {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "HUF" ? 0 : 2,
    });
    fmtCache.set(currency, f);
  }
  const s = f.format(Math.abs(amount));
  if (amount < 0) return `−${s}`;
  return sign ? `+${s}` : s;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function dayLabel(d: Date) {
  if (isToday(d)) return "Ma";
  if (isYesterday(d)) return "Tegnap";
  return cap(format(d, "MMMM d., EEEE", { locale: hu }));
}

export const monthLabel = (d: Date) => format(d, "yyyy. LLLL", { locale: hu });
export const dayKey = (iso: string) => format(new Date(iso), "yyyy-MM-dd");
