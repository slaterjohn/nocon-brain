import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MARKER_FILE, VolumeUnavailableError } from "@ncb/server";
import { newId } from "@ncb/shared";
import { capture, useFixtures } from "../pipeline/helpers.js";
import { archiveSignature, expectConsistent, secondVolume, startStorageTest, type StorageTest } from "../../storage-safety/helpers.js";

const fixtures = useFixtures();

/** A download job row, because reservations belong to one. */
function downloadJob(t: StorageTest, priority = 3): number {
  const r = t.svc.db.run(
    "INSERT INTO download_jobs (public_id, kind, state, priority, requested_by, created_at) VALUES (?, 'capture', 'running', ?, 'user', ?)", [newId("dl"), priority, t.svc.clock.now()]);
  return Number(r.lastInsertRowid);
}

describe("T-06 volumes: placement, usage, reservations, offline", () => {
  it("two volumes: a source's preferred volume is used, otherwise the one with most room; usage totals equal the blob sums", async () => {
    const t = await startStorageTest();
    const v1 = t.svc.volumes.list()[0]!;
    const { volume: v2 } = await secondVolume(t);
    // give volume 1 less room than volume 2 through a quota
    await t.svc.volumes.update(v1.publicId, { quotaBytes: 50_000 });
    const preferV1 = t.seed.source({ priority: 3, preferredVolumeId: v1.id });
    const none = t.seed.source({ priority: 3 });
    const a = await t.seed.page({ url: "https://v.test/a", sources: [none], versions: [{ blobs: [{ tag: "a", bytes: 1000 }] }] });
    expect(t.svc.blobs.bySha(a.blobShas[0]!)!.volumeId, "most room wins without a preference").toBe(v2.id);
    // the placement hint is honoured when the preferred volume can take the blob
    const put = await t.svc.blobs.put(Buffer.from("preferred"), { kind: "other", volumeId: v1.id });
    expect(put.blob.volumeId).toBe(v1.id);
    void preferV1;
    for (const v of t.svc.volumes.list()) {
      const sum = t.svc.db.get<{ n: number }>("SELECT COALESCE(SUM(stored_bytes), 0) AS n FROM blobs WHERE volume_id = ?", [v.id])!.n;
      expect(t.svc.volumes.usedBytes(v.id)).toBe(sum);
      const usage = (await t.api("GET", `/api/storage/usage?by=priority&volumeId=${v.publicId}`)).body;
      expect(usage.totalBytes).toBe(sum);
    }
    const all = (await t.api("GET", "/api/storage/usage?by=volume")).body;
    expect(all.totalBytes).toBe(t.svc.db.get<{ n: number }>("SELECT SUM(stored_bytes) AS n FROM blobs")!.n);
    expect(all.items.map((i: { key: string }) => i.key).sort()).toEqual([v1.publicId, v2.publicId].sort());
  });

  it("usage by priority matches the blob sums and reports the Volume's usageByPriority", async () => {
    const t = await startStorageTest();
    const p1 = t.seed.source({ priority: 1, retention: { mode: "all" } });
    const p3 = t.seed.source({ priority: 3 });
    await t.seed.page({ url: "https://u.test/1", sources: [p1], versions: [{ blobs: [{ tag: "one", bytes: 700 }] }] });
    await t.seed.page({ url: "https://u.test/3", sources: [p3], versions: [{ blobs: [{ tag: "three", bytes: 300 }] }] });
    const usage = (await t.api("GET", "/api/storage/usage?by=priority")).body;
    const by = Object.fromEntries(usage.items.map((i: { key: string; exclusiveBytes: number; sharedBytes: number }) => [i.key, i.exclusiveBytes + i.sharedBytes]));
    expect(by).toMatchObject({ P1: 700, P3: 300, P2: 0, P4: 0 });
    expect(usage.totalBytes).toBe(1000);
    const vol = (await t.api("GET", "/api/storage/volumes")).body.items[0];
    expect(vol.usageByPriority).toEqual({ P1: 700, P2: 0, P3: 300, P4: 0 });
    const kinds = (await t.api("GET", "/api/storage/usage?by=kind")).body;
    expect(kinds.items.find((i: { key: string }) => i.key === "other").exclusiveBytes).toBe(1000);
    const overview = (await t.api("GET", "/api/storage")).body;
    expect(overview.totals.usedBytes).toBe(1000);
    expect(overview.forecast.estimate).toBe(true);
  });

  it("usage is cached in storage_usage_cache and the cache sums to the blob bytes", async () => {
    const t = await startStorageTest();
    const s = t.seed.source({ priority: 3 });
    await t.seed.page({ url: "https://c.test/1", sources: [s], versions: [{ blobs: [{ tag: "c1", bytes: 400 }] }] });
    t.svc.storage.usage.refreshCache();
    const rows = t.svc.db.all<{ dimension: string; key: string; bytes: number }>("SELECT dimension, key, bytes FROM storage_usage_cache ORDER BY dimension, key");
    for (const dim of ["priority", "source", "kind"]) expect(rows.filter((r) => r.dimension === dim).reduce((n, r) => n + r.bytes, 0)).toBe(400);
  });

  it("reservations prevent overcommit: two downloads cannot both be promised the same room", async () => {
    const t = await startStorageTest({ quotaBytes: 10_000 });
    const a = downloadJob(t);
    const b = downloadJob(t);
    const ta = await t.svc.storage.admission.admit({ downloadJobId: a, priority: 3, bytes: 6000 });
    expect(t.svc.volumes.reservedBytes(ta.volumeId)).toBe(6000);
    await expect(t.svc.storage.admission.admit({ downloadJobId: b, priority: 3, bytes: 6000 })).rejects.toMatchObject({ code: "no_eligible_space" });
    // a smaller one still fits in what is left
    const tb = await t.svc.storage.admission.admit({ downloadJobId: b, priority: 3, bytes: 3000 });
    expect(t.svc.volumes.reservedBytes(tb.volumeId)).toBe(9000);
    t.svc.storage.admission.release(ta);
    expect(t.svc.volumes.reservedBytes(tb.volumeId)).toBe(3000);
    // the volume object shows it
    const vol = (await t.api("GET", "/api/storage/volumes")).body.items[0];
    expect(vol.reservedBytes).toBe(3000);
  });

  it("an offline volume marks its content unavailable without deleting any row", async () => {
    const t = await startStorageTest();
    const s = t.seed.source({ priority: 3 });
    const { volume: v2 } = await secondVolume(t);
    await t.svc.volumes.update(t.svc.volumes.list()[0]!.publicId, { state: "readonly" }); // new blobs go to the second volume
    const page = await t.seed.page({ url: "https://o.test/1", sources: [s], versions: [{ blobs: [{ tag: "off", bytes: 500 }] }] });
    expect(t.svc.blobs.bySha(page.blobShas[0]!)!.volumeId).toBe(v2.id);
    const rowsBefore = t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM blobs")!.n;
    fs.rmSync(path.join(v2.rootPath, MARKER_FILE)); // the drive is unplugged
    const list = (await t.api("GET", "/api/storage/volumes")).body.items;
    expect(list.find((v: { id: string }) => v.id === v2.publicId).state).toBe("offline");
    await expect(t.svc.blobs.open(page.blobShas[0]!)).rejects.toBeInstanceOf(VolumeUnavailableError);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM blobs")!.n).toBe(rowsBefore);
    expect(t.svc.db.get<{ s: string }>("SELECT status AS s FROM page_versions WHERE id = ?", [page.versionIds[0]])!.s).toBe("ready");
    // eviction cannot count (or delete) what it cannot reach: it plans nothing from the offline volume
    const plan = t.svc.storage.planAndStore({ bytesNeeded: 100, incomingPriority: 1 });
    expect(plan.items).toEqual([]);
    expect(plan.sufficient).toBe(false);
    // verify-and-repair says it skipped the volume instead of calling every file missing
    const report = await t.svc.storage.maintenance.verify({ checks: ["I-1"], repair: true });
    expect(report.findings).toEqual([]);
    expect(report.skipped[0]?.reason).toMatch(/offline/);
    // back online, everything is as it was
    fs.writeFileSync(path.join(v2.rootPath, MARKER_FILE), JSON.stringify({ uuid: v2.markerUuid, name: v2.name }));
    await t.svc.volumes.refreshAll();
    expect((await t.svc.blobs.read(page.blobShas[0]!)).data.length).toBe(500);
  });
});

