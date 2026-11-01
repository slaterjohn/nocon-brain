import { describe, expect, it } from "vitest";
import { capture, startPipelineServer, useFixtures } from "./helpers.js";

const fixtures = useFixtures();
const control = async (q: string) => (await fetch(`${fixtures().urls.edge}/__control?${q}`)).json() as Promise<{ condHits: { total: number; notModified: number } }>;

describe("A-11 change detection", () => {
  it("creates no version for an unchanged page, uses a conditional request, and updates last_checked_at", async () => {
    await control("reset=1");
    const t = await startPipelineServer();
    const url = `${fixtures().urls.edge}/cond/doc`;
    const first = await capture(t, url);
    expect(first.outcome).toBe("created");
    const page = t.pipeline.getVersion(first.versionId!)!;
    expect(page.etag).toMatch(/^"v1/);
    t.fake.advance(60_000);
    const before = t.pipeline.getPage(page.pageId)!.lastCheckedAt!;
    const second = await capture(t, url);
    expect(second.outcome).toBe("unchanged");
    expect((await control("")).condHits.notModified).toBe(1);
    const after = t.pipeline.getPage(page.pageId)!;
    expect(after.versionCount).toBe(1);
    expect(after.lastCheckedAt!).toBeGreaterThan(before);
  });

  it("creates a new version when the content changes", async () => {
    await control("reset=1");
    const t = await startPipelineServer();
    const url = `${fixtures().urls.edge}/cond/doc`;
    const a = await capture(t, url);
    await control("cond_version=2");
    const b = await capture(t, url);
    expect(b.outcome).toBe("created");
    expect(b.versionId).not.toBe(a.versionId);
    const versions = t.pipeline.listVersions(t.pipeline.getVersion(b.versionId!)!.pageId);
    expect(versions.map((v) => v.versionNo)).toEqual([2, 1]);
    await control("reset=1");
  });

  it("treats a new ETag with identical bytes as unchanged and refreshes the validators", async () => {
    await control("reset=1");
    const t = await startPipelineServer();
    const url = `${fixtures().urls.edge}/cond/doc`;
    const a = await capture(t, url);
    await control("etag_salt=x");
    const b = await capture(t, url);
    expect(b.outcome).toBe("unchanged");
    const v = t.pipeline.getVersion(a.versionId!)!;
    expect(v.etag).toContain("x");
    const c = await capture(t, url);
    expect(c.outcome).toBe("unchanged");
    expect((await control("")).condHits.notModified).toBeGreaterThanOrEqual(1);
    await control("reset=1");
  });

  it("force creates a version even when nothing changed", async () => {
    await control("reset=1");
    const t = await startPipelineServer();
    const url = `${fixtures().urls.edge}/cond/doc`;
    await capture(t, url);
    const b = await capture(t, url, { force: true, versioning: { mode: "all" } });
    expect(b.outcome).toBe("created");
  });
});

describe("A-11 versioning policies end to end", () => {
  const versionNos = (t: Awaited<ReturnType<typeof startPipelineServer>>, id: string) => t.pipeline.listVersions(t.pipeline.getVersion(id)!.pageId).map((v) => v.versionNo);

  it("all keeps every capture; latest_only keeps one and frees the old blobs' references", async () => {
    const url = `${fixtures().urls.article}/comets`;
    const t = await startPipelineServer();
    let last;
    for (let i = 0; i < 3; i++) last = await capture(t, url, { versioning: { mode: "all" } });
    expect(versionNos(t, last!.versionId!)).toEqual([3, 2, 1]);
    const t2 = await startPipelineServer();
    for (let i = 0; i < 3; i++) last = await capture(t2, url, { versioning: { mode: "latest_only" } });
    expect(versionNos(t2, last!.versionId!)).toEqual([3]);
    // only the surviving version references the shared stylesheet
    const css = t2.svc.db.get<{ refcount: number }>("SELECT b.refcount FROM blobs b JOIN assets a ON a.blob_id = b.id WHERE a.url LIKE '%/assets/site.css'")!;
    expect(css.refcount).toBe(1);
    expect(t2.pipeline.getPage(t2.pipeline.getVersion(last!.versionId!)!.pageId)!.versionCount).toBe(1);
  });

  it("last_n keeps the newest n", async () => {
    const t = await startPipelineServer();
    let last;
    for (let i = 0; i < 4; i++) last = await capture(t, `${fixtures().urls.article}/moon`, { versioning: { mode: "last_n", n: 2 } });
    expect(versionNos(t, last!.versionId!)).toEqual([4, 3]);
  });

  it("period replaces within the period and keeps one per period", async () => {
    const t = await startPipelineServer();
    const url = `${fixtures().urls.article}/mars`;
    const opts = { versioning: { mode: "period", period: "day" } } as const;
    await capture(t, url, opts);
    let last = await capture(t, url, opts);
    expect(versionNos(t, last.versionId!)).toEqual([2]);
    t.fake.advance(2 * 86_400_000);
    last = await capture(t, url, opts);
    expect(versionNos(t, last.versionId!)).toEqual([3, 2]);
  });
});
