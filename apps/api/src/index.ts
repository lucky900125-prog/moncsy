import { loadEnvFiles } from "./env-files.js";

// ./.env, then the repository root's .env, when present; real environment variables take precedence.
const envLoaded = loadEnvFiles();

const { buildApp } = await import("./app.js");
const { assertSafeExposure, loadConfig } = await import("./config.js");
const { loadBackupConfig, restoreIfMissing } = await import("./backup.js");

// Everything that can refuse to start runs before the database is opened, so a failed restore never
// starts an empty database that the next backup would then upload over the good copy.
let startup: { warning: string | null; restored: string | null };
let backup: ReturnType<typeof loadBackupConfig>;
try {
  const config = loadConfig();
  const warning = assertSafeExposure(config);
  backup = loadBackupConfig();
  const restored = backup ? await restoreIfMissing(config.dbPath, backup) : null;
  startup = { warning, restored };
} catch (err) {
  console.error(`moncsy API did not start: ${(err as Error).message}`);
  process.exit(1);
}

const app = await buildApp({ logger: true, backup });
const { port, host } = app.deps.config;
app.log.info(envLoaded.length ? `settings read from ${envLoaded.join(", ")}` : "no .env file; settings from the environment only");
if (startup.warning) app.log.warn(startup.warning);
if (startup.restored) app.log.info(`backup: ${startup.restored}`);
try {
  await app.listen({ port, host });
  app.log.info(`AI provider: ${app.deps.ai.name} (${app.deps.ai.model}); Revolut mode: ${app.deps.revolut.mode}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    // close() flushes a pending backup first.
    void app.close().then(() => process.exit(0));
  });
}
