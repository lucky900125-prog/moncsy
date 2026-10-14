import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

// BASE_PATH lets the same build run at a sub-path, e.g. GitHub Pages: BASE_PATH=/moncsy/
const base = process.env.BASE_PATH ?? "/";

// PWA_SERVICE_WORKER=off ships a worker that unregisters itself and empties the origin's caches, so the worker of an
// earlier build goes away too. The Pages build uses it: <account>.github.io is shared by every Pages site of the
// account, any of them can rewrite this app's cached files, and the worker would serve them on every start. On an
// origin of its own (a custom domain) leave it "on" for the offline-capable worker.
const serviceWorker = process.env.PWA_SERVICE_WORKER ?? "on";
if (serviceWorker !== "on" && serviceWorker !== "off") {
  throw new Error(`PWA_SERVICE_WORKER must be "on" or "off", got "${serviceWorker}"`);
}

export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      selfDestroying: serviceWorker === "off",
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "moncsy – kiadáskövető",
        short_name: "moncsy",
        description: "Letisztult kiadáskövető blokkbeolvasással és AI elemzéssel",
        theme_color: "#f6f5f1",
        background_color: "#f6f5f1",
        display: "standalone",
        start_url: base,
        scope: base,
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
        ],
      },
    }),
  ],
  // One React for the whole bundle: the workspace also holds the Expo app, which pins its own React.
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") }, dedupe: ["react", "react-dom"] },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8787" },
  },
});
