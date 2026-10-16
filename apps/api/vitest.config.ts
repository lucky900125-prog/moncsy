import { defineConfig } from "vitest/config";

// --max-old-space-size (some CI runners and cloud shells put one in NODE_OPTIONS) is process-wide and overrides the
// heap limit of the thread that reads uploaded XLSX files, so the reader refuses every workbook (src/io/xlsx-worker.ts).
// Production sets none; the test processes are started the same way.
process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS ?? "").replace(/--max-old-space-size=\S+/g, "").trim();

// Tests never reach a real AI service, whatever the shell running them has set, and buildApp() reads its defaults
// from the environment, which has to name a provider (src/config.ts).
for (const k of ["AI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete process.env[k];
process.env.AI_PROVIDER = "mock";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
  },
});
