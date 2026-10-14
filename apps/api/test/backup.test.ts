import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { MockProvider } from "../src/ai/index.js";
import { decryptBlob, encryptBlob, loadBackupConfig, restoreIfMissing, type BackupConfig } from "../src/backup.js";
import { loadConfig } from "../src/config.js";
import { testApp } from "./helpers.js";

/** Just enough of the GitHub contents API for one file. */
function fakeGithub(opts: { failReads?: number } = {}) {
  const state = { content: null as Buffer | null, sha: null as string | null, puts: 0, failReads: opts.failReads ?? 0 };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer gh-token");
    expect(url).toBe("https://api.github.com/repos/me/moncsy-data/contents/moncsy.db.enc");
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { content: string; sha?: string };
      if (state.sha && body.sha !== state.sha) return new Response("sha mismatch", { status: 409 });
      state.content = Buffer.from(body.content, "base64");
      state.sha = `sha${++state.puts}`;
      return Response.json({ content: { sha: state.sha } }, { status: 201 });
    }
    if (state.failReads > 0) {
      state.failReads--;
      return new Response("boom", { status: 502 });
    }
    if (!state.content) return new Response("Not Found", { status: 404 });
    if (headers.accept === "application/vnd.github.raw+json") return new Response(new Uint8Array(state.content));
    return Response.json({ sha: state.sha });
  }) as typeof fetch;
  return { state, fetchImpl };
}

