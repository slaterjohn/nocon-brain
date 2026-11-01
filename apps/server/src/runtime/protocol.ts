/** Typed messages between the main thread and worker threads. */

export type ToWorker =
  | { t: "run"; jobId: number; handler: string; payload: unknown }
  /** The lease was lost or the job was cancelled: stop as soon as possible. */
  | { t: "cancel"; jobId: number }
  /** Graceful shutdown: reach a checkpoint and report it. */
  | { t: "shutdown" };

export type FromWorker =
  | { t: "ready"; handlers: string[] }
  | { t: "heartbeat"; at: number; rssMb: number; heapUsedMb: number; busyJobId: number | null }
  | { t: "progress"; jobId: number; data: unknown }
  | { t: "done"; jobId: number; result?: unknown }
  /** The handler stopped at a safe point because of `shutdown` or `cancel`; the job should be put back on the queue. */
  | { t: "checkpoint"; jobId: number; state?: unknown }
  | { t: "failed"; jobId: number; error: string; retryable: boolean };

export interface WorkerData {
  name: string;
  heartbeatMs: number;
  /** Registers the memory-hungry `__leak` handler. Tests only. */
  testHandlers?: boolean;
}

export interface HandlerContext {
  jobId: number;
  /** Aborted on `shutdown` and `cancel`. Long handlers check it and return a checkpoint. */
  signal: AbortSignal;
  progress(data: unknown): void;
}

export type HandlerResult = { checkpoint: true; state?: unknown } | { checkpoint?: false; result?: unknown } | void;
export type Handler = (payload: unknown, ctx: HandlerContext) => Promise<HandlerResult> | HandlerResult;

/** Thrown by a handler for failures that retrying will not fix. */
export class PermanentJobError extends Error {}
