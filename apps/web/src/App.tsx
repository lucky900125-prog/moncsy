import { useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { Layout } from "@/components/layout";
import { DashboardPage } from "@/pages/dashboard";
import { TransactionsPage } from "@/pages/transactions";
import { ScanPage } from "@/pages/scan";
import { InsightsPage } from "@/pages/insights";
import { CategoriesPage } from "@/pages/categories";
import { SettingsPage } from "@/pages/settings";
import { useApp } from "@/store/app";

export default function App() {
  const init = useApp((s) => s.init);
  useEffect(() => {
    init();
  }, [init]);

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="tetelek" element={<TransactionsPage />} />
          <Route path="blokk" element={<ScanPage />} />
          <Route path="elemzes" element={<InsightsPage />} />
          <Route path="kategoriak" element={<CategoriesPage />} />
          <Route path="beallitasok" element={<SettingsPage />} />
        </Route>
      </Routes>
      <Toaster
        position="top-center"
        toastOptions={{
          className: "!bg-popover !text-popover-foreground !border-border !rounded-xl !shadow-lg",
          duration: 3200,
        }}
      />
    </BrowserRouter>
  );
}
