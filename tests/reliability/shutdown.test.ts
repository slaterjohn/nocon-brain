import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { resolveCrawlConfig } from "@ncb/crawl";
import { ADMIN, call, setupAdmin, tempDir } from "../integration/server/helpers.js";
import { startBrowserServer } from "../integration/browser/helpers.js";
import { graph, startCrawlServer, useFixtures, waitFinished } from "../integration/crawl/helpers.js";
import { until } from "../integration/pipeline/helpers.js";
import { fetchedUrls } from "../integration/crawl/helpers.js";
import { startChild, ROOT, listFiles, verifyAll, integrity } from "./helpers.js";

const fixtures = useFixtures();

describe("graceful shutdown under load (in process)", () => {
  it("a stop in the middle of a crawl with requests in flight ends within the deadline, leaves nothing running and nothing half-written, and the crawl finishes after a restart", async () => {
    const g = await graph(fixtures());
    const dataDir = tempDir("ncb-sd-data-");
    const rootsDir = tempDir("ncb-sd-roots-");
    const t = await startCrawlServer({ dataDir, rootsDir, env: { NCB_SHUTDOWN_GRACE_SECONDS: "10" } });
    const cookie = await setupAdmin(t);
    const run = t.svc.crawl.startCrawl(resolveCrawlConfig({ startUrls: [g.root], mode: "explore", profile: "comprehensive", overrides: { scope: { maxDepth: 2 }, politeness: { minDelayMs: 0 } } }));
    await until(() => (t.svc.crawl.get(run.downloadId)?.pagesFetched ?? 0) >= 5);

    // Requests keep arriving while the server stops. Each one must be answered (200, or 503 once it says it is stopping), never dropped halfway.
    const outcomes: number[] = [];
    let stopping = false;
    let closed = false;
    const hammer = (async () => {
      while (!closed) {
        const before = !stopping;
        const res = await call(t, { url: "/api/downloads", cookie }).catch(() => undefined);
        // A request made before the stop began was in flight when it did: it must be answered. One made after the app closed is refused outright.
        if (!closed && (before || res)) outcomes.push(res ? res.statusCode : -1);
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    // Wait for a real sample of answered requests rather than a fixed time (a slow runner answers fewer in 50 ms).
    await until(() => outcomes.length >= 10);
    const started = Date.now();
    stopping = true;
    await t.server.close();
    closed = true;
    const took = Date.now() - started;
    await hammer;
    expect(stopping && outcomes.length).toBeGreaterThanOrEqual(10);
    expect(took).toBeLessThan(10_000);
    expect(outcomes.every((s) => s === 200 || s === 503), `statuses: ${[...new Set(outcomes)].join(",")}`).toBe(true);

    // State on disk: lock released, WAL folded into the database, no temporary files, no job claiming to run.
    expect(fs.existsSync(path.join(dataDir, "db", "main.db.lock"))).toBe(false);
    const wal = path.join(dataDir, "db", "main.db-wal");
    expect(!fs.existsSync(wal) || fs.statSync(wal).size === 0).toBe(true);
    expect(listFiles(path.join(rootsDir, "vol")).filter((f) => f.endsWith(".part"))).toEqual([]);
    expect(integrity(path.join(dataDir, "db", "main.db"))).toEqual([]);

    const back = await startCrawlServer({ dataDir, rootsDir });
    expect(back.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE state = 'running' AND started_at IS NULL")!.n).toBe(0);
    const first = back.svc.crawl.list()[0]!;
    await waitFinished(back, first.crawlJobId);
    const urls = fetchedUrls(back, first.downloadJobId);
    expect(new Set(urls).size).toBe(urls.length);
    await back.svc.search.drain();
    expect(await verifyAll(back.svc)).toEqual([]);
  });
});

describe("graceful shutdown of the real process", () => {
  it("SIGTERM with downloads running, a live event stream and requests in flight: exit code 0 within the deadline, stream ended, lock released", async () => {
    // Prepare a data directory with an administrator and a storage volume using the ordinary test server, then stop it.
    const dataDir = tempDir("ncb-sd2-data-");
    const rootsDir = tempDir("ncb-sd2-roots-");
    const seed = await startBrowserServer({ dataDir, rootsDir });
    await seed.server.close();

    const grace = 8;
    const apiPort = 25110 + Math.floor(Math.random() * 40);
    const child = startChild(path.join(ROOT, "apps/server/src/index.ts"), {
      NODE_ENV: "development", NCB_DATA_DIR: dataDir, NCB_VOLUMES_ALLOWED_ROOTS: rootsDir, NCB_APP_URL: "http://localhost:3000", NCB_PROXY_SECRET: "p".repeat(32),
      NCB_API_HOST: "127.0.0.1", NCB_API_PORT: String(apiPort), NCB_ARCHIVE_HOST: "127.0.0.1", NCB_ARCHIVE_PORT: String(apiPort + 50),
      NCB_EXTRACT_WORKERS: "0", NCB_MIN_FREE_DISK_GB: "0", NCB_LOG_LEVEL: "info", NCB_SHUTDOWN_GRACE_SECONDS: String(grace), NCB_FETCH_ALLOW_PRIVATE_HOSTS: "127.0.0.1",
      NCB_BACKUP_INTERVAL_HOURS: "0", NCB_VERIFY_INTERVAL_HOURS: "0",
    });
    // The process logs JSON lines on stdout.
    await child.waitFor(/"msg":"listening"/, 90_000);
    const base = `http://127.0.0.1:${apiPort}`;
    await until(async () => (await fetch(`${base}/api/system/health`).then((r) => r.json()).catch(() => ({}))).status === "ok", 60_000);
    const headers = { "content-type": "application/json", "x-nocon-csrf": "1", origin: "http://localhost:3000" };
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers, body: JSON.stringify(ADMIN) });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith("ncb_session="))!.split(";")[0]!;
    const h = { ...headers, cookie };

    for (const p of ["solar-power", "astronomy", "stars", "comets"]) {
      await fetch(`${base}/api/browser/save`, { method: "POST", headers: h, body: JSON.stringify({ url: `${fixtures().urls.article}/${p}` }) });
    }
    const stream = await fetch(`${base}/api/system/events`, { headers: { cookie } });
    expect(stream.status).toBe(200);
    let streamEnded = false;
    const reader = stream.body!.getReader();
    void (async () => { try { for (;;) { const r = await reader.read(); if (r.done) break; } streamEnded = true; } catch { streamEnded = true; } })();
    // Requests keep arriving. Any request that was sent well before the signal must be answered properly; one sent after it may be refused.
    const sent: { at: number; status: Promise<number> }[] = [];
    let signalled = 0;
    const pump = setInterval(() => sent.push({ at: Date.now(), status: fetch(`${base}/api/downloads`, { headers: { cookie } }).then((r) => r.status, () => -1) }), 4);
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    signalled = t0;
    child.proc.kill("SIGTERM");
    const exit = await Promise.race([child.exited, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("did not exit within the deadline")), (grace + 5) * 1000))]);
    expect(exit.signal).toBeNull();
    expect(exit.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan((grace + 5) * 1000);
    expect(streamEnded).toBe(true);
    clearInterval(pump);
    const early = await Promise.all(sent.filter((r) => r.at < signalled - 50).map((r) => r.status));
    expect(early.length).toBeGreaterThan(10);
    expect(early.every((s) => s === 200 || s === 503), `statuses of requests sent before the signal: ${[...new Set(early)].join(",")}`).toBe(true);
    await Promise.all(sent.map((r) => r.status));
    expect(fs.existsSync(path.join(dataDir, "db", "main.db.lock"))).toBe(false);

    const back = await startCrawlServer({ dataDir, rootsDir });
    await until(() => {
      const n = back.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM download_jobs WHERE state IN ('queued','running')")!.n;
      return n === 0;
    }, 60_000);
    expect(back.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM download_jobs WHERE state = 'failed'")!.n).toBe(0);
    expect(await verifyAll(back.svc)).toEqual([]);
  });
});
