import path from "node:path";
import { FakeClock } from "@ncb/shared";
import { JobQueue, migrate, openDb, type BetterSqliteDb, type QueueOptions } from "@ncb/db";
import { tempDir } from "../helpers.js";

export function setup(opts: QueueOptions & { file?: string } = {}) {
  const file = opts.file ?? path.join(tempDir(), "main.db");
  const db = openDb(file);
  migrate(db);
  const clock = new FakeClock();
  const q = new JobQueue(db, { clock, random: () => 0.5, ...opts });
  return { db, q, clock, file };
}

export function states(db: BetterSqliteDb): Record<string, number> {
  return Object.fromEntries(db.all<{ state: string; n: number }>("SELECT state, COUNT(*) n FROM jobs GROUP BY state").map((r) => [r.state, r.n]));
}

export function hostRow(db: BetterSqliteDb, host: string) {
  return db.get<{ in_flight: number; next_allowed_at: number; backoff_until: number; consecutive_failures: number }>(
    "SELECT * FROM host_state WHERE host = ?", [host],
  );
}
