import { describe, expect, it } from "vitest";
import { doc as docFixture, multipart, upload } from "../imports/helpers.js";
import { addDoc, drained, searchApi, startSearchServer, until } from "./helpers.js";
import { minimalPdf } from "../imports/helpers.js";

describe("search API (S-03 to S-09, S-12, S-14 server side)", () => {
  it("validates input and recovers from odd queries", async () => {
    const t = await startSearchServer();
    await t.svc.search.waitForRebuild();
    const empty = await searchApi(t, { query: "   " });
    expect(empty.status).toBe(400);
    expect(empty.body.details.fields[0].path).toBe("query");
    const long = await searchApi(t, { query: "x".repeat(501) });
    expect(long.status).toBe(400);
    for (const q of ['"unclosed', "AND OR NOT", "(((", "a:b:c", "-", "***", "site:", "before:zz hello"]) {
      const r = await searchApi(t, { query: q });
      expect(r.status, q).toBe(200);
      expect(Array.isArray(r.body.results)).toBe(true);
    }
    const w = await searchApi(t, { query: 'before:zz "oops' });
    expect(w.body.parsed.warnings.length).toBe(2);
    const idx = await t.api("GET", "/api/search/suggestions?q=");
    expect(idx.status).toBe(200);
  });

  it("returns the documented shape, filters, facets, sources and collections", async () => {
    const t = await startSearchServer();
    await t.svc.search.waitForRebuild();
    const a = await addDoc(t, "tides.html", "Tidal turbines", "Tidal turbines turn the motion of the sea into electricity near the Pentland Firth.");
    await addDoc(t, "wind.html", "Wind turbines", "Wind turbines turn the motion of the air into electricity on hills and offshore.");
    const col = await t.api("POST", "/api/collections", { name: "Energy" });
    expect(col.status).toBe(201);
    await t.api("POST", `/api/collections/${col.body.id}/items`, { add: [{ pageId: a.pageId }] });
    await drained(t);
    const r = await searchApi(t, { query: "turbines electricity", debug: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 2, page: 1, pageSize: 20, online: { state: "disabled" }, coverage: { cachedMatches: 2, basis: "local_exact" } });
    expect(r.body.searchId).toMatch(/^sch_/);
    // Each result's highlighted title and snippet come from that page's own title and text (not one shared row).
    const strip = (h: string) => h.replace(/<\/?mark>/g, "");
    expect(new Set(r.body.results.map((x: any) => x.titleHtml)).size).toBe(2);
    for (const x of r.body.results) {
      expect(strip(x.titleHtml)).toBe(x.title);
      expect(strip(x.snippet)).toContain(x.title === "Tidal turbines" ? "Pentland Firth" : "hills and offshore");
    }
    const res = r.body.results.find((x: any) => x.pageId === a.pageId);
    expect(res).toMatchObject({ origin: "archive", availability: "cached", type: "html", storage: "persist", faviconUrl: null });
    expect(res.collections).toEqual([{ id: col.body.id, name: "Energy" }]);
    expect(res.sourceName).toBeTruthy();
    expect(res.actions.open).toBe(`/library/pages/${a.pageId}`);
    expect(res.explain.components).toHaveLength(6);
    expect(r.body.facets.collections).toEqual([{ value: col.body.id, label: "Energy", count: 1 }]);
    expect(r.body.facets.types[0]).toMatchObject({ value: "html", count: 2 });
    // collection filter works after the membership change
    const f = await searchApi(t, { query: "turbines", filters: { collections: [col.body.id] } });
    expect(f.body.results.map((x: any) => x.pageId)).toEqual([a.pageId]);
    // facet counts match the results for the chosen filter
    expect(f.body.facets.collections[0].count).toBe(f.body.total);
    // snapshot restore
    const snap = await t.api("GET", `/api/search/${r.body.searchId}`);
    expect(snap.body.results).toHaveLength(2);
    // Phase 5: with online search off the event stream has a single `done`; the provider list is empty.
    expect(r.body.lastSeq).toBe(0);
    expect((await t.api("GET", "/api/search/providers")).body).toMatchObject({ items: [], online: { enabled: false, state: "off" } });
    expect((await t.api("GET", `/api/search/${r.body.searchId}?after=0`)).body).toMatchObject({ done: true, events: [{ type: "done", reason: "no_providers" }] });
    // user settings keys
    const us = await t.api("PATCH", "/api/settings/user", { search: { resultsPerPage: 25, homepageSections: { recentSearches: true } } });
    expect(us.body.search).toEqual({ resultsPerPage: 25, zimResults: "unified", homepageSections: { recentSearches: true, bookmarks: false, favourites: false, libraryStats: false } });
    expect((await t.api("PATCH", "/api/settings/user", { search: { resultsPerPage: 99 } })).status).toBe(400);
    // Phase 8: how knowledge-package hits join the results is a per-user choice.
    expect((await t.api("PATCH", "/api/settings/user", { search: { zimResults: "federated" } })).body.search).toMatchObject({ zimResults: "federated", resultsPerPage: 25 });
    expect((await t.api("PATCH", "/api/settings/user", { search: { zimResults: "sideways" } })).status).toBe(400);
  });

  it("typo, did you mean, suggestions and prefix", async () => {
    const t = await startSearchServer();
    await t.svc.search.waitForRebuild();
    await addDoc(t, "astro.html", "Astronomy", "Astronomy is the study of stars, planets and galaxies seen through telescopes.");
    await drained(t);
    const r = await searchApi(t, { query: "astronamy" });
    expect(r.body.results[0].title).toBe("Astronomy");
    expect(r.body.didYouMean).toMatchObject({ text: "astronomy", appliedAutomatically: true });
    expect((await searchApi(t, { query: "astronamy", typo: false })).body.results).toHaveLength(0);
    const s = await t.api("GET", "/api/search/suggestions?q=astro&limit=5");
    expect(s.body.items.some((i: any) => i.kind === "title" && i.text === "Astronomy")).toBe(true);
    expect(s.body.items.length).toBeLessThanOrEqual(5);
    const star = await searchApi(t, { query: "teles*" });
    expect(star.body.results).toHaveLength(1);
  });

  it("Documents category by page type: PDF, text and Markdown from imports; Images by type", async () => {
    const t = await startSearchServer();
    await t.svc.search.waitForRebuild();
    const send = async (name: string, data: Buffer, mime: string) => {
      const m = multipart([{ filename: name, mime, data }]);
      const res = await t.server.app.inject({ method: "POST", url: "/api/archive/import", payload: m.body, headers: { "content-type": m.type, "x-nocon-csrf": "1", origin: "http://localhost:3000", cookie: t.cookie } });
      const body = res.json();
      await until(() => { const c = t.pipeline.getCapture(body.downloadId); return c && c.state === "completed" ? c : undefined; }, 30_000);
      return body;
    };
    await send("notes.md", Buffer.from("# Turbine notes\n\nPentland turbines hum. Field notes about marine turbines and tides.\n\nMore text about marine energy devices and moorings."), "text/markdown");
    await send("plain.txt", Buffer.from("Marine energy plain text notes about turbines and tidal races, a longer sentence to be safe."), "text/plain");
    await send("report.pdf", minimalPdf({ title: "Marine report", pages: [["Marine energy turbines report body text for the pdf page."]] }), "application/pdf");
    const html = await addDoc(t, "page.html", "Marine web page", "Marine turbines appear on this web page too, with enough words to be kept as an article.");
    await drained(t);
    const docs = await searchApi(t, { query: "marine", scope: "documents" });
    expect(docs.body.results.map((r: any) => r.type).sort()).toEqual(["pdf", "text", "text"]);
    expect(docs.body.results.every((r: any) => r.url.includes("imports.noconbrain.invalid"))).toBe(true);
    const typed = await searchApi(t, { query: "marine type:pdf" });
    expect(typed.body.results.map((r: any) => r.type)).toEqual(["pdf"]);
    const none = await searchApi(t, { query: "marine", scope: "images" });
    expect(none.body.results).toHaveLength(0);
    // an image page is found by the Images category
    t.svc.db.run("UPDATE pages SET content_type = 'image' WHERE public_id = ?", [html.pageId]);
    await drained(t);
    const imgs = await searchApi(t, { query: "marine", scope: "images" });
    expect(imgs.body.results.map((r: any) => r.pageId)).toEqual([html.pageId]);
    expect(imgs.body.results[0].type).toBe("image");
    expect((await searchApi(t, { query: "marine", scope: "documents" })).body.total).toBe(3);
    expect((await searchApi(t, { query: "marine", scope: "online" })).body.results).toEqual([]);
  });

  it("duplicates collapse with also-at", async () => {
    const t = await startSearchServer();
    await t.svc.search.waitForRebuild();
    const body = "Lighthouse keepers record fog signals every evening. ".repeat(6);
    await addDoc(t, "one.html", "Lighthouse log", body);
    await addDoc(t, "two.html", "Lighthouse log copy", body);
    await drained(t);
    const r = await searchApi(t, { query: "lighthouse fog" });
    expect(r.body.results).toHaveLength(1);
    expect(r.body.results[0].alsoAt).toHaveLength(1);
    const ungrouped = await searchApi(t, { query: "lighthouse fog", group: false });
    expect(ungrouped.body.results).toHaveLength(2);
  });

  it("archived favicons are served from a same-origin path; none means null", async () => {
    const t = await startSearchServer();
    await t.svc.search.waitForRebuild();
    const p = await addDoc(t, "icon.html", "Icon page", "A page that has an icon archived with it, and enough text to be searched.");
    const v = t.svc.db.get<{ id: number }>("SELECT latest_version_id AS id FROM pages WHERE public_id = ?", [p.pageId])!;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const put = await t.svc.blobs.put(png, { kind: "image", mime: "image/png" });
    const asset = t.svc.db.run("INSERT INTO assets (blob_id, url, url_key, kind, mime, status, fetched_at) VALUES (?, 'https://x.invalid/favicon.png', 'k', 'image', 'image/png', 'ok', 1)", [put.blob.id]);
    t.svc.db.run("INSERT INTO asset_references (version_id, asset_id, role, referenced_url) VALUES (?, ?, 'icon', 'https://x.invalid/favicon.png')", [v.id, asset.lastInsertRowid]);
    const r = await searchApi(t, { query: "icon page" });
    expect(r.body.results[0].faviconUrl).toBe(`/api/search/favicon/${p.pageId}`);
    const f = await t.server.app.inject({ method: "GET", url: r.body.results[0].faviconUrl, headers: { cookie: t.cookie } });
    expect(f.statusCode).toBe(200);
    expect(f.headers["content-type"]).toBe("image/png");
    expect(f.rawPayload.equals(png)).toBe(true);
    expect((await t.api("GET", "/api/search/favicon/pg_missing")).status).toBe(404);
  });

  it("saved searches, history setting, and saved search as a collection", async () => {
    const t = await startSearchServer();
    await t.svc.search.waitForRebuild();
    await addDoc(t, "a.html", "Beacon notes", "Beacons guide ships at night using bright lamps near the rocks along the coast.");
    await addDoc(t, "b.html", "Harbour notes", "Harbour walls shelter ships and the beacons help pilots at night entering the port.");
    await drained(t);
    // history is on by default
    await searchApi(t, { query: "beacons ships" });
    await searchApi(t, { query: "beacons ships", page: 2 }); // not recorded
    let h = await t.api("GET", "/api/search/history");
    expect(h.body.enabled).toBe(true);
    expect(h.body.items.map((i: any) => i.query)).toEqual(["beacons ships"]);
    expect(h.body.items[0]).toMatchObject({ scope: "all", localCount: 2 });
    const sug = await t.api("GET", "/api/search/suggestions?q=beac");
    expect(sug.body.items.some((i: any) => i.kind === "query" && i.text === "beacons ships")).toBe(true);
    // turning it off writes nothing and suggestions drop queries
    await t.api("PATCH", "/api/settings", { privacy: { searchHistory: { enabled: false } } });
    await searchApi(t, { query: "harbour walls" });
    expect((await t.api("GET", "/api/search/history")).body).toEqual({ enabled: false, items: [] });
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM search_history")!.n).toBe(1);
    expect((await t.api("GET", "/api/search/suggestions?q=beac")).body.items.some((i: any) => i.kind === "query")).toBe(false);
    await t.api("PATCH", "/api/settings", { privacy: { searchHistory: { enabled: true } } });
    expect((await t.api("DELETE", "/api/search/history")).body).toEqual({ removed: 1 });

    // saved search CRUD and run
    const bad = await t.api("POST", "/api/search/saved", { name: "x", query: "" });
    expect(bad.status).toBe(400);
    const ss = await t.api("POST", "/api/search/saved", { name: "Night ships", query: "ships night", filters: {}, scope: "all" });
    expect(ss.status).toBe(201);
    expect(ss.body.id).toMatch(/^ss_/);
    const run = await t.api("POST", `/api/search/saved/${ss.body.id}/run`, {});
    expect(run.body.total).toBe(2);
    expect((await t.api("GET", "/api/search/saved")).body.items[0]).toMatchObject({ name: "Night ships", lastResultCount: 2 });
    const patched = await t.api("PATCH", `/api/search/saved/${ss.body.id}`, { query: "beacons" });
    expect(patched.body.query).toBe("beacons");
    // saved search as collection
    const noRef = await t.api("POST", "/api/collections", { name: "Bad", kind: "saved_search", savedSearchId: "ss_nope" });
    expect(noRef.status).toBe(400);
    const col = await t.api("POST", "/api/collections", { name: "Night ships collection", kind: "saved_search", savedSearchId: ss.body.id });
    expect(col.status).toBe(201);
    expect(col.body).toMatchObject({ kind: "saved_search", rule: { savedSearchId: ss.body.id }, itemCount: 2 });
    expect((await t.api("POST", `/api/collections/${col.body.id}/items`, { add: [] })).status).toBe(409);
    expect((await t.api("DELETE", `/api/search/saved/${ss.body.id}`)).status).toBe(409);
    // a new matching capture joins the collection once indexed
    await addDoc(t, "c.html", "Lamp room", "The beacon lamp room holds a great lens that is polished every week by the keeper.");
    await drained(t);
    await until(async () => (await t.api("POST", `/api/collections/${col.body.id}/rebuild`)).body.added >= 0 && (await t.api("GET", `/api/collections/${col.body.id}`)).body.itemCount === 3, 15_000);
    expect((await t.api("DELETE", `/api/collections/${col.body.id}`)).status).toBe(200);
    expect((await t.api("DELETE", `/api/search/saved/${ss.body.id}`)).status).toBe(204);
  });

  it("synonyms and ranking endpoints", async () => {
    const t = await startSearchServer();
    await t.svc.search.waitForRebuild();
    await addDoc(t, "s.html", "Cooking pasta", "Boil water and add salt then cook the pasta for ten minutes before serving with sauce.");
    await drained(t);
    expect((await searchApi(t, { query: "noodles" })).body.results).toHaveLength(0);
    const put = await t.api("PUT", "/api/index/synonyms", { enabled: true, items: [{ term: "noodles", expansions: ["pasta"], kind: "oneway" }] });
    expect(put.status).toBe(200);
    expect((await searchApi(t, { query: "noodles" })).body.results).toHaveLength(1);
    expect((await searchApi(t, { query: "noodles", synonyms: false })).body.results).toHaveLength(0);
    expect((await t.api("PUT", "/api/index/synonyms", { items: [{ term: "a<b", expansions: ["x"], kind: "oneway" }] })).status).toBe(400);
    expect((await t.api("GET", "/api/index/synonyms")).body.items).toHaveLength(1);
    const rk = await t.api("GET", "/api/index/ranking");
    expect(rk.body.weights).toEqual(rk.body.defaults);
    expect(rk.body.bm25).toEqual({ title: 10, headings: 5, url: 3, body: 1 });
    const upd = await t.api("PUT", "/api/index/ranking", { weights: { freshness: 0.5 }, preferences: { domains: { "imports.noconbrain.invalid": 1 } } });
    expect(upd.body.weights.freshness).toBe(0.5);
    expect((await t.api("PUT", "/api/index/ranking", { weights: { nonsense: 1 } })).status).toBe(400);
    expect((await t.api("PUT", "/api/index/ranking", { weights: { freshness: 9 } })).status).toBe(400);
  });
});
void docFixture; void upload;
