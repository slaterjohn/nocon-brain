import { describe, expect, it } from "vitest";
import type { CrawlConfig } from "@ncb/crawl";
import { fetchedUrls, startCrawlServer, testConfig, useFixtures, waitFinished } from "./helpers.js";

const fixtures = useFixtures();

async function crawlTrapSite(query: CrawlConfig["query"]) {
  const origin = fixtures().urls.trap;
  const t = await startCrawlServer();
  const run = t.svc.crawl.startCrawl(testConfig({
    startUrls: [`${origin}/`], mode: "explore", profile: "comprehensive", resource: "pi-lite",
    // The ceiling is far above what the traps should let through: only the trap rules can stop this crawl early.
    overrides: { limits: { maxPages: 600 }, scope: { maxDepth: 10 }, query },
  }));
  const s = await waitFinished(t, run.downloadId, 180_000);
  const urls = fetchedUrls(t, run.downloadJobId).map((u) => u.replace(origin, ""));
  return { t, s, urls, origin };
}

const under = (urls: string[], prefix: string) => urls.filter((u) => u === prefix || u.startsWith(prefix + "/") || u.startsWith(prefix + "?") || u.startsWith(prefix + ";"));

describe("C-04 every trap terminates within budget and the real section is crawled", () => {
  for (const policy of ["strip_tracking", "keep_all"] as const) {
    it(`query policy ${policy}`, async () => {
      const { t, s, urls, origin } = await crawlTrapSite({ policy, allowParams: [] });
      // It ran dry by itself: not by the page cap, not by a deadline.
      expect(["completed", "max_depth"]).toContain(s.stopReason);
      expect(s.pagesFetched).toBeLessThan(150);

      // The control section is complete.
      for (const n of [1, 2, 3]) expect(urls, `/real/${n}`).toContain(`/real/${n}`);
      const real = t.svc.db.all<{ status: string }>(
        "SELECT v.status FROM page_versions v WHERE v.download_job_id = ? AND v.requested_url LIKE ?", [s.downloadJobId, `${origin}/real/%`]);
      expect(real).toHaveLength(3);
      expect(real.every((r) => r.status === "ready" || r.status === "partial")).toBe(true);

      // Each trap stops at a small, bounded number of pages.
      expect(under(urls, "/cal").length, "calendar").toBeLessThanOrEqual(16);
      expect(under(urls, "/cal").length, "calendar").toBeGreaterThanOrEqual(2);
      expect(urls.filter((u) => /^\/[ab](\/[ab])*$/.test(u)).length, "repeating segments").toBeLessThanOrEqual(30);
      expect(under(urls, "/sess/page").length, "session ids").toBeLessThanOrEqual(2);
      expect(under(urls, "/list").length, "pagination").toBeLessThanOrEqual(14);
      expect(under(urls, "/facets").length, "facets").toBeLessThanOrEqual(14);
      expect(under(urls, "/track/article").length, "tracking params").toBeLessThanOrEqual(14);

      // The skip reasons say which rule stopped each trap.
      expect(s.skips["trap:repeating_segments"], "repeating segments").toBeGreaterThan(0);
      expect(Object.keys(s.skips).some((k) => k === "trap:calendar_budget" || k === "trap:calendar_window"), "calendar").toBe(true);
      expect(s.skips["trap:query_variants"] ?? 0, "query variants").toBeGreaterThan(0);
      expect(s.skips["trap:redirect_loop"], "redirect loops").toBeGreaterThanOrEqual(2);
      expect(s.skips["normalised:session_id"], "session ids").toBeGreaterThan(0);
    });
  }

  it("session ids never create a second page", async () => {
    const { urls } = await crawlTrapSite({ policy: "keep_all", allowParams: [] });
    const sess = under(urls, "/sess/page");
    expect(sess.every((u) => !/sid=|PHPSESSID|jsessionid/i.test(u))).toBe(true);
  });

  it("a streak of identical pages blocks their family", async () => {
    const origin = fixtures().urls.trap;
    const t = await startCrawlServer();
    // Facet pages are identical; with a roomy query budget only the duplicate-content rule can stop them.
    const run = t.svc.crawl.startCrawl(testConfig({
      startUrls: [`${origin}/facets?sort=price&filter=a`], mode: "explore", profile: "comprehensive", resource: "pi-lite",
      overrides: { limits: { maxPages: 200 }, scope: { maxDepth: 6, maxQueryParams: 8, allowedPaths: ["/facets"] }, traps: { queryVariantBudget: 500, duplicateStreak: 4 } },
    }));
    const s = await waitFinished(t, run.downloadId, 120_000);
    expect(["completed", "max_depth"]).toContain(s.stopReason);
    expect(s.pagesFetched).toBeLessThan(25);
    expect(s.skips["trap:duplicate_content"]).toBeGreaterThan(0);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM crawl_counters WHERE crawl_job_id = ? AND kind = 'blocked_family'", [s.crawlJobId])!.n).toBeGreaterThan(0);
  });

  it("per-host budget stops a crawl that would otherwise keep going", async () => {
    const origin = fixtures().urls.trap;
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({
      startUrls: [`${origin}/list?page=1`], mode: "explore", profile: "comprehensive", resource: "pi-lite",
      overrides: { limits: { maxPages: 200 }, scope: { maxDepth: 10, allowedPaths: ["/list"] }, traps: { queryVariantBudget: 1000, maxUrlsPerHost: 6 } },
    }));
    const s = await waitFinished(t, run.downloadId, 60_000);
    expect(s.pagesFetched).toBeLessThanOrEqual(6);
    expect(s.skips["trap:host_budget"]).toBeGreaterThan(0);
    expect(s.stopReason).not.toBe("max_pages");
  });

  it("the frontier cap holds", async () => {
    const origin = fixtures().urls.trap;
    const t = await startCrawlServer();
    const run = t.svc.crawl.startCrawl(testConfig({
      startUrls: [`${origin}/facets?sort=price&filter=a`], mode: "explore", profile: "comprehensive", resource: "pi-lite",
      overrides: { limits: { maxPages: 3 }, scope: { maxDepth: 6, maxQueryParams: 8, allowedPaths: ["/facets"] }, traps: { queryVariantBudget: 1000, maxFrontier: 10, duplicateStreak: 1000 } },
    }));
    const s = await waitFinished(t, run.downloadId, 60_000);
    expect(s.skips["trap:frontier_full"]).toBeGreaterThan(0);
    const total = t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE crawl_job_id = ?", [s.crawlJobId])!.n;
    expect(total).toBeLessThanOrEqual(1 + 10 + 3 + 1);
  });
});
