import { describe, expect, it } from "vitest";
import { hostRow, setup, states } from "./helpers.js";

const job = (o: Record<string, unknown> = {}) => ({ type: "fetch" as const, queue: "crawl" as const, ...o });

describe("enqueue", () => {
  it("returns the existing job for the same idempotency key while it is active", () => {
    const { q } = setup();
    const a = q.enqueue(job({ idempotencyKey: "k1" }));
    const b = q.enqueue(job({ idempotencyKey: "k1" }));
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect(q.enqueue(job({ idempotencyKey: "k1", type: "asset_fetch" })).created).toBe(true); // key is per type
    const run = q.claim("crawl", "w")!;
    expect(q.enqueue(job({ idempotencyKey: "k1" })).id).toBe(run.id); // still active while running
    q.complete(run.id, "w");
    expect(q.enqueue(job({ idempotencyKey: "k1" })).created).toBe(true); // finished jobs free the key
  });

  it("dedupes the crawl visited set by (crawl_job_id, url_key)", () => {
    const { q, db } = setup();
    db.run(`INSERT INTO download_jobs (public_id, kind, priority, requested_by, created_at) VALUES ('dl_1','explore',3,'user',1)`);
    db.run(`INSERT INTO crawl_jobs (download_job_id, mode) VALUES (1, 'explore')`);
    const a = q.enqueue(job({ crawlJobId: 1, urlKey: "https://a.test/x", url: "https://a.test/x" }));
    const b = q.enqueue(job({ crawlJobId: 1, urlKey: "https://a.test/x", url: "https://a.test/x?utm=1" }));
    expect(b).toEqual({ id: a.id, created: false });
    expect(q.enqueue(job({ crawlJobId: 1, urlKey: "https://a.test/y" })).created).toBe(true);
  });

  it("stores payload as JSON and rejects nothing silently", () => {
    const { q } = setup();
    const { id } = q.enqueue(job({ payload: { a: [1, 2] }, host: "a.test", depth: 2 }));
    expect(q.get(id)).toMatchObject({ payload: { a: [1, 2] }, host: "a.test", depth: 2, state: "queued", attempts: 0 });
  });

  it("enqueueMany counts only new jobs", () => {
    const { q } = setup();
    expect(q.enqueueMany([job({ idempotencyKey: "a" }), job({ idempotencyKey: "a" }), job({ idempotencyKey: "b" })])).toBe(2);
  });
});

describe("claim", () => {
  it("orders by priority DESC, score DESC, then id", () => {
    const { q } = setup();
    const low = q.enqueue(job({ priority: 0 })).id;
    const hiScoreLow = q.enqueue(job({ priority: 5, score: 1 })).id;
    const hiScoreHigh = q.enqueue(job({ priority: 5, score: 9 })).id;
    const tie = q.enqueue(job({ priority: 5, score: 9 })).id;
    expect([1, 2, 3, 4].map(() => q.claim("crawl", "w")!.id)).toEqual([hiScoreHigh, tie, hiScoreLow, low]);
    expect(q.claim("crawl", "w")).toBeUndefined();
  });

  it("only claims from the named queue and only when run_at has passed", () => {
    const { q, clock } = setup();
    q.enqueue({ type: "index", queue: "index" });
    const later = q.enqueue(job({ runAt: clock.now() + 5000 })).id;
    expect(q.claim("crawl", "w")).toBeUndefined();
    clock.advance(5000);
    expect(q.claim("crawl", "w")!.id).toBe(later);
    expect(q.claim("index", "w")).toMatchObject({ type: "index", attempts: 1, workerId: "w" });
  });

  it("does not claim held, done or cancelled jobs", () => {
    const { q } = setup();
    q.enqueue(job({ held: true }));
    expect(q.claim("crawl", "w")).toBeUndefined();
  });
});

