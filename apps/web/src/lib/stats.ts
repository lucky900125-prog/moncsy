import type { Category, Transaction } from "@et/shared";
import { getDate, getDaysInMonth, isSameMonth } from "date-fns";

/** Currency the dashboard, budgets and charts are computed in. Other currencies are never added to it. */
export const BASE_CURRENCY = "HUF";

export function inMonth(tx: Transaction[], d: Date) {
  return tx.filter((t) => isSameMonth(new Date(t.date), d));
}

export function splitByCurrency(tx: Transaction[], currency = BASE_CURRENCY) {
  const base: Transaction[] = [];
  const other: Transaction[] = [];
  for (const t of tx) (t.currency === currency ? base : other).push(t);
  return { base, other };
}

/** Income/expense totals per currency, base currency first. */
export function totalsByCurrency(tx: Transaction[]) {
  const m = new Map<string, { income: number; expense: number }>();
  for (const t of tx) {
    const v = m.get(t.currency) ?? { income: 0, expense: 0 };
    if (t.amount > 0) v.income += t.amount;
    else v.expense -= t.amount;
    m.set(t.currency, v);
  }
  return [...m.entries()]
    .map(([currency, v]) => ({ currency, ...v }))
    .sort((a, b) => (a.currency === BASE_CURRENCY ? -1 : b.currency === BASE_CURRENCY ? 1 : a.currency.localeCompare(b.currency)));
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

/** Spending and income per category, both positive; a refund in an expense category counts as its income. */
export function flowsByCategory(tx: Transaction[]) {
  const m = new Map<string | null, { expense: number; income: number }>();
  for (const t of tx) {
    const v = m.get(t.categoryId) ?? { expense: 0, income: 0 };
    if (t.amount < 0) v.expense -= t.amount;
    else v.income += t.amount;
    m.set(t.categoryId, v);
  }
  return m;
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
