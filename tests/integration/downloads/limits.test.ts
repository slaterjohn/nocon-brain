import { describe, expect, it } from "vitest";
import { createFetcher, createSsrfGuard } from "@ncb/fetch";
import { systemClock } from "@ncb/shared";
import { RESOURCE_PRESETS } from "@ncb/server";
import { startCrawlServer, testConfig, until, useFixtures } from "../crawl/helpers.js";
import { graph } from "../crawl/helpers.js";
import { call, setupAdmin } from "../server/helpers.js";

const fixtures = useFixtures();
const edge = () => fixtures().urls.edge as string;

const setLimits = (t: { svc: { settings: { patch(b: unknown): unknown } } }, resources: Record<string, unknown>) => t.svc.settings.patch({ resources });

describe("C-10 bandwidth token bucket on response streams", () => {
  it("holds a large body to the configured rate within 20 percent, and shares the cap between concurrent downloads", async () => {
    const t = await startCrawlServer();
    // 3,200 kilobits per second = 400,000 bytes per second.
    setLimits(t, { bandwidthLimitKbps: 3200 });
    expect(t.svc.limits.bandwidth.rate).toBe(400_000);
    const fetcher = createFetcher({ ssrf: createSsrfGuard({ allow: "127.0.0.1" }), bodyThrottle: () => t.svc.limits.bandwidth.transform(), maxBytes: 8 * 1024 * 1024 });

    const one = async (bytes: number) => {
      const res = await fetcher.fetch(`${edge()}/huge?bytes=${bytes}`);
      return (res.body as Buffer).length;
    };

    const t0 = performance.now();
    expect(await one(1_200_000)).toBe(1_200_000);
    const alone = (performance.now() - t0) / 1000;
    expect(alone).toBeGreaterThan(3 * 0.8 - 0.3); // 1.2 MB at 400 kB/s is 3 s, less the 100 ms burst
    expect(alone).toBeLessThan(3 * 1.2);

    // Two downloads at once still add up to the one cap.
    const t1 = performance.now();
    const sizes = await Promise.all([one(600_000), one(600_000)]);
    const together = (performance.now() - t1) / 1000;
    expect(sizes).toEqual([600_000, 600_000]);
    expect(together).toBeGreaterThan(3 * 0.8 - 0.3);
    expect(together).toBeLessThan(3 * 1.2);

    // No limit: the same body is fast.
    setLimits(t, { bandwidthLimitKbps: 0 });
    const t2 = performance.now();
    await one(1_200_000);
    expect((performance.now() - t2) / 1000).toBeLessThan(1);
    await fetcher.close();
  }, 60_000);

  it("is applied to the server's own captures", async () => {
    const t = await startCrawlServer();
    setLimits(t, { bandwidthLimitKbps: 3200 });
    const t0 = performance.now();
    const { downloadId } = t.svc.pipeline.captureUrl(`${edge()}/huge?bytes=1000000`, { requestedBy: "user" });
    await until(() => ["completed", "failed"].includes(t.svc.pipeline.getCapture(downloadId)?.state ?? ""), 60_000);
    // 1 MB at 400 kB/s takes at least 2.5 s on the wire.
    expect((performance.now() - t0) / 1000).toBeGreaterThan(2.2);
    expect(t.svc.limits.bandwidth.throttledBytes).toBeGreaterThanOrEqual(1_000_000);
  }, 60_000);
});

