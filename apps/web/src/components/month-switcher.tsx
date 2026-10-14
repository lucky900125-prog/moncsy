import { ChevronLeft, ChevronRight } from "lucide-react";
import { isSameMonth } from "date-fns";
import { Button } from "@/components/ui/button";
import { monthLabel } from "@/lib/format";
import { nextMonth, prevMonth } from "@/lib/period";

export function MonthSwitcher({ value, onChange }: { value: Date; onChange: (d: Date) => void }) {
  const atCurrent = isSameMonth(value, new Date());
  return (
    <div className="flex items-center gap-1 rounded-lg border bg-card p-0.5">
      <Button variant="ghost" size="icon-sm" onClick={() => onChange(prevMonth(value))} aria-label="Előző hónap">
        <ChevronLeft />
      </Button>
      <span key={value.toISOString()} className="min-w-32 animate-fade-in text-center text-sm font-medium">
        {monthLabel(value)}
      </span>
      <Button variant="ghost" size="icon-sm" disabled={atCurrent} onClick={() => onChange(nextMonth(value))} aria-label="Következő hónap">
        <ChevronRight />
      </Button>
    </div>
  );
}
