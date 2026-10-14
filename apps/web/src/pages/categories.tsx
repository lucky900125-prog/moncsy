import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Category } from "@et/shared";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { CategoryBadgeIcon } from "@/components/category-dot";
import { useApp } from "@/store/app";
import { CATEGORY_COLORS, CategoryIcon, PICKABLE_ICONS } from "@/lib/icons";
import { money } from "@/lib/format";
import { BASE_CURRENCY, flowsByCategory, inMonth, splitByCurrency } from "@/lib/stats";
import { cn } from "@/lib/utils";

type Editing = { open: boolean; cat: Category | null };

export function CategoriesPage() {
  const { categories, transactions, addCategory, updateCategory, removeCategory } = useApp();
  const [editing, setEditing] = useState<Editing>({ open: false, cat: null });
  const [name, setName] = useState("");
  const [icon, setIcon] = useState(PICKABLE_ICONS[0]);
  const [color, setColor] = useState(CATEGORY_COLORS[0]);
  const [budget, setBudget] = useState("");

  // Budgets are in the base currency, so only that is summed; other currencies are counted and named instead.
  const month = useMemo(() => {
    const { base, other } = splitByCurrency(inMonth(transactions, new Date()));
    return { flows: flowsByCategory(base), foreign: other };
  }, [transactions]);

  function open(cat: Category | null) {
    setName(cat?.name ?? "");
    setIcon(cat?.icon ?? PICKABLE_ICONS[0]);
    setColor(cat?.color ?? CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length]);
    setBudget(cat?.budget ? String(cat.budget) : "");
    setEditing({ open: true, cat });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const b = budget.trim() ? Number(budget.replace(/\s/g, "")) : null;
    if (b !== null && !Number.isFinite(b)) return toast.error("A keret nem szám");
    const data = { name: name.trim(), icon, color, budget: b };
    try {
      if (editing.cat) await updateCategory(editing.cat.id, data);
      else await addCategory({ ...data, parentId: null });
      setEditing((s) => ({ ...s, open: false }));
    } catch (err) {
      toast.error("Mentés sikertelen", { description: (err as Error).message });
    }
  }

  async function remove() {
    if (!editing.cat) return;
    try {
      await removeCategory(editing.cat.id);
      setEditing((s) => ({ ...s, open: false }));
      toast("Kategória törölve, a tételei kategória nélkül maradtak");
    } catch (err) {
      toast.error("Törlés sikertelen", { description: (err as Error).message });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Kategóriák</h1>
          <p className="text-sm text-muted-foreground">Szerkeszd, adj keretet, vagy hozz létre sajátot.</p>
        </div>
        <Button onClick={() => open(null)}><Plus /> Új</Button>
      </div>

      {month.foreign.length > 0 && (
        <p className="-mt-2 text-xs text-muted-foreground">
          {month.foreign.length} tétel más pénznemben ({[...new Set(month.foreign.map((t) => t.currency))].join(", ")}) van ebben a hónapban, ezek nincsenek benne a {BASE_CURRENCY} összegekben.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((c) => {
          const { expense: s, income } = month.flows.get(c.id) ?? { expense: 0, income: 0 };
          return (
            <button key={c.id} onClick={() => open(c)} className="text-left">
              <Card className="flex h-full flex-col gap-3 p-4 transition-colors duration-200 hover:bg-muted/50">
                <div className="flex items-center gap-3">
                  <CategoryBadgeIcon category={c} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{c.name}</div>
                    <div className="text-xs tabular-nums text-muted-foreground">
                      {(s > 0 || income === 0) && money(s)}
                      {s > 0 && income > 0 && " · "}
                      {income > 0 && <span className="text-positive">{money(income, BASE_CURRENCY, { sign: true })}</span>} ebben a hónapban
                    </div>
                  </div>
                  {c.isCustom && <Badge>egyedi</Badge>}
                </div>
                {c.budget ? <Progress value={(s / c.budget) * 100} color={s > c.budget ? "var(--destructive)" : c.color} /> : null}
              </Card>
            </button>
          );
        })}
      </div>

      <Sheet open={editing.open} onOpenChange={(o) => setEditing((s) => ({ ...s, open: o }))}>
        <SheetContent title={editing.cat ? "Kategória szerkesztése" : "Új kategória"}>
          <form onSubmit={save} className="flex flex-col gap-5 pt-2">
            <div className="flex items-center gap-3">
              <CategoryBadgeIcon category={{ id: "", name, icon, color, isCustom: true }} size="lg" />
              <div className="grid flex-1 gap-1.5">
                <Label htmlFor="cat-name">Név</Label>
                <Input id="cat-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="pl. Kutya" required />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Ikon</Label>
              <div className="grid grid-cols-8 gap-1.5">
                {PICKABLE_ICONS.map((i) => (
                  <button
                    type="button"
                    key={i}
                    onClick={() => setIcon(i)}
                    aria-label={i}
                    className={cn(
                      "flex aspect-square items-center justify-center rounded-lg transition-colors duration-200",
                      icon === i ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted",
                    )}
                  >
                    <CategoryIcon name={i} className="size-4" />
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Szín</Label>
              <div className="flex flex-wrap gap-2">
                {CATEGORY_COLORS.map((c) => (
                  <button
                    type="button"
                    key={c}
                    onClick={() => setColor(c)}
                    aria-label={c}
                    className={cn("size-7 rounded-full ring-offset-2 ring-offset-popover transition-shadow duration-200", color === c && "ring-2 ring-foreground/40")}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="cat-budget">Havi keret (HUF, opcionális)</Label>
              <Input id="cat-budget" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="pl. 30000" />
            </div>
            <div className="flex gap-2">
              {editing.cat?.isCustom && (
                <Button type="button" variant="outline" size="icon" onClick={remove} aria-label="Törlés">
                  <Trash2 className="text-destructive" />
                </Button>
              )}
              <Button type="submit" className="flex-1" size="lg" disabled={!name.trim()}>Mentés</Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  );
}
