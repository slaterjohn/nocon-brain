import type { Clock, JobQueueName, JobState, JobType } from "@ncb/shared";
import { steadyClock } from "@ncb/shared";
import type { Db, SqlValue } from "../db.js";
import { backoffDelayMs, type BackoffOptions } from "./backoff.js";

export interface Job {
  id: number;
  type: JobType;
  queue: JobQueueName;
  state: JobState;
  priority: number;
  score: number;
  host: string | null;
  url: string | null;
  urlKey: string | null;
  downloadJobId: number | null;
  crawlJobId: number | null;
  versionId: number | null;
  depth: number;
  payload: unknown;
  idempotencyKey: string | null;
  attempts: number;
  maxAttempts: number;
  runAt: number;
  leaseUntil: number | null;
  workerId: string | null;
  lastError: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface EnqueueInput {
  type: JobType;
  queue: JobQueueName;
  /** Higher runs first. Default 0. */
  priority?: number;
  /** Link-priority score for frontier ordering. Higher first. Default 0. */
  score?: number;
  /** Lower-case host for the per-host invariant. Omit for jobs that are not rate limited by host. */
  host?: string;
  url?: string;
  urlKey?: string;
  downloadJobId?: number;
  crawlJobId?: number;
  versionId?: number;
  depth?: number;
  payload?: unknown;
  /** While a job with the same (type, key) is queued, running or held, enqueue returns that job instead. */
  idempotencyKey?: string;
  maxAttempts?: number;
  /** Earliest start time (queue clock, ms). Default now. */
  runAt?: number;
  /** Start `held` instead of `queued`. */
  held?: boolean;
}

export interface EnqueueResult {
  id: number;
  /** False when an existing job was returned (idempotency key or crawl visited set). */
  created: boolean;
}

export interface QueueOptions {
  /** Use `steadyClock()` in production so wall-clock jumps cannot expire leases (task F-18). */
  clock?: Clock;
  leaseMs?: number;
  backoff?: BackoffOptions;
  random?: () => number;
}

export interface FailOptions {
  /** Default true: retry with backoff until `max_attempts`, then dead-letter. False: mark `failed` now. */
  retry?: boolean;
  /** Overrides the computed backoff (for example a `Retry-After` value). */
  retryAfterMs?: number;
  /** Also pause the whole host for this long (429/503 handling). Sets `host_state.backoff_until`. */
  hostBackoffMs?: number;
}

export interface ReapResult {
  requeued: number;
  dead: number;
}

export interface StartupRecovery extends ReapResult {
  inFlightRebuilt: number;
  runAtClamped: number;
}

type Row = Record<string, SqlValue>;

const CLAIM_SQL = `
UPDATE jobs SET state = 'running', lease_until = :lease, worker_id = :worker, attempts = attempts + 1, started_at = :now
WHERE id = (
  SELECT j.id FROM jobs j LEFT JOIN host_state h ON h.host = j.host
  WHERE j.queue = :queue AND j.state = 'queued' AND j.run_at <= :now
    AND (j.host IS NULL OR (
      COALESCE(h.in_flight, 0) < COALESCE(h.max_concurrent, :defaultPerHost)
      AND COALESCE(h.next_allowed_at, 0) <= :now
      AND COALESCE(h.backoff_until, 0) <= :now))
  ORDER BY j.priority DESC, j.score DESC, j.id
  LIMIT 1)
RETURNING *`;

function toJob(r: Row): Job {
  return {
    id: r.id as number,
    type: r.type as JobType,
    queue: r.queue as JobQueueName,
    state: r.state as JobState,
    priority: r.priority as number,
    score: r.score as number,
    host: r.host as string | null,
    url: r.url as string | null,
    urlKey: r.url_key as string | null,
    downloadJobId: r.download_job_id as number | null,
    crawlJobId: r.crawl_job_id as number | null,
    versionId: r.version_id as number | null,
    depth: r.depth as number,
    payload: JSON.parse(r.payload_json as string),
    idempotencyKey: r.idempotency_key as string | null,
    attempts: r.attempts as number,
    maxAttempts: r.max_attempts as number,
    runAt: r.run_at as number,
    leaseUntil: r.lease_until as number | null,
    workerId: r.worker_id as string | null,
    lastError: r.last_error as string | null,
    createdAt: r.created_at as number,
    startedAt: r.started_at as number | null,
    finishedAt: r.finished_at as number | null,
  };
}

/**
 * The persistent job queue on SQLite. Every method is one short transaction; call it from the thread
 * that owns the writer connection (docs/architecture.md). Workers talk to it through messages, or hold
 * their own `Db` connection to the same file (WAL and `BEGIN IMMEDIATE` serialise the writes).
 */
export class JobQueue {
  private readonly clock: Clock;
  private readonly leaseMs: number;
  private readonly backoff: BackoffOptions;
  private readonly random: () => number;
  /** Used when a host has no `host_state` row yet. Matches the column default. */
  private readonly defaultPerHost = 1;

