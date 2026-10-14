import { useMemo, useState } from "react";
import { RefreshControl, SectionList, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { ErrorCard, useTheme } from "@/components/ui";
import { TxRow } from "@/components/tx-row";
import { useData } from "@/lib/data";
import { dayKey, dayLabel, money } from "@/lib/format";

export default function Transactions() {
  const t = useTheme();
  const { transactions, categoryMap, loading, error, refresh } = useData();
  const [q, setQ] = useState("");

  const sections = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const m = new Map<string, typeof transactions>();
    for (const x of transactions) {
      if (needle && !x.merchant.toLowerCase().includes(needle) && !(x.note ?? "").toLowerCase().includes(needle)) continue;
      const k = dayKey(x.date); // local calendar day
      m.set(k, [...(m.get(k) ?? []), x]);
    }
    return [...m.entries()].map(([key, data]) => {
      const spend = new Map<string, number>();
      for (const x of data) if (x.amount < 0) spend.set(x.currency, (spend.get(x.currency) ?? 0) - x.amount);
      return { key, title: dayLabel(new Date(data[0]!.date)), total: [...spend].map(([c, v]) => money(-v, c)).join(" · "), data };
    });
  }, [transactions, q]);

  return (
    <SafeAreaView edges={["top"]} className="flex-1 bg-bg dark:bg-bg-dark">
      <SectionList
        sections={sections}
        keyExtractor={(x) => x.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={t.muted} />}
        contentContainerClassName="px-4 pb-10"
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View className="gap-3 pb-2 pt-2">
            <Text className="text-2xl font-semibold text-fg dark:text-fg-dark">Tételek</Text>
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Keresés kereskedőre vagy megjegyzésre"
              placeholderTextColor={t.muted}
              className="h-11 rounded-xl border border-line bg-card px-3 text-fg dark:border-line-dark dark:bg-card-dark dark:text-fg-dark"
            />
            {error ? <ErrorCard message={error} onRetry={refresh} /> : null}
          </View>
        }
        renderSectionHeader={({ section }) => (
          <View className="flex-row justify-between pb-1 pt-4">
            <Text className="text-xs font-medium text-muted-fg dark:text-muted-fg-dark">{section.title}</Text>
            <Text className="text-xs text-muted-fg dark:text-muted-fg-dark">{section.total}</Text>
          </View>
        )}
        renderItem={({ item }) => (
          <TxRow tx={item} category={item.categoryId ? categoryMap.get(item.categoryId) : undefined} onPress={() => router.push({ pathname: "/tx", params: { id: item.id } })} />
        )}
        ListEmptyComponent={!loading && !error ? <Text className="py-10 text-center text-sm text-muted-fg dark:text-muted-fg-dark">Nincs tétel.</Text> : null}
      />
    </SafeAreaView>
  );
}
