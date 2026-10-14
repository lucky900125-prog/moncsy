/** @type {import('tailwindcss').Config} */
// Same calm palette as apps/web (hex approximations of its oklch tokens).
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: "#f7f6f2", dark: "#1a1b1f" },
        card: { DEFAULT: "#fdfcfa", dark: "#212226" },
        fg: { DEFAULT: "#2a2d33", dark: "#e9e8e3" },
        muted: { DEFAULT: "#efeee9", dark: "#2a2b30" },
        "muted-fg": { DEFAULT: "#6b7079", dark: "#9a9da5" },
        primary: { DEFAULT: "#3f5b4a", dark: "#9cc3a8" },
        "primary-fg": { DEFAULT: "#f7f6f2", dark: "#1c2a21" },
        accent: { DEFAULT: "#e2ebe3", dark: "#2e3a31" },
        line: { DEFAULT: "#e6e4de", dark: "#33343a" },
        positive: { DEFAULT: "#4f8a5f", dark: "#8fc39f" },
        danger: { DEFAULT: "#b5534a", dark: "#e08a80" },
      },
    },
  },
  plugins: [],
};
