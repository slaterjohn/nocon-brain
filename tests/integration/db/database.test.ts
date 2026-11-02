import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "@ncb/shared";
import {
  backupBeforeMigration, defaultMigrationsDir, migrate, MigrationError, openDb, openMainDatabase, WriterLock, WriterLockError,
} from "@ncb/db";
import { tempDir } from "../helpers.js";

describe("migrations from empty", () => {
  it("creates every table, STRICT, with the migration recorded", () => {
    const dir = tempDir();
    const m = openMainDatabase({ dataDir: dir });
    try {
      expect(m.migration.applied).toEqual(["0001_foundation", "0002_job_queue", "0003_pages_versions", "0004_bookmarks_history", "0005_crawl", "0006_sources_collections", "0007_downloads_refresh", "0008_imports", "0009_library_filters", "0010_search", "0011_online_search", "0012_intelligent_storage", "0013_discovery"]);
      const tables = m.db.all<{ name: string; strict: number }>(`PRAGMA table_list`).filter((t) => !t.name.startsWith("sqlite_"));
      const names = tables.map((t) => t.name);
      for (const t of ["users", "sessions", "settings", "user_settings", "app_meta", "activity_log", "volumes", "storage_policies",
        "volume_reservations", "blobs", "storage_usage_cache", "download_jobs", "crawl_jobs", "jobs", "host_state", "search_providers", "provider_result_cache", "usage_counters",
        "discovery_candidates", "candidate_provenance", "discovery_ledger", "discovery_state"]) {
        expect(names, t).toContain(t);
      }
      expect(tables.filter((t) => t.strict !== 1).map((t) => t.name)).toEqual([]);
      expect(m.db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      m.close();
    }
  });

  it("is idempotent on the second start and takes a backup only when something is pending", () => {
    const dir = tempDir();
    openMainDatabase({ dataDir: dir }).close();
    const second = openMainDatabase({ dataDir: dir });
    expect(second.migration.applied).toEqual([]);
    second.close();
    expect(fs.existsSync(path.join(dir, "backups"))).toBe(false);
  });

  it("enforces CHECKs, NOCASE usernames and STRICT typing", () => {
    const db = openDb(":memory:");
    migrate(db);
    db.run(`INSERT INTO users (public_id, username, password_hash, created_at) VALUES ('usr_1','Alice','h',1)`);
    expect(() => db.run(`INSERT INTO users (public_id, username, password_hash, created_at) VALUES ('usr_2','ALICE','h',1)`)).toThrow(/UNIQUE/);
    expect(() => db.run(`INSERT INTO users (public_id, username, password_hash, role, created_at) VALUES ('usr_3','b','h','root',1)`)).toThrow(/CHECK/);
    expect(() => db.run(`INSERT INTO settings (key, value_json, updated_at) VALUES ('k','{not json',1)`)).toThrow(/CHECK/);
    expect(() => db.run(`INSERT INTO settings (key, value_json, updated_at) VALUES ('k','{}','not a number')`)).toThrow(/cannot store TEXT|datatype/i);
    expect(() => db.run(`INSERT INTO download_jobs (public_id, kind, priority, requested_by, created_at) VALUES ('dl_1','capture',5,'user',1)`)).toThrow(/CHECK/);
    db.run(`INSERT INTO volumes (public_id,name,root_path,marker_uuid,state,reserve_free_bytes,is_default,created_at) VALUES ('vol_1','a','/v/a','u','online',0,1,1)`);
    expect(() => db.run(`INSERT INTO volumes (public_id,name,root_path,marker_uuid,state,reserve_free_bytes,is_default,created_at) VALUES ('vol_2','b','/v/b','u','online',0,1,1)`)).toThrow(/UNIQUE/);
    db.close();
  });

  it("enforces foreign keys (cascade and restrict)", () => {
    const db = openDb(":memory:");
    migrate(db);
    db.run(`INSERT INTO users (public_id, username, password_hash, created_at) VALUES ('usr_1','a','h',1)`);
    db.run(`INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at, absolute_expires_at) VALUES (1,'t',1,1,2,3)`);
    expect(() => db.run(`INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at, expires_at, absolute_expires_at) VALUES (99,'t2',1,1,2,3)`)).toThrow(/FOREIGN KEY/);
    db.run(`DELETE FROM users WHERE id = 1`);
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM sessions`)!.n).toBe(0);
    db.close();
  });

  it("refuses an edited migration and an unknown newer database", () => {
    const dir = tempDir();
    const mig = path.join(dir, "migrations");
    fs.mkdirSync(mig);
    fs.writeFileSync(path.join(mig, "0001_a.sql"), "CREATE TABLE a (x INTEGER) STRICT;");
    const db = openDb(path.join(dir, "x.db"));
    migrate(db, { migrationsDir: mig });
    fs.writeFileSync(path.join(mig, "0001_a.sql"), "CREATE TABLE a (x INTEGER, y INTEGER) STRICT;");
    expect(() => migrate(db, { migrationsDir: mig })).toThrow(MigrationError);
    fs.rmSync(path.join(mig, "0001_a.sql"));
    fs.writeFileSync(path.join(mig, "0002_b.sql"), "CREATE TABLE b (x INTEGER) STRICT;");
    expect(() => migrate(db, { migrationsDir: mig })).toThrow(/does not know/);
    db.close();
  });

  it("rolls a failing migration back completely", () => {
    const dir = tempDir();
    const mig = path.join(dir, "migrations");
    fs.mkdirSync(mig);
    fs.writeFileSync(path.join(mig, "0001_a.sql"), "CREATE TABLE a (x INTEGER) STRICT;\nCREATE TABLE a (x INTEGER) STRICT;");
    const db = openDb(path.join(dir, "x.db"));
    expect(() => migrate(db, { migrationsDir: mig })).toThrow();
    expect(db.all(`SELECT name FROM sqlite_master WHERE name = 'a'`)).toEqual([]);
    expect(db.all(`SELECT name FROM _migrations`)).toEqual([]);
    db.close();
  });
});

describe("pragmas", () => {
  it("applies WAL, synchronous=NORMAL, busy_timeout, foreign_keys=ON", () => {
    const dir = tempDir();
    const db = openDb(path.join(dir, "p.db"));
    expect(db.pragma("journal_mode")).toEqual([{ journal_mode: "wal" }]);
    expect(db.pragma("synchronous")).toEqual([{ synchronous: 1 }]); // 1 = NORMAL
    expect(db.pragma("busy_timeout")).toEqual([{ timeout: 5000 }]);
    expect(db.pragma("foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    db.close();
  });

  it("durable transactions use synchronous=FULL and restore NORMAL, even after a throw", () => {
    const db = openDb(path.join(tempDir(), "d.db"));
    db.exec("CREATE TABLE t (x INTEGER) STRICT");
    let inside: unknown;
    db.transaction(() => {
      inside = db.pragma("synchronous");
      db.run("INSERT INTO t VALUES (1)");
    }, { durable: true });
    // synchronous cannot change inside a transaction, so FULL must have been set before BEGIN
    expect(inside).toEqual([{ synchronous: 2 }]);
    expect(db.pragma("synchronous")).toEqual([{ synchronous: 1 }]);
    expect(() => db.transaction(() => { throw new Error("boom"); }, { durable: true })).toThrow("boom");
    expect(db.pragma("synchronous")).toEqual([{ synchronous: 1 }]);
    db.close();
  });

  it("rolls back on throw and joins nested transactions", () => {
    const db = openDb(":memory:");
    db.exec("CREATE TABLE t (x INTEGER) STRICT");
    expect(() => db.transaction(() => { db.run("INSERT INTO t VALUES (1)"); throw new Error("x"); })).toThrow("x");
    expect(db.all("SELECT * FROM t")).toEqual([]);
    db.transaction(() => { db.transaction(() => db.run("INSERT INTO t VALUES (2)")); });
    expect(db.all("SELECT * FROM t")).toEqual([{ x: 2 }]);
    db.close();
  });
});

describe("writer lock", () => {
  it("a second instance on the same data directory refuses to start", () => {
    const dir = tempDir();
    const first = openMainDatabase({ dataDir: dir });
    expect(() => openMainDatabase({ dataDir: dir })).toThrow(WriterLockError);
    first.close();
    openMainDatabase({ dataDir: dir }).close(); // released, so it starts again
  });

  it("refuses when another live process holds the lock", () => {
    const dir = tempDir();
    const lockPath = path.join(dir, "main.db.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, host: "other", startedAt: 1 }));
    expect(() => WriterLock.acquire(lockPath)).toThrow(/already holds/);
    expect(fs.existsSync(lockPath)).toBe(true); // a refused start must not delete the owner's lock
  });

  it("replaces a stale lock left by a dead process", () => {
    const dir = tempDir();
    const lockPath = path.join(dir, "main.db.lock");
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: Number(dead.stdout), host: "x", startedAt: 1 }));
    const lock = WriterLock.acquire(lockPath);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("replaces a lock that names our own pid but is not held (container restart as pid 1)", () => {
    const lockPath = path.join(tempDir(), "main.db.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: "old", startedAt: 1 }));
    WriterLock.acquire(lockPath).release();
  });

  it("treats a corrupt lock file as stale", () => {
    const lockPath = path.join(tempDir(), "main.db.lock");
    fs.writeFileSync(lockPath, "garbage");
    WriterLock.acquire(lockPath).release();
  });
});

describe("pre-migration backup", () => {
  it("VACUUM INTO produces a file that opens and passes integrity_check", () => {
    const dir = tempDir();
    const db = openDb(path.join(dir, "main.db"));
    migrate(db);
    db.run(`INSERT INTO users (public_id, username, password_hash, created_at) VALUES ('usr_1','a','h',1)`);
    const dest = backupBeforeMigration(db, path.join(dir, "backups"), "0003_x", Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(path.basename(dest)).toBe("main-pre-0003_x-20260102T030405Z.db");
    const copy = openDb(dest, { readonly: true });
    expect(copy.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(copy.get<{ n: number }>("SELECT COUNT(*) n FROM users")!.n).toBe(1);
    copy.close();
    db.close();
  });

  it("is taken before each pending migration on an existing database, and old ones are pruned", () => {
    const dir = tempDir();
    const mig = path.join(dir, "migrations");
    fs.mkdirSync(mig);
    const db = openDb(path.join(dir, "main.db"));
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const backupDir = path.join(dir, "backups");
    fs.writeFileSync(path.join(mig, "0001_a.sql"), "CREATE TABLE a (x INTEGER) STRICT;");
    expect(migrate(db, { migrationsDir: mig, backupDir, clock }).backups).toEqual([]); // empty database: nothing to protect
    for (let i = 2; i <= 5; i++) {
      fs.writeFileSync(path.join(mig, `000${i}_m.sql`), `CREATE TABLE m${i} (x INTEGER) STRICT;`);
      clock.advance(1000);
      const r = migrate(db, { migrationsDir: mig, backupDir, clock, keepBackups: 2 });
      expect(r.backups).toHaveLength(1);
      const b = openDb(r.backups[0]!, { readonly: true });
      expect(b.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      // the backup is the state BEFORE this migration
      expect(b.all(`SELECT name FROM sqlite_master WHERE name = 'm${i}'`)).toEqual([]);
      b.close();
    }
    expect(fs.readdirSync(backupDir)).toHaveLength(2);
    db.close();
  });

  it("the real migrations directory exists and is picked up by default", () => {
    expect(fs.readdirSync(defaultMigrationsDir).filter((f) => f.endsWith(".sql")).length).toBeGreaterThanOrEqual(2);
  });
});
