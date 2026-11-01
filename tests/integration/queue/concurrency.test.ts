import path from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { JobQueue, migrate, openDb } from "@ncb/db";
import { tempDir } from "../helpers.js";

const workerFile = new URL("./queue-worker.ts", import.meta.url);

function runWorker(file: string, workerId: string) {
  return new Promise<{ workerId: string; claimed: number[]; hostViolations: number }>((resolve, reject) => {
    const w = new Worker(workerFile, { workerData: { file, workerId, queue: "crawl" }, execArgv: ["--import", "tsx"] });
    w.once("message", resolve);
    w.once("error", reject);
    w.once("exit", (code) => code !== 0 && reject(new Error(`worker ${workerId} exited with ${code}`)));
  });
}

describe("concurrent claimers", () => {
  it("two connections interleaving never receive the same job", () => {
    const file = path.join(tempDir(), "main.db");
    const a = openDb(file);
    migrate(a);
    const b = openDb(file);
    const qa = new JobQueue(a);
    const qb = new JobQueue(b);
    qa.enqueueMany(Array.from({ length: 1000 }, (_, i) => ({ type: "fetch" as const, queue: "crawl" as const, priority: i % 3 })));
    const got = new Set<number>();
    for (let i = 0; i < 500; i++) {
      for (const [q, w] of [[qa, "a"], [qb, "b"]] as const) {
        const job = q.claim("crawl", w)!;
        expect(got.has(job.id)).toBe(false);
        got.add(job.id);
      }
    }
    expect(got.size).toBe(1000);
    expect(qa.claim("crawl", "a")).toBeUndefined();
    a.close();
    b.close();
  });

  it("four worker threads with their own connections claim every job exactly once and respect the per-host limit", async () => {
    const file = path.join(tempDir(), "main.db");
    const db = openDb(file);
    migrate(db);
    const q = new JobQueue(db);
    const total = 1200;
    // 12 hosts, so up to four workers contend for each host; a mix of host-less jobs as well.
    q.enqueueMany(Array.from({ length: total }, (_, i) => ({
      type: "fetch" as const, queue: "crawl" as const, priority: i % 4, host: i % 10 === 9 ? undefined : `h${i % 12}.test`,
    })));

    const results = await Promise.all(["w1", "w2", "w3", "w4"].map((id) => runWorker(file, id)));

    const all = results.flatMap((r) => r.claimed);
    expect(all.length).toBe(total);
    expect(new Set(all).size).toBe(total); // nobody got the same job twice
    expect(results.reduce((n, r) => n + r.hostViolations, 0)).toBe(0);
    expect(results.filter((r) => r.claimed.length > 0).length).toBeGreaterThan(1); // they genuinely shared the work
    expect(q.counts()).toEqual({ crawl: { done: total } });
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM host_state WHERE in_flight <> 0")!.n).toBe(0);
    db.close();
  }, 60_000);
});
