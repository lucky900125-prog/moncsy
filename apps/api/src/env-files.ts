import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The `.env` in the working directory (apps/api under `pnpm dev:api` and `pnpm start`), then the one in the
 * repository root, three levels above this file in src/ and in dist/ alike. Started from the root, they are one file.
 */
export function envFiles(cwd = process.cwd()): string[] {
  return [...new Set([resolve(cwd, ".env"), fileURLToPath(new URL("../../../.env", import.meta.url))])];
}

/**
 * Loads each file that exists, in order, and returns those it loaded. A variable already set is kept (Node's
 * process.loadEnvFile), so real environment variables win over both files and the first file over the second.
 */
export function loadEnvFiles(files = envFiles()): string[] {
  const found = files.filter((f) => existsSync(f));
  for (const f of found) process.loadEnvFile(f);
  return found;
}
