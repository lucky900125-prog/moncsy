import { endOfMonth, startOfMonth, subMonths, addMonths } from "date-fns";

export function monthRange(d: Date) {
  return { from: startOfMonth(d).toISOString(), to: endOfMonth(d).toISOString() };
}
export const prevMonth = (d: Date) => subMonths(d, 1);
export const nextMonth = (d: Date) => addMonths(d, 1);
