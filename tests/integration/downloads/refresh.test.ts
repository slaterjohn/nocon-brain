import { describe, expect, it } from "vitest";
import { startSourcesServer, until, useFixtures, type SourcesTest } from "../sources/helpers.js";

const fixtures = useFixtures();
const edge = () => fixtures().urls.edge as string;

const control = async (q: string) => (await fetch(`${edge()}/__control?${q}`)).json() as Promise<{ condVersion: number; condHits: { total: number; notModified: number } }>;

async function download(t: SourcesTest, id: string) {
  return until(() => {
    const d = t.svc.downloads.get(id);
    return ["completed", "failed", "cancelled"].includes(d.state) ? d : undefined;
  }, 30_000);
}

/** A single-page source for an edge /cond route, already captured once. */
async function savedSource(t: SourcesTest, route: string, extra: Record<string, unknown> = {}) {
  await control("reset=1");
  const s = (await t.api("POST", "/api/sources", { name: `Cond ${route}`, type: "single_page", startUrl: `${edge()}/cond/${route}`, ...extra })).body;
  const run = await t.api("POST", `/api/sources/${s.id}/run`);
  expect(run.status, JSON.stringify(run.body)).toBe(202);
  await download(t, run.body.downloadIds[0]);
  return s as { id: string };
}

const refresh = async (t: SourcesTest, sourceId: string) => {
  const r = await t.api("POST", `/api/sources/${sourceId}/refresh`);
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  return download(t, r.body.downloadIds[0]);
};

const pageOf = (t: SourcesTest, sourceId: string) =>
  t.svc.db.get<{ id: number; version_count: number; latest_version_id: number; last_checked_at: number | null; gone_at: number | null; gone_status: number | null; availability: string }>(
    `SELECT p.* FROM pages p JOIN page_sources ps ON ps.page_id = p.id JOIN sources s ON s.id = ps.source_id WHERE s.public_id = ?`, [sourceId])!;

describe("C-11 refresh and change detection (edge /cond routes)", () => {
  it("unchanged: a conditional request answers 304 and no version is created, but last_checked_at moves", async () => {
    const t = await startSourcesServer();
    const s = await savedSource(t, "doc");
    const before = pageOf(t, s.id);
    expect(before.version_count).toBe(1);
    t.fake.advance(60_000);
    const hitsBefore = (await control("")).condHits.notModified;

    const d = await refresh(t, s.id);
    expect(d).toMatchObject({ kind: "refresh", state: "completed", summary: { checked: 1, unchanged: 1, changed: 0, gone: 0, failed: 0 } });
    const after = pageOf(t, s.id);
    expect(after.version_count).toBe(1);
    expect(after.latest_version_id).toBe(before.latest_version_id);
    expect(after.last_checked_at).toBeGreaterThan(before.last_checked_at ?? 0);
    expect((await control("")).condHits.notModified).toBe(hitsBefore + 1);
  });

  it("changed: new content becomes a new version and the old one is kept (on_change)", async () => {
    const t = await startSourcesServer();
    const s = await savedSource(t, "doc");
    await control("cond_version=2");
    const d = await refresh(t, s.id);
    expect(d.summary).toMatchObject({ checked: 1, changed: 1, unchanged: 0 });
    const p = pageOf(t, s.id);
    expect(p.version_count).toBe(2);
    expect(t.pipeline.getVersion(p.latest_version_id)?.title).toBe("Document v2");
    expect(d.progress.bytesDone).toBeGreaterThan(0);
  });

  it("unchanged-but-new-ETag: same bytes under a new ETag is not a new version, and the new validator is stored", async () => {
    const t = await startSourcesServer();
    const s = await savedSource(t, "etag-only");
    const first = pageOf(t, s.id);
    await control("etag_salt=-b");
    const d = await refresh(t, s.id);
    expect(d.summary).toMatchObject({ unchanged: 1, changed: 0 });
    const p = pageOf(t, s.id);
    expect(p.version_count).toBe(1);
    expect(t.pipeline.getVersion(p.latest_version_id)?.etag).toBe('"v1-b"');
    expect(first.latest_version_id).toBe(p.latest_version_id);
  });

  it("gone: a 404 keeps the page and its version, marks it gone, and a later 200 clears the mark", async () => {
    const t = await startSourcesServer();
    const s = await savedSource(t, "gone");
    const availability = pageOf(t, s.id).availability;
    expect(["archived", "partial"]).toContain(availability);
    await control("gone=1");
    const d = await refresh(t, s.id);
    expect(d).toMatchObject({ state: "completed", summary: { checked: 1, gone: 1, failed: 0 } });
    let p = pageOf(t, s.id);
    expect(p).toMatchObject({ gone_status: 404, version_count: 1, availability });
    expect(p.gone_at).not.toBeNull();
    expect(t.pipeline.getPage(p.id)).toMatchObject({ goneStatus: 404 });
    expect((await t.api("GET", `/api/archive/pages/${t.pipeline.getPage(p.id)!.publicId}`)).body.page).toMatchObject({ goneStatus: 404, goneAt: expect.any(String), lastCheckedAt: expect.any(String) });

    await control("gone=0");
    const back = await refresh(t, s.id);
    expect(back.summary).toMatchObject({ gone: 0 });
    p = pageOf(t, s.id);
    expect(p.gone_at).toBeNull();
    expect(p.version_count).toBe(1);
  });

  it("version creation follows the policy: latest_only replaces the old version, all keeps every one", async () => {
    const t = await startSourcesServer();
    const latest = await savedSource(t, "doc", { config: { versioning: { mode: "latest_only" } } });
    await control("cond_version=2");
    await refresh(t, latest.id);
    expect(pageOf(t, latest.id).version_count).toBe(1);
    const v = t.pipeline.getVersion(pageOf(t, latest.id).latest_version_id)!;
    expect(v.title).toBe("Document v2");
    expect(v.versionNo).toBe(2);

    const all = await savedSource(t, "etag-only", { config: { versioning: { mode: "all" } } });
    await control("cond_version=3");
    await refresh(t, all.id);
    expect(pageOf(t, all.id).version_count).toBe(2);
  });

  it("a source with a schedule refreshes its pages: the second scheduled run is a refresh, not a new capture", async () => {
    const t = await startSourcesServer({ server: { scheduler: { tickMs: 1e15 } } });
    const s = await savedSource(t, "doc");
    await t.api("POST", "/api/schedules", { sourceId: s.id, kind: "hourly", minute: 0 });
    await control("cond_version=2");
    t.fake.advance(2 * 3_600_000);
    t.svc.scheduler.tick(true);
    const dl = await until(() => t.svc.db.get<{ public_id: string }>("SELECT public_id FROM download_jobs WHERE requested_by = 'schedule'"), 10_000);
    const d = await download(t, dl.public_id);
    expect(d.kind).toBe("refresh");
    expect(d.summary).toMatchObject({ changed: 1 });
    expect(pageOf(t, s.id).version_count).toBe(2);
  });

  it("refuses to refresh a source that has no saved pages, and lists the refresh among downloads", async () => {
    const t = await startSourcesServer();
    const s = (await t.api("POST", "/api/sources", { name: "Empty", type: "single_page", startUrl: `${edge()}/cond/doc` })).body;
    const r = await t.api("POST", `/api/sources/${s.id}/refresh`);
    expect(r.status).toBe(409);
    const saved = await savedSource(t, "doc");
    await refresh(t, saved.id);
    const list = await t.api("GET", "/api/downloads?kind=refresh");
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ kind: "refresh", state: "completed", sourceId: saved.id, requestedBy: "user" });
  });
});
