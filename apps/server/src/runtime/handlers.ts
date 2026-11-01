import { runExtractOp, type ExtractPayload } from "../pipeline/extract-ops.js";
import type { Handler } from "./protocol.js";

/** `noop`: finishes at once. For tests and for checking that the runner works end to end. */
export const noop: Handler = () => ({ result: { ok: true } });

/**
 * `sleep`: waits `ms` milliseconds in short slices. When asked to shut down it stops at once and reports a
 * checkpoint with the time left, which is what a real long handler does at a stage boundary.
 */
export const sleep: Handler = async (payload, ctx) => {
  const ms = Math.max(0, Number((payload as { ms?: unknown } | null)?.ms ?? 0));
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ctx.signal.aborted) return { checkpoint: true, state: { remainingMs: Math.max(0, end - Date.now()) } };
    await new Promise((r) => setTimeout(r, Math.min(10, Math.max(1, end - Date.now()))));
  }
  return { result: { sleptMs: ms } };
};

/** `__leak` (tests only): allocates until the worker's heap limit kills it. */
export const leak: Handler = async () => {
  const hold: Buffer[][] = [];
  for (;;) {
    const chunk: Buffer[] = [];
    for (let i = 0; i < 2000; i++) chunk.push(Buffer.alloc(1024, 1));
    hold.push(chunk);
    // Plain arrays of objects count against the old-generation limit; Buffers alone live off-heap.
    hold.push(Array.from({ length: 50_000 }, (_, i) => ({ i, s: "x".repeat(16) })) as unknown as Buffer[]);
    await new Promise((r) => setImmediate(r));
  }
};

/** `extract`: DOM work for the pipeline (metadata, readable content, outline, reader HTML, links). Pure, no database. */
export const extract: Handler = async (payload) => ({ result: await runExtractOp(payload as ExtractPayload) });

export const BUILTIN_HANDLERS: Record<string, Handler> = { noop, sleep, extract };