  constructor(private readonly db: Db, opts: QueueOptions = {}) {
    this.clock = opts.clock ?? steadyClock();
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.backoff = opts.backoff ?? {};
    this.random = opts.random ?? Math.random;
  }

  // ---- producing -----------------------------------------------------------------------------

  enqueue(input: EnqueueInput): EnqueueResult {
    const now = this.clock.now();
    const r = this.db.run(
      `INSERT INTO jobs (type, queue, state, priority, score, host, url, url_key, download_job_id, crawl_job_id, version_id,
                         depth, payload_json, idempotency_key, max_attempts, run_at, created_at)
       VALUES (@type, @queue, @state, @priority, @score, @host, @url, @urlKey, @downloadJobId, @crawlJobId, @versionId,
               @depth, @payload, @key, @maxAttempts, @runAt, @now)
       ON CONFLICT DO NOTHING`,
      {
        type: input.type,
        queue: input.queue,
        state: input.held ? "held" : "queued",
        priority: input.priority ?? 0,
        score: input.score ?? 0,
        host: input.host ?? null,
        url: input.url ?? null,
        urlKey: input.urlKey ?? null,
        downloadJobId: input.downloadJobId ?? null,
        crawlJobId: input.crawlJobId ?? null,
        versionId: input.versionId ?? null,
        depth: input.depth ?? 0,
        payload: JSON.stringify(input.payload ?? {}),
        key: input.idempotencyKey ?? null,
        maxAttempts: input.maxAttempts ?? 5,
        runAt: input.runAt ?? now,
        now,
      },
    );
    if (r.changes === 1) return { id: Number(r.lastInsertRowid), created: true };

    // A unique index said no: either the idempotency key or the crawl visited set. Return the winner.
    let existing: { id: number } | undefined;
    if (input.idempotencyKey) {
      existing = this.db.get(
        `SELECT id FROM jobs WHERE type = ? AND idempotency_key = ? AND state IN ('queued','running','held')`,
        [input.type, input.idempotencyKey],
      );
    }
    if (!existing && input.crawlJobId !== undefined && input.urlKey !== undefined) {
      existing = this.db.get(`SELECT id FROM jobs WHERE crawl_job_id = ? AND url_key = ?`, [input.crawlJobId, input.urlKey]);
    }
    if (!existing) throw new Error("enqueue was rejected by a unique index but no existing job was found");
    return { id: existing.id, created: false };
  }

  /** Enqueues many jobs in one transaction. Returns how many were new. */
  enqueueMany(inputs: EnqueueInput[]): number {
    return this.db.transaction(() => inputs.reduce((n, i) => n + (this.enqueue(i).created ? 1 : 0), 0));
  }

  // ---- consuming -----------------------------------------------------------------------------

  /**
   * Takes the best runnable job in `queue`, or undefined. Respects each host's `max_concurrent` (default 1),
   * `next_allowed_at` and `backoff_until`, and increments the host's `in_flight` in the same transaction.
   */
  claim(queue: JobQueueName, workerId: string, leaseMs: number = this.leaseMs): Job | undefined {
    return this.db.transaction(() => {
      const now = this.clock.now();
      const row = this.db.get<Row>(CLAIM_SQL, { queue, worker: workerId, lease: now + leaseMs, now, defaultPerHost: this.defaultPerHost });
      if (!row) return undefined;
      const host = row.host as string | null;
      if (host) {
        this.db.run(`INSERT OR IGNORE INTO host_state (host) VALUES (?)`, [host]);
        this.db.run(
          `UPDATE host_state SET in_flight = in_flight + 1, next_allowed_at = MAX(next_allowed_at, ? + crawl_delay_ms) WHERE host = ?`,
          [now, host],
        );
      }
      return toJob(row);
    });
  }

  /** Extends the lease. Returns false when the job is no longer running under this worker (lost lease). */
  heartbeat(jobId: number, workerId: string, leaseMs: number = this.leaseMs): boolean {
    const r = this.db.run(`UPDATE jobs SET lease_until = ? WHERE id = ? AND state = 'running' AND worker_id = ?`, [
      this.clock.now() + leaseMs, jobId, workerId,
    ]);
    return r.changes === 1;
  }

  /** running -> done. Returns false if the worker no longer owns the job (cancelled, or the lease expired and it was re-claimed). */
  complete(jobId: number, workerId: string): boolean {
    return this.db.transaction(() => {
      const now = this.clock.now();
      const row = this.db.get<{ host: string | null }>(
        `UPDATE jobs SET state = 'done', lease_until = NULL, finished_at = ? WHERE id = ? AND state = 'running' AND worker_id = ? RETURNING host`,
        [now, jobId, workerId],
      );
      if (!row) return false;
      this.releaseHost(row.host, now, { success: true });
      return true;
    });
  }

