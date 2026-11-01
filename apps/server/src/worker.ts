import { parentPort, workerData } from "node:worker_threads";
import { BUILTIN_HANDLERS, leak } from "./runtime/handlers.js";
import type { FromWorker, Handler, ToWorker, WorkerData } from "./runtime/protocol.js";
import { PermanentJobError } from "./runtime/protocol.js";

/**
 * Worker thread entry (bundled separately as dist/worker.js). Handlers do the CPU-heavy or risky work; they
 * never touch the database. The main thread owns the only writer connection and commits results.
 */
const port = parentPort;
if (!port) throw new Error("worker.ts must run in a worker thread");
const data = workerData as WorkerData;

const handlers: Record<string, Handler> = { ...BUILTIN_HANDLERS };
if (data.testHandlers) handlers.__leak = leak;

const send = (m: FromWorker) => port.postMessage(m);
let busyJobId: number | null = null;
let abort: AbortController | null = null;

const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;
function heartbeat() {
  const m = process.memoryUsage();
  send({ t: "heartbeat", at: Date.now(), rssMb: mb(m.rss), heapUsedMb: mb(m.heapUsed), busyJobId });
}
const timer = setInterval(heartbeat, data.heartbeatMs);

async function run(jobId: number, name: string, payload: unknown) {
  const handler = handlers[name];
  if (!handler) {
    send({ t: "failed", jobId, error: `No handler named "${name}"`, retryable: false });
    return;
  }
  busyJobId = jobId;
  abort = new AbortController();
  try {
    const out = await handler(payload, { jobId, signal: abort.signal, progress: (d) => send({ t: "progress", jobId, data: d }) });
    if (out && "checkpoint" in out && out.checkpoint) send({ t: "checkpoint", jobId, state: out.state });
    else send({ t: "done", jobId, result: out && "result" in out ? out.result : undefined });
  } catch (e) {
    send({ t: "failed", jobId, error: e instanceof Error ? e.message : String(e), retryable: !(e instanceof PermanentJobError) });
  } finally {
    busyJobId = null;
    abort = null;
  }
}

port.on("message", (m: ToWorker) => {
  if (m.t === "run") void run(m.jobId, m.handler, m.payload);
  else if (m.t === "cancel") {
    if (busyJobId === m.jobId) abort?.abort();
  } else if (m.t === "shutdown") {
    abort?.abort();
    if (busyJobId === null) {
      clearInterval(timer);
      process.nextTick(() => process.exit(0));
    }
  }
});

send({ t: "ready", handlers: Object.keys(handlers) });
heartbeat();
