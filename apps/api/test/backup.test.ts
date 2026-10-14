import { randomBytes } from "node:crypto";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { MockProvider } from "../src/ai/index.js";
import { BackupScheduler, decryptBlob, encryptBlob, loadBackupConfig, restoreIfMissing, type BackupConfig } from "../src/backup.js";
import { loadConfig } from "../src/config.js";
import type { DB } from "../src/db.js";
import type { RevolutProvider } from "../src/revolut/types.js";
import { fakeGithub } from "./fake-github.js";
import { testApp } from "./helpers.js";

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
    // The write that set off the check got its 2xx, but it is not in the newer copy: the reason says so, and what to do.
    expect(oldApp.deps.backup!.getStatus().lastError).toMatch(
      /another instance wrote a newer copy\. Not overwriting it\. The changes made on this instance since 20\d\d-\d\d-\d\dT[\d:.]+Z are not in that copy: save them with GET \/api\/export before restarting, then restart the service to load it\.$/,
    );
    await oldApp.close(); // closing does not upload either
    expect(gh.state.puts).toBe(2);
    expect(decryptBlob(gh.state.content!, key).data.includes(Buffer.from("Új példány"))).toBe(true);

    // Someone puts the older copy back by hand while the new instance runs: its next write is refused by GitHub
    // (stale sha), and the retry stops instead of overwriting the copy that was put back.
    gh.state.content = generation1;
    gh.state.sha = "manual";
    gh.state.commits.push("Add files via upload");
    await newApp.inject({ method: "POST", url: "/api/categories", payload: { name: "Még egy", icon: "x", color: "#123456" } });
    await newApp.deps.backup!.flush();
    expect(newApp.deps.backup!.getStatus()).toMatchObject({ stopped: false, lastError: expect.stringMatching(/GitHub 409/) });
    await newApp.deps.backup!.flush();
    expect(newApp.deps.backup!.getStatus()).toMatchObject({
      stopped: true,
      lastError: expect.stringMatching(/holds generation 1, older than generation 2 this database came from: the copy was rolled back.*do not restart yet/),
    });
    await newApp.close();
    expect(gh.state.content).toBe(generation1);
    // A restart would load the older copy, so it is refused too.
    await expect(restoreIfMissing(tempDb(), cfg)).rejects.toThrow(/holds generation 1, but generation 2 was written later: the copy was rolled back/);
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

  it("refuses every write once the backup has stopped, and still serves reads and the export", async () => {
    const gh = fakeGithub();
    vi.stubGlobal("fetch", gh.fetchImpl);
    const first = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({}), dbPath: tempDb() } });
    await first.inject({ method: "POST", url: "/api/categories", payload: { name: "Eredeti", icon: "x", color: "#123456" } });
    await first.close();

    const app = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({}), dbPath: tempDb(), apiToken: "right" } });
    const headers = { authorization: "Bearer right" };
    const tx = { date: "2026-10-14", amount: -100, currency: "HUF", merchant: "Spar", categoryId: null, source: "manual" };
    const created = await app.inject({ method: "POST", url: "/api/transactions", headers, payload: tx });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    await app.deps.backup!.flush();
    expect(app.deps.backup!.getStatus()).toMatchObject({ stopped: true });

    // Whatever is written now exists only on a disk the host wipes on restart, so nothing is accepted.
    const writes = [
      { method: "POST" as const, url: "/api/transactions", payload: tx },
      { method: "PATCH" as const, url: `/api/transactions/${id}`, payload: { merchant: "Lidl" } },
      { method: "DELETE" as const, url: `/api/transactions/${id}` },
      { method: "POST" as const, url: "/api/categories", payload: { name: "Új", icon: "x", color: "#123456" } },
      { method: "POST" as const, url: "/api/statements/import", payload: { transactions: [] } },
    ];
    for (const w of writes) {
      const res = await app.inject({ ...w, headers });
      expect(res.statusCode, `${w.method} ${w.url}`).toBe(503);
      expect(res.json().error).toMatch(/^Changes are not saved: the backup has stopped \(.*was not restored from it.*\)/);
    }
    expect((await app.inject({ url: "/api/transactions", headers })).json()).toMatchObject([{ id, merchant: "Spar" }]);
    // Without the right token the answer is the usual 401, which says nothing about the backup.
    expect((await app.inject({ method: "POST", url: "/api/transactions", headers: { authorization: "Bearer nope" }, payload: tx })).statusCode).toBe(401);
    // Reading, the status and the export still work, so the data on this disk can be saved by hand.
    expect((await app.inject({ url: "/api/backup/status", headers })).json()).toMatchObject({ stopped: true });
    expect((await app.inject({ url: "/api/export?format=xml", headers })).statusCode).toBe(200);
    expect((await app.inject("/api/health")).statusCode).toBe(200);
    await app.close();
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
    // A token that cannot see the repository is not the same as a repository with no backup in it yet.
    vi.stubGlobal("fetch", fakeGithub({ repoHidden: true }).fetchImpl);
    await expect(restoreIfMissing(tempDb(), cfg)).rejects.toThrow(/repository me\/moncsy-data not found, or BACKUP_GITHUB_TOKEN cannot read it/);
    vi.stubGlobal("fetch", gh.fetchImpl);
    await expect(restoreIfMissing(tempDb(), { ...cfg, key: randomBytes(32) })).rejects.toThrow(/wrong BACKUP_KEY/);
    // A path that already has a database is left alone.
    expect(existsSync(dbPath)).toBe(true);
    expect(await restoreIfMissing(dbPath, cfg)).toMatch(/exists; not restoring/);
  });

  it("does not start empty when the backup file was deleted, unless told to", async () => {
    const gh = fakeGithub();
    vi.stubGlobal("fetch", gh.fetchImpl);
    const first = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({}), dbPath: tempDb() } });
    await first.inject({ method: "POST", url: "/api/categories", payload: { name: "Eredeti", icon: "x", color: "#123456" } });
    await first.close();
    expect(gh.state.commits).toEqual([expect.stringMatching(/^backup 1 /)]);

    // Someone deletes the file in the repository; its history is still there.
    gh.state.content = null;
    gh.state.sha = null;
    gh.state.commits.push("Delete moncsy.db.enc");
    await expect(restoreIfMissing(tempDb(), cfg)).rejects.toThrow(/is gone, but its history has 2 commit\(s\), up to backup generation 1\. Not starting/);

    // The owner really wants to start over: the new copies continue above the old generations.
    const dbPath = tempDb();
    expect(await restoreIfMissing(dbPath, { ...cfg, allowReset: true })).toMatch(/BACKUP_ALLOW_RESET=1, starting with an empty database/);
    const fresh = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({}), dbPath } });
    await fresh.inject({ method: "POST", url: "/api/categories", payload: { name: "Új kezdet", icon: "x", color: "#123456" } });
    await fresh.close();
    expect(decryptBlob(gh.state.content!, key).generation).toBe(2);
    expect(await restoreIfMissing(tempDb(), cfg)).toMatch(/^restored .* generation 2 /);
    expect(() => loadBackupConfig({ BACKUP_GITHUB_REPO: "me/x", BACKUP_GITHUB_TOKEN: "t", BACKUP_KEY: key.toString("base64"), BACKUP_ALLOW_RESET: "yes" })).toThrow(
      /Invalid BACKUP_ALLOW_RESET "yes"/,
    );
  });

  it("reports a failed upload in /health and retries", async () => {
    const gh = fakeGithub();
    let fail = true;
    const failing = (async (url: string, init?: RequestInit) =>
      fail && init?.method === "PUT" ? new Response("rate limited", { status: 403 }) : gh.fetchImpl(url, init)) as typeof fetch;
    vi.stubGlobal("fetch", failing);
    const app = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({}), dbPath: tempDb() } });
    await app.inject({ method: "POST", url: "/api/categories", payload: { name: "Teszt", icon: "x", color: "#123456" } });
    await app.deps.backup!.flush();
    expect(app.deps.backup!.getStatus()).toMatchObject({ lastBackupAt: null, lastError: expect.stringMatching(/GitHub 403/) });
    fail = false;
    await app.close();
    expect(gh.state.puts).toBe(1);
  });

  it("uploads a write made during an upload the next time, instead of taking it as saved", async () => {
    const gh = fakeGithub();
    let app: Awaited<ReturnType<typeof buildApp>> | null = null;
    let wroteDuringUpload = false;
    vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT" && !wroteDuringUpload) {
        wroteDuringUpload = true;
        const res = await app!.inject({ method: "POST", url: "/api/categories", payload: { name: "Közben", icon: "x", color: "#123456" } });
        expect(res.statusCode).toBe(201);
      }
      return gh.fetchImpl(url, init);
    }) as typeof fetch);
    // A long debounce, so only the explicit flushes below upload.
    app = await buildApp({ ai: new MockProvider(), backup: { ...cfg, debounceMs: 60_000 }, config: { ...loadConfig({}), dbPath: tempDb() } });
    await app.inject({ method: "POST", url: "/api/categories", payload: { name: "Előtte", icon: "x", color: "#123456" } });
    await app.deps.backup!.flush();
    expect(gh.state.puts).toBe(1);
    expect(decryptBlob(gh.state.content!, key).data.includes(Buffer.from("Közben"))).toBe(false);
    expect(app.deps.backup!.getStatus()).toMatchObject({ generation: 1, pending: true });
    await app.deps.backup!.flush();
    expect(gh.state.puts).toBe(2);
    expect(decryptBlob(gh.state.content!, key).data.includes(Buffer.from("Közben"))).toBe(true);
    expect(app.deps.backup!.getStatus()).toMatchObject({ generation: 2, pending: false });
    await app.close();
    expect(gh.state.puts).toBe(2);
  });

  it("stops instead of overwriting a remote copy it cannot decrypt", async () => {
    const gh = fakeGithub();
    vi.stubGlobal("fetch", gh.fetchImpl);
    // A copy made with another key, e.g. after BACKUP_KEY was changed by mistake.
    const other = await buildApp({ ai: new MockProvider(), backup: { ...cfg, key: randomBytes(32) }, config: { ...loadConfig({}), dbPath: tempDb() } });
    await other.inject({ method: "POST", url: "/api/categories", payload: { name: "Másik kulcs", icon: "x", color: "#123456" } });
    await other.close();
    const theirs = gh.state.content;
    expect(gh.state.puts).toBe(1);

    const app = await buildApp({ ai: new MockProvider(), backup: { ...cfg, debounceMs: 60_000 }, config: { ...loadConfig({}), dbPath: tempDb() } });
    await app.inject({ method: "POST", url: "/api/categories", payload: { name: "Teszt", icon: "x", color: "#123456" } });
    await app.deps.backup!.flush();
    await app.deps.backup!.flush();
    expect(app.deps.backup!.getStatus()).toMatchObject({
      stopped: true,
      lastError: expect.stringMatching(/cannot be read with this BACKUP_KEY .*Not overwriting it/),
    });
    await app.close();
    expect(gh.state.puts).toBe(1);
    expect(gh.state.content).toBe(theirs);
  });

  it("continues from an upload that landed although its response was lost", async () => {
    const gh = fakeGithub();
    let loseResponse = true;
    vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
      const res = await gh.fetchImpl(url, init);
      if (init?.method === "PUT" && loseResponse) {
        loseResponse = false;
        throw new TypeError("fetch failed");
      }
      return res;
    }) as typeof fetch);
    const app = await buildApp({ ai: new MockProvider(), backup: { ...cfg, debounceMs: 60_000 }, config: { ...loadConfig({}), dbPath: tempDb() } });
    await app.inject({ method: "POST", url: "/api/categories", payload: { name: "Teszt", icon: "x", color: "#123456" } });
    await app.deps.backup!.flush();
    expect(gh.state.puts).toBe(1);
    expect(app.deps.backup!.getStatus()).toMatchObject({ generation: null, lastError: "fetch failed", pending: true });
    // The retry finds its own copy on GitHub, records it, and has nothing more to upload.
    await app.deps.backup!.flush();
    expect(app.deps.backup!.getStatus()).toMatchObject({ generation: 1, lastError: null, pending: false, stopped: false });
    expect(gh.state.puts).toBe(1);
    await app.inject({ method: "POST", url: "/api/categories", payload: { name: "Utána", icon: "x", color: "#123456" } });
    await app.close();
    expect(gh.state.puts).toBe(2);
    expect(decryptBlob(gh.state.content!, key).generation).toBe(2);
  });

  it("retries the last upload when the server shuts down, and schedules nothing after", async () => {
    const gh = fakeGithub();
    let failPuts = 1;
    vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) =>
      init?.method === "PUT" && failPuts-- > 0 ? new Response("bad gateway", { status: 502 }) : gh.fetchImpl(url, init)) as typeof fetch);
    const app = await buildApp({ ai: new MockProvider(), backup: { ...cfg, debounceMs: 60_000 }, config: { ...loadConfig({}), dbPath: tempDb() } });
    await app.inject({ method: "POST", url: "/api/categories", payload: { name: "Teszt", icon: "x", color: "#123456" } });
    await app.close();
    expect(gh.state.puts).toBe(1);
    const backup = app.deps.backup!;
    expect(backup.getStatus()).toMatchObject({ generation: 1, lastError: null, pending: false });
    backup.touch();
    expect(backup.getStatus().pending).toBe(false);
  });

  it("restores into place in one step, without the journal of an earlier database", async () => {
    const gh = fakeGithub();
    vi.stubGlobal("fetch", gh.fetchImpl);
    const seed = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({}), dbPath: tempDb() } });
    await seed.inject({ method: "POST", url: "/api/categories", payload: { name: "Mentett", icon: "x", color: "#123456" } });
    await seed.close();

    const dbPath = tempDb();
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(`${dbPath}-wal`, "left by an earlier database");
    writeFileSync(`${dbPath}-shm`, "left by an earlier database");
    expect(await restoreIfMissing(dbPath, cfg)).toMatch(/^restored /);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(`${dbPath}.restoring`)).toBe(false);
    const app = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({}), dbPath } });
    expect((await app.inject("/api/categories")).json()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Mentett" })]));
    await app.close();
  });

  it("starts a backup only for requests that carry the right token", async () => {
    const gh = fakeGithub();
    vi.stubGlobal("fetch", gh.fetchImpl);
    const app = await buildApp({
      ai: new MockProvider(),
      backup: { ...cfg, debounceMs: 60_000 },
      config: { ...loadConfig({}), dbPath: tempDb(), apiToken: "right" },
    });
    const payload = { name: "Teszt", icon: "x", color: "#123456" };
    expect((await app.inject({ method: "POST", url: "/api/categories", payload })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/categories", headers: { authorization: "Bearer nope" }, payload })).statusCode).toBe(401);
    expect(app.deps.backup!.getStatus().pending).toBe(false);
    expect((await app.inject({ method: "POST", url: "/api/categories", headers: { authorization: "Bearer right" }, payload })).statusCode).toBe(201);
    expect(app.deps.backup!.getStatus().pending).toBe(true);
    await app.close();
    expect(gh.state.puts).toBe(1);
  });

  it("starts a backup for a write whose client went away before the response", async () => {
    const gh = fakeGithub();
    vi.stubGlobal("fetch", gh.fetchImpl);
    let app: Awaited<ReturnType<typeof buildApp>> | null = null;
    // A slow sync, as against a real bank API; the client gives up while it runs.
    const revolut: RevolutProvider = {
      mode: "business-api",
      status: async () => ({ connected: true, mode: "business-api", lastSyncAt: null, accounts: [] }),
      sync: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        await app!.deps.repo.createCategory({ name: "Lassú", icon: "x", color: "#123456", parentId: null });
        return { imported: 1, skipped: 0 };
      },
    };
    app = await buildApp({ ai: new MockProvider(), revolut, backup: { ...cfg, debounceMs: 60_000 }, config: { ...loadConfig({}), dbPath: tempDb() } });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/api/revolut/sync", headers: { "content-type": "application/json" } });
      req.on("error", () => resolve());
      req.end("{}");
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });
    await vi.waitFor(() => expect(app!.deps.backup!.getStatus().pending).toBe(true), { timeout: 2_000, interval: 50 });
    await app.close();
    expect(decryptBlob(gh.state.content!, key).data.includes(Buffer.from("Lassú"))).toBe(true);
  });

  it("does not let a steady stream of writes postpone the upload forever", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const scheduler = new BackupScheduler({} as DB, { ...cfg, debounceMs: 5_000 }, { info() {}, error() {} });
      const flush = vi.spyOn(scheduler, "flush").mockResolvedValue();
      // A write every 4 seconds would keep resetting a 5-second debounce; the upload still happens a minute after the first.
      for (let t = 0; t < 60_000; t += 4_000) {
        scheduler.touch();
        vi.advanceTimersByTime(4_000);
      }
      expect(flush).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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

  it("counts wrong tokens sent to /health, which stays open without one", async () => {
    const app = await testApp({ config: { apiToken: "right" } });
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({ url: "/api/health", headers: { authorization: "Bearer nope" } });
      expect(res.statusCode).toBe(200);
      expect(res.json().ai).toBeUndefined();
    }
    expect((await app.inject({ url: "/api/health", headers: { authorization: "Bearer nope" } })).statusCode).toBe(429);
    expect((await app.inject({ url: "/api/categories", headers: { authorization: "Bearer nope" } })).statusCode).toBe(429);
    // The platform's health check sends no token, and the owner's app sends the right one.
    expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/health", headers: { authorization: "Bearer right" } })).json().ai).toBeDefined();
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
