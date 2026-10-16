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
    writeFileSync(root, "# local settings\nMONCSY_T_BOTH=from-api\nMONCSY_T_ROOT=from-root\n");
    process.env.MONCSY_T_REAL = "real";
    expect(loadEnvFiles([join(dir, "missing.env"), api, root])).toEqual([api, root]);
    expect(KEYS.map((k) => process.env[k])).toEqual(["real", "from-api", "from-root"]);
  });

  it("refuse to start when two files give one setting different values, naming the setting and not the values", () => {
    dir = mkdtempSync(join(tmpdir(), "moncsy-env-"));
    const api = join(dir, "api.env");
    const root = join(dir, "root.env");
    // apps/api/.env copied from its example, the key filled in only in the root .env.
    writeFileSync(api, "MONCSY_T_BOTH=mock\nMONCSY_T_ROOT=\nMONCSY_T_REAL=same\n");
    writeFileSync(root, "MONCSY_T_BOTH=anthropic\nMONCSY_T_ROOT=secret-value\nMONCSY_T_REAL=same\n");
    let message = "";
    try {
      loadEnvFiles([api, root], {});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe(
      `${api} and ${root} both set MONCSY_T_BOTH, MONCSY_T_ROOT, to different values. Keep each setting in one file (to use only ${root}, delete ${api})`,
    );
    expect(message).not.toContain("secret-value");
    // A real environment variable decides it, so the files do not disagree about anything that is used.
    const env: NodeJS.ProcessEnv = { MONCSY_T_BOTH: "real", MONCSY_T_ROOT: "real" };
    expect(loadEnvFiles([api, root], env)).toEqual([api, root]);
    expect(env).toEqual({ MONCSY_T_BOTH: "real", MONCSY_T_ROOT: "real", MONCSY_T_REAL: "same" });
  });

  it("refuse a UTF-16 file, which Node would read as no settings at all, and read past a UTF-8 byte order mark", () => {
    dir = mkdtempSync(join(tmpdir(), "moncsy-env-"));
    const utf16 = join(dir, "utf16.env");
    writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("MONCSY_T_ROOT=x\r\n", "utf16le")]));
    expect(() => loadEnvFiles([utf16], {})).toThrow(`${utf16} is saved as UTF-16, so none of its settings can be read: save it as UTF-8`);
    const bom = join(dir, "bom.env");
    writeFileSync(bom, "\uFEFFMONCSY_T_ROOT=x\r\n");
    const env: NodeJS.ProcessEnv = {};
    loadEnvFiles([bom], env);
    expect(env).toEqual({ MONCSY_T_ROOT: "x" });
  });
});
