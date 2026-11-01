import { describe, expect, it } from "vitest";
import { saveAndWait, startBrowserServer, useFixtures } from "./helpers.js";

const fixtures = useFixtures();

async function open(t: Awaited<ReturnType<typeof startBrowserServer>>, path: string) {
  const url = `${fixtures().urls.article}${path}`;
  const saved = await saveAndWait(t, url);
  const r = await t.api("POST", "/api/browser/resolve", { input: url });
  return { saved, frame: r.body.resolution.frame as { url: string; frameId: string } };
}

describe("A-18 find in page", () => {
  it("the API count equals the number of <mark> elements the listener adds for ?hl=", async () => {
    const t = await startBrowserServer();
    const { saved, frame } = await open(t, "/astronomy");
    for (const q of ["star", "the", "Solar System", "ZZZ-no-match", "  planet  "]) {
      const api = await t.api("GET", `/api/archive/versions/${saved.versionId}/find?q=${encodeURIComponent(q)}`);
      expect(api.status).toBe(200);
      const res = await t.archiveFetch(`${frame.url}?hl=${encodeURIComponent(q)}`, { headers: { "sec-fetch-dest": "iframe" } });
      const html = await res.text();
      const marks = [...html.matchAll(/<mark id="(ncb-hit-\d+)" class="ncb-hit">/g)].map((m) => m[1]);
      expect(marks.length, `query "${q}"`).toBe(api.body.count);
      expect(api.body.anchors).toEqual(marks);
      if (api.body.count > 0) {
        expect(html).toContain("mark.ncb-hit");
        expect(res.headers.get("content-security-policy")).toContain("sandbox");
        expect(html).not.toMatch(/<script|onerror=|javascript:/i);
      }
    }
    const some = await t.api("GET", `/api/archive/versions/${saved.versionId}/find?q=star`);
    expect(some.body.count).toBeGreaterThan(0);
    expect(some.body.query).toBe("star");
  });

  it("an empty or blank query has no matches; unknown versions are 404; the term is capped", async () => {
    const t = await startBrowserServer();
    const { saved } = await open(t, "/astronomy");
    expect((await t.api("GET", `/api/archive/versions/${saved.versionId}/find?q=`)).body).toEqual({ query: "", count: 0, anchors: [], truncated: false });
    expect((await t.api("GET", `/api/archive/versions/${saved.versionId}/find?q=%20%20`)).body.count).toBe(0);
    expect((await t.api("GET", "/api/archive/versions/ver_00000000000000000000000000/find?q=a")).status).toBe(404);
    expect((await t.api("GET", `/api/archive/versions/${saved.versionId}/find?q=${"a".repeat(401)}`)).status).toBe(400);
  });

  it("highlighting keeps the listener's headers, and the partial banner text is not searched", async () => {
    const t = await startBrowserServer();
    const { frame } = await open(t, "/astronomy");
    const res = await t.archiveFetch(`${frame.url}?hl=a`, { headers: { "sec-fetch-dest": "iframe" } });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    // A very common term stops at the highlight limit.
    const html = await res.text();
    expect((html.match(/<mark /g) ?? []).length).toBeLessThanOrEqual(500);
  });
});

describe("D-5 frame state", () => {
  it("follows the last document the listener served to the frame, including in-frame clicks and the interstitial", async () => {
    const t = await startBrowserServer();
    const base = fixtures().urls.article;
    await saveAndWait(t, `${base}/solar-system`);
    const { frame } = await open(t, "/astronomy");

    // No document served yet.
    expect((await t.api("GET", `/api/browser/frame-state?frameId=${frame.frameId}`)).status).toBe(404);

    // A subresource or a non-framed request does not move the address bar.
    await t.archiveFetch(frame.url, { headers: { "sec-fetch-dest": "empty" } });
    expect((await t.api("GET", `/api/browser/frame-state?frameId=${frame.frameId}`)).status).toBe(404);

    const html = await (await t.archiveFetch(frame.url, { headers: { "sec-fetch-dest": "iframe" } })).text();
    let fs = (await t.api("GET", `/api/browser/frame-state?frameId=${frame.frameId}`)).body;
    expect(fs).toMatchObject({ frameId: frame.frameId, url: `${base}/astronomy`, state: "cached", pageId: expect.stringMatching(/^pg_/) });
    expect(fs.title).toContain("Astronomy");
    const seq1 = fs.seq;

    // The Human clicks a link to another saved page inside the frame.
    const selfId = fs.pageId as string;
    const hrefs = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).filter((a) => a.includes('data-ncb-link="cached"')).map((a) => /href="([^"]*)"/.exec(a)?.[1]).filter((h): h is string => !!h);
    const cached = hrefs.find((h) => !h.includes(selfId));
    expect(cached).toBeTruthy();
    await t.archiveFetch(`http://x${cached}`, { headers: { "sec-fetch-dest": "iframe" } });
    fs = (await t.api("GET", `/api/browser/frame-state?frameId=${frame.frameId}`)).body;
    expect(fs.url).toBe(`${base}/solar-system`);
    expect(fs.pageId).not.toBe(selfId);
    expect(fs.seq).toBeGreaterThan(seq1);

    // A link to something that is not saved shows the interstitial, and the address bar follows it.
    const live = html.match(/<a[^>]*href="([^"]*\/m\?u=[^"]*)"[^>]*data-ncb-link="live-only"/)?.[1] ?? html.match(/<a[^>]*data-ncb-link="live-only"[^>]*href="([^"]*\/m\?u=[^"]*)"/)?.[1];
    expect(live).toBeTruthy();
    await t.archiveFetch(`http://x${live!.replace(/&amp;/g, "&")}`, { headers: { "sec-fetch-dest": "iframe" } });
    fs = (await t.api("GET", `/api/browser/frame-state?frameId=${frame.frameId}`)).body;
    expect(fs).toMatchObject({ interstitial: true, state: "live_only" });
    expect(fs.url).toMatch(/^http/);

    // Another frame id has its own state.
    expect((await t.api("GET", "/api/browser/frame-state?frameId=fr_other")).status).toBe(404);
  });

  it("marks the reader view", async () => {
    const t = await startBrowserServer();
    const url = `${fixtures().urls.article}/astronomy`;
    await saveAndWait(t, url);
    const r = await t.api("POST", "/api/browser/resolve", { input: url, prefer: "reader" });
    const f = r.body.resolution.frame;
    await t.archiveFetch(f.url, { headers: { "sec-fetch-dest": "iframe" } });
    expect((await t.api("GET", `/api/browser/frame-state?frameId=${f.frameId}`)).body).toMatchObject({ reader: true, state: "cached" });
  });
});
