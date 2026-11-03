import { beforeAll, describe, expect, it } from "vitest";
import { mutableSite, startSourcesServer, until, useFixtures } from "./helpers.js";

const fixtures = useFixtures();
const art = () => fixtures().urls.article;
const feedSite = () => fixtures().urls.sitemapFeed;
/** How many articles the fixture's sitemap lists (the README says about 30; the data table is the truth). */
let total = 0;
beforeAll(async () => {
  total = ((await (await fetch(`${fixtures().urls.sitemapFeed}/sitemap.xml`)).text()).match(/<loc>/g) ?? []).length;
  expect(total).toBeGreaterThan(20);
});

const rss = (slugs: string[], extra = "") => `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><link>/</link>${slugs.map((s) => `<item><title>${s}</title><link>${art()}/${s}</link><guid isPermaLink="false">g-${s}</guid></item>`).join("")}${extra}</channel></rss>`;

describe("C-07 sitemap sources against the sitemapFeed fixture", () => {
  it("follows the index and the gzipped child, and captures every page once", async () => {
    const t = await startSourcesServer();
    const s = (await t.api("POST", "/api/sources", { name: "Gazette sitemap", type: "sitemap", startUrl: `${feedSite()}/sitemap-index.xml`, priority: "P3" })).body;
    expect(s).toMatchObject({ type: "sitemap", strategy: "capture" });
    const run = await t.api("POST", `/api/sources/${s.id}/run`);
    expect(run.status).toBe(202);
    expect(run.body).toMatchObject({ found: total, newItems: total });
    expect(run.body.downloadIds).toHaveLength(total);
    await t.settled(s.id, 90_000);
    const pages = (await t.api("GET", `/api/sources/${s.id}/pages?limit=100`)).body;
    // Near-duplicate articles share a canonical address, so a few addresses resolve to the same page.
    expect(pages.total).toBeLessThanOrEqual(total);
    expect(pages.total).toBeGreaterThan(total - 6);
    expect(pages.items.every((p: any) => p.discoveredVia === "sitemap" && p.depth === 0)).toBe(true);
    expect(pages.items.every((p: any) => p.availability === "archived" || p.availability === "partial")).toBe(true);

    // A later run finds nothing new and queues nothing.
    const again = await t.api("POST", `/api/sources/${s.id}/run`);
    expect(again.body).toMatchObject({ found: total, newItems: 0, downloadIds: [] });
  }, 120_000);

  it("reads a gzipped sitemap given directly, and respects the per-run page limit across runs", async () => {
    const t = await startSourcesServer();
    const s = (await t.api("POST", "/api/sources", { name: "Part 2", type: "sitemap", startUrl: `${feedSite()}/sitemap-2.xml.gz`, config: { maxPages: 4 } })).body;
    const r1 = await t.api("POST", `/api/sources/${s.id}/run`);
    expect(r1.body).toMatchObject({ found: 15, newItems: 4 });
    const r2 = await t.api("POST", `/api/sources/${s.id}/run`);
    expect(r2.body).toMatchObject({ found: 15, newItems: 4 });
    await t.settled(s.id);
    expect((await t.api("GET", `/api/sources/${s.id}/pages`)).body.total).toBe(8);
  }, 60_000);

  it("previews a sitemap with the real count and warns when the limit is lower", async () => {
    const t = await startSourcesServer();
    const p = await t.api("POST", "/api/sources/preview", { name: "x", type: "sitemap", startUrl: `${feedSite()}/sitemap.xml`, config: { maxPages: 10 } });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ valid: true, sample: { found: total }, estimate: { estimate: true, pages: { low: 10, high: 10 } } });
    expect(p.body.warnings.join(" ")).toMatch(/limited to 10 pages/);
    const w = await t.api("POST", "/api/sources/preview", { name: "x", type: "website", startUrl: "http://127.0.0.1:9/", config: { respectRobots: false } }); // nothing listens there: no real network is touched
    expect(w.body.warnings.join(" ")).toMatch(/ignores robots.txt/);
    expect(w.body.estimate).toMatchObject({ estimate: true });
    expect((await t.api("POST", "/api/sources/preview", { name: "", type: "website" })).status).toBe(400);
  });

  it("goes through the SSRF guard: a private address is refused with a plain message", async () => {
    const t = await startSourcesServer({ allow: "127.0.0.1" });
    const s = (await t.api("POST", "/api/sources", { name: "Bad", type: "sitemap", startUrl: "http://10.0.0.1/sitemap.xml" })).body;
    const run = await t.api("POST", `/api/sources/${s.id}/run`);
    expect(run.status).toBe(403);
    expect(run.body.error).toBe("blocked");
    expect(run.body.message).toMatch(/private or local network/);
    expect((await t.api("GET", `/api/sources/${s.id}`)).body.lastStatus).toBe("failed");
  });

  it("a page that is not a sitemap gives a clear error, not a crash", async () => {
    const t = await startSourcesServer();
    const s = (await t.api("POST", "/api/sources", { name: "Wrong", type: "sitemap", startUrl: `${art()}/astronomy` })).body;
    const run = await t.api("POST", `/api/sources/${s.id}/run`);
    expect(run.status).toBe(400);
    expect(run.body.message).toMatch(/not a valid sitemap/);
  });
});