describe("C-10 disk thresholds", () => {
  it("pauses background downloads under the reserve (volume_full) and resumes them when space returns; the Human's own save is not paused", async () => {
    const free = { value: 100 * 1024 ** 3 };
    const t = await startCrawlServer({
      env: { NCB_MIN_FREE_DISK_GB: "5" },
      server: { volumeProbes: { statfs: async () => ({ total: 1024 ** 4, free: free.value }) }, limits: { diskTickMs: 3_600_000 } },
    });
    const cookie = await setupAdmin(t);
    const api = async (method: string, url: string, body?: unknown) => {
      const r = await call(t, { method, url, body, cookie });
      return { status: r.statusCode, body: r.body ? r.json() : undefined };
    };
    const g = await graph(fixtures());
    const run = t.svc.crawl.startCrawl(testConfig({ startUrls: [g.root], mode: "explore", profile: "balanced", overrides: { scope: { maxDepth: 2 }, politeness: { minDelayMs: 80 } } }));
    const scheduled = t.svc.pipeline.captureUrl(`${fixtures().urls.article}/moon`, { requestedBy: "schedule" });
    await until(() => (t.svc.crawl.get(run.downloadId)?.pagesFetched ?? 0) >= 2);

    expect((await api("GET", "/api/downloads/queue")).body.disk).toMatchObject({ paused: false });
    free.value = 1 * 1024 ** 3; // below the 5 GiB reserve
    await t.svc.limits.diskTick();

    const crawl = (await api("GET", `/api/downloads/${run.downloadId}`)).body;
    expect(crawl).toMatchObject({ state: "paused", pause: { reason: "volume_full", automatic: true }, controls: { resume: false, cancel: true } });
    const sched = (await api("GET", `/api/downloads/${scheduled.downloadId}`)).body;
    expect(["paused", "completed"]).toContain(sched.state); // it may have finished before the guard looked
    const summary = (await api("GET", "/api/downloads/queue")).body;
    expect(summary.disk.paused).toBe(true);
    expect(summary.disk.volumes[0]).toMatchObject({ low: true });
    expect(summary.disk.pausedDownloads).toBeGreaterThanOrEqual(1);
    // The Human cannot resume it by hand while the disk is full.
    expect((await api("POST", `/api/downloads/${run.downloadId}/resume`)).status).toBe(409);
    const stalled = t.svc.crawl.get(run.downloadId)!.pagesFetched;
    await new Promise((r) => setTimeout(r, 400));
    expect(t.svc.crawl.get(run.downloadId)!.pagesFetched - stalled).toBeLessThanOrEqual(2); // only the pages already being fetched finish

    // A single page the Human saves is not background work.
    const mine = t.svc.pipeline.captureUrl(`${fixtures().urls.article}/mars`, { requestedBy: "user", userInitiated: true });
    await t.svc.limits.diskTick();
    expect((await api("GET", `/api/downloads/${mine.downloadId}`)).body.state).not.toBe("paused");

    free.value = 50 * 1024 ** 3;
    await t.svc.limits.diskTick();
    expect((await api("GET", "/api/downloads/queue")).body.disk).toMatchObject({ paused: false, pausedDownloads: 0 });
    const resumed = (await api("GET", `/api/downloads/${run.downloadId}`)).body;
    expect(["running", "completed"]).toContain(resumed.state);
    expect(resumed.pause).toBeUndefined();
    await until(() => t.svc.crawl.get(run.downloadId)?.finishedAt, 90_000);
    expect(t.svc.crawl.get(run.downloadId)!.state).toBe("completed");
    const log = t.svc.db.all<{ message: string }>("SELECT message FROM activity_log WHERE area = 'storage'").map((r) => r.message).join("\n");
    expect(log).toContain("below the reserve");
    expect(log).toContain("back above the reserve");
  }, 120_000);
});

describe("C-10 CPU throttling", () => {
  it("lowers concurrency while the event loop lags or the load is high, and restores it when calm (synthetic sources)", async () => {
    const src = { lag: 0, load: 0 };
    const t = await startCrawlServer({ server: { limits: { lagSource: () => src.lag, loadSource: () => src.load, cpuTickMs: 3_600_000 } } });
    setLimits(t, { maxFetchConcurrency: 4, perHostConcurrency: 8, cpuThrottle: "medium" });
    const gov = t.svc.limits;
    gov.cpuTick();
    expect(gov.fetchConcurrency()).toBe(4);
    expect(gov.throttleStatus()).toMatchObject({ active: false, level: "medium" });

    src.lag = 150; // over the 100 ms of the medium level
    gov.cpuTick();
    expect(gov.fetchConcurrency()).toBe(2);
    expect(gov.throttleStatus()).toMatchObject({ active: true, reason: "event_loop_lag", lagMs: 150 });
    expect(gov.limits()).toMatchObject({ fetchConcurrency: 4, effectiveFetchConcurrency: 2 });

    src.lag = 400;
    gov.cpuTick();
    expect(gov.fetchConcurrency()).toBe(1);

    src.lag = 70; // under the trigger but not under the release point: stays throttled (hysteresis)
    gov.cpuTick();
    expect(gov.throttleStatus().active).toBe(true);
    src.lag = 10;
    gov.cpuTick();
    expect(gov.fetchConcurrency()).toBe(4);

    src.load = 1.6; // load average per core
    gov.cpuTick();
    expect(gov.throttleStatus()).toMatchObject({ active: true, reason: "load_average" });
    src.load = 0.2;
    gov.cpuTick();
    expect(gov.throttleStatus().active).toBe(false);

    setLimits(t, { cpuThrottle: "off" });
    src.lag = 5000;
    gov.cpuTick();
    expect(gov.fetchConcurrency()).toBe(4);
  });

  it("the runner uses the lowered concurrency: fewer requests reach the site at once", async () => {
    const src = { lag: 0 };
    const t = await startCrawlServer({ server: { limits: { lagSource: () => src.lag, loadSource: () => 0, cpuTickMs: 3_600_000 } } });
    setLimits(t, { maxFetchConcurrency: 4, perHostConcurrency: 8, cpuThrottle: "medium" });
    t.svc.db.run("INSERT INTO host_state (host, max_concurrent) VALUES ('127.0.0.1', 8) ON CONFLICT(host) DO UPDATE SET max_concurrent = 8");

    const burst = async (tag: string) => {
      await fetch(`${edge()}/__log/reset`);
      const ids = Array.from({ length: 8 }, (_, i) => t.svc.pipeline.captureUrl(`${edge()}/delay/350?${tag}=${i}`, { requestedBy: "user" }).downloadId);
      await until(() => ids.every((id) => ["completed", "failed"].includes(t.svc.pipeline.getCapture(id)?.state ?? "")), 60_000);
      const log = (await (await fetch(`${edge()}/__log`)).json()) as { maxInFlight: number };
      return log.maxInFlight;
    };

    const normal = await burst("a");
    expect(normal).toBeGreaterThanOrEqual(3);
    expect(normal).toBeLessThanOrEqual(4);

    src.lag = 500; // far over the medium level: severe, so one at a time
    t.svc.limits.cpuTick();
    expect(await burst("b")).toBe(1);

    src.lag = 0;
    t.svc.limits.cpuTick();
    expect(await burst("c")).toBeGreaterThanOrEqual(3);
  }, 120_000);
});

