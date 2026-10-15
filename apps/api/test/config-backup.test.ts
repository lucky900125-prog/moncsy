import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { MockProvider } from "../src/ai/index.js";
import { BackupScheduler, decryptBlob, type BackupConfig, type GithubStore } from "../src/backup.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { fakeGithub } from "./fake-github.js";

const key = randomBytes(32);
const cfg: BackupConfig = { repo: "me/moncsy-data", token: "gh-token", path: "moncsy.db.enc", key, debounceMs: 5 };
let dirs: string[] = [];
const tempDb = () => {
  const d = mkdtempSync(join(tmpdir(), "moncsy-cb-"));
  dirs.push(d);
  return join(d, "data", "expense.db");
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("configuration (BE-6)", () => {
  it("refuses an unknown STATEMENT_TZ at start instead of failing every statement later", () => {
    expect(() => loadConfig({ STATEMENT_TZ: "Mars/Olympus" })).toThrow(/Invalid STATEMENT_TZ "Mars\/Olympus"/);
    expect(loadConfig({ STATEMENT_TZ: "Europe/Vienna" }).statementTz).toBe("Europe/Vienna");
  });

  it("refuses a DEFAULT_CURRENCY that is not a three-letter code", () => {
    expect(() => loadConfig({ DEFAULT_CURRENCY: "forint" })).toThrow(/Invalid DEFAULT_CURRENCY "forint"/);
    expect(loadConfig({ DEFAULT_CURRENCY: "eur" }).defaultCurrency).toBe("EUR");
  });
});

describe("backup on a disk that survives a restart", () => {
  it("uploads after a restart the changes that were never uploaded before it (BE-9)", async () => {
    const gh = fakeGithub();
    let tokenWorks = false;
    vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) =>
      !tokenWorks && init?.method === "PUT" ? new Response("Bad credentials", { status: 401 }) : gh.fetchImpl(url, init)) as typeof fetch);
    const dbPath = tempDb();
    const first = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({}), dbPath } });
    await first.inject({ method: "POST", url: "/api/categories", payload: { name: "Mentetlen", icon: "x", color: "#123456" } });
    await first.close();
    expect(gh.state.puts).toBe(0);

    // The owner fixes the token and restarts on the same disk, without writing anything new.
    tokenWorks = true;
    const second = await buildApp({ ai: new MockProvider(), backup: cfg, config: { ...loadConfig({}), dbPath } });
    await second.deps.backup!.flush();
    expect(gh.state.puts).toBe(1);
    expect(decryptBlob(gh.state.content!, key).data.includes(Buffer.from("Mentetlen"))).toBe(true);
    await second.close();
    expect(gh.state.puts).toBe(1);
  });

  it("waits out the retry delay after a failed upload, however many writes arrive meanwhile (BE-10)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const db = await openDb(":memory:");
    let fail: (e: Error) => void = () => {};
    const upload = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    const store = { knowsRemote: true, upload } as unknown as GithubStore;
    const scheduler = new BackupScheduler(db, { ...cfg, debounceMs: 5_000 }, { info() {}, error() {} }, store);
    await scheduler.init();
    await db.run("INSERT INTO categories (id, name, icon, color) VALUES ('c', 'C', 'x', '#123456')");

    const first = scheduler.flush();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    scheduler.touch(); // a write while the upload is still running
    fail(new Error("network down"));
    await first;
    expect(scheduler.getStatus().lastError).toBe("network down");

    // A write every few seconds after the failure must not bring the next attempt forward.
    for (let t = 0; t < 55_000; t += 5_000) {
      scheduler.touch();
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(upload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(upload).toHaveBeenCalledTimes(2);
    fail(new Error("still down"));
    await vi.advanceTimersByTimeAsync(0);
    db.close();
  });
});
