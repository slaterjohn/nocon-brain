import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { WriterLock, type Db } from "@ncb/db";
import type { Clock } from "@ncb/shared";
import { AppError } from "@ncb/shared";

/**
 * Backups and restores (task H-02, docs/guides/backup-restore.md).
 *
 * A backup is a folder `<data>/backups/backup-<UTC stamp>/` holding consistent copies made with `VACUUM INTO` (never a file copy of a live
 * WAL database) and `manifest.json` with a SHA-256 for each file. It is built under a temporary name and renamed when complete, so a
 * crash leaves no half-written backup that looks real. What it holds:
 *   - `main.db`: always. Pages, versions, sources, settings, accounts, the job queue, the ZIM registry; everything except file contents.
 *   - `index.db`: only on request. The search index is rebuilt from `main.db` after a restore, so leaving it out is safe and keeps the backup small.
 *   - `secret.key`: only on request. It decrypts stored provider keys; without it they must be entered again. Keep it apart from the backup.
 * Blob files and ZIM files live on the storage volumes and are NOT in the backup folder: copy those separately (the guide says how and in which order).
 */

export const BACKUP_PREFIX = "backup-";

export interface BackupFile {
  name: "main.db" | "index.db" | "secret.key";
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  format: 1;
  createdAt: string;
  appVersion: string;
  /** Name of the last migration the database had applied. */
  schema: string | null;
  files: BackupFile[];
  counts: { pages: number; versions: number; sources: number; blobs: number };
  /** The storage volumes at the time: their blob files must be restored to the same paths. */
  volumes: { name: string; rootPath: string; blobs: number }[];
  integrity: "ok";
  notes: string[];
}

export interface BackupOptions {
  includeIndex?: boolean;
  includeSecretKey?: boolean;
}

export interface BackupResult {
  /** Folder name under `backups/`. */
  dir: string;
  path: string;
  manifest: BackupManifest;
  pruned: string[];
}

export interface BackupServiceOptions {
  db: Db;
  clock: Clock;
  dataDir: string;
  appVersion: string;
  /** Backups kept; older ones are removed after a new one succeeds. Default 7. */
  keep?: number;
  /** Fault hook for tests: called with a step name; throw (or kill the process) to simulate a crash. */
  fault?: (step: "after-main" | "before-rename") => void;
}

export function sha256File(file: string): string {
  const h = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/** Runs `PRAGMA integrity_check` on a database file opened read-only. Returns the messages that are not "ok". */
export function integrityProblems(file: string): string[] {
  const d = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = d.pragma("integrity_check") as { integrity_check: string }[];
    return rows.map((r) => r.integrity_check).filter((m) => m !== "ok");
  } finally {
    d.close();
  }
}

function fsyncFile(file: string): void {
  const fd = fs.openSync(file, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* some filesystems cannot sync a directory */ }
}

export class BackupService {
  constructor(private readonly o: BackupServiceOptions) {}

  get dir(): string { return path.join(this.o.dataDir, "backups"); }

