import { useEffect, useState } from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import type { ReceiptItem } from "@et/shared";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { CategoryBadgeIcon } from "./category-dot";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

type Kind = "expense" | "income";

export function TransactionSheet() {
  const { open, draft } = useUi((s) => s.txSheet);
  const closeTx = useUi((s) => s.closeTx);
  const { categories, addTransaction, updateTransaction, removeTransaction } = useApp();

  const [kind, setKind] = useState<Kind>("expense");
  const [amount, setAmount] = useState("");
  const [merchant, setMerchant] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [items, setItems] = useState<ReceiptItem[] | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const a = draft?.amount ?? 0;
    setKind(a > 0 ? "income" : "expense");
    setAmount(a ? String(Math.abs(a)) : "");
    setMerchant(draft?.merchant ?? "");
    setCategoryId(draft?.categoryId ?? null);
    setDate(format(draft?.date ? new Date(draft.date) : new Date(), "yyyy-MM-dd'T'HH:mm"));
    setNote(draft?.note ?? "");
    setItems(draft?.items);
  }, [open, draft]);

  const editing = Boolean(draft?.id);
  const visibleCats = categories.filter((c) => (kind === "income" ? c.id === "income" || c.isCustom : c.id !== "income"));
  const parsed = Number(amount.replace(/\s/g, "").replace(",", "."));
  const valid = Number.isFinite(parsed) && parsed > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    const payload = {
      amount: kind === "expense" ? -parsed : parsed,
      currency: draft?.currency ?? "HUF",
      merchant: merchant.trim(),
      categoryId,
      date: new Date(date).toISOString(),
      note: note.trim() || undefined,
      source: draft?.source ?? "manual",
      items,
    };
    try {
      if (editing) await updateTransaction(draft!.id!, payload);
      else await addTransaction(payload);
      toast.success(editing ? "Módosítva" : "Rögzítve");
      closeTx();
    } catch (err) {
      toast.error("Mentés sikertelen", { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!draft?.id) return;
    setBusy(true);
    try {
      await removeTransaction(draft.id);
      toast("Törölve");
      closeTx();
    } catch (err) {
      toast.error("Törlés sikertelen", { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && closeTx()}>
      <SheetContent title={editing ? "Tétel szerkesztése" : "Új tétel"}>
        <form onSubmit={submit} className="flex flex-col gap-5 pt-2">
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "expense", label: "Kiadás" },
              { value: "income", label: "Bevétel" },
            ]}
          />
          <div className="flex items-baseline justify-center gap-2 py-2">
            <input
              autoFocus={!editing}
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="Összeg"
              className={cn(
                "w-full bg-transparent text-center text-4xl focus-visible:ring-0 focus-visible:ring-offset-0 font-semibold tracking-tight tabular-nums outline-none placeholder:text-muted-foreground/40",
                kind === "income" && "text-positive",
              )}
            />
            <span className="text-lg text-muted-foreground">{draft?.currency ?? "HUF"}</span>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="merchant">Hol / mire</Label>
            <Input id="merchant" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="pl. Lidl" />
          </div>

          <div className="grid gap-2">
            <Label>Kategória</Label>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
              {visibleCats.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  onClick={() => setCategoryId(c.id === categoryId ? null : c.id)}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-xl border border-transparent p-2 text-[11px] transition-[background-color,border-color] duration-200",
                    c.id === categoryId ? "border-ring/50 bg-accent" : "hover:bg-muted",
                  )}
                >
                  <CategoryBadgeIcon category={c} size="sm" />
                  <span className="w-full truncate text-center">{c.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="date">Időpont</Label>
            <Input id="date" type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          {items && items.length > 0 && (
            <div className="grid gap-1.5">
              <Label>Tételek a blokkról</Label>
              <ul className="divide-y rounded-lg border bg-muted/40 text-sm">
                {items.map((it, i) => (
                  <li key={i} className="flex justify-between gap-3 px-3 py-2">
                    <span className="truncate">{it.quantity > 1 ? `${it.quantity}× ` : ""}{it.name}</span>
                    <span className="tabular-nums text-muted-foreground">{money(it.total, draft?.currency ?? "HUF")}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="note">Megjegyzés</Label>
            <Textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Opcionális" />
          </div>

          <div className="flex gap-2 pt-1">
            {editing && (
              <Button type="button" variant="outline" size="icon" onClick={remove} disabled={busy} aria-label="Törlés">
                <Trash2 className="text-destructive" />
              </Button>
            )}
            <Button type="submit" className="flex-1" size="lg" disabled={!valid || busy}>
              {editing ? "Mentés" : "Rögzítés"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
