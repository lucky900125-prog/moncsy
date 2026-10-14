import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { LayoutGrid, ListOrdered, ScanLine, Sparkles, Settings2, Tags, Plus, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TransactionSheet } from "./transaction-sheet";
import { useApp } from "@/store/app";
import { useUi } from "@/store/ui";
import { cn } from "@/lib/utils";

const NAV: { to: string; label: string; icon: LucideIcon }[] = [
  { to: "/", label: "Áttekintés", icon: LayoutGrid },
  { to: "/tetelek", label: "Tételek", icon: ListOrdered },
  { to: "/blokk", label: "Blokk", icon: ScanLine },
  { to: "/elemzes", label: "Elemzés", icon: Sparkles },
  { to: "/kategoriak", label: "Kategóriák", icon: Tags },
  { to: "/beallitasok", label: "Beállítások", icon: Settings2 },
];

const MOBILE_NAV = ["/", "/tetelek", "/blokk", "/elemzes", "/beallitasok"];

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" className="size-8 rounded-lg" />
      <span className="text-[15px] font-semibold tracking-tight">moncsy</span>
    </div>
  );
}

function ModeBadge() {
  const mode = useApp((s) => s.backend?.mode);
  if (mode !== "demo") return null;
  return (
    <NavLink
      to="/beallitasok"
      className="rounded-full bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300"
      title="Az API nem elérhető, a böngészőben tárolt demó adatokkal fut"
    >
      Demó mód
    </NavLink>
  );
}

export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const openTx = useUi((s) => s.openTx);

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[240px_1fr]">
      {/* Desktop sidebar */}
      <div className="hidden border-r bg-sidebar md:block">
      <aside className="sticky top-0 flex h-dvh flex-col gap-6 p-4">
        <Logo />
        <Button onClick={() => openTx()} className="justify-start">
          <Plus /> Új tétel
        </Button>
        <nav className="flex flex-col gap-0.5">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-200",
                  isActive ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto px-2">
          <ModeBadge />
        </div>
      </aside>
      </div>

      <div className="flex min-w-0 flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/80 px-4 py-3 backdrop-blur-md md:hidden">
          <Logo />
          <div className="flex items-center gap-2">
            <ModeBadge />
            <Button size="icon-sm" variant="ghost" onClick={() => navigate("/kategoriak")} aria-label="Kategóriák">
              <Tags />
            </Button>
          </div>
        </header>

        <main key={location.pathname} className="mx-auto w-full max-w-5xl flex-1 animate-rise-in px-4 pb-28 pt-5 md:px-8 md:pb-10 md:pt-8">
          <Outlet />
        </main>
      </div>

      {/* Mobile FAB */}
      <Button
        onClick={() => openTx()}
        size="icon"
        hidden={location.pathname === "/blokk"}
        className="fixed bottom-24 right-4 z-30 size-12 rounded-full shadow-lg md:hidden"
        aria-label="Új tétel"
      >
        <Plus className="!size-5" />
      </Button>

      {/* Mobile tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/85 pb-safe backdrop-blur-md md:hidden">
        <div className="grid grid-cols-5">
          {NAV.filter((n) => MOBILE_NAV.includes(n.to)).map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex flex-col items-center gap-1 py-2.5 text-[10px] transition-colors duration-200",
                  isActive ? "text-primary" : "text-muted-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className={cn("rounded-full px-4 py-1 transition-colors duration-300", isActive && "bg-accent")}>
                    <Icon className="size-[18px]" />
                  </span>
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>

      <TransactionSheet />
    </div>
  );
}
