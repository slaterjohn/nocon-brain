import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CrawlRequest } from "@ncb/crawl";
import { startCrawlServer, graph, until, useFixtures } from "../crawl/helpers.js";
import { ADMIN, call, cookieFrom, setupAdmin, tempDir } from "../server/helpers.js";

const fixtures = useFixtures();
const art = () => fixtures().urls.article as string;
const edge = () => fixtures().urls.edge as string;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function server(opts: Parameters<typeof startCrawlServer>[0] = {}) {
  const t = await startCrawlServer(opts);
  // A data directory from an earlier run already has its administrator.
  const cookie = opts.dataDir && t.svc.auth.hasAdmin() ? cookieFrom(await call(t, { url: "/api/auth/login", body: ADMIN })) : await setupAdmin(t);
  const api = async <T = any>(method: string, url: string, body?: unknown, headers?: Record<string, string>) => {
    const r = await call(t, { method, url, body, cookie, headers });
    return { status: r.statusCode, body: (r.body ? r.json() : undefined) as T };
  };
  return Object.assign(t, { cookie, api });
}
type S = Awaited<ReturnType<typeof server>>;

const finished = (t: S, id: string, ms = 60_000) =>
  until(() => {
    const d = t.svc.downloads.get(id);
    return ["completed", "failed", "cancelled"].includes(d.state) ? d : undefined;
  }, ms);

/** Keeps captures to 127.0.0.1 queued so a test can use the controls on work that has not started. */
const blockHost = (t: S) => t.svc.db.run("INSERT INTO host_state (host, backoff_until) VALUES ('127.0.0.1', 1000000000000000) ON CONFLICT(host) DO UPDATE SET backoff_until = 1000000000000000");
const unblockHost = (t: S) => t.svc.db.run("UPDATE host_state SET backoff_until = 0 WHERE host = '127.0.0.1'");

