import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { isSameMonth, subMonths, addMonths } from "date-fns";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react-native";
import { Card, ErrorCard, Label, Screen, useTheme } from "@/components/ui";
import { TxRow } from "@/components/tx-row";
import { useData } from "@/lib/data";
import { BASE_CURRENCY, money, monthLabel } from "@/lib/format";

export default function Overview() {
  const t = useTheme();
  const { transactions, categoryMap, error, refresh, loading } = useData();
  const [month, setMonth] = useState(() => new Date());

  const s = useMemo(() => {
    const inMonth = transactions.filter((x) => isSameMonth(new Date(x.date), month));
    // Only the base currency is summed; other currencies are counted, never added in.
    const base = inMonth.filter((x) => x.currency === BASE_CURRENCY);
    let income = 0;
    let expense = 0;
    const byCat = new Map<string | null, number>();
    for (const x of base) {
      if (x.amount > 0) income += x.amount;
      else {
        expense -= x.amount;
        byCat.set(x.categoryId, (byCat.get(x.categoryId) ?? 0) - x.amount);
      }
    }
    const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    return { inMonth, income, expense, cats, foreign: inMonth.length - base.length };
  }, [transactions, month]);

  const atCurrent = isSameMonth(month, new Date());

  return (
    <Screen
      title="Áttekintés"
      subtitle="Hová ment a pénz ebben a hónapban."
      right={
        <Pressable onPress={() => router.push("/tx")} className="size-11 items-center justify-center rounded-full bg-primary dark:bg-primary-dark" accessibilityLabel="Új tétel">
          <Plus size={20} color={t.primaryFg} />
        </Pressable>
      }
    >
      <View className="flex-row items-center justify-between rounded-xl border border-line bg-card px-1 py-1 dark:border-line-dark dark:bg-card-dark">
        <Pressable onPress={() => setMonth(subMonths(month, 1))} className="p-2" accessibilityLabel="Előző hónap"><ChevronLeft size={18} color={t.fg} /></Pressable>
        <Text className="font-medium text-fg dark:text-fg-dark">{monthLabel(month)}</Text>
        <Pressable disabled={atCurrent} onPress={() => setMonth(addMonths(month, 1))} className={`p-2 ${atCurrent ? "opacity-30" : ""}`} accessibilityLabel="Következő hónap"><ChevronRight size={18} color={t.fg} /></Pressable>
      </View>

      {error ? <ErrorCard message={error} onRetry={refresh} /> : null}

      <Card className="gap-1">
        <Label>Kiadás</Label>
        <Text className="text-3xl font-semibold text-fg dark:text-fg-dark">{loading ? "…" : money(s.expense)}</Text>
        {s.foreign > 0 ? (
          <Text className="text-xs text-muted-fg dark:text-muted-fg-dark">{s.foreign} tétel más pénznemben, nincs benne az összesítésben.</Text>
        ) : null}
      </Card>
      <View className="flex-row gap-3">
        <Card className="flex-1 gap-1">
          <Label>Bevétel</Label>
          <Text className="text-lg font-semibold text-positive dark:text-positive-dark">{money(s.income)}</Text>
        </Card>
        <Card className="flex-1 gap-1">
          <Label>Egyenleg</Label>
          <Text className={`text-lg font-semibold ${s.income - s.expense >= 0 ? "text-positive dark:text-positive-dark" : "text-danger dark:text-danger-dark"}`}>{money(s.income - s.expense)}</Text>
        </Card>
      </View>

      <Card className="gap-3">
        <Label>Kategóriák szerint</Label>
        {s.cats.length === 0 ? <Text className="text-sm text-muted-fg dark:text-muted-fg-dark">Ebben a hónapban még nincs kiadás.</Text> : null}
        {s.cats.slice(0, 6).map(([id, v]) => {
          const c = id ? categoryMap.get(id) : undefined;
          const pct = Math.round((v / (s.expense || 1)) * 100);
          return (
            <View key={id ?? "none"} className="gap-1.5">
              <View className="flex-row justify-between">
                <Text className="text-sm text-fg dark:text-fg-dark">{c?.name ?? "Nincs kategória"}</Text>
                <Text className="text-sm text-muted-fg dark:text-muted-fg-dark">{money(v)} · {pct}%</Text>
              </View>
              <View className="h-1.5 overflow-hidden rounded-full bg-muted dark:bg-muted-dark">
                <View style={{ width: `${pct}%`, backgroundColor: c?.color ?? "#94a3a8" }} className="h-full rounded-full" />
              </View>
            </View>
          );
        })}
      </Card>

      <Card>
        <Label>Legutóbbi tételek</Label>
        {s.inMonth.slice(0, 6).map((x) => (
          <TxRow key={x.id} tx={x} category={x.categoryId ? categoryMap.get(x.categoryId) : undefined} onPress={() => router.push({ pathname: "/tx", params: { id: x.id } })} />
        ))}
        {s.inMonth.length === 0 ? <Text className="pt-2 text-sm text-muted-fg dark:text-muted-fg-dark">Nincs tétel ebben a hónapban.</Text> : null}
      </Card>
    </Screen>
  );
}
