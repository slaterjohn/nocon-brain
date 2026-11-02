import { describe, expect, it } from "vitest";
import { startStorageTest } from "../../storage-safety/helpers.js";

describe("storage API: policy, the P2 permit, migrate, forecast, explanation, pins", () => {
  it("the policy has safe defaults, and turning the P2 permit on needs an explicit acknowledgement", async () => {
    const t = await startStorageTest();
    const p = (await t.api("GET", "/api/storage/policy")).body;
    expect(p).toMatchObject({
      permitImportantEviction: false, throttleOpportunistic: true, pruneSurplusVersions: true, orphanGraceSeconds: 86_400, autoEviction: true,
      maxEvictionBatchBytes: null, forecastHorizonDays: 30, protectedNeverEvicted: true,
    });
    expect(p.warnings.permitImportantEviction).toMatch(/Important \(P2\)/);
    expect(p.volumeThresholds[0]).toMatchObject({ softPct: 85, evictStartPct: 90, evictTargetPct: 80 });

    const refused = await t.api("PUT", "/api/storage/policy", { permitImportantEviction: true });
    expect(refused.status).toBe(400);
    expect(refused.body.details.fields[0].path).toBe("storage.acknowledged");
    expect((await t.api("GET", "/api/storage/policy")).body.permitImportantEviction).toBe(false);

    const ok = await t.api("PUT", "/api/storage/policy", { permitImportantEviction: true, acknowledged: true, orphanGraceSeconds: 60, maxEvictionBatchBytes: 5000 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ permitImportantEviction: true, orphanGraceSeconds: 60, maxEvictionBatchBytes: 5000 });
    expect(ok.body.permitAcknowledgedAt).toEqual(expect.any(String));
    // mirrored into the storage_policies row
    expect(t.svc.db.get("SELECT permit_important_eviction AS p, orphan_grace_seconds AS g FROM storage_policies WHERE scope = 'global'")).toEqual({ p: 1, g: 60 });
    // the generic settings endpoint cannot bypass the acknowledgement
    await t.api("PUT", "/api/storage/policy", { permitImportantEviction: false });
    const bypass = await t.api("PATCH", "/api/settings", { storage: { permitImportantEviction: true } });
    expect(bypass.status).toBe(400);
    const viaSettings = await t.api("PATCH", "/api/settings", { storage: { permitImportantEviction: true, acknowledged: true } });
    expect(viaSettings.status).toBe(200);
    expect(viaSettings.body.warning).toMatch(/Important/);
    // turning it off again clears the acknowledgement
    expect((await t.api("PUT", "/api/storage/policy", { permitImportantEviction: false })).body.permitAcknowledgedAt).toBeNull();
    expect((await t.api("PUT", "/api/storage/policy", { orphanGraceSeconds: -1 })).status).toBe(400);
  });

  it("volume-to-volume migration answers 501 not_implemented", async () => {
    const t = await startStorageTest();
    const v = t.svc.volumes.list()[0]!;
    const r = await t.api("POST", `/api/storage/volumes/${v.publicId}/migrate`, {});
    expect(r.status).toBe(501);
    expect(r.body.error).toBe("not_implemented");
  });

  it("the plan endpoint is a dry run with reasons; prune mode and the volume filter work", async () => {
    const t = await startStorageTest();
    const v = t.svc.volumes.list()[0]!;
    const std = t.seed.source({ priority: 3, retention: { mode: "latest", count: 1 } });
    await t.seed.page({ url: "https://p.test/1", sources: [std], versions: [{ ageDays: 3, blobs: [{ tag: "old", bytes: 100 }] }, { ageDays: 1, blobs: [{ tag: "new", bytes: 100 }] }] });
    const prune = (await t.api("POST", "/api/storage/eviction/plan", { mode: "prune" })).body;
    expect(prune).toMatchObject({ mode: "prune", sufficient: true, itemsTotal: 1 });
    expect(prune.items[0]).toMatchObject({ surplus: true, step: "surplus_versions", priority: "P4", exclusiveBytes: 100 });
    expect(prune.expiresAt > prune.createdAt).toBe(true);
    const withVolume = (await t.api("POST", "/api/storage/eviction/plan", { bytesNeeded: 1, volumeId: v.publicId })).body;
    expect(withVolume.volumeId).toBe(v.publicId);
    expect((await t.api("POST", "/api/storage/eviction/plan", { volumeId: "vol_01HZZZZZZZZZZZZZZZZZZZZZZZ" })).status).toBe(404);
    expect((await t.api("POST", "/api/storage/eviction/run", { planId: "plan_unknown" })).status).toBe(404);
    // running the prune plan is the same as the maintenance run, and the run is on record
    const run = (await t.api("POST", "/api/storage/eviction/run", { planId: prune.planId })).body;
    expect(run).toMatchObject({ evicted: 1 });
    const runs = (await t.api("GET", "/api/storage/eviction/runs")).body.items;
    expect(runs[0]).toMatchObject({ id: run.runId, trigger: "prune", state: "done", versionsEvicted: 1, bytesFreed: 100 });
    // the same plan cannot be run twice
    expect((await t.api("POST", "/api/storage/eviction/run", { planId: prune.planId })).status).toBe(404);
  });

  it("the forecast is always an estimate with bands and assumptions, per source too", async () => {
    const t = await startStorageTest();
    const s = t.seed.source({ priority: 3, name: "Docs" });
    await t.seed.page({ url: "https://f.test/1", sources: [s], versions: [{ blobs: [{ tag: "f", bytes: 2000 }] }] });
    const f = (await t.api("GET", "/api/storage/forecast")).body;
    expect(f).toMatchObject({ estimate: true, horizonDays: 30 });
    expect(f.projectedUsedBytes).toEqual({ low: expect.any(Number), high: expect.any(Number) });
    expect(f.projectedUsedBytes.low).toBeLessThanOrEqual(f.projectedUsedBytes.high);
    expect(f.assumptions.length).toBeGreaterThan(0);
    expect(f.confidence).toBe("low");
    const one = (await t.api("GET", `/api/storage/forecast?sourceId=${(t.svc.db.get<{ p: string }>("SELECT public_id AS p FROM sources WHERE id = ?", [s]))!.p}&horizonDays=90`)).body;
    expect(one).toMatchObject({ estimate: true, horizonDays: 90 });
    expect(one.perSource).toHaveLength(1);
    expect((await t.api("GET", "/api/storage/forecast?sourceId=src_01HZZZZZZZZZZZZZZZZZZZZZZZ")).status).toBe(404);
    expect((await t.api("GET", "/api/storage")).body.forecast.estimate).toBe(true);
  });

  it("'why was this kept?' answers for every copy, and pins, bookmarks and floors lift the priority", async () => {
    const t = await startStorageTest();
    // A real source (created through the API) so that it can be edited later.
    const created = await t.api("POST", "/api/sources", { name: "Cheap", type: "single_page", startUrl: "https://w.test/1", priority: "P4", retention: { mode: "latest", count: 1 } });
    expect(created.status).toBe(201);
    const s = t.svc.db.get<{ id: number }>("SELECT id FROM sources WHERE public_id = ?", [created.body.id])!.id;
    const page = await t.seed.page({ url: "https://w.test/1", sources: [s], versions: [{ ageDays: 4, blobs: [{ tag: "w1", bytes: 100 }] }, { ageDays: 1, blobs: [{ tag: "w2", bytes: 100 }] }] });
    let why = (await t.api("GET", `/api/storage/pages/${page.publicId}`)).body;
    expect(why.page).toMatchObject({ effectivePriority: "P4", cachedPriority: "P4" });
    const [latest, old] = why.versions;
    expect(latest).toMatchObject({ isLatest: true, priority: 4, decision: "evictable" });
    expect(old).toMatchObject({ surplus: true, decision: "evictable" });
    expect(latest.references[0]).toMatchObject({ kind: "source", label: "Cheap", retains: true });

    const pin = await t.api("PUT", `/api/storage/pages/${page.publicId}/pin`, { priority: "P1", reason: "My thesis" });
    expect(pin.status).toBe(200);
    expect(pin.body.pin).toEqual({ priority: "P1", reason: "My thesis" });
    why = pin.body;
    expect(why.page).toMatchObject({ effectivePriority: "P1", cachedPriority: "P1" });
    expect(why.versions[0]).toMatchObject({ decision: "kept", skipReason: "p1" });
    expect(why.versions[0].reasons.join(" ")).toMatch(/never removed automatically/);
    expect(t.svc.db.get<{ p: number }>("SELECT effective_priority AS p FROM pages WHERE id = ?", [page.pageId])!.p).toBe(1);

    const un = await t.api("DELETE", `/api/storage/pages/${page.publicId}/pin`);
    expect(un.body.pin).toBeNull();
    expect(t.svc.db.get<{ p: number }>("SELECT effective_priority AS p FROM pages WHERE id = ?", [page.pageId])!.p).toBe(4);

    // a bookmark references the page at the configured priority (default 2)
    const bm = await t.api("POST", "/api/bookmarks", { url: "https://w.test/1" });
    expect(bm.status).toBe(201);
    expect(t.svc.db.get<{ p: number }>("SELECT effective_priority AS p FROM pages WHERE id = ?", [page.pageId])!.p).toBe(2);
    await t.api("DELETE", `/api/bookmarks/${bm.body.id}`);
    expect(t.svc.db.get<{ p: number }>("SELECT effective_priority AS p FROM pages WHERE id = ?", [page.pageId])!.p).toBe(4);

    // raising the source priority recomputes the cached priority of its pages
    const srcPublic = t.svc.db.get<{ p: string }>("SELECT public_id AS p FROM sources WHERE id = ?", [s])!.p;
    const patched = await t.api("PATCH", `/api/sources/${srcPublic}`, { priority: "P2" });
    expect(patched.status).toBe(200);
    expect(t.svc.db.get<{ p: number }>("SELECT effective_priority AS p FROM pages WHERE id = ?", [page.pageId])!.p).toBe(2);
    expect(t.svc.db.get<{ r: number }>("SELECT retained AS r FROM page_versions WHERE id = ?", [page.versionIds[0]])!.r).toBe(0); // the older copy is surplus
    expect((await t.api("GET", "/api/storage/pages/pg_01HZZZZZZZZZZZZZZZZZZZZZZZ")).status).toBe(404);
    expect((await t.api("GET", "/api/storage/pages/not-an-id")).status).toBe(400);
  });

  it("the audit list can be filtered by page and kind", async () => {
    const t = await startStorageTest();
    const s = t.seed.source({ priority: 4 });
    const a = await t.seed.page({ url: "https://au.test/a", sources: [s], versions: [{ blobs: [{ tag: "au-a", bytes: 100 }] }] });
    await t.seed.page({ url: "https://au.test/b", sources: [s], versions: [{ blobs: [{ tag: "au-b", bytes: 100 }] }] });
    const plan = t.svc.storage.planAndStore({ bytesNeeded: 150, incomingPriority: 1 });
    await t.svc.storage.runPlan(plan.planId);
    const all = (await t.api("GET", "/api/storage/audit")).body;
    expect(all.items).toHaveLength(2);
    expect(all.items[0]).toMatchObject({ kind: "evicted", trigger: "manual", priority: "P4", surplus: false });
    expect(all.items[0].reason.length).toBeGreaterThan(10);
    const one = (await t.api("GET", `/api/storage/audit?pageId=${a.publicId}`)).body;
    expect(one.items).toHaveLength(1);
    expect((await t.api("GET", "/api/storage/audit?kind=deleted")).body.items).toEqual([]);
    expect((await t.api("GET", "/api/storage/audit?limit=1")).body.nextCursor).toEqual(expect.any(String));
  });

  it("the overview, usage and dashboard agree on the numbers", async () => {
    const t = await startStorageTest({ quotaBytes: 1_000_000 });
    const s = t.seed.source({ priority: 2 });
    await t.seed.page({ url: "https://o.test/1", sources: [s], versions: [{ blobs: [{ tag: "o", bytes: 600 }] }] });
    const overview = (await t.api("GET", "/api/storage")).body;
    expect(overview.volumes).toHaveLength(1);
    expect(overview.totals.usedBytes).toBe(600);
    expect(overview.usageByPriority.find((i: { key: string }) => i.key === "P2")).toMatchObject({ exclusiveBytes: 600 });
    expect(overview.eviction).toMatchObject({ autoEviction: true, throttling: false, overThreshold: [] });
    const dash = (await t.api("GET", "/api/system/dashboard")).body;
    expect(dash.storage.byPriority).toEqual({ P1: 0, P2: 600, P3: 0, P4: 0 });
    expect(dash.pages).toMatchObject({ total: 1, archived: 1, evicted: 0 });
    expect(dash.sources.total).toBeGreaterThanOrEqual(1);
  });

  it("automatic eviction above the start threshold brings the volume down to its target, and does nothing when switched off", async () => {
    const t = await startStorageTest({ quotaBytes: 10_000 });
    await t.svc.volumes.update(t.svc.volumes.list()[0]!.publicId, { thresholds: { softPct: 70, evictStartPct: 90, evictTargetPct: 60 } });
    const keep = t.seed.source({ priority: 1, retention: { mode: "all" } });
    const std = t.seed.source({ priority: 3 });
    await t.seed.page({ url: "https://a.test/keep", sources: [keep], versions: [{ blobs: [{ tag: "keep", bytes: 4000 }] }] });
    const pages = [];
    for (let i = 0; i < 6; i++) pages.push(await t.seed.page({ url: `https://a.test/${i}`, sources: [std], versions: [{ ageDays: 6 - i, blobs: [{ tag: `s${i}`, bytes: 1000 }] }] }));
    // 10 000 of 10 000 used: over 90%. Target 60% = 6 000 bytes, so 4 000 must go: four Standard pages.
    t.svc.settings.patch({ storage: { autoEviction: false } });
    await t.svc.storage.tick();
    expect(t.svc.volumes.usedBytes(t.svc.volumes.list()[0]!.id)).toBe(10_000);
    t.svc.settings.patch({ storage: { autoEviction: true } });
    const { notes } = await t.svc.storage.tick();
    expect(notes).toEqual([]);
    expect(t.svc.volumes.usedBytes(t.svc.volumes.list()[0]!.id)).toBeLessThanOrEqual(6000);
    expect(t.seed.versionStatus(pages.at(-1)!.versionIds[0]!)).toBe("ready");
    const run = t.svc.db.get<{ trigger: string; versions_evicted: number }>("SELECT trigger, versions_evicted FROM eviction_runs ORDER BY id DESC LIMIT 1")!;
    expect(run).toEqual({ trigger: "threshold", versions_evicted: 4 });
  });

  it("over the threshold with nothing eligible: the pass reports it and removes nothing", async () => {
    const t = await startStorageTest({ quotaBytes: 10_000 });
    const keep = t.seed.source({ priority: 1, retention: { mode: "all" } });
    await t.seed.page({ url: "https://a.test/keep", sources: [keep], versions: [{ blobs: [{ tag: "keep", bytes: 9500 }] }] });
    const { notes } = await t.svc.storage.tick();
    expect(notes[0]).toMatch(/nothing eligible/);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM storage_audit")!.n).toBe(0);
  });
});
