import {
  ShoppingCart, UtensilsCrossed, Coffee, Bus, Car, Fuel, Home, Zap, Wifi, Film, Gamepad2, Music,
  HeartPulse, Pill, Shirt, Plane, Repeat, Package, Wallet, Gift, GraduationCap, PawPrint, Baby,
  Dumbbell, Smartphone, CircleEllipsis, Wrench, Briefcase, Landmark, Sparkles, BookOpen, Beer, Circle, Train, ShoppingBag,
  type LucideIcon,
} from "lucide-react";
import { CATEGORY_ICON_NAMES, resolveCategoryIcon, type CategoryIconName } from "@et/shared";

/** Every CATEGORY_ICON_NAMES entry must have a component here; the Record type makes a missing one a compile error. */
const ICONS: Record<CategoryIconName, LucideIcon> = {
  "shopping-cart": ShoppingCart,
  "shopping-bag": ShoppingBag,
  "utensils-crossed": UtensilsCrossed,
  coffee: Coffee,
  bus: Bus,
  train: Train,
  car: Car,
  fuel: Fuel,
  home: Home,
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

export const PICKABLE_ICONS: readonly string[] = CATEGORY_ICON_NAMES;

export function CategoryIcon({ name, className }: { name: string; className?: string }) {
  const resolved = resolveCategoryIcon(name);
  const Icon = resolved ? ICONS[resolved] : Circle;
  return <Icon className={className} />;
}

export const CATEGORY_COLORS = [
  "#7c9a7e", "#8aa6b8", "#c9a66b", "#b88a8a", "#9d8fb5", "#7fa8a3",
  "#c4956c", "#a3a86b", "#8f9bb3", "#b5899f", "#94a3a8", "#6f8f73",
];
