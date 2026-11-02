import { describe, expect, it } from "vitest";
import { toCrawlConfig } from "@ncb/server";
import { startSourcesServer, until, useFixtures, type SourcesTest } from "../sources/helpers.js";

const fixtures = useFixtures();
const lg = () => fixtures().urls.linkGraph as string;

const log = async (origin: string) => (await (await fetch(`${origin}/__log`)).json()) as { total: number; entries: { url: string }[] };
const reset = (origin: string) => fetch(`${origin}/__log/reset`);

/** The crawl a run of the previewed source would make, without the politeness delay so the test is quick. */
async function actualCrawl(t: SourcesTest, preview: { config: Record<string, unknown> }, url: string) {
  const config = toCrawlConfig({ mode: "explore", seeds: [url], priority: 3, requestedBy: "user", config: { ...(preview.config as Record<string, unknown>), perDomainDelayMs: 0 } as never }, "standard");
  config.politeness.minDelayMs = 0;
  const run = t.svc.crawl.startCrawl(config);
  const dl = await until(() => {
    const d = t.svc.downloads.get(run.downloadId);
    return d.state === "completed" ? d : undefined;
  }, 120_000);
  const bytes = t.svc.db.get<{ n: number }>(
    `SELECT COALESCE(SUM(v.total_bytes), 0) AS n FROM page_versions v WHERE v.download_job_id = ?`, [run.downloadJobId])!.n;
  return { pages: dl.progress.pagesDone, bytes };
}

describe("C-15 source preview", () => {
  it.each([[2], [3]])("on linkGraph (depth %i) reports a labelled range that contains the real crawl, within the request cap", async (depth) => {
    const t = await startSourcesServer();
    const body = { name: "Graph", type: "website", startUrl: `${lg()}/`, profile: "balanced", config: { depth, perDomainDelayMs: 1500 } };
    await reset(lg());
    const p = await t.api("POST", "/api/sources/preview", body);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const seen = await log(lg());
    expect(seen.total).toBeLessThanOrEqual(12);
    expect(p.body.requests).toBeLessThanOrEqual(12);
    expect(p.body.requests).toBeGreaterThan(3);
    // Nothing was saved by looking.
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pages")!.n).toBe(0);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions")!.n).toBe(0);

    expect(p.body.estimate).toMatchObject({ estimate: true, label: "Estimate", confidence: expect.stringMatching(/low|medium|high/) });
    expect(p.body.estimate.basis).toMatch(/pages/);
    expect(p.body.scopeSummary).toMatch(/Pages on 127\.0\.0\.1/);
    expect(p.body.scopeSummary).toContain(`${depth} links`);
    expect(p.body.sample).toMatchObject({ fetched: expect.any(Number), inScopeLinks: expect.any(Number), sampledFrom: `${lg()}/` });
    expect(p.body.robots).toMatchObject({ allowed: true });

    const real = await actualCrawl(t, p.body, `${lg()}/`);
    const { low, high } = p.body.estimate.pages;
    expect(real.pages, `real ${real.pages} outside ${low}-${high}`).toBeGreaterThanOrEqual(low);
    expect(real.pages).toBeLessThanOrEqual(high);
    expect(high).toBeLessThan(real.pages * 5); // a range, not just "up to the limit"
    const b = p.body.estimate.bytes;
    expect(real.bytes, `real bytes ${real.bytes} outside ${b.low}-${b.high}`).toBeGreaterThanOrEqual(b.low);
    expect(real.bytes).toBeLessThanOrEqual(b.high);
  }, 180_000);

  it("is exact when the whole site fits in the sample (depth 1)", async () => {
    const t = await startSourcesServer();
    const p = await t.api("POST", "/api/sources/preview", { name: "Graph", type: "website", startUrl: `${lg()}/`, profile: "focused", config: { depth: 1, perDomainDelayMs: 1500 } });
    expect(p.body.estimate.pages.low).toBe(p.body.estimate.pages.high);
    expect(p.body.estimate.confidence).toBe("high");
    expect(p.body.estimate.pages.low).toBe(1 + p.body.sample.inScopeLinks);
  });

  it("warns about robots: a blocked start page, and a source that ignores robots.txt", async () => {
    const t = await startSourcesServer();
    const robots = fixtures().urls.robots as string;
    const blocked = await t.api("POST", "/api/sources/preview", { name: "R", type: "website", startUrl: `${robots}/noconbrain-blocked/page`, config: { perDomainDelayMs: 1500 } });
    expect(blocked.status).toBe(200);
    expect(blocked.body.robots).toMatchObject({ checked: true, allowed: false });
    expect(blocked.body.estimate.pages).toEqual({ low: 0, high: 0 });
    expect(blocked.body.warnings.join(" ")).toMatch(/robots\.txt does not allow the start page/);

    const delay = await t.api("POST", "/api/sources/preview", { name: "R", type: "single_page", startUrl: `${robots}/allowed/page` });
    expect(delay.body.robots).toMatchObject({ allowed: true, crawlDelayMs: 1000 });

    const ignore = await t.api("POST", "/api/sources/preview", { name: "R", type: "website", startUrl: `${robots}/noconbrain-blocked/page`, config: { respectRobots: false, perDomainDelayMs: 1500 } });
    expect(ignore.body.warnings.join(" ")).toMatch(/ignores robots\.txt/);
    expect(ignore.body.estimate.pages.high).toBeGreaterThan(0);
  });

  it("warns when the upper bound would not fit in the free space", async () => {
    const t = await startSourcesServer({
      env: { NCB_MIN_FREE_DISK_GB: "5" },
      server: { volumeProbes: { statfs: async () => ({ total: 1024 ** 4, free: 5 * 1024 ** 3 + 50_000 }) } },
    });
    const p = await t.api("POST", "/api/sources/preview", { name: "Graph", type: "website", startUrl: `${lg()}/`, profile: "balanced", config: { depth: 2, perDomainDelayMs: 1500 } });
    expect(p.body.warnings.join(" ")).toMatch(/free space/);
  });

  it("an unreachable start address still answers, with a wide range and the reason", async () => {
    const t = await startSourcesServer();
    const p = await t.api("POST", "/api/sources/preview", { name: "X", type: "website", startUrl: "http://127.0.0.1:9/", config: { perDomainDelayMs: 1500 } });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ valid: true, estimate: { estimate: true, confidence: "low", pages: { low: 1 } } });
    expect(p.body.warnings.join(" ")).toMatch(/could not be read/);
  });

  it("single pages and sitemaps get a size estimate too", async () => {
    const t = await startSourcesServer();
    const art = fixtures().urls.article as string;
    const one = await t.api("POST", "/api/sources/preview", { name: "One", type: "single_page", startUrl: `${art}/moon` });
    expect(one.body.estimate).toMatchObject({ estimate: true, pages: { low: 1, high: 1 } });
    expect(one.body.estimate.bytes.high).toBeGreaterThan(0);
    expect(one.body.scopeSummary).toMatch(/only/);
    const map = await t.api("POST", "/api/sources/preview", { name: "Map", type: "sitemap", startUrl: `${fixtures().urls.sitemapFeed}/sitemap.xml` });
    expect(map.body.estimate.bytes.high).toBeGreaterThan(map.body.estimate.bytes.low);
    expect(map.body.estimate.basis).toMatch(/addresses found/);
  });
});
