import { Pressable, Text, View } from "react-native";
import { format } from "date-fns";
import type { Category, Transaction } from "@et/shared";
import { CategoryBadge } from "./ui";
import { money } from "@/lib/format";

export function TxRow({ tx, category, onPress }: { tx: Transaction; category?: Category; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} className="flex-row items-center gap-3 rounded-xl py-2.5 active:bg-muted dark:active:bg-muted-dark">
      <CategoryBadge category={category} />
      <View className="flex-1">
        <Text numberOfLines={1} className="text-[15px] font-medium text-fg dark:text-fg-dark">{tx.merchant || "Névtelen"}</Text>
        <Text numberOfLines={1} className="text-xs text-muted-fg dark:text-muted-fg-dark">
          {category?.name ?? "Kategória nélkül"} · {format(new Date(tx.date), "HH:mm")}
        </Text>
      </View>
      <Text className={`font-semibold ${tx.amount > 0 ? "text-positive dark:text-positive-dark" : "text-fg dark:text-fg-dark"}`}>
        {money(tx.amount, tx.currency, tx.amount > 0)}
      </Text>
    </Pressable>
  );
}
