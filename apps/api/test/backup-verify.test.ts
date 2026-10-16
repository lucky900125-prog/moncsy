import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { MockProvider } from "../src/ai/index.js";
import { encryptBlob, restoreIfMissing, verifyBackup, type BackupConfig } from "../src/backup.js";
import { loadConfig } from "../src/config.js";
import { fakeGithub } from "./fake-github.js";

const key = randomBytes(32);
const cfg: BackupConfig = { repo: "me/moncsy-data", token: "gh-token", path: "moncsy.db.enc", key, debounceMs: 5 };
let dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "moncsy-bkv-"));
  dirs.push(d);
  return d;
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** A SQLite file built by fn, as bytes. */
function sqliteBytes(fn: (db: DatabaseSync) => void): Buffer {
  const path = join(tempDir(), "x.db");
  const db = new DatabaseSync(path);
  fn(db);
  db.close();
  return readFileSync(path);
}

/** A database whose index no longer matches its table: SQLite opens it, and integrity_check names the damage. */
function damagedDb(): Buffer {
  let root = 0;
  const buf = sqliteBytes((db) => {
    db.exec("CREATE TABLE t(x TEXT); CREATE INDEX tx ON t(x); INSERT INTO t VALUES ('apple'), ('banana'), ('cherry');");
    root = (db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'tx'").get() as { rootpage: number }).rootpage;
  });
  const page = buf.subarray((root - 1) * 4096, root * 4096);
  page.write("zzzzzz", page.indexOf(Buffer.from("banana")), "latin1");
  return buf;
}

/** A database of several pages cut after the first one, as a partial write would leave it. */
const truncatedDb = () =>
  sqliteBytes((db) => {
    db.exec("CREATE TABLE t(x TEXT)");
    const ins = db.prepare("INSERT INTO t VALUES (?)");
    for (let i = 0; i < 300; i++) ins.run(`row ${i} `.repeat(10));
  }).subarray(0, 4096);

/** Puts data on the fake remote as backup generation `generation`, the way an upload would. */
function putRemote(gh: ReturnType<typeof fakeGithub>, data: Buffer, generation: number) {
  gh.state.content = encryptBlob(data, key, generation);
  gh.state.sha = `sha-g${generation}`;
  gh.state.commits.push(`backup ${generation} 2026-10-14T12:00:00.000Z`);
}

/** A real backup made by the server: one transaction, uploaded as generation 1. */
async function seed(gh: ReturnType<typeof fakeGithub>) {
  vi.stubGlobal("fetch", gh.fetchImpl);
  const app = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({ AI_PROVIDER: "mock" }), dbPath: join(tempDir(), "expense.db") } });
  const r = await app.inject({ method: "POST", url: "/api/transactions", payload: { amount: -4785, currency: "HUF", date: "2026-10-12", merchant: "Spar" } });
  expect(r.statusCode).toBe(201);
  await app.close();
  expect(gh.state.puts).toBe(1);
}

const verifyTemps = () => readdirSync(tmpdir()).filter((n) => n.startsWith("moncsy-verify-"));

