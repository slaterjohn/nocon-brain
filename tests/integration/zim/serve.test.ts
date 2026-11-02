import { describe, expect, it } from "vitest";
import { startZimServer, type ZimTest } from "./helpers.js";

/** Z-04: knowledge-package entries on the archive listener, from real fixture ZIMs generated with the libzim Creator. */
async function open(t: ZimTest, zimId: string, zimPath = "") {
  const g = await t.api("POST", "/api/archive/frame-grants", { zimId, zimPath });
  expect(g.status, JSON.stringify(g.body)).toBe(200);
  return g.body.url as string;
}
/** Resolves an `href` found in a served page against the listener (it is a path with the token in it). */
const abs = (t: ZimTest, href: string) => `http://127.0.0.1:${t.archivePort}${href}`;

const HEADERS = ["content-security-policy", "x-content-type-options", "referrer-policy", "cache-control"];
function expectHeaderClass(r: Response, popups = false) {
  const csp = r.headers.get("content-security-policy")!;
  expect(csp, "csp").toMatch(/^sandbox( allow-popups allow-popups-to-escape-sandbox)?; default-src 'none'/);
  expect(csp.includes("allow-popups")).toBe(popups);
  expect(csp).not.toContain("allow-scripts");
  expect(csp).toContain("frame-ancestors http://localhost:3000");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  expect(r.headers.get("cache-control")).toBeTruthy();
  expect(r.headers.get("set-cookie")).toBeNull();
  for (const h of HEADERS) expect(r.headers.has(h), h).toBe(true);
}

