import { parentPort, workerData } from "node:worker_threads";
import { IndexCore } from "./index-core.js";
import type { FromIndexWorker, IndexWorkerData, ToIndexWorker } from "./protocol.js";

/** Worker thread entry for the `index` worker: the only writer of index.db. Bundled as dist/index-worker.js. */
const port = parentPort;
if (!port) throw new Error("index-worker.ts must run in a worker thread");
const data = workerData as IndexWorkerData;
const send = (m: FromIndexWorker) => port.postMessage(m);
const core = new IndexCore(data, send);

let queue: Promise<void> = Promise.resolve();
let timer: NodeJS.Timeout | undefined;
let wanted = false;
let running = false;

function pump(): void {
  if (running) return;
  running = true;
  setImmediate(() => {
    try {
      // Apply batches until the outbox is empty, yielding between batches so commands are answered.
      const n = core.syncOnce();
      if (n > 0) { running = false; wanted = true; pump(); return; }
    } catch (e) {
      send({ t: "error", message: e instanceof Error ? e.message : String(e) });
    }
    running = false;
  });
}

function poll(): void {
  try {
    if (core.idx && core.pendingCount() > 0) pump();
  } catch (e) {
    send({ t: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

try {
  core.open();
  timer = setInterval(poll, data.pollMs);
  pump();
} catch (e) {
  send({ t: "error", message: e instanceof Error ? e.message : String(e) });
}

port.on("message", (m: ToIndexWorker | { cmd: "stop"; id: number }) => {
  queue = queue.then(async () => {
    const reply = (ok: boolean, result?: unknown, error?: string) => send(ok ? { t: "reply", id: m.id, ok: true, result } : { t: "reply", id: m.id, ok: false, error: error ?? "failed" });
    try {
      switch (m.cmd) {
        case "sync": core.syncAll(); reply(true, core.status()); break;
        case "status": reply(true, core.status()); break;
        case "pause": core.pause(true); reply(true); break;
        case "resume": core.pause(false); pump(); reply(true); break;
        case "synonyms": core.setSynonyms(m.synonyms); reply(true); break;
        case "optimize": core.syncAll(); reply(true, core.optimize()); break;
        case "check": reply(true, core.check(m.repair)); break;
        case "rebuild": reply(true); core.rebuild(m.jobId, m.generationId, { fresh: m.fresh }); pump(); break;
        case "stop": if (timer) clearInterval(timer); core.close(); reply(true); setImmediate(() => process.exit(0)); break;
      }
    } catch (e) {
      reply(false, undefined, e instanceof Error ? e.message : String(e));
    }
  });
});
