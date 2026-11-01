import path from "node:path";
import type { Clock } from "@ncb/shared";
import type { BetterSqliteDb } from "./sqlite.js";
import { openDb } from "./sqlite.js";
import { WriterLock } from "./lock.js";
import { migrate, type MigrationResult } from "./migrate.js";

export interface MainDatabase {
  db: BetterSqliteDb;
  migration: MigrationResult;
  /** Checkpoints the WAL, closes the database and releases the writer lock. */
  close(): void;
}

export interface OpenMainOptions {
  /** `NCB_DATA_DIR`. Holds `db/main.db`, `db/main.db.lock` and `backups/`. */
  dataDir: string;
  clock?: Clock;
  migrationsDir?: string;
  log?: (message: string) => void;
}

/**
 * Startup sequence for the writer of `main.db`: take the lock (a second instance fails here), open with
 * pragmas, back up and migrate. Throws `WriterLockError` if another instance is running.
 */
export function openMainDatabase(opts: OpenMainOptions): MainDatabase {
  const dbDir = path.join(opts.dataDir, "db");
  const lock = WriterLock.acquire(path.join(dbDir, "main.db.lock"));
  try {
    const db = openDb(path.join(dbDir, "main.db"));
    try {
      const migration = migrate(db, {
        clock: opts.clock,
        migrationsDir: opts.migrationsDir,
        backupDir: path.join(opts.dataDir, "backups"),
        log: opts.log,
      });
      return {
        db,
        migration,
        close() {
          try {
            db.checkpoint("TRUNCATE");
          } finally {
            db.close();
            lock.release();
          }
        },
      };
    } catch (e) {
      db.close();
      throw e;
    }
  } catch (e) {
    lock.release();
    throw e;
  }
}