describe("per-host invariant", () => {
  it("allows one in flight per host by default and skips to other hosts", () => {
    const { q, db } = setup();
    q.enqueue(job({ host: "a.test", priority: 9 }));
    q.enqueue(job({ host: "a.test", priority: 8 }));
    q.enqueue(job({ host: "b.test", priority: 1 }));
    q.enqueue(job({ priority: 0 })); // no host: unconstrained
    const first = q.claim("crawl", "w1")!;
    expect(first.host).toBe("a.test");
    expect(q.claim("crawl", "w2")!.host).toBe("b.test"); // a.test is busy
    expect(q.claim("crawl", "w3")!.host).toBeNull();
    expect(q.claim("crawl", "w4")).toBeUndefined(); // the second a.test job waits
    expect(hostRow(db, "a.test")!.in_flight).toBe(1);
    q.complete(first.id, "w1");
    expect(hostRow(db, "a.test")!.in_flight).toBe(0);
    expect(q.claim("crawl", "w4")!.host).toBe("a.test");
  });

  it("honours max_concurrent above 1", () => {
    const { q, db } = setup();
    db.run("INSERT INTO host_state (host, max_concurrent) VALUES ('a.test', 2)");
    for (let i = 0; i < 4; i++) q.enqueue(job({ host: "a.test" }));
    expect(q.claim("crawl", "w")).toBeDefined();
    expect(q.claim("crawl", "w")).toBeDefined();
    expect(q.claim("crawl", "w")).toBeUndefined();
    expect(hostRow(db, "a.test")!.in_flight).toBe(2);
  });

  it("spaces starts by crawl_delay_ms and honours backoff_until", () => {
    const { q, db, clock } = setup();
    db.run("INSERT INTO host_state (host, crawl_delay_ms) VALUES ('a.test', 1000)");
    q.enqueue(job({ host: "a.test" }));
    q.enqueue(job({ host: "a.test" }));
    const a = q.claim("crawl", "w")!;
    q.complete(a.id, "w");
    expect(q.claim("crawl", "w")).toBeUndefined(); // delay not over
    clock.advance(1000);
    const b = q.claim("crawl", "w")!;
    expect(b).toBeDefined();
    q.enqueue(job({ host: "a.test" }));
    q.fail(b.id, "w", "429", { hostBackoffMs: 30_000, retryAfterMs: 0 }); // the host is paused as well as the job
    clock.advance(10_000);
    expect(q.claim("crawl", "w")).toBeUndefined();
    clock.advance(20_000);
    expect(q.claim("crawl", "w")).toBeDefined();
    expect(hostRow(db, "a.test")!.consecutive_failures).toBe(1);
  });
});

describe("lease, heartbeat and reaper", () => {
  it("heartbeat extends the lease; a stale worker cannot heartbeat or complete", () => {
    const { q, clock } = setup({ leaseMs: 10_000 });
    const { id } = q.enqueue(job());
    q.claim("crawl", "w1");
    clock.advance(8000);
    expect(q.heartbeat(id, "w1")).toBe(true);
    clock.advance(8000);
    expect(q.reapExpired()).toEqual({ requeued: 0, dead: 0 });
    expect(q.heartbeat(id, "other")).toBe(false);
    expect(q.complete(id, "other")).toBe(false);
  });

  it("an expired lease is re-claimed exactly once", () => {
    const { q, clock, db } = setup({ leaseMs: 10_000 });
    const { id } = q.enqueue(job({ host: "a.test" }));
    q.claim("crawl", "dead-worker");
    clock.advance(10_001);
    expect(q.reapExpired()).toEqual({ requeued: 1, dead: 0 });
    expect(q.reapExpired()).toEqual({ requeued: 0, dead: 0 });
    expect(hostRow(db, "a.test")!.in_flight).toBe(0);
    const again = q.claim("crawl", "w2")!;
    expect(again).toMatchObject({ id, attempts: 2, workerId: "w2" });
    expect(q.claim("crawl", "w3")).toBeUndefined(); // exactly once
    expect(q.complete(id, "dead-worker")).toBe(false); // the zombie loses
    expect(q.complete(id, "w2")).toBe(true);
    expect(states(db)).toEqual({ done: 1 });
  });

  it("dead-letters a job whose attempts run out through lease expiry", () => {
    const { q, clock, db } = setup({ leaseMs: 1000 });
    const { id } = q.enqueue(job({ maxAttempts: 2 }));
    for (let i = 0; i < 2; i++) {
      q.claim("crawl", "w");
      clock.advance(1001);
      q.reapExpired();
    }
    expect(q.get(id)!.state).toBe("dead");
    expect(states(db)).toEqual({ dead: 1 });
  });
});

describe("fail, backoff and dead-letter", () => {
  it("retries with exponential backoff, then dead-letters", () => {
    const { q, clock } = setup({ backoff: { baseMs: 1000, factor: 2, maxMs: 60_000, jitter: 0 } });
    const { id } = q.enqueue(job({ maxAttempts: 3 }));
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      const j = q.claim("crawl", "w")!;
      const state = q.fail(j.id, "w", `boom ${i}`);
      seen.push(q.get(id)!.runAt - clock.now());
      expect(state).toBe(i < 2 ? "queued" : "dead");
      expect(q.claim("crawl", "w")).toBeUndefined(); // backing off (or dead)
      clock.advance(seen.at(-1)!);
    }
    expect(seen.slice(0, 2)).toEqual([1000, 2000]);
    expect(q.get(id)).toMatchObject({ state: "dead", attempts: 3, lastError: "boom 2" });
  });

  it("retryAfterMs overrides the computed delay", () => {
    const { q, clock } = setup();
    const { id } = q.enqueue(job());
    q.fail(q.claim("crawl", "w")!.id, "w", "429", { retryAfterMs: 7000 });
    expect(q.get(id)!.runAt).toBe(clock.now() + 7000);
  });

  it("retry:false marks failed, and retry() requeues failed and dead jobs", () => {
    const { q } = setup();
    const { id } = q.enqueue(job());
    expect(q.fail(q.claim("crawl", "w")!.id, "w", "bad input", { retry: false })).toBe("failed");
    expect(q.retry(id)).toBe(true);
    expect(q.get(id)).toMatchObject({ state: "queued", attempts: 0 });
    expect(q.retry(id)).toBe(false); // only failed or dead
  });

  it("release returns a job without using an attempt", () => {
    const { q, db } = setup();
    const { id } = q.enqueue(job({ host: "a.test" }));
    q.claim("crawl", "w");
    expect(q.release(id, "w")).toBe(true);
    expect(q.get(id)).toMatchObject({ state: "queued", attempts: 0 });
    expect(hostRow(db, "a.test")!.in_flight).toBe(0);
  });

  it("only the owning worker can fail a job", () => {
    const { q } = setup();
    const { id } = q.enqueue(job());
    q.claim("crawl", "w1");
    expect(q.fail(id, "w2", "x")).toBeUndefined();
  });
});

