import { describe, expect, it } from "vitest";
import { AppError } from "@ncb/shared";
import { HARD_CEILINGS, resolveCrawlConfig, type CrawlConfig } from "@ncb/crawl";
import { fetchedUrls, graph, startCrawlServer, testConfig, until, useFixtures, waitFinished } from "./helpers.js";

const fixtures = useFixtures();
const path = (u: string) => new URL(u).pathname;

describe("C-05 modes", () => {
  it("capture is a single page with no crawl row", async () => {
    const fx = fixtures();
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({ startUrls: [`${fx.urls.article}/astronomy`], mode: "capture" }));
    expect(run.crawlJobId).toBeNull();
    await until(() => t.svc.pipeline.getCapture(run.downloadId)?.state === "completed");
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM crawl_jobs")!.n).toBe(0);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pages")!.n).toBe(1);
    expect(t.svc.db.get<{ kind: string }>("SELECT kind FROM download_jobs")!.kind).toBe("capture");
  });

  it("explore follows links by the profile's rules", async () => {
    const g = await graph(fixtures());
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({ startUrls: [g.root], mode: "explore", profile: "focused", overrides: { scope: { maxDepth: 1 } } }));
    const s = await waitFinished(t, run.downloadId);
    const paths = fetchedUrls(t, run.downloadJobId).map(path).sort();
    // The root and its six children (main and heading links); the nav, related and footer links are not followed.
    expect(paths).toEqual(["/n/0", "/n/1", "/n/2", "/n/3", "/n/4", "/n/5", "/n/6"]);
    expect(s.followed).toEqual({ content: 5, heading: 1 });
    expect(s.skips["filter:region"]).toBeGreaterThan(0);
  });

  it("mirror of a section stays inside the section", async () => {
    const g = await graph(fixtures());
    const start = g.nodes.find((n) => n.id === 7)!.url;
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({ startUrls: [start], mode: "mirror", section: true, overrides: { scope: { maxDepth: 1 } } }));
    const s = await waitFinished(t, run.downloadId);
    const fetched = new Set(fetchedUrls(t, run.downloadJobId));
    const expected = new Set([start, ...g.edges.filter((e) => e.from === start && !e.broken && !e.external && path(e.to).startsWith("/n/")).map((e) => e.to)]);
    expect(fetched).toEqual(expected);
    // Home, the legal pages and the broken links are outside /n.
    expect(s.skips["scope:path_not_allowed"]).toBeGreaterThanOrEqual(3);
    expect([...fetched].some((u) => u.includes("/legal/"))).toBe(false);
  });

  it("mirror of a whole site follows navigation and footer links too", async () => {
    const g = await graph(fixtures());
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({ startUrls: [g.root], mode: "mirror", overrides: { scope: { maxDepth: 1 } } }));
    const s = await waitFinished(t, run.downloadId);
    const paths = fetchedUrls(t, run.downloadJobId).map(path);
    expect(paths).toContain("/legal/terms");
    expect(paths).toContain("/");
    expect(s.followed.footer).toBeGreaterThan(0);
    expect(s.followed.nav).toBeGreaterThan(0);
  });

  it("mirror refuses to exceed the hard ceilings", async () => {
    const fx = fixtures();
    const t = await startCrawlServer();
    expect(() => resolveCrawlConfig({ startUrls: [fx.urls.linkGraph], mode: "mirror", profile: "custom", resource: "pi-lite", overrides: { limits: { maxPages: 1_000_000 } } })).toThrow(/cannot be more than/);
    // A config built by hand gets the same check at the door.
    const ok = resolveCrawlConfig({ startUrls: [fx.urls.linkGraph], mode: "mirror", resource: "pi-lite" });
    const bad: CrawlConfig = { ...ok, limits: { ...ok.limits, maxPages: HARD_CEILINGS["pi-lite"].maxPages + 1 }, scope: { ...ok.scope, maxDepth: 99 } };
    try {
      t.svc.crawl.startCrawl(bad);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).details).toEqual({ fields: expect.arrayContaining([expect.objectContaining({ path: "limits.maxPages" }), expect.objectContaining({ path: "scope.maxDepth" })]) });
    }
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM crawl_jobs")!.n).toBe(0);
  });
});

describe("C-05 profiles", () => {
  async function run(profile: "focused" | "balanced" | "comprehensive") {
    const g = await graph(fixtures());
    const t = await startCrawlServer();
    const r = t.svc.crawl.startCrawl(testConfig({ startUrls: [g.root], mode: "explore", profile, overrides: { scope: { maxDepth: 2 } } }));
    return waitFinished(t, r.downloadId);
  }

  it("focused follows fewer non-main links than comprehensive", async () => {
    const focused = await run("focused");
    const comprehensive = await run("comprehensive");
    const nonMain = (s: typeof focused) => Object.entries(s.followed).filter(([region]) => region !== "content").reduce((n, [, c]) => n + c, 0);
    const skippedByRegion = (s: typeof focused) => s.skips["filter:region"] ?? 0;
    expect(nonMain(focused)).toBeLessThan(nonMain(comprehensive));
    // Navigation, related and footer links are what focused leaves out.
    const outside = (s: typeof focused) => (["related", "nav", "footer", "other"] as const).reduce((n, r) => n + (s.followed[r] ?? 0), 0);
    expect(outside(focused)).toBe(0);
    expect(outside(comprehensive)).toBeGreaterThan(0);
    expect(skippedByRegion(focused)).toBeGreaterThan(skippedByRegion(comprehensive));
    expect(focused.pagesFetched).toBeLessThan(comprehensive.pagesFetched);
  });

  it("balanced sits between them", async () => {
    const [f, b, c] = [await run("focused"), await run("balanced"), await run("comprehensive")];
    expect(f.pagesFetched).toBeLessThanOrEqual(b.pagesFetched);
    expect(b.pagesFetched).toBeLessThanOrEqual(c.pagesFetched);
    expect(Object.keys(f.followed).length).toBeLessThanOrEqual(Object.keys(b.followed).length);
  });
});
