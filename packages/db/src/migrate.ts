import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "@ncb/shared";
import { systemClock } from "@ncb/shared";
import type { Db } from "./db.js";

/** Forward-only SQL migrations (docs/data-model.md section 8). Files are `NNNN_name.sql`, applied in name order. */
export const defaultMigrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

export interface MigrateOptions {
  migrationsDir?: string;
  /** Where pre-migration backups go. Omit to skip backups (in-memory databases, tests). */
  backupDir?: string;
  /** Number of pre-migration backups kept. Default 5. */
  keepBackups?: number;
  clock?: Clock;
  log?: (message: string) => void;
}

export interface MigrationResult {
  applied: string[];
  backups: string[];
}

export class MigrationError extends Error {}

function listMigrations(dir: string): { name: string; sql: string; checksum: string }[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = fs.readFileSync(path.join(dir, f), "utf8");
      return { name: f.replace(/\.sql$/, ""), sql, checksum: crypto.createHash("sha256").update(sql).digest("hex") };
    });
}

/** Writes `<backupDir>/main-pre-<migration>-<timestamp>.db` using VACUUM INTO and prunes old ones. */
export function backupBeforeMigration(db: Db, backupDir: string, migrationName: string, nowMs: number, keep = 5): string {
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dest = path.join(backupDir, `main-pre-${migrationName}-${stamp}.db`);
  db.backupTo(dest);
  const old = fs
    .readdirSync(backupDir)
    .filter((f) => /^main-pre-.*\.db$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t || (a.f < b.f ? 1 : -1));
  for (const o of old.slice(keep)) fs.unlinkSync(path.join(backupDir, o.f));
  return dest;
}

export function migrate(db: Db, opts: MigrateOptions = {}): MigrationResult {
  const dir = opts.migrationsDir ?? defaultMigrationsDir;
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? (() => {});
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT");

  const done = new Map(db.all<{ name: string; checksum: string }>("SELECT name, checksum FROM _migrations").map((r) => [r.name, r.checksum]));
  const all = listMigrations(dir);
  for (const m of all) {
    const prior = done.get(m.name);
    if (prior !== undefined && prior !== m.checksum) {
      throw new MigrationError(`Migration ${m.name} was edited after it was applied. Migrations are forward-only; add a new one.`);
    }
  }
  const known = new Set(all.map((m) => m.name));
  for (const name of done.keys()) {
    if (!known.has(name)) throw new MigrationError(`Database has migration ${name} that this version does not know. Upgrade the application.`);
  }

  const result: MigrationResult = { applied: [], backups: [] };
  for (const m of all.filter((x) => !done.has(x.name))) {
    // A database that had no migrations yet (fresh install) has nothing to protect.
    if (opts.backupDir && done.size > 0) {
      const dest = backupBeforeMigration(db, opts.backupDir, m.name, clock.now(), opts.keepBackups ?? 5);
      result.backups.push(dest);
      log(`backup before ${m.name}: ${dest}`);
    }
    db.transaction(() => {
      db.exec(m.sql);
      db.run("INSERT INTO _migrations (name, checksum, applied_at) VALUES (?, ?, ?)", [m.name, m.checksum, clock.now()]);
    });
    result.applied.push(m.name);
    log(`applied ${m.name}`);
  }
  if (db.pragma("foreign_key_check").length > 0) throw new MigrationError("foreign_key_check failed after migration");
  return result;
}