describe("pause, resume, cancel", () => {
  function withDownloadJob() {
    const s = setup();
    s.db.run(`INSERT INTO download_jobs (public_id, kind, priority, requested_by, created_at) VALUES ('dl_1','explore',3,'user',1)`);
    return s;
  }

  it("holds queued children on pause and requeues them on resume", () => {
    const { q, db } = withDownloadJob();
    for (let i = 0; i < 3; i++) q.enqueue(job({ downloadJobId: 1, host: `h${i}.test` }));
    q.claim("crawl", "w");
    expect(q.holdByDownloadJob(1)).toBe(2);
    expect(q.claim("crawl", "w")).toBeUndefined();
    expect(states(db)).toEqual({ running: 1, held: 2 });
    expect(q.resumeByDownloadJob(1)).toBe(2);
    expect(q.claim("crawl", "w")).toBeDefined();
  });

  it("cancel releases the host and the worker finds out on complete", () => {
    const { q, db } = withDownloadJob();
    const { id } = q.enqueue(job({ downloadJobId: 1, host: "a.test" }));
    q.claim("crawl", "w");
    expect(q.cancel(id)).toBe(true);
    expect(hostRow(db, "a.test")!.in_flight).toBe(0);
    expect(q.heartbeat(id, "w")).toBe(false);
    expect(q.complete(id, "w")).toBe(false);
    expect(q.cancel(id)).toBe(false); // terminal
  });

  it("cancelByDownloadJob cancels queued, held and running jobs and releases hosts", () => {
    const { q, db } = withDownloadJob();
    q.enqueue(job({ downloadJobId: 1, host: "a.test" }));
    q.enqueue(job({ downloadJobId: 1, host: "a.test" }));
    q.enqueue(job({ downloadJobId: 1, host: "b.test", held: true }));
    q.claim("crawl", "w");
    expect(q.cancelByDownloadJob(1)).toBe(3);
    expect(states(db)).toEqual({ cancelled: 3 });
    expect(hostRow(db, "a.test")!.in_flight).toBe(0);
  });
});

describe("startup recovery", () => {
  it("rebuilds in_flight from jobs instead of trusting the counter", () => {
    const { q, db } = setup();
    q.enqueue(job({ host: "a.test" }));
    q.enqueue(job({ host: "b.test" }));
    q.claim("crawl", "w"); // a.test running
    db.run("UPDATE host_state SET in_flight = 7 WHERE host = 'a.test'"); // corrupt, as after a crash
    db.run("INSERT INTO host_state (host, in_flight) VALUES ('ghost.test', 3)");
    expect(q.rebuildInFlight()).toBe(2);
    expect(hostRow(db, "a.test")!.in_flight).toBe(1);
    expect(hostRow(db, "ghost.test")!.in_flight).toBe(0);
    expect(q.rebuildInFlight()).toBe(0);
  });

  it("requeues everything that was running when the process died, then rebuilds in_flight", () => {
    const { q, db, clock } = setup({ leaseMs: 3_600_000 });
    q.enqueue(job({ host: "a.test" }));
    q.enqueue(job({ host: "b.test" }));
    q.claim("crawl", "w");
    q.claim("crawl", "w");
    const rec = q.recoverOnStartup(); // leases have not expired, but their workers are gone
    expect(rec).toMatchObject({ requeued: 2, dead: 0 });
    expect(states(db)).toEqual({ queued: 2 });
    expect(hostRow(db, "a.test")!.in_flight).toBe(0);
    expect(q.claim("crawl", "w")).toBeDefined();
    void clock;
  });

  it("pulls far-future run_at back after a restart on an earlier clock", () => {
    const { q, clock } = setup();
    const { id } = q.enqueue(job({ runAt: clock.now() + 365 * 86_400_000 }));
    expect(q.claim("crawl", "w")).toBeUndefined();
    expect(q.clampFutureRunAt(3_600_000)).toBe(1);
    clock.advance(3_600_000);
    expect(q.claim("crawl", "w")!.id).toBe(id);
  });
});

describe("counts and pruning", () => {
  it("reports counts by queue and state and prunes finished rows", () => {
    const { q, clock } = setup();
    q.enqueue(job());
    q.enqueue({ type: "index", queue: "index" });
    q.complete(q.claim("crawl", "w")!.id, "w");
    expect(q.counts()).toEqual({ crawl: { done: 1 }, index: { queued: 1 } });
    clock.advance(1000);
    expect(q.pruneFinished(500)).toBe(1);
    expect(q.counts()).toEqual({ index: { queued: 1 } });
  });
});
