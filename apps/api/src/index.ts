import { existsSync } from "node:fs";

// Load ./.env when present (Node 22 built-in; real environment variables take precedence).
if (existsSync(".env")) process.loadEnvFile(".env");

const { buildApp } = await import("./app.js");

const app = await buildApp({ logger: true });
const { port, host } = app.deps.config;
try {
  await app.listen({ port, host });
  app.log.info(`AI provider: ${app.deps.ai.name} (${app.deps.ai.model}); Revolut mode: ${app.deps.revolut.mode}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