describe("C-08 the downloads list and detail", () => {
  it("lists a capture from queued to completed with progress, the right state names and filters", async () => {
    const t = await server();
    const created = await t.api("POST", "/api/downloads", { kind: "capture", url: `${art()}/moon`, priority: "P2" });
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ kind: "capture", priority: "P2", requestedBy: "user", requestedUrl: `${art()}/moon`, attempts: 0 });
    expect(["queued", "running"]).toContain(created.body.state);
    const d = await finished(t, created.body.id);
    expect(d).toMatchObject({ state: "completed", progress: { pagesDone: 1, percent: 100, label: "Saved" }, controls: { pause: false, resume: false, cancel: false, retry: false } });
    expect(d.progress.bytesDone).toBeGreaterThan(0);
    expect(d.title).toContain("127.0.0.1");

    const list = await t.api("GET", "/api/downloads");
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].id).toBe(created.body.id);
    expect((await t.api("GET", "/api/downloads?state=completed,failed")).body.items).toHaveLength(1);
    expect((await t.api("GET", "/api/downloads?state=queued")).body.items).toHaveLength(0);
    expect((await t.api("GET", "/api/downloads?kind=refresh")).body.items).toHaveLength(0);
    expect((await t.api("GET", "/api/downloads?priority=P2")).body.items).toHaveLength(1);
    expect((await t.api("GET", "/api/downloads?priority=P4")).body.items).toHaveLength(0);
    expect((await t.api("GET", "/api/downloads?state=bogus")).status).toBe(400);
    expect((await t.api("GET", "/api/downloads/dl_nope")).status).toBe(404);
    const log = await t.api("GET", `/api/downloads/${created.body.id}/log`);
    expect(log.status).toBe(200);
    expect(log.body.items.length).toBeGreaterThan(0);
    expect(log.body.items[0]).toMatchObject({ downloadJobId: created.body.id });
  });

  it("pages through the list with a cursor", async () => {
    const t = await server();
    const ids: string[] = [];
    for (const slug of ["moon", "mars", "stars"]) ids.push((await t.api("POST", "/api/downloads", { kind: "capture", url: `${art()}/${slug}` })).body.id);
    for (const id of ids) await finished(t, id);
    const p1 = await t.api("GET", "/api/downloads?limit=2");
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await t.api("GET", `/api/downloads?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items).toHaveLength(1);
    expect([...p1.body.items, ...p2.body.items].map((i: any) => i.id)).toEqual([...ids].reverse());
  });

  it("maps failure codes to plain messages with a hint, and keeps the reason in the log", async () => {
    const t = await server();
    const c = await t.api("POST", "/api/downloads", { kind: "capture", url: `${edge()}/status/404` });
    const d = await finished(t, c.body.id);
    expect(d.state).toBe("failed");
    expect(d.failure!).toMatchObject({ code: "http_4xx", retryable: false });
    expect(d.failure!.message).toMatch(/refused the request or the page does not exist/);
    expect(d.failure!.message).toContain("404");
    expect(d.failure!.hint).toMatch(/address/);
    expect(d.controls).toMatchObject({ retry: true, pause: false });
    const blocked = await t.api("POST", "/api/downloads", { kind: "capture", url: "http://169.254.169.254/latest" });
    // Blocked addresses are refused when the download is made or when it runs, never fetched.
    if (blocked.status === 202) {
      const b = await finished(t, blocked.body.id);
      expect(b.failure!.code).toBe("ssrf_blocked");
    } else expect([400, 403]).toContain(blocked.status);
  });
});

describe("C-08 controls and the state machine", () => {
  it("pause, resume, cancel and priority change on queued work", async () => {
    const t = await server();
    blockHost(t);
    const a = (await t.api("POST", "/api/downloads", { kind: "capture", url: `${art()}/moon` })).body;
    expect(a).toMatchObject({ state: "queued", controls: { pause: true, resume: false, cancel: true, retry: false, setPriority: true } });

    const paused = await t.api("POST", `/api/downloads/${a.id}/pause`);
    expect(paused.body).toMatchObject({ state: "paused", pause: { reason: "user", automatic: false }, controls: { pause: false, resume: true } });
    expect(t.svc.db.get<{ state: string }>("SELECT state FROM jobs WHERE download_job_id = (SELECT id FROM download_jobs WHERE public_id = ?)", [a.id])!.state).toBe("held");
    expect((await t.api("POST", `/api/downloads/${a.id}/pause`)).status).toBe(409);

    const resumed = await t.api("POST", `/api/downloads/${a.id}/resume`);
    expect(resumed.body).toMatchObject({ state: "queued" });

    const patched = await t.api("PATCH", `/api/downloads/${a.id}`, { priority: "P1" });
    expect(patched.body.priority).toBe("P1");
    expect(t.svc.db.get<{ priority: number; payload_json: string }>("SELECT priority, payload_json FROM jobs WHERE download_job_id = (SELECT id FROM download_jobs WHERE public_id = ?)", [a.id])).toMatchObject({ priority: 4 });
    expect((await t.api("PATCH", `/api/downloads/${a.id}`, {})).status).toBe(400);

    const cancelled = await t.api("POST", `/api/downloads/${a.id}/cancel`);
    expect(cancelled.body).toMatchObject({ state: "cancelled", controls: { pause: false, resume: false, cancel: false, retry: false, setPriority: false } });
    expect(t.svc.db.get<{ state: string }>("SELECT state FROM jobs WHERE download_job_id = (SELECT id FROM download_jobs WHERE public_id = ?)", [a.id])!.state).toBe("cancelled");
    unblockHost(t);
  });

  it("every forbidden transition answers 409 with what is allowed, and the state does not change", async () => {
    const t = await server();
    const done = (await t.api("POST", "/api/downloads", { kind: "capture", url: `${art()}/moon` })).body;
    await finished(t, done.id);
    for (const action of ["pause", "resume", "cancel", "retry"]) {
      const r = await t.api("POST", `/api/downloads/${done.id}/${action}`);
      expect(r.status, action).toBe(409);
      expect(r.body.error).toBe("conflict");
      expect(r.body.details).toMatchObject({ state: "completed", action, allowed: [] });
    }
    expect((await t.api("PATCH", `/api/downloads/${done.id}`, { priority: "P1" })).status).toBe(409);

    blockHost(t);
    const q = (await t.api("POST", "/api/downloads", { kind: "capture", url: `${art()}/mars` })).body;
    expect((await t.api("POST", `/api/downloads/${q.id}/resume`)).status).toBe(409); // not paused
    expect((await t.api("POST", `/api/downloads/${q.id}/retry`)).status).toBe(409); // not failed
    await t.api("POST", `/api/downloads/${q.id}/cancel`);
    expect((await t.api("POST", `/api/downloads/${q.id}/cancel`)).status).toBe(409);
    expect((await t.api("POST", `/api/downloads/${q.id}/resume`)).status).toBe(409);
    expect((await t.api("GET", `/api/downloads/${q.id}`)).body.state).toBe("cancelled");
    unblockHost(t);
  });

  it("retry re-queues a failed capture, counts the attempt and fails again with the same reason when nothing changed", async () => {
    const t = await server();
    const c = (await t.api("POST", "/api/downloads", { kind: "capture", url: `${edge()}/status/500` })).body;
    const first = await finished(t, c.id, 120_000);
    expect(first.state).toBe("failed");
    expect(first.failure!.code).toBe("http_5xx");
    const r = await t.api("POST", `/api/downloads/${c.id}/retry`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: "queued", attempts: 1 });
    expect(r.body.failure).toBeUndefined();
    const second = await until(() => {
      const d = t.svc.downloads.get(c.id);
      return d.state === "failed" ? d : undefined;
    }, 120_000);
    expect(second.attempts).toBe(1);
    expect(t.svc.db.all<{ message: string }>("SELECT message FROM activity_log WHERE download_job_id = (SELECT id FROM download_jobs WHERE public_id = ?)", [c.id]).some((m) => /Retry 1/.test(m.message))).toBe(true);
  }, 180_000);

  it("queue order: 'top' runs a later download before an earlier one of the same priority", async () => {
    const t = await server();
    blockHost(t);
    const a = (await t.api("POST", "/api/downloads", { kind: "capture", url: `${art()}/moon` })).body;
    const b = (await t.api("POST", "/api/downloads", { kind: "capture", url: `${art()}/mars` })).body;
    const c = (await t.api("POST", "/api/downloads", { kind: "capture", url: `${art()}/stars` })).body;
    const moved = (await t.api("PATCH", `/api/downloads/${c.id}`, { queueOrder: "top" })).body;
    expect(moved.queueOrder).toBeLessThan(0);
    (await t.api("PATCH", `/api/downloads/${a.id}`, { queueOrder: "bottom" }));
    const score = (id: string) => t.svc.db.get<{ score: number }>("SELECT score FROM jobs WHERE download_job_id = (SELECT id FROM download_jobs WHERE public_id = ?)", [id])!.score;
    expect(score(c.id)).toBeGreaterThan(score(b.id));
    expect(score(b.id)).toBeGreaterThan(score(a.id));
    // Start them one at a time to see the order they run in.
    t.svc.db.run("UPDATE host_state SET backoff_until = 0 WHERE host = '127.0.0.1'");
    await Promise.all([a, b, c].map((x) => finished(t, x.id)));
    const order = t.svc.db.all<{ public_id: string }>("SELECT public_id FROM download_jobs ORDER BY started_at, id").map((r) => r.public_id);
    expect(order[0]).toBe(c.id);
    expect(order[2]).toBe(a.id);
  });

  it("Idempotency-Key: the same key and body returns the first download, a different body is refused", async () => {
    const t = await server();
    blockHost(t);
    const key = { "idempotency-key": "abc-123" };
    const one = await t.api("POST", "/api/downloads", { kind: "capture", url: `${art()}/moon` }, key);
    const two = await t.api("POST", "/api/downloads", { kind: "capture", url: `${art()}/moon` }, key);
    expect([one.status, two.status]).toEqual([202, 200]);
    expect(two.body.id).toBe(one.body.id);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM download_jobs")!.n).toBe(1);
    expect((await t.api("POST", "/api/downloads", { kind: "capture", url: `${art()}/mars` }, key)).status).toBe(409);
    unblockHost(t);
  });

  it("creation validates the kind and says which kinds are not available yet", async () => {
    const t = await server();
    expect((await t.api("POST", "/api/downloads", { kind: "capture" })).status).toBe(400);
    expect((await t.api("POST", "/api/downloads", { kind: "wikipedia", url: "https://en.wikipedia.org/wiki/Moon" })).status).toBe(501);
    expect((await t.api("POST", "/api/downloads", { kind: "capture", url: `${art()}/moon`, asCollection: { name: "x" } })).status).toBe(501);
    expect((await t.api("POST", "/api/downloads", { kind: "nonsense", url: `${art()}/moon` })).status).toBe(400);
    expect((await t.api("POST", "/api/downloads", { kind: "refresh", sourceId: "src_nope" })).status).toBe(404);
  });
});

describe("C-08 crawls: control cycle, progress, estimate and SSE", () => {
  it("pause, resume and cancel a crawl; progress and a labelled estimate while it runs; download.update events", async () => {
    const t = await server();
    const g = await graph(fixtures());
    const updates: any[] = [];
    t.svc.events.subscribe((e) => { if (e.type === "download.update") updates.push((e.data as any).download); });
    const created = await t.api("POST", "/api/downloads", { kind: "explore", url: g.root, config: { depth: 2, perDomainDelayMs: 60 }, priority: "P3" });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    const id = created.body.id;
    expect(created.body).toMatchObject({ kind: "explore", state: "running", controls: { pause: true, cancel: true, retry: false } });

    const mid = await until(() => {
      const d = t.svc.downloads.get(id);
      return d.progress.pagesDone >= 4 ? d : undefined;
    });
    expect(mid.progress).toMatchObject({ pagesFailed: 0 });
    expect(mid.progress.pagesDiscovered).toBeGreaterThan(mid.progress.pagesDone);
    expect(mid.progress.percent).toBeGreaterThan(0);
    expect(mid.progress.percent).toBeLessThan(100);
    expect(mid.estimate).toMatchObject({ estimate: true, confidence: "low" });
    expect(mid.estimate!.pages!.high).toBeGreaterThanOrEqual(mid.estimate!.pages!.low);
    expect(mid.estimate!.bytes!.high).toBeGreaterThan(0);
    expect(mid.estimate!.basis).toMatch(/Extrapolated/);

    const p = await t.api("POST", `/api/downloads/${id}/pause`);
    expect(p.body).toMatchObject({ state: "paused", pause: { reason: "user" } });
    const frozen = t.svc.downloads.get(id).progress.pagesDone;
    await new Promise((r) => setTimeout(r, 400));
    expect(t.svc.downloads.get(id).progress.pagesDone - frozen).toBeLessThanOrEqual(1);
    const r = await t.api("POST", `/api/downloads/${id}/resume`);
    expect(r.body.state).toBe("running");
    await until(() => t.svc.downloads.get(id).progress.pagesDone > frozen + 2);
    const detail = (await t.api("GET", `/api/downloads/${id}`)).body;
    expect(detail.crawl).toMatchObject({ mode: "explore" });
    expect(detail.crawl.frontier.queued + detail.crawl.frontier.running).toBeGreaterThan(0);

    const c = await t.api("POST", `/api/downloads/${id}/cancel`);
    expect(c.body).toMatchObject({ state: "cancelled", stop: { reason: "cancelled" } });
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE download_job_id = (SELECT id FROM download_jobs WHERE public_id = ?) AND state IN ('queued','running','held')", [id])!.n).toBe(0);

    await new Promise((r2) => setTimeout(r2, 300)); // the last events are flushed in batches
    const mine = updates.filter((u) => u.id === id);
    expect(mine.length).toBeGreaterThan(2);
    expect(mine.map((u) => u.state)).toContain("paused");
    expect(mine.at(-1).state).toBe("cancelled");
    const counts = mine.map((u) => u.progress.pagesDone);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(mine.every((u) => u.crawl === undefined)).toBe(true);
    const queue = (await t.api("GET", "/api/downloads/queue")).body;
    expect(queue.counts).toMatchObject({ cancelled: 1, running: 0 });
    expect(queue).toMatchObject({ connectivity: expect.any(String), window: { open: true }, throttle: { active: false }, disk: { paused: false } });
    expect(queue.workers.map((w: any) => w.name)).toContain("runner");
    expect(queue.limits).toMatchObject({ fetchConcurrency: expect.any(Number), minFreeDiskBytes: expect.any(Number) });
  }, 120_000);

  it("download.update reaches an SSE client of /api/system/events", async () => {
    const t = await server();
    const { apiPort } = await t.server.listen();
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/system/events`, { headers: { cookie: t.cookie }, signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += dec.decode(value);
        if (text.includes("event: download.update") && text.includes('"state":"completed"')) return;
      }
    })();
    await t.api("POST", "/api/downloads", { kind: "capture", url: `${art()}/moon` });
    await Promise.race([pump, new Promise((_, rej) => setTimeout(() => rej(new Error(`no download.update; got ${text.slice(0, 300)}`)), 20_000))]);
    ac.abort();
    const data = /event: download\.update\ndata: (.+)\n/.exec(text)?.[1];
    expect(JSON.parse(data!).download).toMatchObject({ kind: "capture", progress: expect.any(Object), controls: expect.any(Object) });
  }, 40_000);
});

