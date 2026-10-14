import type { Category, Transaction } from "@et/shared";
import { getDate, getDaysInMonth, isSameMonth } from "date-fns";

export function inMonth(tx: Transaction[], d: Date) {
  return tx.filter((t) => isSameMonth(new Date(t.date), d));
}

export function totals(tx: Transaction[]) {
  let income = 0;
  let expense = 0;
  for (const t of tx) {
    if (t.amount > 0) income += t.amount;
    else expense -= t.amount;
  }
  return { income, expense, balance: income - expense };
}

export function byCategory(tx: Transaction[], cats: Map<string, Category>) {
  const m = new Map<string | null, number>();
  for (const t of tx) if (t.amount < 0) m.set(t.categoryId, (m.get(t.categoryId) ?? 0) - t.amount);
  return [...m.entries()]
    .map(([id, value]) => ({ id, value, category: id ? cats.get(id) : undefined }))
    .sort((a, b) => b.value - a.value);
}

/** Cumulative daily spend for a month; `upToToday` stops the line at today for the current month. */
export function cumulative(tx: Transaction[], month: Date, upToToday: boolean) {
  const days = getDaysInMonth(month);
  const perDay = new Array(days).fill(0);
  for (const t of tx) if (t.amount < 0) perDay[getDate(new Date(t.date)) - 1] -= t.amount;
  const lastDay = upToToday ? getDate(new Date()) : days;
  let acc = 0;
  return perDay.map((v, i) => {
    acc += v;
    return i < lastDay ? acc : null;
  });
}

export function pctChange(now: number, prev: number) {
  if (!prev) return null;
  return ((now - prev) / prev) * 100;
}
