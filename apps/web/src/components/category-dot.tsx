import type { Category } from "@et/shared";
import { CategoryIcon } from "@/lib/icons";
import { cn } from "@/lib/utils";

export function CategoryBadgeIcon({ category, size = "md" }: { category?: Category | null; size?: "sm" | "md" | "lg" }) {
  const color = category?.color ?? "#94a3a8";
  const dims = { sm: "size-7 rounded-lg [&_svg]:size-3.5", md: "size-9 rounded-xl [&_svg]:size-4", lg: "size-11 rounded-xl [&_svg]:size-5" }[size];
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center", dims)}
      style={{ background: `color-mix(in oklab, ${color} 16%, transparent)`, color }}
    >
      <CategoryIcon name={category?.icon ?? "package"} />
    </span>
  );
}