describe("restore checks the copy before starting from it", () => {
  it.each([
    ["an index that does not match its table", damagedDb, /integrity_check: row 2 missing from index tx/],
    ["a database cut short", truncatedDb, /database disk image is malformed/],
    ["bytes that are not a database", () => Buffer.from("not a database ".repeat(300)), /file is not a database/],
  ])("refuses %s, and leaves no file behind", async (_what, make, why) => {
    const gh = fakeGithub();
    vi.stubGlobal("fetch", gh.fetchImpl);
    putRemote(gh, make(), 3);
    const dbPath = join(tempDir(), "data", "expense.db");
    const err = (await restoreIfMissing(dbPath, cfg).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^me\/moncsy-data\/moncsy\.db\.enc generation 3 decrypted, but it is not a sound database/);
    expect(err.message).toMatch(why);
    expect(err.message).toMatch(/restore an earlier generation from the repository history/);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}.restoring`)).toBe(false);
  });
});

describe("verifyBackup: a read-only check of the copy the next start would restore", () => {
  it("reports a sound copy with its generation and row counts, and only reads", async () => {
    const gh = fakeGithub();
    await seed(gh);
    const methods: string[] = [];
    vi.stubGlobal("fetch", ((url: string, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return gh.fetchImpl(url, init);
    }) as typeof fetch);
    const before = verifyTemps();

    const r = await verifyBackup(cfg);
    const text = r.lines.join("\n");
    expect(r.ok).toBe(true);
    expect(text).toMatch(/^copy: me\/moncsy-data\/moncsy\.db\.enc, generation 1, \d+ bytes$/m);
    expect(text).toMatch(/^history: 1 commit\(s\), highest generation 1$/m);
    expect(text).toMatch(/^decrypt: ok$/m);
    expect(text).toMatch(/^integrity_check: ok$/m);
    expect(text).toMatch(/^made: 20\d\d-\d\d-\d\dT[\d:.]+Z, recorded generation 1$/m);
    expect(text).toMatch(/^rows: .*\btransactions 1\b/m);
    expect(r.lines.at(-1)).toBe("OK: the next start would restore generation 1 from this copy.");
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((m) => m === "GET")).toBe(true);
    expect(gh.state.puts).toBe(1);
    expect(verifyTemps()).toEqual(before);
  });

  it.each([
    ["a damaged database", (gh: ReturnType<typeof fakeGithub>) => putRemote(gh, damagedDb(), 1), cfg, /^PROBLEM: integrity_check: row 2 missing from index tx/m],
    ["a copy this key cannot open", (gh: ReturnType<typeof fakeGithub>) => putRemote(gh, damagedDb(), 1), { ...cfg, key: randomBytes(32) }, /^PROBLEM: .*wrong BACKUP_KEY or a damaged file/m],
    [
      "a copy older than its history",
      (gh: ReturnType<typeof fakeGithub>) => {
        putRemote(gh, damagedDb(), 1);
        gh.state.commits.push("backup 2 2026-10-14T13:00:00.000Z");
      },
      cfg,
      /^PROBLEM: the file holds generation 1, but generation 2 was written later: the copy was rolled back/m,
    ],
    [
      "a copy that does not record its own generation",
      (gh: ReturnType<typeof fakeGithub>) => putRemote(gh, sqliteBytes((db) => db.exec("CREATE TABLE t(x)")), 1),
      cfg,
      /^PROBLEM: the copy does not record which generation it is/m,
    ],
    ["no backup at all", () => undefined, cfg, /^PROBLEM: there is no backup at me\/moncsy-data\/moncsy\.db\.enc yet$/m],
    [
      "a deleted backup file",
      (gh: ReturnType<typeof fakeGithub>) => gh.state.commits.push("backup 1 2026-10-14T12:00:00.000Z"),
      cfg,
      /^PROBLEM: me\/moncsy-data\/moncsy\.db\.enc is gone, but its history has 1 commit\(s\), up to generation 1/m,
    ],
  ])("finds %s", async (_what, arrange, config, problem) => {
    const gh = fakeGithub();
    arrange(gh);
    vi.stubGlobal("fetch", gh.fetchImpl);
    const before = verifyTemps();
    const r = await verifyBackup(config);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(problem);
    expect(r.lines.at(-1)).toMatch(/^NOT OK: \d+ problem\(s\) above\.$/);
    expect(verifyTemps()).toEqual(before);
  });

  it("throws, rather than reporting a problem, when GitHub cannot be read", async () => {
    vi.stubGlobal("fetch", fakeGithub({ failReads: 1 }).fetchImpl);
    await expect(verifyBackup(cfg)).rejects.toThrow(/GitHub 502/);
  });
});

describe("the verify command", () => {
  // Run from an empty directory, so a developer's .env with real backup secrets is never picked up.
  const run = (env: Record<string, string>) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BACKUP_|REQUIRE_BACKUP)/.test(k)));
    return spawnSync(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, join(import.meta.dirname, "../src/verify-backup.ts")], {
      cwd: tempDir(),
      env: { ...clean, ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
  };

  it("exits 2 with the reason when it cannot run, before any request", () => {
    const none = run({});
    expect(none.stderr).toMatch(/^backup check did not run: no backup is configured/m);
    expect(none.status).toBe(2);
    const badKey = run({ BACKUP_GITHUB_REPO: "me/moncsy-data", BACKUP_GITHUB_TOKEN: "gh-token", BACKUP_KEY: "c2hvcnQ=" });
    expect(badKey.stderr).toMatch(/^backup check did not run: BACKUP_KEY must be 32 random bytes/m);
    expect(badKey.status).toBe(2);
  });
});
