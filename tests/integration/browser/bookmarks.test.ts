import { describe, expect, it } from "vitest";
import { call, saveAndWait, startBrowserServer, useFixtures } from "./helpers.js";

const fixtures = useFixtures();

describe("A-17 bookmarks", () => {
  it("a bookmark of an archived page links the page and records the configured priority", async () => {
    const t = await startBrowserServer();
    const url = `${fixtures().urls.article}/astronomy`;
    const saved = await saveAndWait(t, url);
    expect((await t.api("PATCH", "/api/settings", { browser: { bookmarkPriority: 1 } })).status).toBe(200);

    const b = await t.api("POST", "/api/bookmarks", { url: `${url}#overview` });
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ originalUrl: url, referencePriority: 1, archive: { pageId: saved.pageId, availability: "archived" } });
    expect(b.body.id).toMatch(/^bm_/);
    expect(t.svc.db.get<{ reference_priority: number; page_id: number | null }>("SELECT reference_priority, page_id FROM bookmarks")!.reference_priority).toBe(1);

    // The same address again returns the same bookmark.
    const again = await t.api("POST", "/api/bookmarks", { url });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(b.body.id);
    const byUrl = await t.api("GET", `/api/bookmarks?url=${encodeURIComponent(url)}`);
    expect(byUrl.body.items).toHaveLength(1);
  });

  it("a bookmark of an unarchived address has no archive reference until the page is saved", async () => {
    const t = await startBrowserServer();
    const url = `${fixtures().urls.article}/solar-system`;
    const b = await t.api("POST", "/api/bookmarks", { url, title: "Solar system" });
    expect(b.status).toBe(201);
    expect(b.body.archive).toBeUndefined();
    expect(b.body.title).toBe("Solar system");
    expect(b.body.referencePriority).toBe(2); // default P2
    await saveAndWait(t, url);
    const list = await t.api("GET", "/api/bookmarks");
    expect(list.body.items[0].archive).toMatchObject({ availability: "archived" });
    expect((await t.api("GET", "/api/bookmarks?q=solar")).body.items).toHaveLength(1);
    expect((await t.api("GET", "/api/bookmarks?q=zzz")).body.items).toHaveLength(0);
  });

  it("renames and deletes a bookmark, and lets the address be bookmarked again", async () => {
    const t = await startBrowserServer();
    const url = `${fixtures().urls.article}/astronomy`;
    const b = await t.api("POST", "/api/bookmarks", { url });
    expect((await t.api("PATCH", `/api/bookmarks/${b.body.id}`, { title: "Stars" })).body.title).toBe("Stars");
    expect((await t.api("DELETE", `/api/bookmarks/${b.body.id}`)).status).toBe(204);
    expect((await t.api("DELETE", `/api/bookmarks/${b.body.id}`)).status).toBe(404);
    expect((await t.api("GET", "/api/bookmarks")).body.items).toHaveLength(0);
    expect((await t.api("POST", "/api/bookmarks", { url })).status).toBe(201);
    expect((await t.api("POST", "/api/bookmarks", { url: "javascript:1" })).status).toBe(400);
  });

  it("keeps the address when the saved page is deleted", async () => {
    const t = await startBrowserServer();
    const url = `${fixtures().urls.article}/astronomy`;
    const saved = await saveAndWait(t, url);
    await t.api("POST", "/api/bookmarks", { url });
    expect((await t.api("DELETE", `/api/archive/pages/${saved.pageId}?dryRun=true`)).body.references.bookmarks).toBe(1);
    expect((await t.api("DELETE", `/api/archive/pages/${saved.pageId}`)).status).toBe(200);
    const list = await t.api("GET", "/api/bookmarks");
    expect(list.body.items[0]).toMatchObject({ originalUrl: url });
    expect(list.body.items[0].archive).toBeUndefined();
  });
});

describe("A-17 history", () => {
  it("records archived visits (read from the frame) and live visits with the cached/live marker", async () => {
    const t = await startBrowserServer();
    const base = fixtures().urls.article;
    await saveAndWait(t, `${base}/astronomy`);
    const r = await t.api("POST", "/api/browser/resolve", { input: `${base}/astronomy` });
    const frame = r.body.resolution.frame;
    // Nothing is recorded until the listener serves the page.
    expect((await t.api("GET", "/api/history")).body.items).toHaveLength(0);
    await t.archiveFetch(frame.url, { headers: { "sec-fetch-dest": "iframe" } });
    // The visit is written by the listener's own request: a shell that never asks for the frame state (or asks too late) loses nothing.
    expect((await t.api("GET", "/api/history")).body.items).toEqual([expect.objectContaining({ servedFrom: "archive", url: `${base}/astronomy` })]);
    const fs = await t.api("GET", `/api/browser/frame-state?frameId=${frame.frameId}`);
    expect(fs.status).toBe(200);
    await t.api("GET", `/api/browser/frame-state?frameId=${frame.frameId}`); // reading twice records one visit
    await t.api("POST", "/api/browser/resolve", { input: `${base}/solar-system` });

    const h = await t.api("GET", "/api/history");
    expect(h.body.enabled).toBe(true);
    expect(h.body.items.map((i: { servedFrom: string }) => i.servedFrom).sort()).toEqual(["archive", "live"]);
    expect(h.body.items.find((i: { servedFrom: string }) => i.servedFrom === "archive")).toMatchObject({ url: `${base}/astronomy`, pageId: expect.stringMatching(/^pg_/) });
    expect((await t.api("GET", "/api/history?q=solar")).body.items).toHaveLength(1);
  });

  it("disabling history stops writes, clearing deletes rows, and single entries can go", async () => {
    const t = await startBrowserServer();
    const base = fixtures().urls.article;
    await t.api("POST", "/api/browser/resolve", { input: `${base}/a` });
    await t.api("POST", "/api/browser/resolve", { input: `${base}/b` });
    let h = await t.api("GET", "/api/history");
    expect(h.body.items).toHaveLength(2);
    expect((await t.api("DELETE", `/api/history/${h.body.items[0].id}`)).status).toBe(204);
    expect((await t.api("DELETE", `/api/history/${h.body.items[0].id}`)).status).toBe(404);

    await t.api("PATCH", "/api/settings", { privacy: { history: { enabled: false } } });
    await t.api("POST", "/api/browser/resolve", { input: `${base}/c` });
    h = await t.api("GET", "/api/history");
    expect(h.body).toMatchObject({ enabled: false });
    expect(h.body.items).toHaveLength(1); // the earlier entry is still there until it is cleared

    const cleared = await t.api("DELETE", "/api/history");
    expect(cleared.body.deleted).toBe(1);
    expect((await t.api("GET", "/api/history")).body.items).toHaveLength(0);
    await t.api("PATCH", "/api/settings", { privacy: { history: { enabled: true } } });
    await t.api("POST", "/api/browser/resolve", { input: `${base}/d` });
    expect((await t.api("DELETE", `/api/history?before=${encodeURIComponent(new Date(t.clock.now() - 1000).toISOString())}`)).body.deleted).toBe(0);
    expect((await t.api("GET", "/api/history")).body.items).toHaveLength(1);
  });

  it("needs a session and the CSRF header", async () => {
    const t = await startBrowserServer();
    expect((await call(t, { url: "/api/history" })).statusCode).toBe(401);
    expect((await call(t, { url: "/api/bookmarks" })).statusCode).toBe(401);
    expect((await call(t, { method: "DELETE", url: "/api/history", cookie: t.cookie, raw: true })).statusCode).toBe(403);
  });
});
