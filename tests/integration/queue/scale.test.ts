import path from "node:path";
import { describe, expect, it } from "vitest";
import { JobQueue, migrate, openDb } from "@ncb/db";
import { tempDir } from "../helpers.js";

describe("50,000 jobs", () => {
  it("inserts and runs claim/complete cycles to exhaustion with no job lost or repeated", () => {
    const db = openDb(path.join(tempDir(), "main.db"));
    migrate(db);
    const q = new JobQueue(db);
    const total = 50_000;

    const t0 = performance.now();
    const created = q.enqueueMany(
      Array.from({ length: total }, (_, i) => ({
        type: "fetch" as const, queue: "crawl" as const, priority: i % 5, host: `h${i % 500}.example`, urlKey: `k${i}`,
      })),
    );
    const insertMs = performance.now() - t0;
    expect(created).toBe(total);

    const seen = new Set<number>();
    const t1 = performance.now();
    for (let i = 0; i < total; i++) {
      const job = q.claim("crawl", "w");
      if (!job) throw new Error(`ran dry after ${i} cycles`);
      if (seen.has(job.id)) throw new Error(`job ${job.id} claimed twice`);
      seen.add(job.id);
      if (!q.complete(job.id, "w")) throw new Error("complete failed");
    }
    const cycleMs = performance.now() - t1;

    expect(q.claim("crawl", "w")).toBeUndefined();
    expect(q.counts()).toEqual({ crawl: { done: total } });
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM host_state WHERE in_flight <> 0")!.n).toBe(0);
    // Not a benchmark (see docs/benchmarks.md); a guard against an accidental O(n) claim, which cost 12 ms per cycle here.
    expect(cycleMs / total).toBeLessThan(2);
    console.log(`queue: insert ${total} in ${insertMs.toFixed(0)} ms, ${(cycleMs / total).toFixed(3)} ms per claim+complete cycle`);
    db.close();
  });
});
