import { cn } from "@/lib/utils";

export function Progress({ value, color, className }: { value: number; color?: string; className?: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div
        className="h-full rounded-full transition-[width] duration-700 ease-[var(--ease-calm)]"
        style={{ width: `${v}%`, background: color ?? "var(--primary)" }}
      />
    </div>
  );
}
