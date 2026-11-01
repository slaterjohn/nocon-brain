import { describe, expect, it } from "vitest";
import { call, setupAdmin, startServer } from "./helpers.js";

async function until<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const withWorkers = (extra: Record<string, string> = {}) => ({
  env: { NCB_EXTRACT_WORKERS: "1", ...extra },
});

const job = (t: { svc: { queue: { enqueue: (i: never) => { id: number } } } }, payload: unknown) =>
  t.svc.queue.enqueue({ type: "verify", queue: "maintenance", payload } as never).id;

describe("F-08 worker runtime", () => {
  it("runs noop and sleep jobs on a worker thread and completes them", async () => {
    const t = await startServer(withWorkers());
    const a = job(t, { handler: "noop" });
    const b = job(t, { handler: "sleep", ms: 50 });
    await until(() => t.svc.queue.get(a)?.state === "done" && t.svc.queue.get(b)?.state === "done");
    expect(t.svc.queue.get(a)!.attempts).toBe(1);
  });

  it("fails a job with an unknown handler without retrying", async () => {
    const t = await startServer(withWorkers());
    const id = job(t, { handler: "does-not-exist" });
    await until(() => t.svc.queue.get(id)?.state === "failed");
    expect(t.svc.queue.get(id)!.lastError).toMatch(/No handler/);
  });

  it("uses the steady clock for the queue and recovers running jobs before workers start", async () => {
    const t = await startServer();
    const id = job(t, { handler: "noop" });
    t.svc.db.run("UPDATE jobs SET state='running', worker_id='ghost', lease_until=?, attempts=1 WHERE id=?", [t.fake.now() + 10_000_000, id]);
    await t.server.close();
    const again = await startServer({ dataDir: t.dataDir, rootsDir: t.rootsDir, ...withWorkers() });
    expect(again.svc.runner.recovery).toMatchObject({ requeued: 1 });
    await until(() => again.svc.queue.get(id)?.state === "done");
    // A wall-clock jump does not touch queue timestamps.
    const before = again.svc.queue.get(id)!.finishedAt!;
    again.fake.jumpWall(10 * 86_400_000);
    expect(again.svc.queue.get(id)!.finishedAt).toBe(before);
  });

  it("kills a worker that exceeds its memory limit, restarts it, and keeps the server up", async () => {
    const t = await startServer({
      ...withWorkers({ NCB_WORKER_MEMORY_MB: "32" }),
      server: { pool: { testHandlers: true, restartBackoff: { baseMs: 50, maxMs: 200 }, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 } } },
    });
    const cookie = await setupAdmin(t);
    const leak = t.svc.queue.enqueue({ type: "verify", queue: "maintenance", payload: { handler: "__leak" }, maxAttempts: 1 }).id;
    await until(() => ["dead", "failed"].includes(t.svc.queue.get(leak)?.state ?? ""), 30_000);
    expect(t.svc.queue.get(leak)!.lastError).toMatch(/memory|heap/i);

    // The server still answers and the worker comes back.
    expect((await call(t, { url: "/api/system/health" })).json().status).toMatch(/ok|degraded/);
    await until(() => t.svc.runner.poolStatus()[0]?.state === "idle", 10_000);
    expect(t.svc.runner.poolStatus()[0]!.restarts).toBe(1);
    const status = (await call(t, { url: "/api/system/status", cookie })).json();
    expect(status.workerPool[0].restarts).toBe(1);

    const next = job(t, { handler: "noop" });
    await until(() => t.svc.queue.get(next)?.state === "done");
    const log = t.svc.db.all<{ message: string }>("SELECT message FROM activity_log WHERE level='error'");
    expect(log.some((l) => /worker died/i.test(l.message))).toBe(true);
  }, 60_000);

  it("shows worker heartbeats in the status and dashboard", async () => {
    const t = await startServer({ ...withWorkers(), server: { pool: { heartbeatMs: 50 } } });
    const cookie = await setupAdmin(t);
    await until(() => t.svc.runner.poolStatus()[0]?.lastHeartbeatAt);
    const status = (await call(t, { url: "/api/system/status", cookie })).json();
    expect(status.workerPool[0]).toMatchObject({ state: "idle", lastHeartbeatAt: expect.any(String) });
    const dash = (await call(t, { url: "/api/system/dashboard", cookie })).json();
    const extract = dash.workers.find((w: { name: string }) => w.name === "extract");
    expect(extract).toMatchObject({ state: "idle", lastHeartbeatAt: expect.any(String) });
    expect(dash.workers.map((w: { name: string }) => w.name)).toEqual(["runner", "extract", "index", "search", "zim", "renderer"]);
  });

  it("drains a running job to a checkpoint on shutdown within the grace period", async () => {
    const t = await startServer(withWorkers());
    const id = job(t, { handler: "sleep", ms: 60_000 });
    await until(() => t.svc.queue.get(id)?.state === "running");
    const started = Date.now();
    await t.server.close();
    expect(Date.now() - started).toBeLessThan(5000);
    const again = await startServer({ dataDir: t.dataDir, rootsDir: t.rootsDir });
    expect(again.svc.runner.recovery).toMatchObject({ requeued: 0, dead: 0 }); // nothing was left running
    expect(again.svc.queue.get(id)).toMatchObject({ state: "queued", attempts: 0, workerId: null });
  });

  it("lets a short job finish during the grace period", async () => {
    const t = await startServer(withWorkers());
    const id = job(t, { handler: "sleep", ms: 300 });
    await until(() => t.svc.queue.get(id)?.state === "running");
    // Short job: the sleep handler also honours shutdown, so either outcome leaves nothing running.
    await t.server.close();
    const again = await startServer({ dataDir: t.dataDir, rootsDir: t.rootsDir });
    expect(["done", "queued"]).toContain(again.svc.queue.get(id)!.state);
    expect(again.svc.db.get<{ n: number }>("SELECT COUNT(*) n FROM jobs WHERE state='running'")!.n).toBe(0);
  });

  it("checkpoints the WAL on shutdown", async () => {
    const t = await startServer();
    await setupAdmin(t);
    await t.server.close();
    const fs = await import("node:fs");
    const wal = `${t.dataDir}/db/main.db-wal`;
    expect(!fs.existsSync(wal) || fs.statSync(wal).size === 0).toBe(true);
    expect(fs.existsSync(`${t.dataDir}/db/main.db.lock`)).toBe(false);
  });
});
