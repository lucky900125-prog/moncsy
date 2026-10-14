import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View, useColorScheme, type PressableProps } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Category } from "@et/shared";
import {
  Baby, BookOpen, CircleEllipsis, Beer, Briefcase, Bus, Car, Circle, Coffee, Dumbbell, Film, Fuel, Gamepad2, Gift, GraduationCap, HeartPulse,
  Home, Landmark, Music, Package, PawPrint, Pill, Plane, Repeat, Shirt, ShoppingBag, ShoppingCart, Smartphone, Sparkles,
  Train, UtensilsCrossed, Wallet, Wifi, Wrench, Zap, type LucideIcon,
} from "lucide-react-native";

export function useTheme() {
  const dark = useColorScheme() === "dark";
  return {
    dark,
    fg: dark ? "#e9e8e3" : "#2a2d33",
    muted: dark ? "#9a9da5" : "#6b7079",
    primary: dark ? "#9cc3a8" : "#3f5b4a",
    primaryFg: dark ? "#1c2a21" : "#f7f6f2",
  };
}

export function Screen({ title, subtitle, children, right }: { title: string; subtitle?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <SafeAreaView edges={["top"]} className="flex-1 bg-bg dark:bg-bg-dark">
      <ScrollView contentContainerClassName="gap-4 px-4 pb-10 pt-2">
        <View className="flex-row items-end justify-between">
          <View className="flex-1">
            <Text className="text-2xl font-semibold text-fg dark:text-fg-dark">{title}</Text>
            {subtitle ? <Text className="text-sm text-muted-fg dark:text-muted-fg-dark">{subtitle}</Text> : null}
          </View>
          {right}
        </View>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <View className={`rounded-2xl border border-line bg-card p-4 dark:border-line-dark dark:bg-card-dark ${className}`}>{children}</View>;
}

export function Label({ children }: { children: ReactNode }) {
  return <Text className="text-xs font-medium text-muted-fg dark:text-muted-fg-dark">{children}</Text>;
}

export function Button({ title, variant = "primary", loading, className = "", ...props }: PressableProps & { title: string; variant?: "primary" | "outline"; loading?: boolean; className?: string }) {
  const t = useTheme();
  const primary = variant === "primary";
  return (
    <Pressable
      {...props}
      disabled={props.disabled || loading}
      className={`h-12 flex-row items-center justify-center rounded-xl px-5 active:opacity-80 ${
        primary ? "bg-primary dark:bg-primary-dark" : "border border-line bg-card dark:border-line-dark dark:bg-card-dark"
      } ${props.disabled ? "opacity-50" : ""} ${className}`}
    >
      {loading ? (
        <ActivityIndicator color={primary ? t.primaryFg : t.fg} />
      ) : (
        <Text className={`font-medium ${primary ? "text-primary-fg dark:text-primary-fg-dark" : "text-fg dark:text-fg-dark"}`}>{title}</Text>
      )}
    </Pressable>
  );
}

export function ErrorCard({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card className="gap-3">
      <Text className="font-medium text-danger dark:text-danger-dark">Nem sikerült</Text>
      <Text className="text-sm text-muted-fg dark:text-muted-fg-dark">{message}</Text>
      {onRetry ? <Button title="Újra" variant="outline" onPress={onRetry} /> : null}
    </Card>
  );
}

const ICONS: Record<string, LucideIcon> = {
  "shopping-cart": ShoppingCart, "shopping-bag": ShoppingBag, "utensils-crossed": UtensilsCrossed, utensils: UtensilsCrossed,
  coffee: Coffee, bus: Bus, train: Train, car: Car, fuel: Fuel, home: Home, house: Home, zap: Zap, wifi: Wifi, film: Film,
  "gamepad-2": Gamepad2, music: Music, "heart-pulse": HeartPulse, pill: Pill, shirt: Shirt, plane: Plane, repeat: Repeat,
  package: Package, wallet: Wallet, gift: Gift, "graduation-cap": GraduationCap, "paw-print": PawPrint, baby: Baby,
  dumbbell: Dumbbell, smartphone: Smartphone, wrench: Wrench, briefcase: Briefcase, landmark: Landmark, sparkles: Sparkles,
  "book-open": BookOpen, beer: Beer, "circle-ellipsis": CircleEllipsis,
};

export function CategoryBadge({ category, size = 36 }: { category?: Category | null; size?: number }) {
  const Icon = ICONS[category?.icon ?? "package"] ?? Circle;
  const color = category?.color ?? "#94a3a8";
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.32, backgroundColor: `${color}29`, alignItems: "center", justifyContent: "center" }}>
      <Icon size={size * 0.46} color={color} />
    </View>
  );
}
