import { describe, expect, it } from "vitest";
import { CONTACT, apiRequests, creditsDone, fakeLog, pageRequests, startWikiServer, waitCrawl, type WikiTest } from "./helpers.js";

async function crawl(t: WikiTest, body: Record<string, unknown>) {
  const res = await t.api("POST", "/api/wikipedia/crawl", body);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const downloadId = res.body.downloadIds[0] as string;
  const status = await waitCrawl(t, downloadId);
  return { res, downloadId, status };
}
const savedTitles = (t: WikiTest): string[] =>
  t.svc.db.all<{ canonical_url: string }>("SELECT p.canonical_url FROM pages p WHERE p.availability IN ('archived','partial') ORDER BY p.id").map((r) => decodeURIComponent(r.canonical_url.split("/wiki/")[1]!));

/** Z-08: topic crawl and linked expansion on the fake Wikimedia server. */
describe("Wikipedia topic crawl", () => {
  it("stops at the page cap, taking the lead-section links first", async () => {
    const t = await startWikiServer();
    const { res, status } = await crawl(t, { title: "Astronomy", depth: 1, maxPages: 3, images: false });
    expect(status.stopReason).toBe("max_pages");
    expect(status.pagesFetched).toBe(3);
    // The first article, then its links best first: those in the lead (all six here), the one linked twice (Black hole) ahead of the rest.
    expect(savedTitles(t)).toEqual(["Astronomy", "Black_hole", "Solar_System"]);
    expect(pageRequests(await fakeLog(t.wiki))).toEqual(["Astronomy", "Black_hole", "Solar_System"]);
    // It is an ordinary source with the Wikipedia adapter, run by the crawl engine as an explore download.
    expect(res.body.source).toMatchObject({ type: "linked_collection", adapter: "wikipedia", name: "Wikipedia: Astronomy" });
    expect(res.body.source.config.wikipedia).toMatchObject({ language: "en", images: false, linkedExpansionDepth: 1, preferZim: true });
    const dl = t.svc.db.get<{ kind: string; source_id: number }>("SELECT kind, source_id FROM download_jobs ORDER BY id DESC LIMIT 1")!;
    expect(dl.kind).toBe("explore");
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_sources WHERE source_id = ?", [dl.source_id])!.n).toBe(3);
  });

  it("goes one level deep by default and not further, skipping other namespaces, red links and disambiguation pages", async () => {
    const t = await startWikiServer();
    const { status } = await crawl(t, { title: "Astronomy", images: false });
    // Astronomy links to six articles; their own links (depth 2) are not followed with depth 1.
    expect(status.pagesFetched).toBe(7);
    expect(status.stopReason).toBe("max_depth");
    expect(status.depthReached).toBe(1);
    expect(savedTitles(t).sort()).toEqual(["Astronomy", "Black_hole", "Galaxy", "Planet", "Solar_System", "Star", "Telescope"]);
    expect(status.skips["wikipedia:disambiguation"]).toBeGreaterThanOrEqual(1);
    expect(status.skips["wikipedia:not_article"]).toBeGreaterThanOrEqual(2); // Category:, Template:, File: and the red link
    const requested = pageRequests(await fakeLog(t.wiki));
    expect(requested.some((x) => /disambiguation|Category|Template|File|Nonexistent/.test(x))).toBe(false);
  });

  it("depth 2 reaches the links of the links and stops at the page cap", async () => {
    const t = await startWikiServer();
    const { status } = await crawl(t, { title: "Astronomy", depth: 2, maxPages: 10, images: false });
    expect(status.pagesFetched).toBe(10);
    expect(status.stopReason).toBe("max_pages");
    expect(status.depthReached).toBe(2);
  });

  it("refuses more than the hard caps", async () => {
    const t = await startWikiServer();
    const deep = await t.api("POST", "/api/wikipedia/crawl", { title: "Astronomy", depth: 4 });
    expect(deep.status).toBe(400);
    expect(JSON.stringify(deep.body)).toMatch(/Depth can be at most 3/);
    const big = await t.api("POST", "/api/wikipedia/crawl", { title: "Astronomy", maxPages: 5000 });
    expect(big.status).toBe(400);
    expect(JSON.stringify(big.body)).toMatch(/2,000/);
    const prev = await t.api("POST", "/api/wikipedia/preview", { title: "Astronomy", depth: 9 });
    expect(prev.status).toBe(400);
    expect(JSON.stringify(await t.api("POST", "/api/sources", { name: "W", type: "linked_collection", adapter: "wikipedia", startUrl: `${t.wiki.origin}/wiki/Astronomy`, config: { depth: 5, wikipedia: { language: "en", images: true } } }))).toMatch(/at most 3/);
    expect((await fakeLog(t.wiki)).total).toBe(0);
    // Defaults are the documented ones.
    const ok = await t.api("POST", "/api/wikipedia/preview", { title: "Astronomy" });
    expect(ok.body.caps).toMatchObject({ depth: 1, maxPages: 200, maxDepth: 3, maxPagesCeiling: 2000 });
  });

  it("links an article an enabled package holds instead of fetching it, and the archived page opens the package copy", async () => {
    const t = await startWikiServer();
    const pkg = (await t.add("wiki")).body;
    expect(pkg.state).toBe("ready");
    const { status } = await crawl(t, { title: "Solar_System", images: false });
    // Sun is in the package: skipped, never requested. Everything else is fetched.
    expect(status.skips["wikipedia:in_zim"]).toBe(1);
    const requested = pageRequests(await fakeLog(t.wiki));
    expect(requested).not.toContain("Sun");
    expect(requested).toContain("Planet");
    expect(savedTitles(t)).not.toContain("Sun");
    // The saved Solar System page links to Sun in the package.
    const res = await t.api("POST", "/api/browser/resolve", { input: `${t.wiki.origin}/wiki/Solar_System` });
    expect(res.body.resolution.kind).toBe("archive");
    const html = await (await t.archiveFetch(res.body.resolution.frame.url)).text();
    const sun = /<a [^>]*href="([^"]*)"[^>]*>Sun<\/a>/.exec(html);
    expect(sun, html.slice(0, 2000)).toBeTruthy();
    expect(sun![1]).toMatch(new RegExp(`/z/${pkg.id}/Sun$`));
    expect(sun![0]).toContain('data-ncb-link="cached"');
    // an archived article links to the other archived article, not the live site
    expect(html).toMatch(/href="[^"]*\/p\/pg_[^"]*"[^>]*>Planet</);
  });

  it("fetches the article itself when the package rule is off", async () => {
    const t = await startWikiServer();
    await t.add("wiki");
    const { status } = await crawl(t, { title: "Solar_System", images: false, preferZim: false });
    expect(status.skips["wikipedia:in_zim"]).toBeUndefined();
    expect(pageRequests(await fakeLog(t.wiki))).toContain("Sun");
  });

  it("records the author and licence of every saved image, and leaves images out when asked", async () => {
    const t = await startWikiServer();
    const { status } = await crawl(t, { title: "Astronomy", depth: 1, maxPages: 4, images: true });
    expect(status.pagesFetched).toBe(4);
    await creditsDone(t);
    const imgs = t.svc.db.get<{ n: number }>("SELECT COUNT(DISTINCT a.id) AS n FROM assets a JOIN asset_references r ON r.asset_id = a.id WHERE a.kind = 'image' AND a.status = 'ok'")!.n;
    expect(imgs).toBe(4);
    const rows = t.svc.db.all<{ license_name: string; author: string }>("SELECT license_name, author FROM asset_attributions ORDER BY asset_id");
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => !!r.license_name && !!r.author)).toBe(true);
    expect(rows.map((r) => r.license_name)).toContain("Fair use"); // the Black hole picture is non-free
    // imageinfo asked in batches, with maxlag, through the same limiter
    const info = apiRequests(await fakeLog(t.wiki)).filter((e) => e.url.includes("prop=imageinfo"));
    expect(info.length).toBeGreaterThanOrEqual(1);
    for (const q of info) expect(q.url).toContain("maxlag=5");

    const t2 = await startWikiServer();
    await crawl(t2, { title: "Astronomy", depth: 1, maxPages: 3, images: false });
    expect((await fakeLog(t2.wiki)).entries.filter((e) => e.url.startsWith("/images/"))).toHaveLength(0);
    expect(t2.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM asset_attributions")!.n).toBe(0);
  });

  it("makes no request without the contact agent and never exceeds the pace or the one-at-a-time rule", async () => {
    const t = await startWikiServer();
    await crawl(t, { title: "Astronomy", depth: 1, maxPages: 5, images: true });
    await creditsDone(t);
    const log = await fakeLog(t.wiki);
    const own = log.entries.filter((e) => !e.url.startsWith("/__"));
    expect(own.length).toBeGreaterThan(5);
    for (const e of own) if (!e.url.startsWith("/images/")) expect(e.ua, e.url).toContain(CONTACT);
    expect(log.maxInFlight).toBe(1);
    const times = own.map((e) => e.t).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!, `gap ${i}`).toBeGreaterThanOrEqual(240);
    expect((await fakeLog(t.wiki)).entries.some((e) => e.url.includes("robots.txt"))).toBe(false);
  });

  it("waits out a rate-limit answer from the server and still finishes", async () => {
    const t = await startWikiServer({ rps: 2 });
    const { status } = await crawl(t, { title: "Astronomy", depth: 1, maxPages: 4, images: false });
    expect(status.pagesFetched).toBe(4);
    expect(status.pagesFailed).toBe(0);
  });

  it("previews counts per level, requests, time at one request a second and bytes", async () => {
    const t = await startWikiServer();
    await t.add("wiki");
    const before = (await fakeLog(t.wiki)).total;
    const res = await t.api("POST", "/api/wikipedia/preview", { title: "Solar_System", depth: 2, maxPages: 50, images: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const b = res.body;
    expect(b.estimate).toBe(true);
    expect(b.article).toMatchObject({ title: "Solar System", language: "en" });
    expect(b.levels).toHaveLength(3);
    expect(b.levels[0]).toMatchObject({ depth: 0, willFetch: 1, estimated: false });
    // Solar System links to Sun, Planet, Earth, Mars, Jupiter, Comet, Asteroid, Astronomy: Sun is in the package, the rest are fetched.
    expect(b.levels[1]).toMatchObject({ depth: 1, willFetch: 7, inKnowledgePackage: 1, estimated: false });
    expect(b.levels[2]).toMatchObject({ depth: 2, estimated: true });
    expect(b.knowledgePackages.present).toBe(1);
    expect(b.sample[0]).toMatchObject({ lead: true });
    expect(b.totals.pages).toBe(b.levels.reduce((n: number, l: { willFetch: number }) => n + l.willFetch, 0));
    expect(b.totals.requests).toBeGreaterThanOrEqual(b.totals.pages);
    expect(b.totals.seconds).toBe(Math.ceil((b.totals.requests * 250) / 1000));
    expect(b.totals.bytes).toBeGreaterThan(0);
    expect(b.pace.requestsPerSecond).toBe(4);
    expect(b.warnings.join(" ")).toMatch(/beyond the first/);
    // the preview itself cost the article and one batch of existence checks, and saved nothing
    expect(b.requestsMade).toBe(2);
    expect((await fakeLog(t.wiki)).total - before).toBe(2);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions")!.n).toBe(0);
    // a missing article is a plain 404
    const none = await t.api("POST", "/api/wikipedia/preview", { title: "No_such_article" });
    expect(none.status).toBe(404);
  });

  it("previews offline with a plain explanation and sends nothing", async () => {
    const t = await startWikiServer();
    await t.api("POST", "/api/system/connectivity", { forceOffline: true });
    const res = await t.api("POST", "/api/wikipedia/preview", { title: "Astronomy" });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/online/);
    expect((await fakeLog(t.wiki)).total).toBe(0);
  });
});