  /** Finished backups, newest first. A folder without a readable manifest is not listed (it is an unfinished one). */
  list(): { dir: string; manifest: BackupManifest }[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir).filter((n) => n.startsWith(BACKUP_PREFIX)); } catch { return []; }
    const out: { dir: string; manifest: BackupManifest }[] = [];
    for (const dir of names) {
      try { out.push({ dir, manifest: JSON.parse(fs.readFileSync(path.join(this.dir, dir, "manifest.json"), "utf8")) as BackupManifest }); } catch { /* unfinished */ }
    }
    return out.sort((a, b) => (a.dir < b.dir ? 1 : -1));
  }

  /** Removes leftovers of a backup a crash interrupted. Called at startup. */
  cleanUnfinished(): number {
    let n = 0;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (name.startsWith(".tmp-backup-")) { fs.rmSync(path.join(this.dir, name), { recursive: true, force: true }); n++; }
      }
    } catch { /* no backups folder yet */ }
    return n;
  }

  run(opts: BackupOptions = {}): BackupResult {
    const { db, clock } = this.o;
    fs.mkdirSync(this.dir, { recursive: true });
    const stamp = new Date(clock.now()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    let name = `${BACKUP_PREFIX}${stamp}`;
    for (let i = 2; fs.existsSync(path.join(this.dir, name)); i++) name = `${BACKUP_PREFIX}${stamp}-${i}`;
    const tmp = path.join(this.dir, `.tmp-backup-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    const notes: string[] = [];
    try {
      db.backupTo(path.join(tmp, "main.db"));
      this.o.fault?.("after-main");
      const files: BackupFile[] = [{ name: "main.db", bytes: 0, sha256: "" }];

      const indexFile = path.join(this.o.dataDir, "index", "index.db");
      if (opts.includeIndex) {
        if (fs.existsSync(indexFile)) {
          const src = new Database(indexFile, { readonly: true, fileMustExist: true });
          try { src.prepare("VACUUM INTO ?").run(path.join(tmp, "index.db")); } finally { src.close(); }
          files.push({ name: "index.db", bytes: 0, sha256: "" });
        } else notes.push("The search index did not exist yet, so it is not in this backup. It is rebuilt after a restore.");
      } else notes.push("The search index is not in this backup. It is rebuilt from the archive after a restore.");

      const keyFile = path.join(this.o.dataDir, "secrets", "secret.key");
      if (opts.includeSecretKey) {
        if (fs.existsSync(keyFile)) {
          fs.copyFileSync(keyFile, path.join(tmp, "secret.key"));
          fs.chmodSync(path.join(tmp, "secret.key"), 0o600);
          files.push({ name: "secret.key", bytes: 0, sha256: "" });
        } else notes.push("No secret key file exists (the key comes from NCB_SECRET_KEY); keep that value safe separately.");
      } else notes.push("The secret key is not in this backup. Without it, stored search-provider keys must be entered again after a restore.");

      for (const f of files) {
        const p = path.join(tmp, f.name);
        if (f.name !== "secret.key") {
          const bad = integrityProblems(p);
          if (bad.length) throw new AppError("internal", `The backup copy of ${f.name} failed its integrity check: ${bad[0]}`);
        }
        f.bytes = fs.statSync(p).size;
        f.sha256 = sha256File(p);
        fsyncFile(p);
      }

      const one = <T>(sql: string): T => db.get<T>(sql)!;
      const manifest: BackupManifest = {
        format: 1,
        createdAt: new Date(clock.now()).toISOString(),
        appVersion: this.o.appVersion,
        schema: db.get<{ name: string }>("SELECT name FROM _migrations ORDER BY name DESC LIMIT 1")?.name ?? null,
        files,
        counts: {
          pages: one<{ n: number }>("SELECT COUNT(*) AS n FROM pages").n,
          versions: one<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions").n,
          sources: one<{ n: number }>("SELECT COUNT(*) AS n FROM sources").n,
          blobs: one<{ n: number }>("SELECT COUNT(*) AS n FROM blobs WHERE state = 'ready'").n,
        },
        volumes: db.all<{ name: string; root_path: string; n: number }>(
          "SELECT v.name, v.root_path, (SELECT COUNT(*) FROM blobs b WHERE b.volume_id = v.id AND b.state = 'ready') AS n FROM volumes v ORDER BY v.id")
          .map((v) => ({ name: v.name, rootPath: v.root_path, blobs: v.n })),
        integrity: "ok",
        notes,
      };
      const mf = path.join(tmp, "manifest.json");
      fs.writeFileSync(mf, JSON.stringify(manifest, null, 2));
      fsyncFile(mf);
      fsyncDir(tmp);
      this.o.fault?.("before-rename");
      fs.renameSync(tmp, path.join(this.dir, name));
      fsyncDir(this.dir);
      const pruned = this.prune();
      return { dir: name, path: path.join(this.dir, name), manifest, pruned };
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  /** Keeps the newest `keep` finished backups. */
  prune(): string[] {
    const keep = Math.max(1, this.o.keep ?? 7);
    const all = this.list();
    const gone: string[] = [];
    for (const b of all.slice(keep)) {
      fs.rmSync(path.join(this.dir, b.dir), { recursive: true, force: true });
      gone.push(b.dir);
    }
    return gone;
  }
}

// ---- restore -------------------------------------------------------------------------------------

export interface RestoreOptions {
  /** The backup folder (containing manifest.json). */
  backupDir: string;
  /** The data directory to restore into (`NCB_DATA_DIR`). */
  dataDir: string;
  /** Replace an existing database. The old one is kept as `main.db.before-restore-<stamp>`. */
  force?: boolean;
  /** Replace an existing secret key too. Default: an existing key is kept. */
  replaceSecretKey?: boolean;
  now?: () => number;
  log?: (message: string) => void;
}

export interface RestoreResult {
  restored: string[];
  /** Things the Human has to do or check next. */
  warnings: string[];
  manifest: BackupManifest;
  keptOld?: string;
}

export class RestoreError extends Error {}

/**
 * Restores a backup into a data directory. The server must be stopped (the writer lock is taken for the duration, so a running server makes
 * this fail). Every file is checked against the manifest's SHA-256 and `PRAGMA integrity_check` before anything in the data directory changes.
 * Nothing is migrated here: the next start of the server applies any newer migrations (after its own pre-migration backup).
 */
export function restoreBackup(o: RestoreOptions): RestoreResult {
  const log = o.log ?? (() => {});
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(o.backupDir, "manifest.json"), "utf8")) as BackupManifest;
  } catch {
    throw new RestoreError(`${o.backupDir} is not a finished backup: manifest.json is missing or unreadable.`);
  }
  if (manifest.format !== 1) throw new RestoreError(`Unknown backup format ${String(manifest.format)}.`);
  const main = manifest.files.find((f) => f.name === "main.db");
  if (!main) throw new RestoreError("The backup has no main.db.");

  // 1. Check the backup before touching anything.
  for (const f of manifest.files) {
    const p = path.join(o.backupDir, f.name);
    if (!fs.existsSync(p)) throw new RestoreError(`The backup is missing ${f.name}.`);
    if (sha256File(p) !== f.sha256) throw new RestoreError(`${f.name} does not match its checksum. The backup is damaged; use an earlier one.`);
    if (f.name !== "secret.key") {
      const bad = integrityProblems(p);
      if (bad.length) throw new RestoreError(`${f.name} failed its integrity check (${bad[0]}). Use an earlier backup.`);
    }
  }

  // 2. Make sure no server is running on the target.
  const dbDir = path.join(o.dataDir, "db");
  fs.mkdirSync(dbDir, { recursive: true });
  const lock = WriterLock.acquire(path.join(dbDir, "main.db.lock"));
  const restored: string[] = [];
  const warnings: string[] = [];
  let keptOld: string | undefined;
  try {
    const target = path.join(dbDir, "main.db");
    if (fs.existsSync(target)) {
      if (!o.force) throw new RestoreError(`${target} already exists. Restore into an empty data directory, or pass force to replace it (the old database is kept alongside).`);
      keptOld = `${target}.before-restore-${new Date((o.now ?? Date.now)()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
      fs.renameSync(target, keptOld);
    }
    for (const ext of ["-wal", "-shm"]) fs.rmSync(target + ext, { force: true });

    const place = (name: string, dest: string, mode?: number) => {
      const part = `${dest}.restoring`;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(o.backupDir, name), part);
      if (mode !== undefined) fs.chmodSync(part, mode);
      fsyncFile(part);
      fs.renameSync(part, dest);
      fsyncDir(path.dirname(dest));
      restored.push(name);
      log(`restored ${name}`);
    };
    place("main.db", target);

    const indexDir = path.join(o.dataDir, "index");
    for (const stale of ["index.db", "index.db-wal", "index.db-shm", "index.rebuild.db", "index.rebuild.db-wal", "index.rebuild.db-shm"]) fs.rmSync(path.join(indexDir, stale), { force: true });
    if (manifest.files.some((f) => f.name === "index.db")) place("index.db", path.join(indexDir, "index.db"));
    else warnings.push("The search index was not in the backup. It is rebuilt when the server starts; searching works while it rebuilds.");

    const keyDest = path.join(o.dataDir, "secrets", "secret.key");
    if (manifest.files.some((f) => f.name === "secret.key")) {
      if (!fs.existsSync(keyDest) || o.replaceSecretKey) { fs.mkdirSync(path.dirname(keyDest), { recursive: true, mode: 0o700 }); place("secret.key", keyDest, 0o600); }
      else warnings.push("A secret key already exists in the data directory, so the one in the backup was not used. Pass replaceSecretKey to use it.");
    } else {
      warnings.push("The backup has no secret key. If this is a new machine, provider API keys must be entered again unless NCB_SECRET_KEY is set to the old value.");
    }
  } finally {
    lock.release();
  }

  for (const v of manifest.volumes) {
    if (!fs.existsSync(v.rootPath)) warnings.push(`Storage volume "${v.name}" expected its files at ${v.rootPath}, which does not exist here. Restore the blob files to that path (or mount it) before using the archive, then run a verify.`);
  }
  warnings.push("Start the server to apply any newer migrations, then run a verify (Settings, Storage) to confirm every stored file is present.");
  return { restored, warnings, manifest, ...(keptOld ? { keptOld } : {}) };
}
