import { describe, expect, it } from "vitest";
import { graph, startCrawlServer, testConfig, until, useFixtures, waitFinished, fetchedUrls } from "./helpers.js";

const fixtures = useFixtures();
/** The trap site's /real section links back to the trap home from its nav; stay inside the section. */
const REAL_ONLY = { scope: { allowedPaths: ["/real"] } };

async function logOf(origin: string) {
  return (await (await fetch(`${origin}/__log`)).json()) as { entries: { url: string; t: number; inFlight: number }[]; maxInFlight: number };
}
const resetLog = (origin: string) => fetch(`${origin}/__log/reset`);

describe("C-01 depth-limited crawl reproduces the link graph", () => {
  it.each([1, 2])("depth %i matches /__graph.json countsByDepth", async (depth) => {
    const fx = fixtures();
    const g = await graph(fx);
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({ startUrls: [g.root], mode: "explore", profile: "comprehensive", overrides: { scope: { maxDepth: depth } } }));
    const s = await waitFinished(t, run.downloadId);
    expect(s.stopReason).toBe("max_depth");
    expect(s.state).toBe("completed");

    const byUrl = new Map(g.nodes.filter((n) => n.kind === "content").map((n) => [n.url, n]));
    const counts: Record<number, number> = {};
    const seen = new Set<number>();
    for (const u of fetchedUrls(t, run.downloadJobId)) {
      const n = byUrl.get(u);
      if (!n) continue; // the "/" alias of the root, and the legal pages
      expect(seen.has(n.id), `node ${n.id} fetched twice`).toBe(false);
      seen.add(n.id);
      counts[n.depth] = (counts[n.depth] ?? 0) + 1;
    }
    for (let d = 0; d <= depth; d++) expect(counts[d], `depth ${d}`).toBe(g.countsByDepth[String(d)]);
    expect(Object.keys(counts).map(Number).filter((d) => d > depth)).toEqual([]);
    expect(s.depthReached).toBe(depth);
    // The footer's two legal pages and the "/" alias (the nav links to it) are fetched once each, outside the node counts.
    expect(fetchedUrls(t, run.downloadJobId).filter((u) => u.includes("/legal/"))).toHaveLength(2);
    expect(fetchedUrls(t, run.downloadJobId)).toContain(g.homeAlias);
    expect(s.pagesFailed).toBeGreaterThanOrEqual(1); // /legal/old
    const dup = t.svc.db.get<{ n: number }>("SELECT COUNT(*) - COUNT(DISTINCT url_key) AS n FROM jobs WHERE crawl_job_id = ?", [s.crawlJobId])!.n;
    expect(dup).toBe(0);
  });
});

