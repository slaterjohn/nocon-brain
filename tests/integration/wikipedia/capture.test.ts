import { describe, expect, it } from "vitest";
import { CONTACT, apiRequests, creditsDone, fakeLog, startWikiServer, until, type WikiTest } from "./helpers.js";

async function save(t: WikiTest, url: string) {
  const { downloadId } = t.svc.pipeline.captureUrl(url, { userInitiated: true });
  return until(() => {
    const r = t.svc.pipeline.getCapture(downloadId);
    return r && (r.state === "completed" || r.state === "failed") ? r : undefined;
  }, 30_000);
}

/** Z-07: an article saved through the pipeline is fetched by the Wikipedia client and keeps its CC BY-SA details. */
describe("saving a Wikipedia article", () => {
  it("fetches the core REST html with the contact agent and stores revision, licence and history link per version", async () => {
    const t = await startWikiServer();
    const url = `${t.wiki.origin}/wiki/Astronomy`;
    const r = await save(t, url);
    expect(r).toMatchObject({ state: "completed", outcome: "created" });
    const v = t.svc.db.get<{ id: number; final_url: string; etag: string | null }>("SELECT id, final_url, etag FROM page_versions ORDER BY id DESC LIMIT 1")!;
    expect(v.final_url).toBe(url);
    expect(v.etag).toBeTruthy();
    const a = t.svc.db.get<Record<string, string>>("SELECT * FROM page_attributions WHERE version_id = ?", [v.id])!;
    expect(a).toMatchObject({
      license_name: "CC BY-SA 4.0", license_url: "https://creativecommons.org/licenses/by-sa/4.0/", source_url: url,
      history_url: `${t.wiki.origin}/w/index.php?title=Astronomy&action=history`,
    });
    expect(a.revision_id).toMatch(/^\d{7}$/);
    expect(a.credit_text).toContain("CC BY-SA 4.0");
    expect(a.credit_text).toContain(`revision ${a.revision_id}`);
    expect(t.svc.db.get<{ origin: string }>("SELECT origin FROM pages ORDER BY id DESC LIMIT 1")!.origin).toBe("wikipedia");

    // The page came through the Wikipedia client: the core REST route, with the contact in every request's agent.
    const log = await fakeLog(t.wiki);
    const reqs = apiRequests(log);
    expect(reqs.some((q) => q.url === "/w/rest.php/v1/page/Astronomy/html")).toBe(true);
    expect(log.entries.filter((e) => e.url.startsWith("/wiki/"))).toHaveLength(0); // the reading page itself is never scraped
    for (const q of reqs) expect(q.ua).toContain(CONTACT);
    expect(log.maxInFlight).toBe(1);
    // usage is counted
    expect(t.svc.db.get<{ count: number }>("SELECT count FROM usage_counters WHERE kind = 'wikipedia_requests' AND subject = 'global'")!.count).toBeGreaterThanOrEqual(2);
  });

  it("fetches per-image licence details with imageinfo and shows the attribution footer on the listener", async () => {
    const t = await startWikiServer();
    const url = `${t.wiki.origin}/wiki/Black_hole`;
    expect((await save(t, url)).state).toBe("completed");
    await creditsDone(t);
    const rows = t.svc.db.all<{ author: string | null; license_name: string | null; license_url: string | null; source_page_url: string | null }>("SELECT * FROM asset_attributions");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ license_name: "Fair use", author: "Fixture Black hole Photographer" });
    expect(rows[0]!.source_page_url).toContain("File:Black_hole_illustration.png");

    const res = await t.api("POST", "/api/browser/resolve", { input: url });
    expect(res.body.resolution.kind).toBe("archive");
    const r = await t.archiveFetch(res.body.resolution.frame.url, { headers: { "sec-fetch-dest": "iframe" } });
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain("data-ncb-attribution");
    expect(html).toContain("Text from Wikipedia, licensed under");
    expect(html).toContain("CC BY-SA 4.0");
    expect(html).toContain("https://creativecommons.org/licenses/by-sa/4.0/");
    expect(html).toContain(`${t.wiki.origin}/w/index.php?title=Black_hole&amp;action=history`);
    expect(html).toMatch(/revision \d{7}/);
    expect(html).toContain("Image credits (1)");
    expect(html).toContain("Fixture Black hole Photographer");
    expect(html).toContain("Fair use");
    expect(html).not.toMatch(/<script/i);

    // The version's detail carries the same facts for the UI.
    const ver = await t.api("GET", `/api/archive/versions/${res.body.resolution.version.id}`);
    expect(ver.body.attribution).toMatchObject({ licenseName: "CC BY-SA 4.0", historyUrl: `${t.wiki.origin}/w/index.php?title=Black_hole&action=history` });
    expect(ver.body.attribution.images).toHaveLength(1);
  });

  it("makes a conditional request for a refresh and keeps the stored revision when the article has not changed", async () => {
    const t = await startWikiServer();
    const url = `${t.wiki.origin}/wiki/Planet`;
    expect((await save(t, url)).outcome).toBe("created");
    const before = (await fakeLog(t.wiki)).entries.length;
    const again = await save(t, url);
    expect(again.state).toBe("completed");
    const reqs = (await fakeLog(t.wiki)).entries.slice(before).filter((e) => e.url.startsWith("/w/rest.php/v1/page/Planet/html"));
    expect(reqs).toHaveLength(1);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions WHERE status IN ('ready','partial')")!.n).toBe(1);
  });

  it("stores a redirect under the article's real title", async () => {
    const t = await startWikiServer();
    const r = await save(t, `${t.wiki.origin}/wiki/Blackhole`);
    expect(r.state).toBe("completed");
    const p = t.svc.db.get<{ canonical_url: string }>("SELECT canonical_url FROM pages ORDER BY id DESC LIMIT 1")!;
    expect(p.canonical_url).toBe(`${t.wiki.origin}/wiki/Black_hole`);
  });

  it("makes no request at all without a contact, and says why", async () => {
    const t = await startWikiServer({ contact: null });
    const r = await save(t, `${t.wiki.origin}/wiki/Astronomy`);
    expect(r.state).toBe("failed");
    expect(r.failureMessage).toMatch(/NCB_CONTACT/);
    expect((await fakeLog(t.wiki)).total).toBe(0);
    const pre = await t.api("POST", "/api/wikipedia/preview", { title: "Astronomy" });
    expect(pre.status).toBe(400);
    expect(pre.body.message).toMatch(/NCB_CONTACT/);
    const crawl = await t.api("POST", "/api/wikipedia/crawl", { title: "Astronomy" });
    expect(crawl.status).toBe(400);
    expect(crawl.body.message).toMatch(/NCB_CONTACT/);
    const src = await t.api("POST", "/api/sources", { name: "W", type: "linked_collection", adapter: "wikipedia", startUrl: `${t.wiki.origin}/wiki/Astronomy`, config: { wikipedia: { language: "en", images: true } } });
    expect(src.status).toBe(400);
    expect((await fakeLog(t.wiki)).total).toBe(0);
    const st = await t.api("GET", "/api/wikipedia/status");
    expect(st.body).toMatchObject({ contactConfigured: false, userAgentPreview: null });
  });

  it("rejects a contact that is not a web address or an email address", async () => {
    const t = await startWikiServer({ contact: "just me" });
    const r = await save(t, `${t.wiki.origin}/wiki/Astronomy`);
    expect(r.state).toBe("failed");
    expect(r.failureMessage).toMatch(/NCB_CONTACT/);
    expect((await fakeLog(t.wiki)).total).toBe(0);
  });

  it("reports status without leaking anything but the agent", async () => {
    const t = await startWikiServer();
    const st = await t.api("GET", "/api/wikipedia/status");
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ contactConfigured: true, breaker: { state: "closed" }, minIntervalMs: 250 });
    expect(st.body.userAgentPreview).toContain(CONTACT);
  });
});
