import type { Category, Transaction } from "@et/shared";
import { Receipt, Landmark, FileSpreadsheet } from "lucide-react";
import { format } from "date-fns";
import { CategoryBadgeIcon } from "./category-dot";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

const sourceIcon = { receipt: Receipt, revolut: Landmark, import: FileSpreadsheet, manual: null } as const;

export function TransactionRow({ tx, category, onClick }: { tx: Transaction; category?: Category; onClick?: () => void }) {
  const SourceIcon = sourceIcon[tx.source];
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors duration-200 hover:bg-muted/70"
    >
      <CategoryBadgeIcon category={category} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{tx.merchant || "Névtelen"}</div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">{category?.name ?? "Kategória nélkül"}</span>
          <span aria-hidden>·</span>
          <span>{format(new Date(tx.date), "HH:mm")}</span>
          {SourceIcon && <SourceIcon className="size-3 opacity-70" aria-label={tx.source} />}
        </div>
      </div>
      <div className={cn("text-sm font-semibold tabular-nums", tx.amount > 0 && "text-positive")}>
        {money(tx.amount, tx.currency, { sign: tx.amount > 0 })}
      </div>
    </button>
  );
}