describe("C-07 feed sources", () => {
  it("RSS 2.0 and Atom from the fixture are normalised and de-duplicated across sources", async () => {
    const t = await startSourcesServer();
    const a = (await t.api("POST", "/api/sources", { name: "RSS", type: "feed", startUrl: `${feedSite()}/rss.xml` })).body;
    const b = (await t.api("POST", "/api/sources", { name: "Atom", type: "feed", startUrl: `${feedSite()}/atom.xml` })).body;
    const ra = await t.api("POST", `/api/sources/${a.id}/run`);
    expect(ra.body).toMatchObject({ found: 15, newItems: 15 });
    await t.settled(a.id, 60_000);
    const rb = await t.api("POST", `/api/sources/${b.id}/run`);
    expect(rb.body).toMatchObject({ found: 15, newItems: 15 });
    await t.settled(undefined, 60_000);
    // The same fifteen articles, referenced by both sources, stored once.
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pages")!.n).toBe(15);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_sources")!.n).toBe(30);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions")!.n).toBe(15);
    const via = t.svc.db.all<{ discovered_via: string }>("SELECT DISTINCT discovered_via FROM page_sources").map((r) => r.discovered_via);
    expect(via).toEqual(["feed"]);
  }, 120_000);

  it("adds only the new items on later runs", async () => {
    const site = await mutableSite({ "/feed.xml": { type: "application/rss+xml", body: rss(["astronomy", "moon"]) } });
    try {
      const t = await startSourcesServer();
      const s = (await t.api("POST", "/api/sources", { name: "Growing", type: "feed", startUrl: `${site.origin}/feed.xml` })).body;
      const r1 = await t.api("POST", `/api/sources/${s.id}/run`);
      expect(r1.body).toMatchObject({ found: 2, newItems: 2 });
      await t.settled(s.id);

      const r2 = await t.api("POST", `/api/sources/${s.id}/run`);
      expect(r2.body).toMatchObject({ found: 2, newItems: 0, downloadIds: [] });

      // A new item, and the old ones repeated under new wrappers (a duplicate guid, a fragment on a known address).
      site.set("/feed.xml", "application/rss+xml", rss(["mars", "astronomy", "moon"], `<item><link>${art()}/mars#again</link><guid isPermaLink="false">g-mars</guid></item>`));
      const r3 = await t.api("POST", `/api/sources/${s.id}/run`);
      expect(r3.body).toMatchObject({ found: 3, newItems: 1 });
      expect(r3.body.downloadIds).toHaveLength(1);
      await t.settled(s.id);
      expect((await t.api("GET", `/api/sources/${s.id}/pages`)).body.total).toBe(3);
      expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM source_discovered_urls")!.n).toBe(3);
      // Every download has ended, so the newest one decides the status (refreshStatus runs just after the job row settles).
      await until(async () => (await t.api("GET", `/api/sources/${s.id}`)).body.lastStatus === "ok");
    } finally {
      await site.close();
    }
  }, 60_000);

  it("skips addresses the Human deleted on purpose", async () => {
    const site = await mutableSite({ "/feed.xml": { type: "application/rss+xml", body: rss(["astronomy", "moon"]) } });
    try {
      const t = await startSourcesServer();
      // Save and delete /moon by hand: the deletion is remembered.
      const saved = await t.api("POST", "/api/browser/save", { url: `${art()}/moon` });
      await until(() => t.pipeline.getCapture(saved.body.downloadId)?.state === "completed");
      const page = t.svc.db.get<{ public_id: string }>("SELECT public_id FROM pages WHERE url_key LIKE '%/moon'")!;
      expect((await t.api("DELETE", `/api/archive/pages/${page.public_id}`)).status).toBe(200);

      const s = (await t.api("POST", "/api/sources", { name: "Feed", type: "feed", startUrl: `${site.origin}/feed.xml` })).body;
      const run = await t.api("POST", `/api/sources/${s.id}/run`);
      expect(run.body).toMatchObject({ found: 2, newItems: 1, excluded: 1 });
      await t.settled(s.id);
      expect(t.svc.db.get("SELECT 1 AS x FROM pages WHERE url_key LIKE '%/moon'")).toBeUndefined();
      // Saving it by hand still works.
      const again = await t.api("POST", "/api/browser/save", { url: `${art()}/moon` });
      await until(() => t.pipeline.getCapture(again.body.downloadId)?.state === "completed");
      expect(t.svc.db.get("SELECT 1 AS x FROM pages WHERE url_key LIKE '%/moon'")).toBeDefined();
    } finally {
      await site.close();
    }
  }, 60_000);
});