describe("C-01 politeness", () => {
  it("never has two requests in flight and keeps the configured spacing", async () => {
    const fx = fixtures();
    const origin = fx.urls.linkGraph;
    const g = await graph(fx);
    await resetLog(origin);
    const delay = 150;
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({ startUrls: [g.root], mode: "explore", profile: "comprehensive", overrides: { scope: { maxDepth: 1 }, politeness: { minDelayMs: delay } } }));
    const s = await waitFinished(t, run.downloadId);
    expect(s.pagesFetched).toBeGreaterThan(5);
    const log = await logOf(origin);
    expect(log.maxInFlight).toBe(1);
    const pages = log.entries.filter((e) => !e.url.startsWith("/robots.txt"));
    expect(pages.length).toBeGreaterThanOrEqual(s.pagesFetched + s.pagesFailed);
    for (let i = 1; i < pages.length; i++) expect(pages[i]!.t - pages[i - 1]!.t, `gap before request ${i}`).toBeGreaterThanOrEqual(delay - 10);
    // robots.txt is fetched once for the whole crawl (it is cached).
    expect(log.entries.filter((e) => e.url.startsWith("/robots.txt")).length).toBe(1);
  });

  it("obeys robots.txt rules and its Crawl-delay, and never bypasses them", async () => {
    const fx = fixtures();
    const origin = fx.urls.robots;
    await resetLog(origin);
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({
      startUrls: [`${origin}/public/page-1`, `${origin}/private/secret`, `${origin}/public/page-2`, `${origin}/noconbrain-blocked/page`, `${origin}/allowed/page`],
      mode: "explore", profile: "focused", overrides: { scope: { maxDepth: 0 } },
    }));
    const s = await waitFinished(t, run.downloadId);
    expect(s.pagesFetched).toBe(4); // /private/secret is allowed: the NoConBrain group replaces the * group
    expect(s.skips.robots).toBe(1);
    const log = await logOf(origin);
    const paths = log.entries.map((e) => e.url);
    expect(paths.some((p) => p.startsWith("/noconbrain-blocked/"))).toBe(false);
    const pages = log.entries.filter((e) => !e.url.startsWith("/robots.txt"));
    expect(pages).toHaveLength(4);
    // The NoConBrain group says Crawl-delay: 1 (second).
    for (let i = 1; i < pages.length; i++) expect(pages[i]!.t - pages[i - 1]!.t).toBeGreaterThanOrEqual(990);
    expect(log.maxInFlight).toBe(1);
    expect(t.svc.db.get<{ crawl_delay_ms: number }>("SELECT crawl_delay_ms FROM host_state WHERE host = '127.0.0.1'")!.crawl_delay_ms).toBeGreaterThanOrEqual(1000);
  });

  it("backs the host off on 429 and retries", async () => {
    const fx = fixtures();
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({ startUrls: [`${fx.urls.edge}/429/once?key=crawl-${Date.now()}`], mode: "explore", profile: "focused", overrides: { scope: { maxDepth: 0 } } }));
    const s = await waitFinished(t, run.downloadId);
    expect(s.pagesFetched + s.pagesFailed).toBe(1);
    const job = t.svc.db.get<{ attempts: number }>("SELECT attempts FROM jobs WHERE crawl_job_id = ?", [s.crawlJobId])!;
    expect(job.attempts).toBeGreaterThanOrEqual(2);
  });
});

describe("C-01 caps and stop reasons", () => {
  it("maxPages", async () => {
    const g = await graph(fixtures());
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({ startUrls: [g.root], mode: "explore", profile: "comprehensive", overrides: { limits: { maxPages: 5 } } }));
    const s = await waitFinished(t, run.downloadId);
    expect(s.stopReason).toBe("max_pages");
    expect(s.pagesFetched).toBe(5);
    expect(s.state).toBe("completed");
    expect(s.frontier.queued + s.frontier.held).toBe(0);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions WHERE download_job_id = ?", [run.downloadJobId])!.n).toBe(5);
  });

  it("maxBytes", async () => {
    const g = await graph(fixtures());
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({ startUrls: [g.root], mode: "explore", profile: "comprehensive", overrides: { limits: { maxBytes: 3000 } } }));
    const s = await waitFinished(t, run.downloadId);
    expect(s.stopReason).toBe("max_bytes");
    // HB-06: the per-page share of the budget is reserved before fetching, so the crawl no longer overshoots by a page.
    expect(s.bytesFetched).toBeLessThanOrEqual(3000);
    expect(s.bytesFetched).toBeGreaterThan(0);
    expect(s.pagesFetched).toBeLessThan(15);
  });

  it("maxDuration", async () => {
    const g = await graph(fixtures());
    const t = await startCrawlServer();
    const started = Date.now();
    const run = t.svc.crawl.startCrawl(testConfig({
      startUrls: [g.root], mode: "explore", profile: "comprehensive", overrides: { limits: { maxDurationMs: 1000 }, politeness: { minDelayMs: 200 } },
    }));
    const s = await waitFinished(t, run.downloadId);
    expect(s.stopReason).toBe("deadline");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(s.pagesFetched).toBeGreaterThanOrEqual(2);
    expect(s.pagesFetched).toBeLessThanOrEqual(8);
  });

  it("completed when the frontier runs dry", async () => {
    const fx = fixtures();
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({ startUrls: [`${fx.urls.trap}/real/1`], mode: "explore", profile: "balanced", overrides: REAL_ONLY }));
    const s = await waitFinished(t, run.downloadId);
    expect(s.stopReason).toBe("completed");
    expect(s.pagesFetched).toBe(3);
  });

  it("writes activity rows for start and stop with the reason", async () => {
    const fx = fixtures();
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({ startUrls: [`${fx.urls.trap}/real/3`], mode: "explore", profile: "balanced", overrides: REAL_ONLY }));
    await waitFinished(t, run.downloadId);
    const rows = t.svc.db.all<{ message: string; area: string; details_json: string | null }>("SELECT message, area, details_json FROM activity_log WHERE download_job_id = ? AND area = 'crawl' ORDER BY id", [run.downloadJobId]);
    expect(rows[0]!.message).toMatch(/Crawl started/);
    const stop = rows.at(-1)!;
    expect(stop.message).toMatch(/Crawl finished: completed/);
    expect(JSON.parse(stop.details_json!)).toMatchObject({ stopReason: "completed", pagesFetched: 1 });
  });
});

