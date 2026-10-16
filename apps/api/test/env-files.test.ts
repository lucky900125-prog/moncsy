import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { envFiles, loadEnvFiles } from "../src/env-files.js";

const KEYS = ["MONCSY_T_REAL", "MONCSY_T_BOTH", "MONCSY_T_ROOT"];
let dir: string | null = null;

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe(".env files", () => {
  it("are the working directory's .env, then the repository root's", () => {
    // vitest runs in apps/api, as `pnpm dev:api` and `pnpm start` do.
    expect(envFiles()).toEqual([resolve(".env"), resolve("../../.env")]);
    // Started from the repository root, both are the same file, read once.
    expect(envFiles(resolve("../.."))).toEqual([resolve("../../.env")]);
  });

  it("are loaded in order, a variable already set winning, and a missing one skipped", () => {
    dir = mkdtempSync(join(tmpdir(), "moncsy-env-"));
    const api = join(dir, "api.env");
    const root = join(dir, "root.env");
    writeFileSync(api, "MONCSY_T_REAL=from-api\nMONCSY_T_BOTH=from-api\n");
    writeFileSync(root, "# local settings\nMONCSY_T_BOTH=from-root\nMONCSY_T_ROOT=from-root\n");
    process.env.MONCSY_T_REAL = "real";
    expect(loadEnvFiles([join(dir, "missing.env"), api, root])).toEqual([api, root]);
    expect(KEYS.map((k) => process.env[k])).toEqual(["real", "from-api", "from-root"]);
  });
});