  /**
   * running -> queued with backoff, or `dead` when attempts are used up, or `failed` when `retry` is false.
   * Returns the new state, or undefined if the worker no longer owns the job.
   */
  fail(jobId: number, workerId: string, error: string, opts: FailOptions = {}): JobState | undefined {
    return this.db.transaction(() => {
      const now = this.clock.now();
      const job = this.db.get<{ attempts: number; max_attempts: number; host: string | null }>(
        `SELECT attempts, max_attempts, host FROM jobs WHERE id = ? AND state = 'running' AND worker_id = ?`,
        [jobId, workerId],
      );
      if (!job) return undefined;
      const retry = opts.retry !== false;
      let next: JobState;
      let runAt = now;
      if (!retry) next = "failed";
      else if (job.attempts >= job.max_attempts) next = "dead";
      else {
        next = "queued";
        runAt = now + (opts.retryAfterMs ?? backoffDelayMs(job.attempts, this.backoff, this.random));
      }
      this.db.run(
        `UPDATE jobs SET state = ?, run_at = ?, lease_until = NULL, worker_id = CASE WHEN ? = 'queued' THEN NULL ELSE worker_id END,
                last_error = ?, finished_at = CASE WHEN ? = 'queued' THEN NULL ELSE ? END
         WHERE id = ?`,
        [next, runAt, next, error.slice(0, 2000), next, now, jobId],
      );
      this.releaseHost(job.host, now, { success: false, hostBackoffMs: opts.hostBackoffMs });
      return next;
    });
  }

  /** running -> queued without using up an attempt (graceful shutdown, pause between stages). */
  release(jobId: number, workerId: string): boolean {
    return this.db.transaction(() => {
      const now = this.clock.now();
      const row = this.db.get<{ host: string | null }>(
        `UPDATE jobs SET state = 'queued', lease_until = NULL, worker_id = NULL, attempts = MAX(attempts - 1, 0), run_at = ?
         WHERE id = ? AND state = 'running' AND worker_id = ? RETURNING host`,
        [now, jobId, workerId],
      );
      if (!row) return false;
      this.releaseHost(row.host, now, { success: true });
      return true;
    });
  }

  // ---- controlling ---------------------------------------------------------------------------

  /** Cancels a queued, held or running job. A running job's worker finds out on its next heartbeat or complete(). */
  cancel(jobId: number): boolean {
    return this.db.transaction(() => {
      const now = this.clock.now();
      const before = this.db.get<{ state: JobState; host: string | null }>(`SELECT state, host FROM jobs WHERE id = ?`, [jobId]);
      if (!before || !["queued", "held", "running"].includes(before.state)) return false;
      this.db.run(`UPDATE jobs SET state = 'cancelled', lease_until = NULL, finished_at = ? WHERE id = ?`, [now, jobId]);
      if (before.state === "running") this.releaseHost(before.host, now, { success: true });
      return true;
    });
  }

  /** Cancels every unfinished job of a download job. Returns the number cancelled. */
  cancelByDownloadJob(downloadJobId: number): number {
    return this.db.transaction(() => {
      const now = this.clock.now();
      const running = this.db.all<{ host: string; n: number }>(
        `SELECT host, COUNT(*) AS n FROM jobs WHERE download_job_id = ? AND state = 'running' AND host IS NOT NULL GROUP BY host`,
        [downloadJobId],
      );
      const r = this.db.run(
        `UPDATE jobs SET state = 'cancelled', lease_until = NULL, finished_at = ? WHERE download_job_id = ? AND state IN ('queued','held','running')`,
        [now, downloadJobId],
      );
      for (const h of running) this.releaseHost(h.host, now, { success: true, count: h.n });
      return r.changes;
    });
  }

  /** Pausing a download job holds its queued children. Running ones finish their current unit. */
  holdByDownloadJob(downloadJobId: number): number {
    return this.db.run(`UPDATE jobs SET state = 'held' WHERE download_job_id = ? AND state = 'queued'`, [downloadJobId]).changes;
  }

  resumeByDownloadJob(downloadJobId: number): number {
    return this.db.run(`UPDATE jobs SET state = 'queued', run_at = MIN(run_at, ?) WHERE download_job_id = ? AND state = 'held'`, [
      this.clock.now(), downloadJobId,
    ]).changes;
  }

  /** failed or dead -> queued, with a fresh attempt count. */
  retry(jobId: number): boolean {
    return (
      this.db.run(
        `UPDATE jobs SET state = 'queued', attempts = 0, run_at = ?, finished_at = NULL, lease_until = NULL, worker_id = NULL
         WHERE id = ? AND state IN ('failed','dead')`,
        [this.clock.now(), jobId],
      ).changes === 1
    );
  }