const key = randomBytes(32);
const cfg: BackupConfig = { repo: "me/moncsy-data", token: "gh-token", path: "moncsy.db.enc", key, debounceMs: 5 };
let dirs: string[] = [];
const tempDb = () => {
  const d = mkdtempSync(join(tmpdir(), "moncsy-bk-"));
  dirs.push(d);
  return join(d, "data", "expense.db");
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("backup blob", () => {
  it("round-trips with its generation, and refuses a wrong key, a damaged file or a changed generation", () => {
    const plain = Buffer.from("SQLite format 3\0 some data ".repeat(50));
    const blob = encryptBlob(plain, key, 7);
    expect(blob.includes(Buffer.from("some data"))).toBe(false);
    expect(decryptBlob(blob, key)).toEqual({ data: plain, generation: 7 });
    expect(() => decryptBlob(blob, randomBytes(32))).toThrow(/wrong BACKUP_KEY/);
    const broken = Buffer.from(blob);
    broken[broken.length - 20]! ^= 1;
    expect(() => decryptBlob(broken, key)).toThrow(/wrong BACKUP_KEY or a damaged file/);
    // The generation is authenticated: raising it without the key makes the blob unreadable.
    const bumped = Buffer.from(blob);
    bumped[16]! ^= 1;
    expect(() => decryptBlob(bumped, key)).toThrow(/wrong BACKUP_KEY or a damaged file/);
    expect(() => decryptBlob(Buffer.from("hello"), key)).toThrow(/not a moncsy backup/);
    expect(() => encryptBlob(plain, key, 0)).toThrow(/Invalid backup generation/);
  });

  it("is configured all or nothing, with a 32-byte key", () => {
    expect(loadBackupConfig({})).toBeNull();
    expect(() => loadBackupConfig({ REQUIRE_BACKUP: "1" })).toThrow(/every restart would start from an empty database/);
    expect(() => loadBackupConfig({ BACKUP_GITHUB_REPO: "me/x" })).toThrow(/some are missing/);
    expect(() => loadBackupConfig({ BACKUP_GITHUB_REPO: "me/x", BACKUP_GITHUB_TOKEN: "t", BACKUP_KEY: "c2hvcnQ=" })).toThrow(/32 random bytes/);
    expect(() => loadBackupConfig({ BACKUP_GITHUB_REPO: "me/x", BACKUP_GITHUB_TOKEN: "t", BACKUP_KEY: key.toString("base64"), BACKUP_DEBOUNCE_MS: "soon" })).toThrow(
      /Invalid BACKUP_DEBOUNCE_MS "soon"/,
    );
    expect(loadBackupConfig({ BACKUP_GITHUB_REPO: "me/x", BACKUP_GITHUB_TOKEN: "t", BACKUP_KEY: key.toString("base64") })).toMatchObject({
      repo: "me/x",
      path: "moncsy.db.enc",
    });
  });
});

describe("backup and restore through the API", () => {
  it("uploads after a write, restores into a fresh server, and keeps the data", async () => {
    const gh = fakeGithub();
    vi.stubGlobal("fetch", gh.fetchImpl);
    const dbPath = tempDb();
    expect(await restoreIfMissing(dbPath, cfg)).toMatch(/no backup .* yet/);

    const app1 = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({}), dbPath } });
    const created = await app1.inject({
      method: "POST",
      url: "/api/transactions",
      payload: { amount: -4785, currency: "HUF", date: "2026-10-12", merchant: "Spar", categoryId: "groceries" },
    });
    expect(created.statusCode).toBe(201);
    await app1.deps.backup!.flush();
    expect(gh.state.puts).toBe(1);
    expect(gh.state.content!.includes(Buffer.from("Spar"))).toBe(false); // encrypted at rest on GitHub
    expect(decryptBlob(gh.state.content!, key).generation).toBe(1);

    // A read does not create a commit, and neither does a flush with nothing new.
    await app1.inject("/api/transactions");
    await app1.deps.backup!.flush();
    expect(gh.state.puts).toBe(1);
    expect((await app1.inject("/api/health")).json().backup).toMatchObject({ enabled: true, lastError: null, pending: false });
    const first = (await app1.inject("/api/backup/status")).json();
    expect(first).toMatchObject({ enabled: true, generation: 1, lastBackupAt: expect.any(String), lastError: null, pending: false, stopped: false });
    await app1.close();

    // The instance restarts with an empty disk.
    rmSync(dbPath);
    const dbPath2 = tempDb();
    expect(await restoreIfMissing(dbPath2, cfg)).toMatch(/^restored .* generation 1 /);
    expect(readFileSync(dbPath2).subarray(0, 15).toString()).toBe("SQLite format 3");
    const app2 = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({}), dbPath: dbPath2 } });
    expect((await app2.inject("/api/transactions")).json()).toMatchObject([{ merchant: "Spar", amount: -4785 }]);
    // The restored database knows which copy it came from and when that copy was made.
    expect((await app2.inject("/api/backup/status")).json()).toMatchObject({ generation: 1, lastBackupAt: first.lastBackupAt });
    // Restarting without a write does not make a new commit.
    await app2.deps.backup!.flush();
    expect(gh.state.puts).toBe(1);

    // A second write updates the same file (with its sha) instead of failing.
    await app2.inject({ method: "DELETE", url: `/api/transactions/${created.json().id}` });
    await app2.close(); // close() flushes
    expect(gh.state.puts).toBe(2);
    expect(decryptBlob(gh.state.content!, key).generation).toBe(2);
  });

  it("never overwrites a copy another instance wrote, and says so", async () => {
    const gh = fakeGithub();
    vi.stubGlobal("fetch", gh.fetchImpl);
    const seed = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({}), dbPath: tempDb() } });
    await seed.inject({ method: "POST", url: "/api/categories", payload: { name: "Közös", icon: "x", color: "#123456" } });
    await seed.close();
    const generation1 = gh.state.content!;

    // A deploy: the old and the new instance both start from generation 1.
    const start = async () => {
      const dbPath = tempDb();
      await restoreIfMissing(dbPath, cfg);
      return buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({}), dbPath } });
    };
    const oldApp = await start();
    const newApp = await start();
    await newApp.inject({ method: "POST", url: "/api/categories", payload: { name: "Új példány", icon: "x", color: "#123456" } });
    await newApp.deps.backup!.flush();
    expect(gh.state.puts).toBe(2);

    // The old instance reads the remote copy before its first upload, sees generation 2, and stops.
    await oldApp.inject({ method: "POST", url: "/api/categories", payload: { name: "Régi példány", icon: "x", color: "#123456" } });
    await oldApp.deps.backup!.flush();
    expect((await oldApp.inject("/api/backup/status")).json()).toMatchObject({
      stopped: true,
      generation: 1,
      pending: true,
      lastError: expect.stringMatching(/holds generation 2, but this database came from generation 1/),
    });
    await oldApp.close(); // closing does not upload either
    expect(gh.state.puts).toBe(2);
    expect(decryptBlob(gh.state.content!, key).data.includes(Buffer.from("Új példány"))).toBe(true);

    // Someone puts the older copy back by hand while the new instance runs: its next write is refused by GitHub
    // (stale sha), and the retry stops instead of overwriting the copy that was put back.
    gh.state.content = generation1;
    gh.state.sha = "manual";
    await newApp.inject({ method: "POST", url: "/api/categories", payload: { name: "Még egy", icon: "x", color: "#123456" } });
    await newApp.deps.backup!.flush();
    expect(newApp.deps.backup!.getStatus()).toMatchObject({ stopped: false, lastError: expect.stringMatching(/GitHub 409/) });
    await newApp.deps.backup!.flush();
    expect(newApp.deps.backup!.getStatus()).toMatchObject({
      stopped: true,
      lastError: expect.stringMatching(/holds generation 1, but this database came from generation 2/),
    });
    await newApp.close();
    expect(gh.state.content).toBe(generation1);
  });

  it("does not overwrite a remote copy that this database was not restored from", async () => {
    const gh = fakeGithub();
    vi.stubGlobal("fetch", gh.fetchImpl);
    const first = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({}), dbPath: tempDb() } });
    await first.inject({ method: "POST", url: "/api/categories", payload: { name: "Eredeti", icon: "x", color: "#123456" } });
    await first.close();

    // A second database that never saw the backup, e.g. a leftover local file.
    const stranger = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({}), dbPath: tempDb() } });
    await stranger.inject({ method: "POST", url: "/api/categories", payload: { name: "Idegen", icon: "x", color: "#123456" } });
    await stranger.deps.backup!.flush();
    expect(stranger.deps.backup!.getStatus()).toMatchObject({ stopped: true, lastError: expect.stringMatching(/was not restored from it/) });
    await stranger.close();
    expect(gh.state.puts).toBe(1);
  });

  it("refuses to start empty when the copy cannot be read", async () => {
    const gh = fakeGithub();
    vi.stubGlobal("fetch", gh.fetchImpl);
    const dbPath = tempDb();
    const app = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({}), dbPath } });
    await app.inject({ method: "POST", url: "/api/categories", payload: { name: "Teszt", icon: "x", color: "#123456" } });
    await app.close();

    gh.state.failReads = 1;
    await expect(restoreIfMissing(tempDb(), cfg)).rejects.toThrow(/GitHub 502/);
    await expect(restoreIfMissing(tempDb(), { ...cfg, key: randomBytes(32) })).rejects.toThrow(/wrong BACKUP_KEY/);
    // A path that already has a database is left alone.
    expect(existsSync(dbPath)).toBe(true);
    expect(await restoreIfMissing(dbPath, cfg)).toMatch(/exists; not restoring/);
  });

  it("reports a failed upload in /health and retries", async () => {
    const gh = fakeGithub();
    const failing = (async (url: string, init?: RequestInit) =>
      init?.method === "PUT" ? new Response("rate limited", { status: 403 }) : gh.fetchImpl(url, init)) as typeof fetch;
    vi.stubGlobal("fetch", failing);
    const app = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({}), dbPath: tempDb() } });
    await app.inject({ method: "POST", url: "/api/categories", payload: { name: "Teszt", icon: "x", color: "#123456" } });
    await app.deps.backup!.flush();
    expect(app.deps.backup!.getStatus()).toMatchObject({ lastBackupAt: null, lastError: expect.stringMatching(/GitHub 403/) });
    vi.stubGlobal("fetch", gh.fetchImpl);
    await app.close();
  });
});

describe("wrong-token rate limit", () => {
  it("answers 429 after repeated wrong tokens from one address", async () => {
    const app = await testApp({ config: { apiToken: "right" } });
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await app.inject({ url: "/api/categories", headers: { authorization: "Bearer nope" } })).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes[20]).toBe(429);
    // The right token is never refused, even from the address that is over the limit.
    expect((await app.inject({ url: "/api/categories", headers: { authorization: "Bearer right" } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/categories", headers: { authorization: "Bearer nope" } })).statusCode).toBe(429);
    await app.close();
  });

  it("does not count requests that send no token at all", async () => {
    const app = await testApp({ config: { apiToken: "right" } });
    for (let i = 0; i < 25; i++) expect((await app.inject({ url: "/api/categories" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/categories", headers: { authorization: "Bearer right" } })).statusCode).toBe(200);
    await app.close();
  });

  it("validates TRUST_PROXY_HOPS", () => {
    expect(loadConfig({}).trustProxyHops).toBe(0);
    expect(loadConfig({ TRUST_PROXY_HOPS: "1" }).trustProxyHops).toBe(1);
    expect(() => loadConfig({ TRUST_PROXY_HOPS: "one" })).toThrow(/Invalid TRUST_PROXY_HOPS "one"/);
  });
});
