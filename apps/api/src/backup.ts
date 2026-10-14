import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { DB } from "./db.js";

/*
 * Off-site copy of the SQLite file for hosts whose disk does not survive a restart (Render's free tier).
 * The file is gzipped and encrypted with AES-256-GCM before it leaves the server, and stored as one file in a
 * private GitHub repository; every backup is a commit, so the repository history doubles as point-in-time copies.
 * On start, when the local database file is missing, the latest copy is downloaded and decrypted first.
 *
 * Blob layout: MAGIC | 12-byte nonce | ciphertext | 16-byte GCM tag; MAGIC is also the additional authenticated data.
 */

const MAGIC = Buffer.from("MONCSYBK1");

export interface BackupConfig {
  /** "owner/name" of a private repository */
  repo: string;
  token: string;
  /** path of the blob inside the repository */
  path: string;
  /** 32 bytes */
  key: Buffer;
  /** wait this long after the last write before uploading */
  debounceMs: number;
}

export interface BackupStatus {
  enabled: boolean;
  lastBackupAt: string | null;
  lastError: string | null;
  pending: boolean;
}

function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  return env[name]?.trim() || undefined;
}

/**
 * All of BACKUP_GITHUB_REPO, BACKUP_GITHUB_TOKEN and BACKUP_KEY, or none; a half-configured backup refuses to start.
 * REQUIRE_BACKUP=1 (set by render.yaml) turns "none" into a refusal too, for hosts whose disk is wiped on restart.
 */
export function loadBackupConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig | null {
  const repo = env.BACKUP_GITHUB_REPO?.trim();
  const token = readSecret(env, "BACKUP_GITHUB_TOKEN");
  const keyText = readSecret(env, "BACKUP_KEY");
  const given = [repo, token, keyText].filter(Boolean).length;
  if (given === 0 && env.REQUIRE_BACKUP === "1") {
    throw new Error(
      "REQUIRE_BACKUP=1 but BACKUP_GITHUB_REPO, BACKUP_GITHUB_TOKEN and BACKUP_KEY are not set; " +
        "on a host without a persistent disk every restart would start from an empty database.",
    );
  }
  if (given === 0) return null;
  if (given < 3) {
    throw new Error("Backup needs all of BACKUP_GITHUB_REPO, BACKUP_GITHUB_TOKEN (or _FILE) and BACKUP_KEY (or _FILE); some are missing.");
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo!)) throw new Error(`BACKUP_GITHUB_REPO must look like "owner/name", got "${repo}"`);
  const key = Buffer.from(keyText!, "base64");
  if (key.length !== 32) {
    throw new Error("BACKUP_KEY must be 32 random bytes in base64 (generate one with: openssl rand -base64 32)");
  }
  const debounceMs = Number(env.BACKUP_DEBOUNCE_MS?.trim() || 10_000);
  if (!Number.isInteger(debounceMs) || debounceMs < 0) throw new Error(`Invalid BACKUP_DEBOUNCE_MS "${env.BACKUP_DEBOUNCE_MS}" (expected milliseconds)`);
  return { repo: repo!, token: token!, key, path: env.BACKUP_GITHUB_PATH?.trim() || "moncsy.db.enc", debounceMs };
}

export function encryptBlob(plain: Buffer, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(MAGIC);
  const body = Buffer.concat([c.update(gzipSync(plain)), c.final()]);
  return Buffer.concat([MAGIC, nonce, body, c.getAuthTag()]);
}

