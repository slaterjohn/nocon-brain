import type { Clock, JobQueueName } from "@ncb/shared";
import { JobQueue, type Job, type StartupRecovery } from "@ncb/db";
import type { ActivityLog } from "../services/activity.js";
import type { EventBus } from "../services/events.js";
import type { JobOutcome, SlotStatus, WorkerPool } from "./pool.js";

export interface RunnerOptions {
  queue: JobQueue;
  pool: WorkerPool | undefined;
  activity: ActivityLog;
  events: EventBus;
  clock: Clock;
  log: { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
  queues?: JobQueueName[];
  pollMs?: number;
  leaseMs?: number;
}

const DEFAULT_QUEUES: JobQueueName[] = ["crawl", "process", "index", "maintenance"];

/** Which handler a job runs: `payload.handler` if set (used by tests and by job types with variants), else the job type. */
export function handlerFor(job: Job): string {
  const p = job.payload as { handler?: unknown } | null;
  return typeof p?.handler === "string" ? p.handler : job.type;
}

/**
 * The job runner on the main thread. It owns the queue (so the single DB writer rule holds): it claims jobs,
 * hands them to worker threads, extends leases while they run and commits the outcome. On shutdown it
 * stops claiming, lets running jobs reach a checkpoint within the grace period and puts them back.
 */
export class JobRunner {
  private readonly queues: JobQueueName[];
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopping = false;
  private readonly inFlight = new Map<number, { workerId: string; lease: NodeJS.Timeout; promise: Promise<void> }>();
  private lastTickAt: number | null = null;
  recovery?: StartupRecovery;

  constructor(private readonly o: RunnerOptions) {
    this.queues = o.queues ?? DEFAULT_QUEUES;
    this.pollMs = o.pollMs ?? 500;
    this.leaseMs = o.leaseMs ?? 60_000;
  }

  /** Recovers the previous run's leftovers, then starts the workers, then starts claiming. */
  start(): void {
    this.recovery = this.o.queue.recoverOnStartup();
    if (this.recovery.requeued || this.recovery.dead) {
      this.o.activity.write({ level: "warn", area: "system", message: "Recovered jobs left running by the previous run", details: this.recovery });
    }
    this.o.pool?.start();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref();
    void this.tick();
  }

  get claiming(): boolean {
    return !this.stopping && this.timer !== undefined;
  }

  get running(): number {
    return this.inFlight.size;
  }

  get lastTick(): number | null {
    return this.lastTickAt;
  }

  poolStatus(): SlotStatus[] {
    return this.o.pool?.status() ?? [];
  }

  /** Claims work for every idle worker. Re-entrant calls are ignored. */
  async tick(): Promise<void> {
    const pool = this.o.pool;
    if (this.stopping || this.ticking || !pool) return;
    this.ticking = true;
    this.lastTickAt = this.o.clock.now();
    try {
      for (;;) {
        const slotId = pool.acquire();
        if (!slotId) break;
        let job: Job | undefined;
        for (const q of this.queues) {
          job = this.o.queue.claim(q, slotId, this.leaseMs);
          if (job) break;
        }
        if (!job) {
          pool.release(slotId);
          break;
        }
        this.dispatch(pool, slotId, job);
      }
    } catch (e) {
      this.o.log.error({ err: e instanceof Error ? e.message : String(e) }, "job runner tick failed");
    } finally {
      this.ticking = false;
    }
  }

  private dispatch(pool: WorkerPool, slotId: string, job: Job): void {
    const lease = setInterval(() => {
      if (!this.o.queue.heartbeat(job.id, slotId, this.leaseMs)) pool.cancel(job.id); // cancelled or lease lost
    }, Math.max(100, Math.floor(this.leaseMs / 3)));
    lease.unref();
    const promise = pool
      .run(slotId, job.id, handlerFor(job), job.payload)
      .then((outcome) => this.settle(job, slotId, outcome))
      .catch((e) => this.o.log.error({ err: String(e), jobId: job.id }, "failed to settle job"))
      .finally(() => {
        clearInterval(lease);
        this.inFlight.delete(job.id);
        if (!this.stopping) void this.tick();
      });
    this.inFlight.set(job.id, { workerId: slotId, lease, promise });
  }

  private settle(job: Job, workerId: string, outcome: JobOutcome): void {
    const q = this.o.queue;
    switch (outcome.kind) {
      case "done":
        q.complete(job.id, workerId);
        this.o.events.publish("job", { jobId: job.id, type: job.type, state: "done" });
        break;
      case "checkpoint":
        q.release(job.id, workerId);
        this.o.events.publish("job", { jobId: job.id, type: job.type, state: "queued", reason: "checkpoint" });
        break;
      case "failed": {
        const next = q.fail(job.id, workerId, outcome.error, { retry: outcome.retryable });
        this.o.activity.write({ level: "error", area: "system", message: `Job ${job.type} failed: ${outcome.error}`, jobId: job.id, details: { next } });
        this.o.events.publish("job", { jobId: job.id, type: job.type, state: next, error: outcome.error });
        break;
      }
      case "crashed": {
        if (this.stopping) {
          // Terminated at the end of the grace period: the job did nothing wrong, so keep its attempt.
          q.release(job.id, workerId);
          this.o.activity.write({ level: "warn", area: "system", message: `Job ${job.type} was put back on the queue at shutdown`, jobId: job.id });
          break;
        }
        const next = q.fail(job.id, workerId, outcome.error);
        this.o.activity.write({ level: "error", area: "system", message: `A worker died while running ${job.type}: ${outcome.error}`, jobId: job.id, details: { next } });
        this.o.events.publish("job", { jobId: job.id, type: job.type, state: next, error: outcome.error });
        break;
      }
    }
  }

  /**
   * Graceful stop: stop claiming, ask workers to checkpoint, wait up to `graceMs`, then terminate. Jobs that
   * did not finish are put back on the queue without using up an attempt.
   */
  async stop(graceMs: number): Promise<{ drained: number; released: number }> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const pending = [...this.inFlight.entries()];
    await this.o.pool?.shutdown(graceMs);
    await Promise.allSettled(pending.map(([, v]) => v.promise));
    // Anything still marked running (a crash during shutdown) goes back to the queue without losing an attempt.
    let released = 0;
    for (const [jobId, v] of this.inFlight) {
      clearInterval(v.lease);
      if (this.o.queue.release(jobId, v.workerId)) released++;
    }
    this.inFlight.clear();
    return { drained: pending.length, released };
  }
}