  // ---- recovery ------------------------------------------------------------------------------

  /**
   * Returns running jobs whose lease has expired to the queue (or to `dead` if attempts are used up).
   * `all: true` ignores leases; use it at startup, when every worker from the previous run is gone.
   */
  reapExpired(opts: { all?: boolean } = {}): ReapResult {
    return this.db.transaction(() => {
      const now = this.clock.now();
      const rows = this.db.all<{ host: string | null; state: JobState }>(
        `UPDATE jobs SET
            state = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
            lease_until = NULL, worker_id = NULL, run_at = ?,
            last_error = COALESCE(last_error, 'lease expired'),
            finished_at = CASE WHEN attempts >= max_attempts THEN ? ELSE NULL END
         WHERE state = 'running' AND (? = 1 OR lease_until < ?)
         RETURNING host, state`,
        [now, now, opts.all ? 1 : 0, now],
      );
      const perHost = new Map<string, number>();
      for (const r of rows) if (r.host) perHost.set(r.host, (perHost.get(r.host) ?? 0) + 1);
      for (const [host, n] of perHost) this.releaseHost(host, now, { success: true, count: n });
      return { requeued: rows.filter((r) => r.state === "queued").length, dead: rows.filter((r) => r.state === "dead").length };
    });
  }

  /** Recomputes `host_state.in_flight` from `jobs`. The counter is a cache; this is the truth. Returns rows corrected. */
  rebuildInFlight(): number {
    return this.db.run(
      `UPDATE host_state SET in_flight = (SELECT COUNT(*) FROM jobs WHERE jobs.host = host_state.host AND jobs.state = 'running')
       WHERE in_flight <> (SELECT COUNT(*) FROM jobs WHERE jobs.host = host_state.host AND jobs.state = 'running')`,
    ).changes;
  }

  /**
   * Pulls `run_at` back for queued jobs scheduled further ahead than any backoff could be. Needed after a
   * restart on a machine whose clock now reads earlier than when the job was scheduled (no RTC).
   */
  clampFutureRunAt(maxAheadMs: number = this.backoff.maxMs ?? 3_600_000): number {
    const now = this.clock.now();
    return this.db.run(`UPDATE jobs SET run_at = ? WHERE state = 'queued' AND run_at > ?`, [now + maxAheadMs, now + maxAheadMs]).changes;
  }

  /** Call once at server start, before workers claim anything. */
  recoverOnStartup(): StartupRecovery {
    return this.db.transaction(() => {
      const reaped = this.reapExpired({ all: true });
      return { ...reaped, inFlightRebuilt: this.rebuildInFlight(), runAtClamped: this.clampFutureRunAt() };
    });
  }

  // ---- reading -------------------------------------------------------------------------------

  get(jobId: number): Job | undefined {
    const row = this.db.get<Row>(`SELECT * FROM jobs WHERE id = ?`, [jobId]);
    return row ? toJob(row) : undefined;
  }

  /** Job counts by queue and state, for the admin dashboard. */
  counts(): Record<string, Partial<Record<JobState, number>>> {
    const out: Record<string, Partial<Record<JobState, number>>> = {};
    for (const r of this.db.all<{ queue: string; state: JobState; n: number }>(`SELECT queue, state, COUNT(*) AS n FROM jobs GROUP BY queue, state`)) {
      (out[r.queue] ??= {})[r.state] = r.n;
    }
    return out;
  }

  /** Deletes finished rows (done, cancelled) older than `olderThanMs`. The doc prunes after a crawl completes. */
  pruneFinished(olderThanMs: number): number {
    return this.db.run(`DELETE FROM jobs WHERE state IN ('done','cancelled') AND finished_at < ?`, [this.clock.now() - olderThanMs]).changes;
  }

  // ---- internals -----------------------------------------------------------------------------

  private releaseHost(host: string | null, now: number, o: { success: boolean; hostBackoffMs?: number; count?: number }): void {
    if (!host) return;
    this.db.run(
      `UPDATE host_state SET
          in_flight = MAX(in_flight - ?, 0),
          next_allowed_at = MAX(next_allowed_at, ? + crawl_delay_ms),
          consecutive_failures = CASE WHEN ? = 1 THEN 0 ELSE consecutive_failures + 1 END,
          backoff_until = CASE WHEN ? > 0 THEN MAX(backoff_until, ? + ?) ELSE backoff_until END
       WHERE host = ?`,
      [o.count ?? 1, now, o.success ? 1 : 0, o.hostBackoffMs ?? 0, now, o.hostBackoffMs ?? 0, host],
    );
  }
}