describe("C-01 pause, resume, cancel", () => {
  it("pauses within one request, resumes, and cancels", async () => {
    const g = await graph(fixtures());
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({
      startUrls: [g.root], mode: "explore", profile: "comprehensive", overrides: { scope: { maxDepth: 3 }, politeness: { minDelayMs: 60 } },
    }));
    await until(() => (t.svc.crawl.get(run.downloadId)?.pagesFetched ?? 0) >= 3);
    expect(t.svc.crawl.pause(run.downloadId)).toBe(true);
    await new Promise((r) => setTimeout(r, 250)); // let the request in flight finish
    const paused = t.svc.crawl.get(run.downloadId)!;
    expect(paused.state).toBe("paused");
    await new Promise((r) => setTimeout(r, 500));
    const still = t.svc.crawl.get(run.downloadId)!;
    expect(still.pagesFetched).toBe(paused.pagesFetched);
    expect(still.frontier.held).toBeGreaterThan(0);
    expect(still.frontier.running).toBe(0);
    expect(still.finishedAt).toBeNull();

    expect(t.svc.crawl.resume(run.downloadId)).toBe(true);
    await until(() => (t.svc.crawl.get(run.downloadId)?.pagesFetched ?? 0) >= paused.pagesFetched + 4);
    expect(t.svc.crawl.get(run.downloadId)!.state).toBe("running");

    expect(t.svc.crawl.cancel(run.downloadId)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    const cancelled = t.svc.crawl.get(run.downloadId)!;
    expect(cancelled).toMatchObject({ state: "cancelled", stopReason: "cancelled" });
    expect(cancelled.finishedAt).not.toBeNull();
    await new Promise((r) => setTimeout(r, 400));
    expect(t.svc.crawl.get(run.downloadId)!.pagesFetched).toBeLessThanOrEqual(cancelled.pagesFetched + 1);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE crawl_job_id = ? AND state IN ('queued','running','held')", [cancelled.crawlJobId])!.n).toBe(0);
    expect(t.svc.crawl.cancel(run.downloadId)).toBe(false);
  });

  it("time spent paused does not count against the duration cap", async () => {
    const fx = fixtures();
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({
      startUrls: [`${fx.urls.trap}/real/1`], mode: "explore", profile: "balanced", overrides: { ...REAL_ONLY, limits: { maxDurationMs: 2500 }, politeness: { minDelayMs: 100 } },
    }));
    t.svc.crawl.pause(run.downloadId);
    await new Promise((r) => setTimeout(r, 2800));
    t.svc.crawl.resume(run.downloadId);
    const s = await waitFinished(t, run.downloadId);
    expect(s.stopReason).toBe("completed");
    expect(s.pagesFetched).toBe(3);
  });
});