describe("C-08 downloads survive a restart", () => {
  it("kill the server in the middle of a crawl; after a restart the list shows the same job, resumed, and it finishes", async () => {
    const g = await graph(fixtures());
    const dataDir = tempDir("ncb-dl-data-");
    const rootsDir = tempDir("ncb-dl-roots-");
    const request: CrawlRequest = { startUrls: [g.root], mode: "explore", profile: "comprehensive", overrides: { scope: { maxDepth: 2 }, politeness: { minDelayMs: 25 } } };
    const { signal, code } = await new Promise<{ signal: NodeJS.Signals | null; code: number | null }>((resolve, reject) => {
      const c = spawn(path.join(root, "node_modules/.bin/tsx"), [path.join(root, "tests/integration/crawl/crawl-child.ts")], {
        cwd: root, stdio: ["ignore", "ignore", "inherit"],
        env: { ...process.env, CHILD_DATA_DIR: dataDir, CHILD_ROOTS_DIR: rootsDir, CRAWL_REQUEST: JSON.stringify(request), KILL_AFTER_PAGES: "7" },
      });
      c.on("error", reject);
      c.on("exit", (cd, sg) => resolve({ code: cd, signal: sg }));
    });
    expect(signal === "SIGKILL" || code === 137, `child exited with code ${code} signal ${signal}`).toBe(true);

    const t = await server({ dataDir, rootsDir });
    const list = await t.api("GET", "/api/downloads");
    expect(list.body.total).toBe(1);
    const first = list.body.items[0];
    expect(first).toMatchObject({ kind: "explore", requestedBy: "user", requestedUrl: g.root });
    expect(["running", "completed"]).toContain(first.state);
    expect(first.progress.pagesDone).toBeGreaterThanOrEqual(7);
    expect(first.id).toBe(t.svc.crawl.list()[0]!.downloadId);

    const done = await finished(t, first.id, 120_000);
    expect(done).toMatchObject({ id: first.id, state: "completed", stop: { reason: "max_depth" }, progress: { percent: 100 } });
    expect(done.progress.pagesDone).toBe(t.svc.crawl.get(first.id)!.pagesFetched);
    expect(done.progress.pagesDone).toBeGreaterThanOrEqual(37);
    expect((await t.api("GET", "/api/downloads")).body.total).toBe(1);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running','held')")!.n).toBe(0);
  }, 180_000);
});

describe("C-08 a queued capture survives a restart too", () => {
  it("is still queued, then runs, after the server restarts", async () => {
    const dataDir = tempDir("ncb-dl2-data-");
    const rootsDir = tempDir("ncb-dl2-roots-");
    const t1 = await server({ dataDir, rootsDir });
    blockHost(t1);
    const created = await t1.api("POST", "/api/downloads", { kind: "capture", url: `${art()}/moon` });
    const id = created.body.id as string;
    await t1.server.close();

    const t2 = await server({ dataDir, rootsDir });
    const before = t2.svc.downloads.get(id);
    expect(["queued", "running", "completed"]).toContain(before.state);
    unblockHost(t2);
    t2.svc.db.run("UPDATE host_state SET next_allowed_at = 0, backoff_until = 0");
    expect((await finished(t2, id)).state).toBe("completed");
  }, 60_000);
});
