import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

// BASE_PATH lets the same build run at a sub-path, e.g. GitHub Pages: BASE_PATH=/moncsy/
const base = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
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