describe("C-10 profiles", () => {
  it("pi-lite and standard presets match the table in docs/architecture.md section 10", () => {
    expect(RESOURCE_PRESETS["pi-lite"]).toMatchObject({ maxFetchConcurrency: 2, perHostConcurrency: 1, perHostDelayMs: 1500, extractWorkers: 1, workerMemoryMb: 256, renderConcurrency: 1 });
    expect(RESOURCE_PRESETS.standard).toMatchObject({ maxFetchConcurrency: 6, perHostConcurrency: 1, perHostDelayMs: 1000, extractWorkers: 2, workerMemoryMb: 512, renderConcurrency: 1 });
  });

  it("the setup step applies the preset and the settings expose every limit", async () => {
    const t = await startCrawlServer();
    const cookie = await setupAdmin(t);
    const r = await call(t, { url: "/api/setup/profile", body: { profile: "pi-lite" }, cookie });
    expect(r.statusCode).toBe(200);
    expect(r.json().resources).toMatchObject({ profile: "pi-lite", maxFetchConcurrency: 2, perHostConcurrency: 1, perHostDelayMs: 1500, extractWorkers: 1, workerMemoryMb: 256, renderConcurrency: 1, cpuThrottle: "medium", bandwidthLimitKbps: 0 });
    const q = (await call(t, { url: "/api/downloads/queue", cookie })).json();
    expect(q.limits).toMatchObject({ profile: "pi-lite", fetchConcurrency: 2, effectiveFetchConcurrency: 2, perHostDelayMs: 1500, workerMemoryMb: 256, renderConcurrency: 1, cpuThrottle: "medium" });
    expect(q.limits.bandwidthKbps).toBeUndefined();
    // Invalid values name the field.
    const bad = await call(t, { method: "PATCH", url: "/api/settings", body: { resources: { cpuThrottle: "extreme", renderConcurrency: 99 } }, cookie });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details.fields.map((f: { path: string }) => f.path).sort()).toEqual(["resources.cpuThrottle", "resources.renderConcurrency"]);
    void systemClock;
  });

  it("the per-host cap and delay floor apply to the queue claim", async () => {
    const t = await startCrawlServer();
    setLimits(t, { perHostConcurrency: 1, perHostDelayMs: 600 });
    await fetch(`${edge()}/__log/reset`);
    const ids = Array.from({ length: 3 }, (_, i) => t.svc.pipeline.captureUrl(`${edge()}/delay/10?h=${i}`, { requestedBy: "user" }).downloadId);
    await until(() => ids.every((id) => ["completed", "failed"].includes(t.svc.pipeline.getCapture(id)?.state ?? "")), 30_000);
    const log = (await (await fetch(`${edge()}/__log`)).json()) as { entries: { url: string; t: number }[]; maxInFlight: number };
    const hits = log.entries.filter((e) => e.url.startsWith("/delay/")).map((e) => e.t);
    expect(log.maxInFlight).toBe(1);
    expect(hits).toHaveLength(3);
    expect(hits[1]! - hits[0]!).toBeGreaterThanOrEqual(550);
    expect(hits[2]! - hits[1]!).toBeGreaterThanOrEqual(550);
  }, 60_000);
});
