import type { WorkerPool } from "../runtime/pool.js";
import { runExtractOp, type ExtractPayload } from "./extract-ops.js";

/** The page was refused before parsing (too large, too many nodes, too deep). Not retryable. */
export class ExtractionRefused extends Error {
  constructor(readonly reason: string, readonly detail?: string) {
    super(detail ?? `The page was refused by the extractor: ${reason}`);
    this.name = "ExtractionRefused";
  }
}

/** The worker died or failed. Retryable: the stage runner tries again. */
export class ExtractionWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionWorkerError";
  }
}

let syntheticId = 0;

/**
 * Runs extraction operations on the worker pool (task A-08). With no pool (`NCB_EXTRACT_WORKERS=0`) they run
 * on the calling thread; the size, node and depth caps apply either way, but only a worker adds the memory
 * limit that protects the server from a pathological page.
 */
export class ExtractClient {
  constructor(private readonly pool: WorkerPool | undefined, private readonly opts: { waitMs?: number } = {}) {}

  get usesWorkers(): boolean {
    return this.pool !== undefined && this.pool.size > 0;
  }

  async run<T>(payload: ExtractPayload): Promise<T> {
    const pool = this.pool;
    let reply: { ok: true; value: unknown } | { ok: false; rejected: string; message?: string };
    if (!pool || pool.size === 0) reply = await runExtractOp(payload);
    else {
      const deadline = Date.now() + (this.opts.waitMs ?? 120_000);
      let slot = pool.acquire();
      while (!slot) {
        if (Date.now() > deadline) throw new ExtractionWorkerError("No extraction worker became available in time.");
        await new Promise((r) => setTimeout(r, 15));
        slot = pool.acquire();
      }
      const outcome = await pool.run(slot, --syntheticId, "extract", payload);
      if (outcome.kind === "done") reply = outcome.result as typeof reply;
      else if (outcome.kind === "failed") throw new ExtractionWorkerError(outcome.error);
      else if (outcome.kind === "crashed") throw new ExtractionWorkerError(`The extraction worker stopped: ${outcome.error}`);
      else throw new ExtractionWorkerError("The extraction worker was asked to stop.");
    }
    if (!reply.ok) throw new ExtractionRefused(reply.rejected, reply.message);
    return reply.value as T;
  }
}
