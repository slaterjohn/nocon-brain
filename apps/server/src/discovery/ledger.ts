import type { Db } from "@ncb/db";
import type { Clock } from "@ncb/shared";

export type Lane = "active" | "background" | "auto_cache";
/** The two budgets: the active runner's, and the one search-driven downloads and the auto-cache share. */
export type Budget = "active" | "background";
export const budgetOf = (l: Lane): Budget => (l === "active" ? "active" : "background");

export interface LedgerRow {
  id: number; day: string; at: number; lane: Lane; candidate_id: number | null; download_job_id: number | null; host: string;
  requests: number; reserved_bytes: number; bytes: number | null; state: "reserved" | "settled"; outcome: string | null; settled_at: number | null;
}

/** The UTC calendar day of an instant. Daily budgets reset at 00:00 UTC. */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The budget ledger (tasks D-04 to D-06). Every download the runner or the auto-cache starts is entered before it starts: one
 * request and a byte allotment that is also the cap given to the capture. When the download ends the entry is settled with the bytes
 * it really took, so what is "used" is always the actual bytes of finished downloads plus the allotments of running ones.
 */
export class Ledger {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  reserve(a: { lane: Lane; candidateId: number | null; downloadJobId: number | null; host: string; bytes: number }): number {
    const now = this.clock.now();
    return Number(this.db.run(
      `INSERT INTO discovery_ledger (day, at, lane, candidate_id, download_job_id, host, requests, reserved_bytes, state) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'reserved')`,
      [dayOf(now), now, a.lane, a.candidateId, a.downloadJobId, a.host, Math.max(0, Math.floor(a.bytes))]).lastInsertRowid);
  }

  /** Requests and bytes spent today against one budget. */
  used(budget: Budget, now = this.clock.now()): { requests: number; bytes: number } {
    const lanes = budget === "active" ? ["active"] : ["background", "auto_cache"];
    const r = this.db.get<{ requests: number; bytes: number }>(
      `SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(CASE WHEN state = 'settled' THEN COALESCE(bytes, 0) ELSE reserved_bytes END), 0) AS bytes
       FROM discovery_ledger WHERE day = ? AND lane IN (${lanes.map(() => "?").join(",")})`, [dayOf(now), ...lanes])!;
    return r;
  }

  /** Downloads started today per host, across every lane. */
  sites(now = this.clock.now()): Map<string, number> {
    return new Map(this.db.all<{ host: string; n: number }>("SELECT host, SUM(requests) AS n FROM discovery_ledger WHERE day = ? GROUP BY host", [dayOf(now)]).map((r) => [r.host, r.n]));
  }

  topSites(now = this.clock.now(), limit = 10): { host: string; requests: number }[] {
    return this.db.all<{ host: string; requests: number }>(
      "SELECT host, SUM(requests) AS requests FROM discovery_ledger WHERE day = ? GROUP BY host ORDER BY requests DESC, host LIMIT ?", [dayOf(now), limit]);
  }

  /** Discovery downloads queued or running now. */
  inFlight(): number {
    return this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM discovery_ledger l JOIN download_jobs d ON d.id = l.download_job_id WHERE l.state = 'reserved' AND d.state IN ('queued','running','paused')`)!.n;
  }

  /**
   * Settles every open entry whose download has ended: the bytes it really took replace the allotment. A download that never started
   * (cancelled while queued) gives its request back. Returns how many entries were settled.
   */
  settle(): number {
    const now = this.clock.now();
    const open = this.db.all<{ id: number; job: number | null; state: string | null; started: number | null }>(
      `SELECT l.id, l.download_job_id AS job, d.state, d.started_at AS started FROM discovery_ledger l LEFT JOIN download_jobs d ON d.id = l.download_job_id WHERE l.state = 'reserved'`);
    let n = 0;
    for (const o of open) {
      if (o.job !== null && o.state !== null && !["completed", "failed", "cancelled"].includes(o.state)) continue;
      const bytes = o.job === null ? 0 : (this.db.get<{ b: number }>("SELECT COALESCE(SUM(total_bytes), 0) AS b FROM page_versions WHERE download_job_id = ?", [o.job])?.b ?? 0);
      const outcome = o.state === "cancelled" ? "cancelled" : o.state === "failed" || o.state === null ? "failed" : bytes > 0 ? "archived" : "unchanged";
      const gaveBack = outcome === "cancelled" && o.started === null;
      this.db.run("UPDATE discovery_ledger SET state = 'settled', bytes = ?, outcome = ?, settled_at = ?, requests = CASE WHEN ? THEN 0 ELSE requests END WHERE id = ?", [bytes, outcome, now, gaveBack ? 1 : 0, o.id]);
      n++;
    }
    return n;
  }

  prune(olderThanDays = 90): number {
    return this.db.run("DELETE FROM discovery_ledger WHERE state = 'settled' AND at < ?", [this.clock.now() - olderThanDays * 86_400_000]).changes;
  }

  list(f: { day?: string; lane?: Lane; limit: number; cursor?: number }): { items: LedgerRow[]; nextCursor?: string } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.day) { where.push("day = ?"); args.push(f.day); }
    if (f.lane) { where.push("lane = ?"); args.push(f.lane); }
    if (f.cursor !== undefined) { where.push("id < ?"); args.push(f.cursor); }
    const rows = this.db.all<LedgerRow>(`SELECT * FROM discovery_ledger ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`, [...args, f.limit + 1]);
    const page = rows.slice(0, f.limit);
    return { items: page, ...(rows.length > f.limit ? { nextCursor: String(page[page.length - 1]!.id) } : {}) };
  }
}
