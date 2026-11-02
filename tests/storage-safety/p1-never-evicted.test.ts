import { describe, expect, it } from "vitest";
import { expectConsistent, startStorageTest } from "./helpers.js";

/**
 * Non-negotiable: Protected (P1) content is never evicted automatically, whatever the flags, policy, mode, incoming priority or
 * state of the cached columns. The pure planner is covered by truth-table and property tests in packages/storage-planner/test; here the
 * same rule is checked against a real database, the real executor and the real admission control.
 */
describe("P1 is never automatically evicted", () => {
  async function archive(opts: { p1AutoEvict: boolean }) {
    const t = await startStorageTest();
    const p1 = t.seed.source({ name: "P1 source", priority: 1, retention: { mode: "latest", count: 1 }, automaticEviction: opts.p1AutoEvict });
    const p2 = t.seed.source({ name: "P2 source", priority: 2, automaticEviction: true });
    const p4 = t.seed.source({ name: "P4 source", priority: 4, automaticEviction: true });
    const protectedPage = await t.seed.page({ url: "https://p1.test/a", sources: [p1], versions: [{ ageDays: 9, blobs: [{ tag: "p1-old", bytes: 700 }] }, { ageDays: 1, blobs: [{ tag: "p1-new", bytes: 900 }] }] });
    const important = await t.seed.page({ url: "https://p2.test/a", sources: [p2], versions: [{ blobs: [{ tag: "p2", bytes: 800 }] }] });
    const cheap = await t.seed.page({ url: "https://p4.test/a", sources: [p4], versions: [{ blobs: [{ tag: "p4", bytes: 600 }] }] });
    const pinned = await t.seed.page({ url: "https://pin.test/a", sources: [p4], pin: 1, versions: [{ blobs: [{ tag: "pin", bytes: 500 }] }] });
    const bookmarked = await t.seed.page({ url: "https://bm.test/a", sources: [p4], bookmark: 1, versions: [{ blobs: [{ tag: "bm", bytes: 500 }] }] });
    const floored = await t.seed.page({ url: "https://floor.test/a", sources: [p4], collectionFloor: 1, versions: [{ blobs: [{ tag: "floor", bytes: 500 }] }] });
    return { t, protectedPage, important, cheap, pinned, bookmarked, floored };
  }

  for (const autoEvict of [true, false]) {
    for (const permit of [false, true]) {
      it(`P1 source with automaticEviction=${autoEvict}, P2 permit=${permit}: asking for far more space than exists removes no P1 current copy`, async () => {
        const { t, protectedPage, important, cheap, pinned, bookmarked, floored } = await archive({ p1AutoEvict: autoEvict });
        if (permit) t.svc.settings.patch({ storage: { permitImportantEviction: true, acknowledged: true } });
        for (const incoming of [1, 2, 3, 4] as const) {
          const plan = t.svc.storage.planAndStore({ bytesNeeded: 10_000_000, incomingPriority: incoming });
          expect(plan.sufficient).toBe(false); // there is never enough, so nothing must be removed
          await expect(t.svc.storage.runPlan(plan.planId)).rejects.toMatchObject({ code: "conflict" });
        }
        // a pressure run that does fit (everything non-protected that may go) still leaves every P1 copy
        const plan = t.svc.storage.planAndStore({ bytesNeeded: 1, incomingPriority: 1 });
        await t.svc.storage.runPlan(plan.planId);
        await t.svc.storage.runMaintenanceEviction();
        for (const p of [protectedPage, pinned, bookmarked, floored]) {
          expect(t.seed.versionStatus(p.versionIds.at(-1)!), `current copy of ${p.publicId}`).toBe("ready");
          for (const sha of p.blobShas.slice(p.blobShas.length > 1 ? 1 : 0)) expect(t.seed.blobExists(sha)).toBe(true);
        }
        expect(t.seed.versionStatus(protectedPage.versionIds[1]!)).toBe("ready");
        // the P2 page goes only with the permit; the P4 page may go either way
        if (!permit) expect(t.seed.versionStatus(important.versionIds[0]!)).toBe("ready");
        void cheap;
        expectConsistent(t, expect);
        const p1Audit = t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM storage_audit WHERE kind = 'evicted' AND priority = 1 AND surplus = 0")!.n;
        expect(p1Audit).toBe(0);
        expect((await t.svc.storage.maintenance.verify({ checks: ["I-13"] })).findings).toEqual([]);
      });
    }
  }

  it("automaticEviction=true on a P1 source permits eviction of its surplus versions only; with false not even those", async () => {
    for (const autoEvict of [true, false]) {
      const { t, protectedPage } = await archive({ p1AutoEvict: autoEvict });
      const plan = t.svc.storage.planAndStore({ bytesNeeded: 600, incomingPriority: 1 });
      const planned = plan.items.map((i) => i.versionId);
      expect(planned.includes(protectedPage.versionPublicIds[0]!)).toBe(autoEvict); // the old copy: surplus under latest(1)
      expect(planned.includes(protectedPage.versionPublicIds[1]!)).toBe(false); // the current copy: P1
      await t.svc.storage.runPlan(plan.planId).catch(() => undefined);
      expect(t.seed.versionStatus(protectedPage.versionIds[1]!)).toBe("ready");
      expect(t.seed.versionStatus(protectedPage.versionIds[0]!)).toBe(autoEvict ? "evicted" : "ready");
    }
  });

  it("a forged plan that names a P1 version is refused by the executor, which re-derives from the references", async () => {
    const { t, protectedPage, pinned } = await archive({ p1AutoEvict: true });
    const base = t.svc.storage.buildPlan({ bytesNeeded: 100, incomingPriority: 1 }).plan;
    const forged = {
      ...base, mode: "pressure" as const, sufficient: true,
      items: [protectedPage, pinned].map((p) => ({
        versionId: p.versionIds.at(-1)!, versionNo: 1, pageId: p.pageId, pageUrl: "https://forged.test", priority: 4 as const, surplus: false, isLatest: true,
        step: "p4" as const, exclusiveBytes: 1000, soloExclusiveBytes: 1000, lastAccessedAt: null, reason: "forged",
      })),
      unreferencedBlobs: [],
    };
    const r = await t.svc.storage.executor.execute(forged, { trigger: "manual" });
    expect(r.evicted).toBe(0);
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(["p1", "p1"]);
    for (const p of [protectedPage, pinned]) expect(t.seed.versionStatus(p.versionIds.at(-1)!)).toBe("ready");
    expectConsistent(t, expect);
  });

  it("a stale cached priority never decides: the executor and the planner use the reference rows", async () => {
    const { t, protectedPage } = await archive({ p1AutoEvict: true });
    t.svc.db.run("UPDATE pages SET effective_priority = 4 WHERE id = ?", [protectedPage.pageId]);
    t.svc.db.run("UPDATE page_versions SET retained = 0 WHERE page_id = ?", [protectedPage.pageId]);
    const plan = t.svc.storage.planAndStore({ bytesNeeded: 10_000, incomingPriority: 1 });
    expect(plan.items.some((i) => i.versionId === protectedPage.versionPublicIds[1])).toBe(false);
    await t.svc.storage.runMaintenanceEviction();
    expect(t.seed.versionStatus(protectedPage.versionIds[1]!)).toBe("ready");
  });

  it("disabling a P1 source never makes its content evictable, and a soft-deleted one stops protecting", async () => {
    const t = await startStorageTest();
    const src = t.seed.source({ priority: 1, retention: { mode: "all" }, automaticEviction: true, enabled: false });
    const page = await t.seed.page({ url: "https://p1.test/disabled", sources: [src], versions: [{ blobs: [{ tag: "d", bytes: 400 }] }] });
    expect(t.svc.storage.planAndStore({ bytesNeeded: 100, incomingPriority: 1 }).items).toEqual([]);
    t.svc.db.run("UPDATE sources SET deleted_at = ? WHERE id = ?", [t.svc.clock.now(), src]);
    const plan = t.svc.storage.planAndStore({ bytesNeeded: 100, incomingPriority: 1 });
    expect(plan.items.map((i) => i.versionId)).toEqual([page.versionPublicIds[0]]); // no active reference: surplus, P4
  });
});
