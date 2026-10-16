import { loadEnvFiles } from "./env-files.js";

// Same settings as the server: ./.env, then the repository root's .env, real environment variables first.
loadEnvFiles();

const { loadBackupConfig, verifyBackup } = await import("./backup.js");

// Exit codes: 0 the copy is sound, 1 a problem was found, 2 the check could not run (settings, network, GitHub).
try {
  const cfg = loadBackupConfig();
  if (!cfg) throw new Error("no backup is configured: set BACKUP_GITHUB_REPO, BACKUP_GITHUB_TOKEN (or _FILE) and BACKUP_KEY (or _FILE)");
  const { ok, lines } = await verifyBackup(cfg);
  for (const line of lines) console.log(line);
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  console.error(`backup check did not run: ${(err as Error).message}`);
  process.exitCode = 2;
}
