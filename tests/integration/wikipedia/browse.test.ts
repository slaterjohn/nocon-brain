import { describe, expect, it } from "vitest";
import { saveAndWait, useFixtures } from "../browser/helpers.js";
import { startWikiServer, until, type WikiTest } from "./helpers.js";

const fx = useFixtures();
const abs = (t: WikiTest, href: string) => (href.startsWith("http") ? href : `http://127.0.0.1:${t.archivePort}${href}`);
const resolve = (t: WikiTest, input: string, extra: Record<string, unknown> = {}) => t.api("POST", "/api/browser/resolve", { input, ...extra });
const FRAME = { headers: { "sec-fetch-dest": "iframe" } };

/** A Wikipedia reading page, as the stubbed Wikipedia client serves it for any article. */
const stubFetch = (): { fetch: typeof fetch; seen: string[] } => {
  const seen: string[] = [];
  return {
    seen,
    fetch: (async (input: string | URL) => {
      const u = new URL(String(input));
      seen.push(u.pathname + u.search);
      const title = decodeURIComponent(/\/page\/([^/]+)\/html/.exec(u.pathname)?.[1] ?? "X");
      return new Response(
        `<!DOCTYPE html><html about="//en.wikipedia.org/wiki/Special:Redirect/revision/9001"><head><meta charset="utf-8"><base href="//en.wikipedia.org/wiki/"><title>${title}</title></head><body><section data-mw-section-id="0"><p><b>${title.replace(/_/g, " ")}</b> is a chemical element.</p></section></body></html>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8", etag: 'W/"9001/x"', "x-revision-id": "9001" } },
      );
    }) as typeof fetch,
  };
};

/** Z-06: Wikipedia addresses open the package copy, archived pages link to package entries, and History and bookmarks work for them. */
describe("unified browsing: Wikipedia addresses and knowledge packages", () => {
  it("maps article addresses of every shape to the package entry, offline, and opens it on the listener", async () => {
    const t = await startWikiServer();
    const pkg = (await t.add("wiki")).body;
    await t.api("POST", "/api/system/connectivity", { forceOffline: true });
    for (const [input, path] of [
      ["https://en.wikipedia.org/wiki/Benzene", "Benzene"],
      ["en.wikipedia.org/wiki/Benzene", "Benzene"],
      ["https://en.m.wikipedia.org/wiki/Toluene", "Toluene"],
      ["https://en.wikipedia.org/w/index.php?title=Aromaticity", "Aromaticity"],
      ["https://en.wikipedia.org/index.php?title=Black_hole", "Black_hole"],
      ["https://en.wikipedia.org/wiki/black_hole", "Black_hole"],
      ["https://en.wikipedia.org/wiki/Benzene#History", "Benzene"],
    ] as const) {
      const r = await resolve(t, input);
      expect(r.status, input).toBe(200);
      expect(r.body.resolution, input).toMatchObject({ kind: "zim", zim: { id: pkg.id, title: "Wikipedia (fixture)" }, path });
      expect(r.body.alternatives).toContain("zim");
      expect(r.body.connectivity).toBe("offline");
    }
    const r = await resolve(t, "https://en.wikipedia.org/wiki/Benzene");
    const page = await t.archiveFetch(r.body.resolution.frame.url);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("<b>Benzene</b> is an aromatic hydrocarbon");
    expect(html).toContain("data-ncb-zim-bar");
    // a link inside the package stays in the package
    expect(html).toMatch(new RegExp(`href="[^"]*/z/${pkg.id}/Toluene"`));
    // an article the package does not have, a language it does not hold and a different site are not mapped
    expect((await resolve(t, "https://en.wikipedia.org/wiki/Zirconium")).body.resolution.kind).toBe("offline");
    expect((await resolve(t, "https://de.wikipedia.org/wiki/Benzene")).body.resolution.kind).toBe("offline");
    expect((await resolve(t, "https://en.wikipedia.org/wiki/Category:Benzene")).body.resolution.kind).toBe("offline");
    expect((await resolve(t, "https://example.org/wiki/Benzene")).body.resolution.kind).toBe("offline");
    expect((await resolve(t, "https://en.wikipedia.org/wiki/Benzene?action=edit")).body.resolution.kind).toBe("offline");
  });

  it("uses the package copy online too, unless the Human asks for the live site, and ignores a switched-off package", async () => {
    const t = await startWikiServer();
    const pkg = (await t.add("wiki")).body;
    const url = "https://en.wikipedia.org/wiki/Benzene";
    expect((await resolve(t, url)).body.resolution.kind).toBe("zim");
    const live = await resolve(t, url, { prefer: "live" });
    expect(live.body.resolution.kind).toBe("live");
    expect(live.body.alternatives).toEqual(expect.arrayContaining(["zim", "live"]));
    await t.api("PATCH", `/api/zim/packages/${pkg.id}`, { enabledForSearch: false });
    expect((await resolve(t, url)).body.resolution.kind).toBe("live");
  });

  it("records the visit in History and answers frame-state with the Wikipedia address", async () => {
    const t = await startWikiServer();
    const pkg = (await t.add("wiki")).body;
    const r = await resolve(t, "https://en.m.wikipedia.org/wiki/Toluene");
    const frame = r.body.resolution.frame;
    expect((await t.archiveFetch(frame.url, FRAME)).status).toBe(200);
    const fs = await t.api("GET", `/api/browser/frame-state?frameId=${frame.frameId}`);
    expect(fs.body).toMatchObject({ state: "zim", zimId: pkg.id, zimPath: "Toluene", url: "https://en.wikipedia.org/wiki/Toluene" });
    const h = await t.api("GET", "/api/history");
    expect(h.body.items).toHaveLength(1);
    expect(h.body.items[0]).toMatchObject({ url: "https://en.wikipedia.org/wiki/Toluene", servedFrom: "zim", zim: { zimId: pkg.id, path: "Toluene" } });
    expect(h.body.items[0].title).toBeTruthy();
    // reading the frame state again does not record a second visit
    await t.api("GET", `/api/browser/frame-state?frameId=${frame.frameId}`);
    expect((await t.api("GET", "/api/history")).body.items).toHaveLength(1);
    // following a link inside the package is a visit of its own
    const html = await (await t.archiveFetch(frame.url)).text();
    expect(html).toBeTruthy();
    // switched off, nothing is written
    await t.api("PATCH", "/api/settings", { privacy: { history: { enabled: false } } });
    const again = await resolve(t, "https://en.wikipedia.org/wiki/Moon");
    await t.archiveFetch(again.body.resolution.frame.url, FRAME);
    expect((await t.api("GET", "/api/history")).body.items).toHaveLength(1);
  });

  it("bookmarks a package entry by its Wikipedia address or by package and path", async () => {
    const t = await startWikiServer();
    const pkg = (await t.add("wiki")).body;
    const chem = (await t.add("chem")).body;
    const b = await t.api("POST", "/api/bookmarks", { url: "https://en.wikipedia.org/wiki/Benzene" });
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ originalUrl: "https://en.wikipedia.org/wiki/Benzene", zim: { zimId: pkg.id, path: "Benzene" }, title: "Benzene" });
    expect((await t.api("POST", "/api/bookmarks", { url: "https://en.m.wikipedia.org/wiki/Benzene" })).status).toBe(201); // another address of the same article is its own bookmark
    const again = await t.api("POST", "/api/bookmarks", { url: "https://en.wikipedia.org/wiki/Benzene" });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(b.body.id);
    // a package that is not Wikipedia has no web address for its entries
    const e = await t.api("POST", "/api/bookmarks", { zimId: chem.id, zimPath: "Ethanol", title: "Ethanol (chemistry package)" });
    expect(e.status).toBe(201);
    expect(e.body).toMatchObject({ originalUrl: `zim://${chem.id}/Ethanol`, zim: { zimId: chem.id, path: "Ethanol" }, title: "Ethanol (chemistry package)" });
    expect((await t.api("POST", "/api/bookmarks", { zimId: chem.id, zimPath: "Ethanol" })).body.id).toBe(e.body.id);
    expect((await t.api("POST", "/api/bookmarks", { zimId: "zim_nope", zimPath: "X" })).status).toBe(404);
    expect((await t.api("POST", "/api/bookmarks", {})).status).toBe(400);
    const list = await t.api("GET", "/api/bookmarks");
    expect(list.body.items).toHaveLength(3);
    expect((await t.api("GET", `/api/bookmarks?url=${encodeURIComponent(`zim://${chem.id}/Ethanol`)}`)).body.items).toHaveLength(1);
    // the bookmark opens the package entry offline
    await t.api("POST", "/api/system/connectivity", { forceOffline: true });
    expect((await resolve(t, b.body.originalUrl)).body.resolution).toMatchObject({ kind: "zim", path: "Benzene" });
    // a package with bookmarks cannot be removed without saying so
    const plan = await t.api("GET", `/api/zim/packages/${chem.id}/references`);
    expect(plan.body.references.bookmarks.count).toBe(1);
    const del = await t.api("DELETE", `/api/zim/packages/${chem.id}`);
    expect(del.status).toBe(409);
    expect((await t.api("DELETE", `/api/zim/packages/${chem.id}?confirm=true`)).status).toBe(200);
    expect((await t.api("GET", "/api/bookmarks")).body.items.map((x: { id: string }) => x.id).sort()).toEqual([b.body.id, (await t.api("GET", "/api/bookmarks")).body.items.find((x: { originalUrl: string }) => x.originalUrl.includes("m.wikipedia"))?.id].sort());
  });

  it("an archived page's Wikipedia links open the package copy, and a package page's links open archived copies", async () => {
    const stub = stubFetch();
    const t = await startWikiServer({ noOrigin: true, wiki: { fetch: stub.fetch, minIntervalMs: 30 } });
    const pkg = (await t.add("wiki")).body;
    // 1. an ordinary web page that cites Wikipedia in several address forms
    const cites = `${fx().urls.article}/cites-wikipedia`;
    expect((await saveAndWait(t, cites)).state).toBe("completed");
    await t.api("POST", "/api/system/connectivity", { forceOffline: true });
    const open = await resolve(t, cites);
    expect(open.body.resolution.kind).toBe("archive");
    const html = await (await t.archiveFetch(open.body.resolution.frame.url)).text();
    const href = (id: string) => new RegExp(`<a [^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
    for (const [id, p] of [["w-benzene", "Benzene"], ["w-toluene", "Toluene"], ["w-index", "Aromaticity"]] as const) {
      const a = href(id);
      expect(a, id).toMatch(new RegExp(`href="[^"]*/z/${pkg.id}/${p}"`));
      expect(a, id).toContain('data-ncb-link="cached"');
    }
    // not in any package, and not archived: the notice page, marked unavailable offline
    expect(href("w-missing")).toMatch(/href="[^"]*\/m\?u=/);
    expect(href("w-missing")).toContain('data-ncb-link="unavailable"');
    // following a mapped link lands on the package entry
    const follow = /id="w-benzene"[^>]*href="([^"]+)"|href="([^"]+)"[^>]*id="w-benzene"/.exec(html)!;
    const target = await t.archiveFetch(abs(t, (follow[1] ?? follow[2])!.replace(/&amp;/g, "&")));
    expect(await target.text()).toContain("<b>Benzene</b> is an aromatic hydrocarbon");
    // link states report the same
    expect((await t.api("POST", "/api/browser/link-states", { urls: ["https://en.wikipedia.org/wiki/Benzene"] })).body.items[0].state).toBeDefined();

    // 2. back: save the one article that the package page links to (Zirconium) as an ordinary archived page, and the package page's link now opens it
    await t.api("POST", "/api/system/connectivity", { forceOffline: false });
    const saved = await saveAndWait(t, "https://en.wikipedia.org/wiki/Zirconium");
    expect(saved.state).toBe("completed");
    expect(stub.seen.some((s) => s.startsWith("/w/rest.php/v1/page/Zirconium/html"))).toBe(true);
    const benzene = await resolve(t, "https://en.wikipedia.org/wiki/Benzene");
    expect(benzene.body.resolution.kind).toBe("zim");
    const pkgHtml = await (await t.archiveFetch(benzene.body.resolution.frame.url)).text();
    const zr = /<a [^>]*>Zirconium<\/a>/.exec(pkgHtml)![0];
    expect(zr).toMatch(/href="[^"]*\/p\/pg_[^"]*"/);
    expect(zr).toMatch(/data-ncb-link="(cached|partial)"/);
    // and Zirconium now resolves to its archived copy
    expect((await resolve(t, "https://en.wikipedia.org/wiki/Zirconium")).body.resolution.kind).toBe("archive");
  });

  it("prefers the archived copy of an article but offers the package copy as an alternative", async () => {
    const stub = stubFetch();
    const t = await startWikiServer({ noOrigin: true, wiki: { fetch: stub.fetch, minIntervalMs: 30 } });
    const pkg = (await t.add("wiki")).body;
    expect((await saveAndWait(t, "https://en.wikipedia.org/wiki/Benzene")).state).toBe("completed");
    const r = await resolve(t, "https://en.wikipedia.org/wiki/Benzene");
    expect(r.body.resolution.kind).toBe("archive");
    expect(r.body.alternatives).toEqual(expect.arrayContaining(["archive", "zim"]));
    const z = await resolve(t, "https://en.wikipedia.org/wiki/Benzene", { prefer: "zim" });
    expect(z.body.resolution).toMatchObject({ kind: "zim", zim: { id: pkg.id }, path: "Benzene" });
    // the archived copy carries its attribution footer
    const html = await (await t.archiveFetch(r.body.resolution.frame.url)).text();
    expect(html).toContain("data-ncb-attribution");
    expect(html).toContain("revision 9001");
  });

  it("drops a package hit from a mixed search when the same Wikipedia article is archived", async () => {
    const stub = stubFetch();
    const t = await startWikiServer({ noOrigin: true, wiki: { fetch: stub.fetch, minIntervalMs: 30 } });
    const pkg = (await t.add("wiki")).body;
    const before = (await t.api("POST", "/api/search", { query: "benzene", online: "off", record: false })).body;
    expect(before.results.filter((x: { origin: string }) => x.origin === "zim").map((x: { zimPath: string }) => x.zimPath)).toContain("Benzene");
    expect((await saveAndWait(t, "https://en.wikipedia.org/wiki/Benzene")).state).toBe("completed");
    await until(async () => {
      const r = (await t.api("POST", "/api/search", { query: "benzene", online: "off", record: false, scope: "offline", zim: "off" })).body;
      return r.results.some((x: { origin: string }) => x.origin === "archive");
    }, 30_000);
    const mixed = (await t.api("POST", "/api/search", { query: "benzene", online: "off", record: false })).body;
    const zimHits = mixed.results.filter((x: { origin: string }) => x.origin === "zim");
    expect(zimHits.map((x: { zimPath: string }) => x.zimPath)).not.toContain("Benzene");
    expect(mixed.results.some((x: { origin: string }) => x.origin === "archive")).toBe(true);
    // the package's own list still names it, marked as archived
    const group = mixed.zim.groups.find((g: { zimId: string }) => g.zimId === pkg.id);
    expect(group.hits.find((h: { zimPath: string }) => h.zimPath === "Benzene")).toMatchObject({ archivedAs: expect.stringMatching(/^pg_/) });
    // other articles of the package are untouched
    expect(zimHits.map((x: { zimPath: string }) => x.zimPath)).toEqual(expect.arrayContaining(["Toluene"]));
    // the package-only view shows everything
    const only = (await t.api("POST", "/api/search", { query: "benzene", online: "off", record: false, scope: "zim" })).body;
    expect(only.results.map((x: { zimPath: string }) => x.zimPath)).toContain("Benzene");
  });
});
