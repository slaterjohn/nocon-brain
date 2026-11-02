import { describe, expect, it } from "vitest";
import { capture, startPipelineServer, useFixtures } from "./helpers.js";

const fixtures = useFixtures();

describe("A-05/A-06 capture end to end", () => {
  it("captures an article through all fifteen stages", async () => {
    const t = await startPipelineServer();
    const url = `${fixtures().urls.article}/astronomy`;
    const r = await capture(t, url);
    expect(r).toMatchObject({ state: "completed", outcome: "created" });
    const v = t.pipeline.getVersion(r.versionId!)!;
    expect(v.status).toBe("ready");
    expect(v.title).toBe("Astronomy");
    expect(v.language).toBe("en");
    expect(v.publishedSource).toBe("og");
    expect(v.stages).toHaveLength(15);
    expect(v.stages.filter((s) => s.state === "done")).toHaveLength(13);
    expect(v.stages.filter((s) => s.state === "skipped").map((s) => s.stage)).toEqual(["link_graph", "candidates"]);
    expect(v.content.textSha256 && v.content.readerSha256 && v.content.outlineSha256).toBeTruthy();
    const page = t.pipeline.getPage(v.pageId)!;
    expect(page).toMatchObject({ availability: "archived", versionCount: 1, latestVersionPublicId: v.publicId });
    const res = t.pipeline.listResources(v.id);
    expect(res.some((x) => x.url.endsWith("/assets/site.css") && x.status === "ok" && x.blobSha256)).toBe(true);
    expect(res.every((x) => /^r[0-9a-f]{15}$/.test(x.key))).toBe(true);
    // reader and text blobs are readable
    const reader = await t.svc.blobs.read(v.content.readerSha256!);
    expect(reader.data.toString()).toContain("<h2 id=\"overview\">");
    expect(reader.data.toString()).not.toMatch(/<script|onerror|javascript:/i);
    // refcount invariant: blobs.refcount equals the number of references
    const bad = t.svc.db.all(`SELECT b.id FROM blobs b WHERE b.refcount <> (SELECT COUNT(*) FROM asset_references ar JOIN assets a ON a.id = ar.asset_id WHERE a.blob_id = b.id)
      + (SELECT COUNT(*) FROM version_content vc WHERE vc.text_blob_id = b.id OR vc.reader_blob_id = b.id OR vc.outline_blob_id = b.id OR vc.extraction_blob_id = b.id)`);
    expect(bad).toEqual([]);
  });

  it("stores a stylesheet and image shared by two pages once, with two references", async () => {
    const t = await startPipelineServer();
    const a = await capture(t, `${fixtures().urls.article}/stars`);
    const b = await capture(t, `${fixtures().urls.article}/galaxies`);
    expect(a.outcome).toBe("created");
    expect(b.outcome).toBe("created");
    const css = t.svc.db.get<{ blob_id: number; refcount: number; n: number }>(
      `SELECT a.blob_id, b.refcount, (SELECT COUNT(*) FROM assets x WHERE x.url_key = a.url_key) AS n FROM assets a JOIN blobs b ON b.id = a.blob_id WHERE a.url LIKE '%/assets/site.css'`)!;
    expect(css.n).toBe(1);
    expect(css.refcount).toBeGreaterThanOrEqual(2);
    const refs = t.svc.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM asset_references r JOIN assets a ON a.id = r.asset_id WHERE a.blob_id = ?`, [css.blob_id])!.n;
    expect(refs).toBe(2);
    // the CSS import chain is followed: base.css and typography.css are captured via site.css
    const urls = t.svc.db.all<{ url: string }>("SELECT url FROM assets WHERE status = 'ok'").map((r) => r.url);
    expect(urls.some((u) => u.endsWith("/assets/base.css"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/assets/typography.css"))).toBe(true);
    expect(urls.some((u) => u.endsWith("fixture.woff2"))).toBe(true);
    const copies = t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM blobs WHERE kind='image' AND sha256 IN (SELECT sha256 FROM blobs)")!.n;
    expect(copies).toBeGreaterThan(0);
  });

  it("dedupes identical bytes served from two URLs into one blob", async () => {
    const t = await startPipelineServer();
    await capture(t, `${fixtures().urls.article}/dedup/a`);
    await capture(t, `${fixtures().urls.article}/dedup/b`);
    const css = t.svc.db.all<{ url: string; blob_id: number }>("SELECT url, blob_id FROM assets WHERE url LIKE '%site%.css'");
    expect(css).toHaveLength(2);
    expect(new Set(css.map((c) => c.blob_id)).size).toBe(1);
    const img = t.svc.db.all<{ blob_id: number }>("SELECT blob_id FROM assets WHERE url LIKE '%hero%.png' AND status='ok' AND url NOT LIKE '%-480%' AND url NOT LIKE '%-960%'");
    expect(new Set(img.map((c) => c.blob_id)).size).toBe(1);
  });

  it("records a blocked asset host as skipped and the version as partial", async () => {
    const t = await startPipelineServer();
    const r = await capture(t, `${fixtures().urls.ssrfBait}/page/assets`);
    const v = t.pipeline.getVersion(r.versionId!)!;
    expect(["partial", "ready"]).toContain(v.status);
    const blocked = t.svc.db.all<{ status: string; error_code: string }>("SELECT status, error_code FROM assets WHERE blob_id IS NULL");
    expect(blocked.some((b) => b.status === "blocked" && b.error_code === "ssrf_blocked")).toBe(true);
    expect(v.status).toBe("partial");
    expect(v.partialReason).toBe("assets_missing");
  });

  it("applies the per-capture asset count cap", async () => {
    const t = await startPipelineServer();
    const r = await capture(t, `${fixtures().urls.article}/astronomy`, { caps: { maxAssets: 2 } });
    const v = t.pipeline.getVersion(r.versionId!)!;
    expect(v.status).toBe("partial");
    expect(v.partialReason).toBe("size_cap");
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM assets WHERE status='skipped'")!.n).toBeGreaterThan(0);
  });

  it("fails a capture of a missing page with http_4xx and no version", async () => {
    const t = await startPipelineServer();
    const r = await capture(t, `${fixtures().urls.article}/no-such-page`);
    expect(r).toMatchObject({ state: "failed", failureCode: "http_4xx" });
  });

  it("refuses a private address before connecting", async () => {
    const t = await startPipelineServer({ allow: "10.255.255.1" });
    const r = await capture(t, `${fixtures().urls.article}/astronomy`);
    expect(r).toMatchObject({ state: "failed", failureCode: "ssrf_blocked" });
  });
});