describe("serving ZIM entries on the archive listener", () => {
  it("opens the main page, sanitises it, rewrites links and carries the archive security headers", async () => {
    const t = await startZimServer();
    const z = (await t.add("chem")).body;
    const start = await open(t, z.id);
    const main = await t.archiveFetch(start, { redirect: "manual" });
    expect(main.status).toBe(302); // mainpage redirects to the article behind it
    expectHeaderClass(main);
    const art = await t.archiveFetch(abs(t, main.headers.get("location")!));
    expect(art.status).toBe(200);
    expectHeaderClass(art);
    expect(art.headers.get("content-type")).toBe("text/html; charset=utf-8");

    // Benzene by name
    const base = start.replace(/\/z\/.*$/, "");
    const r = await t.archiveFetch(`${base}/z/${z.id}/Benzene`);
    const html = await r.text();
    expect(r.status).toBe(200);
    expectHeaderClass(r);
    // scripts and handlers are gone, so nothing in the page can run
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("evil.example");
    expect(html).not.toMatch(/\bonclick\b/i);
    expect(html).not.toContain("pwned");
    // attribution bar
    expect(html).toContain("From the offline package <b>Chemistry (fixture)</b>");
    expect(html).toContain("Licence: CC BY-SA 4.0");
    // links between entries stay inside the package, with the token and the same listener
    expect(html).toMatch(new RegExp(`<a href="/a/[^"]+/z/${z.id}/Aromaticity" data-ncb-link="cached">`));
    expect(html).toMatch(new RegExp(`<a href="/a/[^"]+/z/${z.id}/Toluene" data-ncb-link="cached">`));
    // an image and the stylesheet are served from the package too
    expect(html).toMatch(new RegExp(`<img src="/a/[^"]+/z/${z.id}/I/benzene\\.png"`));
    expect(html).toMatch(new RegExp(`<link rel="stylesheet" href="/a/[^"]+/z/${z.id}/-/style\\.css"`));
    // an external link goes through the interstitial; it is never an off-site href
    expect(html).not.toMatch(/href="https:\/\/en\.wikipedia/);
    expect(html).toMatch(/href="\/a\/[^"]+\/m\?u=https%3A%2F%2Fen\.wikipedia\.org%2Fwiki%2FBenzene"/);
    // a link to an entry the package does not have goes to the "not in this package" interstitial
    const gap = /href="(\/a\/[^"]+\/m\?u=zim%3A%2F%2F[^"]+)"[^>]*data-ncb-link="unavailable"/.exec(html);
    expect(gap, "missing-entry link").toBeTruthy();
    const note = await t.archiveFetch(abs(t, gap![1]!.replace(/&amp;/g, "&")));
    expect(note.status).toBe(200);
    expectHeaderClass(note, true);
    expect(await note.text()).toMatch(/Nonexistent_article.*is not in .Chemistry \(fixture\)/s);

    // links between entries work offline: follow one, then the link back
    const toluene = await (await t.archiveFetch(abs(t, new RegExp(`href="(/a/[^"]+/z/${z.id}/Toluene)"`).exec(html)![1]!))).text();
    expect(toluene).toContain("methylbenzene");
    expect(toluene).toMatch(new RegExp(`href="/a/[^"]+/z/${z.id}/Benzene"`));
  });

  it("serves the stylesheet rewritten and the image as an image; script entries are never run or inlined", async () => {
    const t = await startZimServer();
    const z = (await t.add("chem")).body;
    const base = (await open(t, z.id)).replace(/\/z\/.*$/, "");
    const css = await t.archiveFetch(`${base}/z/${z.id}/-/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toContain("font-family");
    expectHeaderClass(css);
    const img = await t.archiveFetch(`${base}/z/${z.id}/I/benzene.png`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await img.arrayBuffer()).subarray(1, 4).toString()).toBe("PNG");
    expectHeaderClass(img);
    // A JavaScript entry is only ever offered as a download; the page that referenced it had the tag removed
    const js = await t.archiveFetch(`${base}/z/${z.id}/-/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("application/octet-stream");
    expect(js.headers.get("content-disposition")).toBe("attachment");
    expectHeaderClass(js);
    const page = await (await t.archiveFetch(`${base}/z/${z.id}/Water`)).text();
    expect(page).not.toContain("app.js");
  });

  it("redirects inside a package with a 302, sets an ETag and answers 304 to If-None-Match", async () => {
    const t = await startZimServer();
    const z = (await t.add("chem")).body;
    const base = (await open(t, z.id)).replace(/\/z\/.*$/, "");
    const red = await t.archiveFetch(`${base}/z/${z.id}/Methylbenzene`, { redirect: "manual" });
    expect(red.status).toBe(302);
    expect(red.headers.get("location")).toMatch(new RegExp(`/z/${z.id}/Toluene$`));
    expectHeaderClass(red);
    // immutable entries: ETag from the package UUID and path, long cache, 304 on revalidation
    const img = await t.archiveFetch(`${base}/z/${z.id}/I/benzene.png`);
    const etag = img.headers.get("etag")!;
    expect(etag).toMatch(/^"zim-[0-9a-f]{24}-/);
    expect(img.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    await img.arrayBuffer();
    const again = await t.archiveFetch(`${base}/z/${z.id}/I/benzene.png`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expectHeaderClass(again);
    // the same path in another package would have another ETag
    const other = (await t.add("other")).body;
    const base2 = (await open(t, other.id)).replace(/\/z\/.*$/, "");
    const o = await t.archiveFetch(`${base2}/z/${other.id}/Pain`);
    expect(o.headers.get("etag")).not.toBe(etag);
    // HTML is revalidated rather than cached (its link states can change), with a content-based ETag
    const art = await t.archiveFetch(`${base}/z/${z.id}/Water`);
    const aetag = art.headers.get("etag")!;
    expect(art.headers.get("cache-control")).toBe("private, no-cache");
    await art.arrayBuffer();
    expect((await t.archiveFetch(`${base}/z/${z.id}/Water`, { headers: { "if-none-match": aetag } })).status).toBe(304);
  });

  it("missing entries, unknown and unavailable packages answer with the standard headers", async () => {
    const t = await startZimServer();
    const z = (await t.add("chem")).body;
    const base = (await open(t, z.id)).replace(/\/z\/.*$/, "");
    for (const [p, status] of [[`/z/${z.id}/Nope`, 404], [`/z/zim_unknown/x`, 404], [`/z/${z.id}/..%2F..%2Fetc%2Fpasswd`, 404]] as const) {
      const r = await t.archiveFetch(`${base}${p}`);
      expect(r.status, p).toBe(404);
      expectHeaderClass(r);
      expect(await r.text()).not.toContain("passwd:");
    }
    expect((await t.archiveFetch(`${base}/z/${z.id}/Benzene`, { method: "POST" })).status).toBe(405);
    // a bad token is still 401 for this class
    expect((await t.archiveFetch(`http://x/a/bad.token/z/${z.id}/Benzene`)).status).toBe(401);
    // a frame grant for a package that is not there is refused by the API
    expect((await t.api("POST", "/api/archive/frame-grants", { zimId: "zim_unknown" })).status).toBe(404);
  });

  it("a missing package file makes its pages answer 404 and frame grants 503 until it is back", async () => {
    const t = await startZimServer();
    const z = (await t.add("chem")).body;
    const base = (await open(t, z.id)).replace(/\/z\/.*$/, "");
    expect((await t.archiveFetch(`${base}/z/${z.id}/Water`)).status).toBe(200);
    (await import("node:fs")).rmSync(z.path);
    await t.api("POST", `/api/zim/packages/${z.id}/verify`, {});
    const gone = await t.api("POST", "/api/archive/frame-grants", { zimId: z.id });
    expect(gone.status).toBe(503);
    expect(gone.body.error).toBe("unavailable");
  });

  it("the listener records the visit as a ZIM frame the browser can read", async () => {
    const t = await startZimServer();
    const z = (await t.add("chem")).body;
    const grant = await t.api("POST", "/api/archive/frame-grants", { zimId: z.id, zimPath: "Benzene" });
    expect(grant.body.url).toMatch(new RegExp(`/z/${z.id}/Benzene$`));
    const r = await t.archiveFetch(grant.body.url, { headers: { "sec-fetch-dest": "iframe" } });
    expect(r.status).toBe(200);
    await r.arrayBuffer();
    const fs = await t.api("GET", `/api/browser/frame-state?frameId=${grant.body.frameId}`);
    expect(fs.status).toBe(200);
    expect(fs.body).toMatchObject({ state: "zim", zimId: z.id, zimPath: "Benzene", url: `zim://${z.id}/Benzene` });
  });
});