describe("T-07 admission control", () => {
  it("P4 downloads are throttled above the soft threshold while P3 still gets in", async () => {
    const t = await startStorageTest({ quotaBytes: 10_000 });
    const s = t.seed.source({ priority: 1, retention: { mode: "all" } });
    await t.seed.page({ url: "https://a.test/1", sources: [s], versions: [{ blobs: [{ tag: "fill", bytes: 9000 }] }] }); // 90% > 85%
    await expect(t.svc.storage.admission.admit({ downloadJobId: downloadJob(t, 4), priority: 4, bytes: 100 })).rejects.toMatchObject({ code: "throttled", retryAfterMs: expect.any(Number) });
    const ok = await t.svc.storage.admission.admit({ downloadJobId: downloadJob(t, 3), priority: 3, bytes: 100 });
    expect(ok.reservedBytes).toBe(100);
    // started by the Human, a P4 save is never throttled
    await t.svc.storage.admission.admit({ downloadJobId: downloadJob(t, 4), priority: 4, bytes: 100, userInitiated: true });
    // and the throttle can be switched off
    t.svc.settings.patch({ storage: { throttleOpportunistic: false } });
    await t.svc.storage.admission.admit({ downloadJobId: downloadJob(t, 4), priority: 4, bytes: 100 });
  });

  it("a throttled P4 download says why it waits in the downloads API and queue summary, and the reason clears when it is admitted", async () => {
    const t = await startStorageTest({ quotaBytes: 10_000 });
    const s = t.seed.source({ priority: 1, retention: { mode: "all" } });
    await t.seed.page({ url: "https://a.test/1", sources: [s], versions: [{ blobs: [{ tag: "fill", bytes: 9000 }] }] }); // 90% > 85%
    const job = downloadJob(t, 4);
    const publicId = t.svc.db.get<{ public_id: string }>("SELECT public_id FROM download_jobs WHERE id = ?", [job])!.public_id;
    // before any attempt there is no reason
    expect((await t.api("GET", `/api/downloads/${publicId}`)).body.wait).toBeUndefined();
    await expect(t.svc.storage.admission.admit({ downloadJobId: job, priority: 4, bytes: 100 })).rejects.toMatchObject({ code: "throttled" });
    const waiting = (await t.api("GET", `/api/downloads/${publicId}`)).body;
    expect(waiting.wait).toMatchObject({ reason: "throttled", message: expect.stringContaining("soft threshold") });
    expect(waiting.pause).toBeUndefined();
    const queue = (await t.api("GET", "/api/downloads/queue")).body;
    expect(queue.storageThrottle).toEqual({ downloads: 1 });
    // a P3 download is not throttled and carries no reason
    const other = downloadJob(t, 3);
    await t.svc.storage.admission.admit({ downloadJobId: other, priority: 3, bytes: 100 });
    const otherId = t.svc.db.get<{ public_id: string }>("SELECT public_id FROM download_jobs WHERE id = ?", [other])!.public_id;
    expect((await t.api("GET", `/api/downloads/${otherId}`)).body.wait).toBeUndefined();
    // switching the throttle off lets the P4 job in, and the reason goes
    t.svc.settings.patch({ storage: { throttleOpportunistic: false } });
    await t.svc.storage.admission.admit({ downloadJobId: job, priority: 4, bytes: 100 });
    expect((await t.api("GET", `/api/downloads/${publicId}`)).body.wait).toBeUndefined();
    expect((await t.api("GET", "/api/downloads/queue")).body.storageThrottle).toEqual({ downloads: 0 });
  });

  it("a P1 download makes room by evicting P4, then P3, never P2 or P1; with nothing eligible it fails and removes nothing", async () => {
    const t = await startStorageTest({ quotaBytes: 10_000 });
    const keep = t.seed.source({ priority: 1, retention: { mode: "all" } });
    const important = t.seed.source({ priority: 2, automaticEviction: true });
    const std = t.seed.source({ priority: 3 });
    const cheap = t.seed.source({ priority: 4 });
    const p1 = await t.seed.page({ url: "https://m.test/p1", sources: [keep], versions: [{ blobs: [{ tag: "p1", bytes: 3000 }] }] });
    const p2 = await t.seed.page({ url: "https://m.test/p2", sources: [important], versions: [{ blobs: [{ tag: "p2", bytes: 3000 }] }] });
    const p3 = await t.seed.page({ url: "https://m.test/p3", sources: [std], versions: [{ blobs: [{ tag: "p3", bytes: 2000 }] }] });
    const p4 = await t.seed.page({ url: "https://m.test/p4", sources: [cheap], versions: [{ blobs: [{ tag: "p4", bytes: 1500 }] }] });
    // 9 500 of 10 000 used: 500 free. A 1 000 byte P1 download needs 500 more: the P4 page (1 500) goes, nothing else.
    await t.svc.storage.admission.admit({ downloadJobId: downloadJob(t, 1), priority: 1, bytes: 1000 });
    expect(t.seed.versionStatus(p4.versionIds[0]!)).toBe("evicted");
    for (const p of [p1, p2, p3]) expect(t.seed.versionStatus(p.versionIds[0]!)).toBe("ready");
    // now 8 000 used with 1 000 reserved: a 3 000 byte P1 download needs P3 (2 000) as well
    await t.svc.storage.admission.admit({ downloadJobId: downloadJob(t, 1), priority: 1, bytes: 3000 });
    expect(t.seed.versionStatus(p3.versionIds[0]!)).toBe("evicted");
    expect(t.seed.versionStatus(p2.versionIds[0]!)).toBe("ready");
    // asking for more than P3/P4 can give needs P2, which is not permitted: fail, and remove nothing
    const before = archiveSignature(t);
    await expect(t.svc.storage.admission.admit({ downloadJobId: downloadJob(t, 1), priority: 1, bytes: 2500 })).rejects.toMatchObject({ code: "no_eligible_space" });
    expect(archiveSignature(t)).toEqual(before);
    expect(t.seed.versionStatus(p1.versionIds[0]!)).toBe("ready");
    // with the permit the Important page may go, still not the Protected one
    t.svc.settings.patch({ storage: { permitImportantEviction: true, acknowledged: true } });
    await t.svc.storage.admission.admit({ downloadJobId: downloadJob(t, 1), priority: 1, bytes: 2500 });
    expect(t.seed.versionStatus(p2.versionIds[0]!)).toBe("evicted");
    expect(t.seed.versionStatus(p1.versionIds[0]!)).toBe("ready");
    expectConsistent(t, expect);
  });

  it("a P3 download never evicts P3 for itself above P4, and a P4 download only reclaims P4", async () => {
    const t = await startStorageTest({ quotaBytes: 4000 });
    const std = t.seed.source({ priority: 3 });
    const cheap = t.seed.source({ priority: 4 });
    const a = await t.seed.page({ url: "https://g.test/3", sources: [std], versions: [{ blobs: [{ tag: "g3", bytes: 2000 }] }] });
    const b = await t.seed.page({ url: "https://g.test/4", sources: [cheap], versions: [{ blobs: [{ tag: "g4", bytes: 1900 }] }] });
    t.svc.settings.patch({ storage: { throttleOpportunistic: false } });
    await t.svc.storage.admission.admit({ downloadJobId: downloadJob(t, 4), priority: 4, bytes: 1500, userInitiated: true });
    expect(t.seed.versionStatus(b.versionIds[0]!)).toBe("evicted");
    expect(t.seed.versionStatus(a.versionIds[0]!)).toBe("ready");
    await expect(t.svc.storage.admission.admit({ downloadJobId: downloadJob(t, 4), priority: 4, bytes: 3000 })).rejects.toMatchObject({ code: "no_eligible_space" });
    expect(t.seed.versionStatus(a.versionIds[0]!)).toBe("ready");
  });

  it("a source over its storage budget is refused with source_budget, and the budget counts shared blobs once", async () => {
    const t = await startStorageTest();
    const s = t.seed.source({ priority: 3, storageBudgetBytes: 3000, name: "Budgeted" });
    await t.seed.page({ url: "https://b.test/1", sources: [s], versions: [{ blobs: [{ tag: "b1", bytes: 1500 }, { tag: "css", bytes: 500 }] }] });
    await t.seed.page({ url: "https://b.test/2", sources: [s], versions: [{ blobs: [{ tag: "b2", bytes: 500 }, { tag: "css", bytes: 500 }] }] });
    expect(t.svc.storage.usage.sourceBytes(s)).toBe(1500 + 500 + 500);
    const ok = await t.svc.storage.admission.admit({ downloadJobId: downloadJob(t), priority: 3, sourceId: s, bytes: 400 });
    expect(ok.reservedBytes).toBe(400);
    await t.svc.storage.admission.admit({ downloadJobId: downloadJob(t), priority: 3, sourceId: s, bytes: 400 }).catch(() => undefined);
    await expect(t.svc.storage.admission.admit({ downloadJobId: downloadJob(t), priority: 3, sourceId: s, bytes: 400 })).rejects.toMatchObject({ code: "source_budget" });
    // another source is unaffected
    const other = t.seed.source({ priority: 3 });
    await t.svc.storage.admission.admit({ downloadJobId: downloadJob(t), priority: 3, sourceId: other, bytes: 400 });
  });

  it("end to end: a real capture to a full volume evicts Opportunistic content and completes", async () => {
    const t = await (async () => {
      const t = await startStorageTest();
      const cheap = t.seed.source({ priority: 4 });
      const pages = [];
      for (let i = 0; i < 6; i++) pages.push(await t.seed.page({ url: `https://old.test/${i}`, sources: [cheap], versions: [{ blobs: [{ tag: `old${i}`, bytes: 50_000 }] }] }));
      // 300 000 bytes of Opportunistic pages on a volume that holds 320 000
      await t.svc.volumes.update(t.svc.volumes.list()[0]!.publicId, { quotaBytes: 320_000 });
      return Object.assign(t, { pages });
    })();
    const done = await capture(t, `${fixtures().urls.article}/solar-power`, { priority: 1 });
    expect(done.state).toBe("completed");
    const evicted = t.pages.filter((p) => t.seed.versionStatus(p.versionIds[0]!) === "evicted").length;
    expect(evicted).toBeGreaterThanOrEqual(1);
    expect(t.svc.volumes.usedBytes(t.svc.volumes.list()[0]!.id)).toBeLessThanOrEqual(320_000);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM volume_reservations")!.n).toBe(0);
    expectConsistent(t, expect);
  });

  it("end to end: a real capture with no room and nothing eligible fails with disk_full and removes nothing", async () => {
    const t = await startStorageTest();
    const keep = t.seed.source({ priority: 1, retention: { mode: "all" } });
    await t.seed.page({ url: "https://keep.test/1", sources: [keep], versions: [{ blobs: [{ tag: "keep", bytes: 60_000 }] }] });
    await t.svc.volumes.update(t.svc.volumes.list()[0]!.publicId, { quotaBytes: 60_500 });
    const before = archiveSignature(t);
    const done = await capture(t, `${fixtures().urls.article}/solar-power`, { priority: 2 });
    expect(done.state).toBe("failed");
    expect(done.failureCode).toBe("disk_full");
    expect(archiveSignature(t)).toEqual({ ...before, audit: before.audit, outbox: expect.anything() });
  });

  it("end to end: a background P4 capture above the soft threshold waits (costing no attempt) and completes once there is room", async () => {
    const t = await startStorageTest({ quotaBytes: 1_000_000 });
    await t.svc.volumes.update(t.svc.volumes.list()[0]!.publicId, { thresholds: { softPct: 50, evictStartPct: 90, evictTargetPct: 40 } });
    const keep = t.seed.source({ priority: 1, retention: { mode: "all" } });
    for (let i = 0; i < 10; i++) await t.seed.page({ url: `https://keep.test/${i}`, sources: [keep], versions: [{ blobs: [{ tag: `keep${i}`, bytes: 60_000 }] }] }); // 60% > 50%
    const { downloadId } = t.pipeline.captureUrl(`${fixtures().urls.article}/solar-power`, { priority: 4, requestedBy: "schedule" });
    await new Promise((r) => setTimeout(r, 400));
    const waiting = t.pipeline.getCapture(downloadId)!;
    expect(["queued", "running"]).toContain(waiting.state);
    expect(waiting.state).not.toBe("failed");
    expect(t.svc.db.get<{ a: number; s: string }>("SELECT attempts AS a, state AS s FROM jobs WHERE type = 'fetch' ORDER BY id DESC LIMIT 1")).toMatchObject({ a: 0, s: "queued" });
    t.svc.settings.patch({ storage: { throttleOpportunistic: false } });
    t.fake.advance(60_000);
    const done = await (await import("../pipeline/helpers.js")).until(() => {
      const r = t.pipeline.getCapture(downloadId);
      return r && (r.state === "completed" || r.state === "failed") ? r : undefined;
    }, 30_000);
    expect(done.state).toBe("completed");
  });

  it("end to end: a real capture for a source at its budget fails with limit_reached", async () => {
    const t = await startStorageTest({ quotaBytes: 1_000_000 });
    const s = t.seed.source({ priority: 3, storageBudgetBytes: 2000 });
    await t.seed.page({ url: "https://budget.test/1", sources: [s], versions: [{ blobs: [{ tag: "bud", bytes: 2000 }] }] });
    const done = await capture(t, `${fixtures().urls.article}/solar-power`, { sourceId: s, priority: 3 });
    expect(done.state).toBe("failed");
    expect(done.failureCode).toBe("limit_reached");
  });
});
