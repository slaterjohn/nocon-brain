import { Worker, type ResourceLimits } from "node:worker_threads";
import type { Clock } from "@ncb/shared";
import type { FromWorker, ToWorker, WorkerData } from "./protocol.js";

export type SlotState = "starting" | "idle" | "busy" | "down" | "stopping";

export type JobOutcome =
  | { kind: "done"; result?: unknown }
  | { kind: "failed"; error: string; retryable: boolean }
  | { kind: "checkpoint"; state?: unknown }
  /** The worker died (out of memory, uncaught error, heartbeat timeout) while running the job. */
  | { kind: "crashed"; error: string };

export interface SlotStatus {
  id: string;
  state: SlotState;
  currentJobId: number | null;
  lastHeartbeatAt: number | null;
  memoryMb: number | null;
  restarts: number;
  lastError: string | null;
  nextRestartAt: number | null;
}

export interface PoolOptions {
  name: string;
  size: number;
  /** A path or file URL of the bundled worker (`dist/worker.js`). */
  workerFile: string | URL;
  execArgv?: string[];
  resourceLimits?: ResourceLimits;
  heartbeatMs?: number;
  /** A busy or idle worker silent for this long is terminated and restarted. Default 5x the heartbeat interval, at least 5 s. */
  heartbeatTimeoutMs?: number;
  /** Restart delay: `baseMs * 2^(consecutiveFailures-1)`, capped at `maxMs`. */
  restartBackoff?: { baseMs: number; maxMs: number };
  /** A worker that stays up this long (ms) resets its failure count. Default 30 s. */
  stableAfterMs?: number;
  testHandlers?: boolean;
  clock?: Clock;
  log?: { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
  onHeartbeat?: (s: SlotStatus) => void;
  onSlotChange?: (s: SlotStatus) => void;
}

interface Slot {
  index: number;
  id: string;
  worker?: Worker;
  state: SlotState;
  generation: number;
  jobId: number | null;
  resolve?: (o: JobOutcome) => void;
  lastHeartbeat: number | null;
  memoryMb: number | null;
  restarts: number;
  failures: number;
  startedAt: number;
  lastError: string | null;
  restartTimer?: NodeJS.Timeout;
  nextRestartAt: number | null;
}

/**
 * A fixed-size pool of worker threads. The pool never talks to the database: the runner claims a job,
 * hands it to `run()` and commits the outcome. A worker that dies is replaced after an exponential backoff
 * and the job it held comes back as `crashed`, so one pathological page cannot take down the server.
 */
export class WorkerPool {
  private readonly slots: Slot[] = [];
  private watchdog?: NodeJS.Timeout;
  private stopping = false;
  private readonly heartbeatMs: number;
  private readonly timeoutMs: number;
  private readonly backoff: { baseMs: number; maxMs: number };
  private readonly stableAfterMs: number;
  private readonly now: () => number;

  constructor(private readonly o: PoolOptions) {
    this.heartbeatMs = o.heartbeatMs ?? 2000;
    this.timeoutMs = o.heartbeatTimeoutMs ?? Math.max(5000, this.heartbeatMs * 5);
    this.backoff = o.restartBackoff ?? { baseMs: 500, maxMs: 30_000 };
    this.stableAfterMs = o.stableAfterMs ?? 30_000;
    this.now = () => (o.clock ?? { now: () => Date.now() }).now();
    for (let i = 0; i < o.size; i++) {
      this.slots.push({
        index: i, id: `${o.name}-${i}`, state: "down", generation: 0, jobId: null, lastHeartbeat: null, memoryMb: null,
        restarts: 0, failures: 0, startedAt: 0, lastError: null, nextRestartAt: null,
      });
    }
  }

  get size(): number {
    return this.slots.length;
  }

  start(): void {
    for (const s of this.slots) this.spawn(s);
    this.watchdog = setInterval(() => this.checkHeartbeats(), Math.max(50, Math.min(this.heartbeatMs, 1000)));
    this.watchdog.unref();
  }

  status(): SlotStatus[] {
    return this.slots.map((s) => this.toStatus(s));
  }

  private toStatus(s: Slot): SlotStatus {
    return {
      id: s.id, state: s.state, currentJobId: s.jobId, lastHeartbeatAt: s.lastHeartbeat, memoryMb: s.memoryMb,
      restarts: s.restarts, lastError: s.lastError, nextRestartAt: s.nextRestartAt,
    };
  }

  /** An idle worker, reserved for the caller until `run()` or `release()`. */
  acquire(): string | undefined {
    const s = this.slots.find((x) => x.state === "idle" && x.jobId === null && !x.resolve);
    if (!s) return undefined;
    s.state = "busy"; // reserved
    return s.id;
  }

  release(slotId: string): void {
    const s = this.slots.find((x) => x.id === slotId);
    if (s && s.state === "busy" && s.jobId === null) s.state = "idle";
  }

