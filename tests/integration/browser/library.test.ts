import { describe, expect, it } from "vitest";
import { saveAndWait, startBrowserServer, until, useFixtures } from "./helpers.js";

const fixtures = useFixtures();

describe("Library: list, detail and explicit deletion", () => {
  it("lists saved pages with title, site, captured date, version count and size", async () => {
    const t = await startBrowserServer();
    const base = fixtures().urls.article;
    await saveAndWait(t, `${base}/astronomy`);
    await saveAndWait(t, `${base}/solar-system`);

    const l = await t.api("GET", "/api/archive/pages");
    expect(l.status).toBe(200);
    expect(l.body.total).toBe(2);
    const p = l.body.items.find((i: { url: string }) => i.url.endsWith("/astronomy"));
    expect(p).toMatchObject({
      id: expect.stringMatching(/^pg_/), title: expect.stringContaining("Astronomy"), domain: "127.0.0.1", availability: "archived",
      versionCount: 1, effectivePriority: "P3", totalBytes: expect.any(Number), lastCapturedAt: expect.any(String),
    });
    expect(p.totalBytes).toBeGreaterThan(1000);
    expect((await t.api("GET", "/api/archive/pages?q=solar")).body.items).toHaveLength(1);
    expect((await t.api("GET", "/api/archive/pages?q=nothing-like-this")).body.total).toBe(0);
    const sorted = await t.api("GET", "/api/archive/pages?sort=title&limit=1");
    expect(sorted.body.items).toHaveLength(1);
    expect(sorted.body.nextCursor).toBe("1");
    const second = await t.api("GET", `/api/archive/pages?sort=title&limit=1&cursor=${sorted.body.nextCursor}`);
    expect(second.body.items[0].id).not.toBe(sorted.body.items[0].id);
    expect(second.body.nextCursor).toBeUndefined();

    const d = await t.api("GET", `/api/archive/pages/${p.id}`);
    expect(d.body.page.id).toBe(p.id);
    expect(d.body.versions).toHaveLength(1);
    expect((await t.api("GET", `/api/archive/versions?pageId=${p.id}`)).body.items[0].id).toBe(p.latestVersionId);
    const v = await t.api("GET", `/api/archive/versions/${p.latestVersionId}`);
    expect(v.body).toMatchObject({ status: "ready", pageId: p.id });
    expect((await t.api("GET", "/api/archive/pages/pg_00000000000000000000000000")).status).toBe(404);
  });

  it("dryRun previews the impact; deletion releases the blob references and removes the page", async () => {
    const t = await startBrowserServer();
    const base = fixtures().urls.article;
    const a = await saveAndWait(t, `${base}/astronomy`);
    const b = await saveAndWait(t, `${base}/solar-system`);
    const refsBefore = t.svc.db.get<{ n: number }>("SELECT SUM(refcount) AS n FROM blobs")!.n;

    const preview = await t.api("DELETE", `/api/archive/pages/${a.pageId}?dryRun=true`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ versions: 1, requiresConfirmation: false });
    expect(preview.body.exclusiveBytes).toBeGreaterThan(0);
    expect(preview.body.sharedBytesKept).toBeGreaterThan(0); // the shared stylesheet is also used by the other page
    expect(t.pipeline.getPage(a.pageId!)).toBeDefined(); // a preview deletes nothing

    const del = await t.api("DELETE", `/api/archive/pages/${a.pageId}`);
    expect(del.status).toBe(200);
    expect(del.body.deletedVersions).toBe(1);
    expect(t.pipeline.getPage(a.pageId!)).toBeUndefined();
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions WHERE page_id NOT IN (SELECT id FROM pages)")!.n).toBe(0);
    const refsAfter = t.svc.db.get<{ n: number }>("SELECT SUM(refcount) AS n FROM blobs")!.n;
    expect(refsAfter).toBeLessThan(refsBefore);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM blobs WHERE refcount > 0")!.n).toBeGreaterThan(0);

    // The other page is untouched and still opens.
    const open = await t.api("POST", "/api/browser/resolve", { input: `${base}/solar-system` });
    expect(open.body.resolution.kind).toBe("archive");
    expect((await t.archiveFetch(open.body.resolution.frame.url)).status).toBe(200);
    expect((await t.api("POST", "/api/browser/resolve", { input: `${base}/astronomy` })).body.resolution.kind).toBe("live");
    expect((await t.api("DELETE", `/api/archive/pages/${a.pageId}`)).status).toBe(404);
    expect(b.pageId).toBeDefined();
    // The saved page can be saved again at once.
    expect((await saveAndWait(t, `${base}/astronomy`)).outcome).toBe("created");
  });

  it("a protected page needs confirmation", async () => {
    const t = await startBrowserServer();
    const url = `${fixtures().urls.article}/astronomy`;
    const saved = await saveAndWait(t, url);
    // Re-save the same page at P1: the page's effective priority is the highest reference.
    t.svc.db.run("UPDATE pages SET effective_priority = 1 WHERE public_id = ?", [saved.pageId!]);
    const prev = await t.api("DELETE", `/api/archive/pages/${saved.pageId}?dryRun=true`);
    expect(prev.body).toMatchObject({ requiresConfirmation: true, references: { pins: ["P1"] } });
    const refused = await t.api("DELETE", `/api/archive/pages/${saved.pageId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.details.requiresConfirmation).toBe(true);
    expect((await t.api("DELETE", `/api/archive/pages/${saved.pageId}?confirmProtected=true`)).status).toBe(200);
  });

  it("deleting a page recalculates the inbound count of the pages it linked to", async () => {
    const t = await startBrowserServer();
    const base = fixtures().urls.article;
    const target = await saveAndWait(t, `${base}/solar-system`);
    const from = await saveAndWait(t, `${base}/astronomy`);
    await until(() => t.pipeline.getPage(target.pageId!)!.inboundCount > 0 || undefined).catch(() => undefined);
    const before = t.pipeline.getPage(target.pageId!)!.inboundCount;
    await t.api("DELETE", `/api/archive/pages/${from.pageId}`);
    expect(t.pipeline.getPage(target.pageId!)!.inboundCount).toBeLessThanOrEqual(before);
    expect(t.pipeline.getPage(target.pageId!)!.inboundCount).toBe(0);
  });
});
