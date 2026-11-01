/**
 * The database seam. Everything above packages/db talks to this interface so `node:sqlite` or another
 * engine stays possible (docs/technology-decisions.md, Database). It is deliberately small and
 * synchronous, because better-sqlite3 is synchronous and the main thread holds the only writer.
 */
export type SqlValue = string | number | bigint | Buffer | null;
export type SqlParams = SqlValue[] | Record<string, SqlValue>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface TransactionOptions {
  /** BEGIN IMMEDIATE: take the write lock up front. Use for read-then-write units such as the queue claim. Default true. */
  immediate?: boolean;
  /**
   * Run with `synchronous=FULL` for this transaction, then restore the previous level. Use for user
   * data that cannot be recreated (settings, sources, bookmarks, collections).
   */
  durable?: boolean;
}

export interface Db {
  /** File path, or ":memory:". */
  readonly path: string;
  readonly readonly: boolean;
  run(sql: string, params?: SqlParams): RunResult;
  get<T = Record<string, unknown>>(sql: string, params?: SqlParams): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[];
  /** Runs one or more statements with no parameters (DDL, scripts). */
  exec(sql: string): void;
  /** Runs `fn` in a transaction; commits on return, rolls back on throw. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T, opts?: TransactionOptions): T;
  /** Runs a PRAGMA and returns its rows, e.g. `[{ journal_mode: "wal" }]`. */
  pragma(statement: string): Record<string, unknown>[];
  /** `VACUUM INTO`: a consistent copy of the database, safe while it is in use. */
  backupTo(destPath: string): void;
  /** `PRAGMA wal_checkpoint(...)`. Call with TRUNCATE at idle and on shutdown. */
  checkpoint(mode?: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE"): void;
  close(): void;
}
