import { parentPort, workerData } from "node:worker_threads";
import { JobQueue, openDb } from "@ncb/db";

// A claimer with its own connection. Runs in a worker thread so claims genuinely overlap.
const { file, workerId, queue } = workerData as { file: string; workerId: string; queue: "crawl" };
const db = openDb(file);
const q = new JobQueue(db, { leaseMs: 30_000 });
const claimed: number[] = [];
let hostViolations = 0;
let idleRounds = 0;

while (idleRounds < 200) {
  const job = q.claim(queue, workerId);
  if (!job) {
    // Hosts may be busy in another worker; wait briefly and look again.
    idleRounds++;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    continue;
  }
  idleRounds = 0;
  claimed.push(job.id);
  if (job.host) {
    const row = db.get<{ in_flight: number }>("SELECT in_flight FROM host_state WHERE host = ?", [job.host]);
    if (!row || row.in_flight > 1) hostViolations++;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); // simulate a little work while holding the host
  if (!q.complete(job.id, workerId)) throw new Error(`lost lease on job ${job.id}`);
}
db.close();
parentPort!.postMessage({ workerId, claimed, hostViolations });