export function decryptBlob(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < MAGIC.length + 28 || !blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a moncsy backup blob");
  const nonce = blob.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = blob.subarray(blob.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(MAGIC);
  d.setAuthTag(tag);
  try {
    return gunzipSync(Buffer.concat([d.update(blob.subarray(MAGIC.length + 12, blob.length - 16)), d.final()]));
  } catch {
    throw new Error("backup could not be decrypted: wrong BACKUP_KEY or a damaged file");
  }
}

/** The GitHub contents API, used for exactly one file. */
export class GithubStore {
  private sha: string | null = null;

  constructor(
    private readonly cfg: Pick<BackupConfig, "repo" | "token" | "path">,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url() {
    return `https://api.github.com/repos/${this.cfg.repo}/contents/${this.cfg.path.split("/").map(encodeURIComponent).join("/")}`;
  }

  private headers(accept: string) {
    return {
      authorization: `Bearer ${this.cfg.token}`,
      accept,
      "x-github-api-version": "2022-11-28",
      "user-agent": "moncsy-backup",
    };
  }

  /** null when the file does not exist yet; throws for every other failure, so a fresh start never hides a lost copy. */
  async download(): Promise<Buffer | null> {
    const meta = await this.fetchImpl(this.url(), { headers: this.headers("application/vnd.github+json") });
    if (meta.status === 404) return null;
    if (!meta.ok) throw new Error(`GitHub ${meta.status} reading ${this.cfg.repo}/${this.cfg.path}: ${(await meta.text()).slice(0, 200)}`);
    this.sha = ((await meta.json()) as { sha: string }).sha;
    const raw = await this.fetchImpl(this.url(), { headers: this.headers("application/vnd.github.raw+json") });
    if (!raw.ok) throw new Error(`GitHub ${raw.status} downloading ${this.cfg.repo}/${this.cfg.path}`);
    return Buffer.from(await raw.arrayBuffer());
  }

  async upload(blob: Buffer, message: string): Promise<void> {
    if (this.sha === null) {
      const meta = await this.fetchImpl(this.url(), { headers: this.headers("application/vnd.github+json") });
      if (meta.ok) this.sha = ((await meta.json()) as { sha: string }).sha;
      else if (meta.status !== 404) throw new Error(`GitHub ${meta.status} reading ${this.cfg.repo}/${this.cfg.path}`);
    }
    const res = await this.fetchImpl(this.url(), {
      method: "PUT",
      headers: { ...this.headers("application/vnd.github+json"), "content-type": "application/json" },
      body: JSON.stringify({ message, content: blob.toString("base64"), ...(this.sha ? { sha: this.sha } : {}) }),
    });
    if (!res.ok) {
      // 409/422: the file changed under us (another instance, or a manual edit); re-read its sha next time.
      if (res.status === 409 || res.status === 422) this.sha = null;
      throw new Error(`GitHub ${res.status} writing ${this.cfg.repo}/${this.cfg.path}: ${(await res.text()).slice(0, 200)}`);
    }
    this.sha = ((await res.json()) as { content: { sha: string } }).content.sha;
  }
}

/**
 * Downloads and decrypts the latest copy when the local file is missing.
 * Returns what happened, for the start-up log.
 */
export async function restoreIfMissing(dbPath: string, cfg: BackupConfig, store = new GithubStore(cfg)): Promise<string> {
  if (dbPath === ":memory:") throw new Error("Backup cannot be used with DB_PATH=:memory:");
  if (existsSync(dbPath)) return `local database ${dbPath} exists; not restoring`;
  const blob = await store.download();
  if (!blob) return `no backup at ${cfg.repo}/${cfg.path} yet; starting with an empty database`;
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, decryptBlob(blob, cfg.key));
  return `restored ${dbPath} from ${cfg.repo}/${cfg.path} (${blob.length} bytes)`;
}

/** Uploads a consistent snapshot a few seconds after the database last changed, one upload at a time. */
export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private savedChanges: number | null = null;
  private status: BackupStatus = { enabled: true, lastBackupAt: null, lastError: null, pending: false };

  constructor(
    private readonly db: DB,
    private readonly cfg: BackupConfig,
    private readonly log: { info(msg: string): void; error(msg: string): void },
    private readonly store = new GithubStore(cfg),
  ) {}

  getStatus(): BackupStatus {
    return { ...this.status };
  }

  /** Called after any request that may have written; uploads only when the change counter moved. */
  touch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.status.pending = true;
    this.timer = setTimeout(() => void this.flush(), this.cfg.debounceMs);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.running) await this.running;
    this.running = this.backup().finally(() => (this.running = null));
    await this.running;
  }

  private async backup(): Promise<void> {
    const changes = (await this.db.get<{ n: number }>("SELECT total_changes() AS n"))!.n;
    if (this.savedChanges !== null && changes === this.savedChanges) {
      this.status.pending = false;
      return;
    }
    const tmp = join(tmpdir(), `moncsy-snapshot-${process.pid}-${Date.now()}.db`);
    try {
      // VACUUM INTO writes a consistent copy without blocking readers for long.
      await this.db.run("VACUUM INTO ?", [tmp]);
      const blob = encryptBlob(readFileSync(tmp), this.cfg.key);
      await this.store.upload(blob, `backup ${new Date().toISOString()}`);
      this.savedChanges = changes;
      this.status = { ...this.status, lastBackupAt: new Date().toISOString(), lastError: null, pending: false };
      this.log.info(`backup uploaded to ${this.cfg.repo}/${this.cfg.path} (${blob.length} bytes)`);
    } catch (e) {
      this.status.lastError = (e as Error).message;
      this.log.error(`backup failed, will retry: ${(e as Error).message}`);
      // Retry later even if nothing else is written.
      this.timer = setTimeout(() => void this.flush(), Math.max(60_000, this.cfg.debounceMs));
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}
