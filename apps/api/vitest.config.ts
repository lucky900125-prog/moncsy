import { defineConfig } from "vitest/config";

// --max-old-space-size (some CI runners and cloud shells put one in NODE_OPTIONS) is process-wide and overrides the
// heap limit of the thread that reads uploaded XLSX files, so the reader refuses every workbook (src/io/xlsx-worker.ts).
// Production sets none; the test processes are started the same way.
process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS ?? "").replace(/--max-old-space-size=\S+/g, "").trim();

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
  },
});
