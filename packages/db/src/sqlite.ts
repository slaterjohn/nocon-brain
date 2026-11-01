import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Db, RunResult, SqlParams, TransactionOptions } from "./db.js";
import * as schema from "./schema/index.js";

export interface OpenOptions {
  /** Open read-only (a reader connection). No pragmas that write are applied. */
  readonly?: boolean;
  /** Default 5000. Time a statement waits for another connection's write lock. */
  busyTimeoutMs?: number;
  /** Create the parent directory when missing. Default true. */
  createDir?: boolean;
}

const STMT_CACHE_MAX = 200;

/** better-sqlite3 implementation of `Db`. Pragmas: WAL, synchronous=NORMAL, busy_timeout, foreign_keys=ON. */
export class BetterSqliteDb implements Db {
  readonly path: string;
  readonly readonly: boolean;
  /** The underlying handle, for adapter-specific needs (Drizzle). Prefer the `Db` methods. */
  readonly raw: Database.Database;
  private readonly cache = new Map<string, Database.Statement>();
  private depth = 0;
  private closed = false;

  constructor(file: string, opts: OpenOptions = {}) {
    this.path = file;
    this.readonly = opts.readonly ?? false;
    if (file !== ":memory:" && !this.readonly && opts.createDir !== false) fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new Database(file, { readonly: this.readonly });
    this.raw.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
    this.raw.pragma("foreign_keys = ON");
    if (!this.readonly) {
      this.raw.pragma("journal_mode = WAL");
      this.raw.pragma("synchronous = NORMAL");
    }
  }

  private stmt(sql: string): Database.Statement {
    let s = this.cache.get(sql);
    if (!s) {
      if (this.cache.size >= STMT_CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  run(sql: string, params: SqlParams = []): RunResult {
    const r = this.stmt(sql).run(params as never);
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }

  get<T = Record<string, unknown>>(sql: string, params: SqlParams = []): T | undefined {
    return this.stmt(sql).get(params as never) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, params: SqlParams = []): T[] {
    return this.stmt(sql).all(params as never) as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  transaction<T>(fn: () => T, opts: TransactionOptions = {}): T {
    if (this.depth > 0) return fn(); // join the outer transaction
    const durable = opts.durable === true;
    const prevSync = durable ? (this.raw.pragma("synchronous", { simple: true }) as number) : 0;
    if (durable) this.raw.pragma("synchronous = FULL");
    this.depth++;
    try {
      this.raw.exec(opts.immediate === false ? "BEGIN" : "BEGIN IMMEDIATE");
      try {
        const out = fn();
        this.raw.exec("COMMIT");
        return out;
      } catch (e) {
        if (this.raw.inTransaction) this.raw.exec("ROLLBACK");
        throw e;
      }
    } finally {
      this.depth--;
      if (durable) this.raw.pragma(`synchronous = ${prevSync}`);
    }
  }

  pragma(statement: string): Record<string, unknown>[] {
    return this.raw.pragma(statement) as Record<string, unknown>[];
  }

  backupTo(destPath: string): void {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    if (fs.existsSync(destPath)) throw new Error(`Backup target already exists: ${destPath}`);
    this.raw.prepare("VACUUM INTO ?").run(destPath);
  }

  checkpoint(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"): void {
    this.raw.pragma(`wal_checkpoint(${mode})`);
  }

  /** Drizzle query builder over the same connection (shares transactions started with `transaction()`). */
  orm(): BetterSQLite3Database<typeof schema> {
    return drizzle(this.raw, { schema });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    this.raw.close();
  }
}

export function openDb(file: string, opts: OpenOptions = {}): BetterSqliteDb {
  return new BetterSqliteDb(file, opts);
}
