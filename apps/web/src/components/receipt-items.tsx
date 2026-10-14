import { useState } from "react";
import { Pencil } from "lucide-react";
import type { ReceiptItem } from "@et/shared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

/** "Mizo · tej · 1 l": what the Részletek tab groups this line by. */
export function itemMeta(it: ReceiptItem) {
  return [it.brand, it.product, it.packSize && it.packUnit ? `${it.packSize.toLocaleString("hu-HU")} ${it.packUnit}` : null]
    .filter(Boolean)
    .join(" · ");
}

const qty = (q: number) => (q !== 1 ? `${q.toLocaleString("hu-HU", { maximumFractionDigits: 3 })}× ` : "");

/**
 * Receipt lines with their recognised product, brand and pack size. With `onChange` the product and brand can be
 * corrected in place; the whole items array is saved with the transaction.
 */
export function ReceiptItems({ items, currency, onChange, label, className }: { items: ReceiptItem[]; currency: string; onChange?: (items: ReceiptItem[]) => void; label?: string; className?: string }) {
  const [editing, setEditing] = useState(false);
  const set = (i: number, patch: Partial<ReceiptItem>) => onChange?.(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  return (
    <div className={cn("grid gap-1.5", className)}>
      {(label || onChange) && (
        <div className="flex items-center justify-between gap-3">
          {label ? <Label>{label}</Label> : <span />}
          {onChange && (
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="flex items-center gap-1 text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground"
            >
              <Pencil className="size-3" /> {editing ? "Kész" : "Termék és márka javítása"}
            </button>
          )}
        </div>
      )}
      <ul className="divide-y rounded-lg border bg-muted/40 text-sm">
        {items.map((it, i) => (
          <li key={i} className="px-3 py-2">
            <div className="flex justify-between gap-3">
              <span className="truncate">{qty(it.quantity)}{it.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{money(it.total, currency)}</span>
            </div>
            {editing ? (
              <div className="mt-2 grid animate-fade-in grid-cols-2 gap-2">
                <Input
                  value={it.product ?? ""}
                  onChange={(e) => set(i, { product: e.target.value || null })}
                  placeholder="Termék (pl. tej)"
                  aria-label={`${it.name}: termék`}
                  className="h-8 text-xs"
                />
                <Input
                  value={it.brand ?? ""}
                  onChange={(e) => set(i, { brand: e.target.value || null })}
                  placeholder="Márka"
                  aria-label={`${it.name}: márka`}
                  className="h-8 text-xs"
                />
              </div>
            ) : (
              itemMeta(it) && <div className="mt-0.5 truncate text-xs text-muted-foreground">{itemMeta(it)}</div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
