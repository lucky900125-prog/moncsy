import {
  ShoppingCart, UtensilsCrossed, Coffee, Bus, Car, Fuel, Home, Zap, Wifi, Film, Gamepad2, Music,
  HeartPulse, Pill, Shirt, Plane, Repeat, Package, Wallet, Gift, GraduationCap, PawPrint, Baby,
  Dumbbell, Smartphone, CircleEllipsis, Wrench, Briefcase, Landmark, Sparkles, BookOpen, Beer, Circle, Train, ShoppingBag,
  type LucideIcon,
} from "lucide-react";

/** Curated icon set for categories; keys are lucide kebab-case names (stored in Category.icon). */
export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  "shopping-cart": ShoppingCart,
  "shopping-bag": ShoppingBag,
  "utensils-crossed": UtensilsCrossed,
  utensils: UtensilsCrossed,
  coffee: Coffee,
  bus: Bus,
  train: Train,
  car: Car,
  fuel: Fuel,
  home: Home,
  house: Home,
  zap: Zap,
  wifi: Wifi,
  film: Film,
  "gamepad-2": Gamepad2,
  music: Music,
  "heart-pulse": HeartPulse,
  pill: Pill,
  shirt: Shirt,
  plane: Plane,
  repeat: Repeat,
  package: Package,
  wallet: Wallet,
  gift: Gift,
  "graduation-cap": GraduationCap,
  "paw-print": PawPrint,
  baby: Baby,
  dumbbell: Dumbbell,
  smartphone: Smartphone,
  wrench: Wrench,
  briefcase: Briefcase,
  landmark: Landmark,
  sparkles: Sparkles,
  "book-open": BookOpen,
  beer: Beer,
  "circle-ellipsis": CircleEllipsis,
};

export const PICKABLE_ICONS = Object.keys(CATEGORY_ICONS).filter((k) => !["utensils", "house"].includes(k));

export function CategoryIcon({ name, className }: { name: string; className?: string }) {
  const Icon = CATEGORY_ICONS[name] ?? Circle;
  return <Icon className={className} />;
}

export const CATEGORY_COLORS = [
  "#7c9a7e", "#8aa6b8", "#c9a66b", "#b88a8a", "#9d8fb5", "#7fa8a3",
  "#c4956c", "#a3a86b", "#8f9bb3", "#b5899f", "#94a3a8", "#6f8f73",
];
