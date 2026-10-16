import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/**
 * The `.env` in the working directory (apps/api under `pnpm dev:api` and `pnpm start`), then the one in the
 * repository root, three levels above this file in src/ and in dist/ alike. Started from the root, they are one file.
 */
export function envFiles(cwd = process.cwd()): string[] {
  return [...new Set([resolve(cwd, ".env"), fileURLToPath(new URL("../../../.env", import.meta.url))])];
}

/**
 * Node reads a UTF-16 file (what Windows PowerShell 5's `>` writes) as no settings at all and says nothing, so it is
 * refused here instead. A UTF-8 byte order mark would become part of the first key's name, so it is dropped.
 */
export function readEnvFile(file: string): Record<string, string> {
  const buf = readFileSync(file);
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff) || buf.includes(0)) {
    throw new Error(`${file} is saved as UTF-16, so none of its settings can be read: save it as UTF-8`);
  }
  return parseEnv(buf.toString("utf8").replace(/^﻿/, "")) as Record<string, string>;
}

/**
 * Loads each file that exists, in order, and returns those it loaded. A variable already set is kept, so real
 * environment variables win over both files. Two files giving one setting different values is refused rather than
 * settled by their order: the losing value would otherwise be ignored without a word (an empty key in apps/api/.env
 * hiding the one in the root .env). Values are never printed, only the names.
 */
export function loadEnvFiles(files = envFiles(), env: NodeJS.ProcessEnv = process.env): string[] {
  const found = files.filter((f) => existsSync(f));
  const parsed = found.map((f) => ({ file: f, vars: readEnvFile(f) }));
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const a = parsed[i];
      const b = parsed[j];
      const clash = Object.keys(a.vars).filter((k) => k in b.vars && a.vars[k] !== b.vars[k] && env[k] === undefined);
      if (clash.length) {
        throw new Error(
          `${a.file} and ${b.file} both set ${clash.join(", ")}, to different values. Keep each setting in one file ` +
            `(to use only ${b.file}, delete ${a.file})`,
        );
      }
    }
  }
  for (const { vars } of parsed) {
    for (const [k, v] of Object.entries(vars)) if (env[k] === undefined) env[k] = v;
  }
  return found;
}
