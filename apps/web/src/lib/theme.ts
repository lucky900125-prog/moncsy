export type Theme = "light" | "dark" | "system";

export function getTheme(): Theme {
  try {
    return (localStorage.getItem("kassza-theme") as Theme) || "system";
  } catch {
    return "system";
  }
}

/** Switches theme with a short color cross-fade instead of a hard flip. */
export function setTheme(t: Theme) {
  try {
    localStorage.setItem("kassza-theme", t);
  } catch { /* storage blocked: theme still applies for this session */ }
  const root = document.documentElement;
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.add("theme-transition");
  root.classList.toggle("dark", dark);
  window.setTimeout(() => root.classList.remove("theme-transition"), 300);
}