describe("C-03 frontier order and score components", () => {
  async function frontierOrder() {
    const g = await graph(fixtures());
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({ startUrls: [g.root], mode: "explore", profile: "comprehensive", overrides: { scope: { maxDepth: 1 } } }));
    await waitFinished(t, run.downloadId);
    const rows = t.svc.db.all<{ url: string; score: number; payload_json: string }>(
      "SELECT url, score, payload_json FROM jobs WHERE crawl_job_id = ? AND depth = 1 AND json_extract(payload_json, '$.aliasOf') IS NULL ORDER BY id", [run.crawlJobId]);
    return { rows, g };
  }

  it("orders by region and stores the components, the same on every run", async () => {
    const a = await frontierOrder();
    const b = await frontierOrder();
    const norm = (x: typeof a) => x.rows.map((r) => r.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ""));
    expect(norm(a)).toEqual(norm(b));
    const via = a.rows.map((r) => ({ url: r.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ""), ...JSON.parse(r.payload_json).via }));
    const regionAt = (p: string) => via.findIndex((v) => v.url === p);
    // Main-article links (nodes 2 to 6) come before the heading link (node 1) and both before the footer pages.
    expect(regionAt("/n/2")).toBeLessThan(regionAt("/n/1"));
    expect(regionAt("/n/1")).toBeLessThan(regionAt("/legal/terms"));
    expect(via.find((v) => v.url === "/n/2")).toMatchObject({ region: "content", components: { region: 85 } });
    expect(via.find((v) => v.url === "/n/1")).toMatchObject({ region: "heading", components: { region: 65 } });
    expect(via.find((v) => v.url === "/legal/terms")).toMatchObject({ region: "footer", components: { region: 10 } });
    for (const v of via) expect(Object.keys(v.components).sort()).toEqual(["depth", "external", "position", "quality", "region"]);
    expect(a.rows[0]!.score).toBeGreaterThan(a.rows.at(-1)!.score);
  });
});

describe("C-01 kill and resume", () => {
  it("a restart continues the same frontier with no duplicates", async () => {
    const g = await graph(fixtures());
    const t1 = await startCrawlServer();
    const run = t1.svc.crawl.startCrawl(testConfig({
      startUrls: [g.root], mode: "explore", profile: "comprehensive", overrides: { scope: { maxDepth: 2 }, politeness: { minDelayMs: 30 } },
    }));
    await until(() => (t1.svc.crawl.get(run.downloadId)?.pagesFetched ?? 0) >= 8);
    const before = t1.svc.crawl.get(run.downloadId)!;
    expect(before.finishedAt).toBeNull();
    const { dataDir, rootsDir } = t1;
    await t1.server.close();

    const t2 = await startCrawlServer({ dataDir, rootsDir });
    const s = await waitFinished(t2, run.downloadId);
    expect(s.stopReason).toBe("max_depth");
    expect(s.pagesFetched).toBeGreaterThan(before.pagesFetched);

    const urls = fetchedUrls(t2, run.downloadJobId);
    expect(new Set(urls).size).toBe(urls.length); // no page fetched into two versions
    const nodeUrls = new Set(g.nodes.filter((n) => n.kind === "content" && n.depth <= 2).map((n) => n.url));
    const fetchedNodes = urls.filter((u) => nodeUrls.has(u));
    expect(fetchedNodes.length).toBe(1 + 6 + 30);
    expect(t2.svc.db.get<{ n: number }>("SELECT COUNT(*) - COUNT(DISTINCT url_key) AS n FROM jobs WHERE crawl_job_id = ?", [s.crawlJobId])!.n).toBe(0);
    expect(t2.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pages")!.n).toBe(new Set(urls).size);
    // Same totals as an uninterrupted run would give.
    expect(s.pagesFetched).toBe(urls.length);
  });
});
