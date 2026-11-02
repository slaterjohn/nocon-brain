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

export interface FkDirective {
  table: string;
  column: string;
  clause: string;
}

/**
 * Lines of the form `-- ncb:fk <table>.<column> REFERENCES parent(id) ON DELETE ...` ask the runner to add a foreign key to an
 * existing column. SQLite cannot do that with ALTER TABLE, so the runner rebuilds the table (see `rebuildWithForeignKeys`).
 */
export function parseFkDirectives(sql: string): FkDirective[] {
  const out: FkDirective[] = [];
  for (const m of sql.matchAll(/^--\s*ncb:fk\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s+(REFERENCES\s+.+?)\s*$/gim)) {
    out.push({ table: m[1]!, column: m[2]!, clause: m[3]! });
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The SQLite 12-step table rebuild, for adding REFERENCES clauses to existing columns. The caller must have switched
 * foreign_keys off before the surrounding transaction began (the pragma does nothing inside one) and must run
 * `foreign_key_check` before committing. The new CREATE TABLE is derived from the stored one, so columns added by earlier
 * migrations are carried over without this file having to know them. Indexes and triggers on the table are recreated and
 * the AUTOINCREMENT counter is preserved.
 */
export function rebuildWithForeignKeys(db: Db, table: string, columns: { column: string; clause: string }[]): void {
  const row = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  if (!row) throw new MigrationError(`Cannot add foreign keys: table ${table} does not exist`);
  let ddl = row.sql;
  for (const { column, clause } of columns) {
    const re = new RegExp(`^(\\s*"?${escapeRe(column)}"?\\s+\\w+)([^,\\n]*?)(,?)[ \\t]*$`, "m");
    const m = re.exec(ddl);
    if (!m) throw new MigrationError(`Cannot find column ${table}.${column} in its CREATE TABLE statement`);
    if (/\bREFERENCES\b/i.test(m[2]!)) throw new MigrationError(`${table}.${column} already has a foreign key`);
    ddl = ddl.replace(re, `$1$2 ${clause}$3`);
  }
  const tmp = `${table}__rebuild`;
  const head = new RegExp(`^CREATE TABLE\\s+"?${escapeRe(table)}"?`, "i");
  if (!head.test(ddl)) throw new MigrationError(`Unexpected CREATE TABLE statement for ${table}`);
  ddl = ddl.replace(head, `CREATE TABLE "${tmp}"`);
  const aux = db.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL", [table]);
  const seq = db.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = ?", [table]);
  db.exec(ddl);
  db.exec(`INSERT INTO "${tmp}" SELECT * FROM "${table}"`);
  db.exec(`DROP TABLE "${table}"`);
  db.exec(`ALTER TABLE "${tmp}" RENAME TO "${table}"`);
  for (const a of aux) db.exec(a.sql);
  if (seq) {
    db.run("UPDATE sqlite_sequence SET seq = ? WHERE name = ?", [seq.seq, table]);
  }
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
    const fks = parseFkDirectives(m.sql);
    // Rebuilding a table that others reference must not cascade or fail on the dropped parent: foreign keys go off for the
    // duration (outside the transaction, where the pragma works) and are verified with foreign_key_check before commit.
    if (fks.length > 0) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(m.sql);
        const byTable = new Map<string, FkDirective[]>();
        for (const f of fks) byTable.set(f.table, [...(byTable.get(f.table) ?? []), f]);
        for (const [table, cols] of byTable) rebuildWithForeignKeys(db, table, cols);
        if (fks.length > 0 && db.pragma("foreign_key_check").length > 0) throw new MigrationError(`foreign_key_check failed after ${m.name}`);
        db.run("INSERT INTO _migrations (name, checksum, applied_at) VALUES (?, ?, ?)", [m.name, m.checksum, clock.now()]);
      });
    } finally {
      if (fks.length > 0) db.pragma("foreign_keys = ON");
    }
    result.applied.push(m.name);
    log(`applied ${m.name}`);
  }
  if (db.pragma("foreign_key_check").length > 0) throw new MigrationError("foreign_key_check failed after migration");
  return result;
}