  /** Runs a job on a slot obtained from `acquire()`. Always resolves; failures are outcomes, not exceptions. */
  run(slotId: string, jobId: number, handler: string, payload: unknown): Promise<JobOutcome> {
    const s = this.slots.find((x) => x.id === slotId);
    if (!s || !s.worker) return Promise.resolve({ kind: "crashed", error: "The worker is not running." });
    s.jobId = jobId;
    s.state = "busy";
    this.changed(s);
    return new Promise<JobOutcome>((resolve) => {
      s.resolve = resolve;
      this.post(s, { t: "run", jobId, handler, payload });
    });
  }

  cancel(jobId: number): void {
    const s = this.slots.find((x) => x.jobId === jobId);
    if (s) this.post(s, { t: "cancel", jobId });
  }

  /** Waits for running jobs to reach a checkpoint (up to `graceMs`), then terminates every worker. */
  async shutdown(graceMs: number): Promise<void> {
    this.stopping = true;
    if (this.watchdog) clearInterval(this.watchdog);
    for (const s of this.slots) {
      if (s.restartTimer) clearTimeout(s.restartTimer);
      s.restartTimer = undefined;
      if (s.worker) {
        s.state = s.jobId === null ? "stopping" : s.state;
        this.post(s, { t: "shutdown" });
      }
    }
    const deadline = Date.now() + graceMs;
    while (this.slots.some((s) => s.jobId !== null) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    await Promise.all(
      this.slots.map(async (s) => {
        const w = s.worker;
        s.worker = undefined;
        if (s.resolve) this.settle(s, { kind: "crashed", error: "The server shut down before this job finished." });
        s.state = "down";
        if (w) await w.terminate();
      }),
    );
  }

  // ---- internals -----------------------------------------------------------------------------

  private post(s: Slot, m: ToWorker): void {
    try {
      s.worker?.postMessage(m);
    } catch {
      /* the worker is gone; its exit handler settles the job */
    }
  }

  private changed(s: Slot): void {
    this.o.onSlotChange?.(this.toStatus(s));
  }

  private settle(s: Slot, outcome: JobOutcome): void {
    const resolve = s.resolve;
    s.resolve = undefined;
    s.jobId = null;
    resolve?.(outcome);
  }

  private spawn(s: Slot): void {
    if (this.stopping) return;
    const generation = ++s.generation;
    s.state = "starting";
    s.nextRestartAt = null;
    s.startedAt = this.now();
    const data: WorkerData = { name: s.id, heartbeatMs: this.heartbeatMs, testHandlers: this.o.testHandlers };
    const w = new Worker(this.o.workerFile, {
      workerData: data,
      resourceLimits: this.o.resourceLimits,
      execArgv: this.o.execArgv,
    });
    s.worker = w;
    this.changed(s);

    const alive = () => s.generation === generation;
    w.on("message", (m: FromWorker) => {
      if (!alive()) return;
      switch (m.t) {
        case "ready":
          if (s.state === "starting") s.state = "idle";
          s.lastHeartbeat = this.now();
          this.changed(s);
          break;
        case "heartbeat":
          s.lastHeartbeat = this.now();
          s.memoryMb = m.rssMb;
          if (s.failures > 0 && this.now() - s.startedAt > this.stableAfterMs) s.failures = 0;
          this.o.onHeartbeat?.(this.toStatus(s));
          break;
        case "progress":
          break;
        case "done":
          if (s.jobId === m.jobId) this.finish(s, { kind: "done", result: m.result });
          break;
        case "checkpoint":
          if (s.jobId === m.jobId) this.finish(s, { kind: "checkpoint", state: m.state });
          break;
        case "failed":
          if (s.jobId === m.jobId) this.finish(s, { kind: "failed", error: m.error, retryable: m.retryable });
          break;
      }
    });
    w.on("error", (err) => {
      if (!alive()) return;
      s.lastError = (err as NodeJS.ErrnoException).code ? `${(err as NodeJS.ErrnoException).code}: ${err.message}` : err.message;
    });
    w.on("exit", (code) => {
      if (!alive()) return;
      s.worker = undefined;
      if (this.stopping) {
        s.state = "down";
        return;
      }
      const reason = s.lastError ?? `The worker exited unexpectedly (code ${code}).`;
      this.o.log?.warn({ slot: s.id, reason }, "worker exited");
      if (s.resolve) this.settle(s, { kind: "crashed", error: reason });
      s.state = "down";
      s.restarts++;
      s.failures++;
      const delay = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** (s.failures - 1));
      s.nextRestartAt = this.now() + delay;
      this.changed(s);
      s.restartTimer = setTimeout(() => {
        s.restartTimer = undefined;
        s.lastError = null;
        this.spawn(s);
      }, delay);
      s.restartTimer.unref();
    });
  }

  private finish(s: Slot, outcome: JobOutcome): void {
    this.settle(s, outcome);
    s.state = this.stopping ? "stopping" : "idle";
    this.changed(s);
  }

  private checkHeartbeats(): void {
    const now = this.now();
    for (const s of this.slots) {
      if (!s.worker || s.state === "down" || s.state === "stopping") continue;
      const last = s.lastHeartbeat ?? s.startedAt;
      if (now - last > this.timeoutMs) {
        s.lastError = `The worker stopped sending heartbeats for ${Math.round((now - last) / 1000)} s and was restarted.`;
        void s.worker.terminate();
      }
    }
  }
}
