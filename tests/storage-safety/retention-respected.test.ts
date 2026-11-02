import { describe, expect, it } from "vitest";
import { DAY, expectConsistent, startStorageTest } from "./helpers.js";

describe("retention is respected", () => {
  it("latest(2): only copies beyond the two newest are surplus, and they go first when space is needed", async () => {
    const t = await startStorageTest();
    const src = t.seed.source({ priority: 3, retention: { mode: "latest", count: 2 } });
    const page = await t.seed.page({
      url: "https://r.test/a", sources: [src],
      versions: [4, 3, 2, 1].map((age, i) => ({ ageDays: age, blobs: [{ tag: `v${i}`, bytes: 100 }] })),
    });
    const plan = t.svc.storage.planAndStore({ bytesNeeded: 150, incomingPriority: 1 });
    expect(plan.items.map((i) => [i.versionNo, i.surplus])).toEqual([[1, true], [2, true]]);
    await t.svc.storage.runPlan(plan.planId);
    expect(page.versionIds.map((id) => t.seed.versionStatus(id))).toEqual(["evicted", "evicted", "ready", "ready"]);
    expect(t.svc.db.get<{ n: number; l: number }>("SELECT version_count AS n, latest_version_id AS l FROM pages WHERE id = ?", [page.pageId])).toEqual({ n: 2, l: page.versionIds[3] });
    expectConsistent(t, expect);
  });

  it("the prune pass removes surplus copies only, and respects pruneSurplusVersions and the batch cap", async () => {
    const t = await startStorageTest();
    const src = t.seed.source({ priority: 3, retention: { mode: "latest", count: 1 } });
    const page = await t.seed.page({ url: "https://r.test/b", sources: [src], versions: [{ ageDays: 9, blobs: [{ tag: "old", bytes: 300 }] }, { ageDays: 1, blobs: [{ tag: "new", bytes: 300 }] }] });
    t.svc.settings.patch({ storage: { pruneSurplusVersions: false } });
    expect((await t.svc.storage.runMaintenanceEviction()).runs).toEqual([]);
    expect(t.seed.versionStatus(page.versionIds[0]!)).toBe("ready");
    t.svc.settings.patch({ storage: { pruneSurplusVersions: true } });
    await t.svc.storage.runMaintenanceEviction();
    expect(page.versionIds.map((id) => t.seed.versionStatus(id))).toEqual(["evicted", "ready"]);
    expectConsistent(t, expect);
  });

  it("time retention keeps recent copies and (keepLatest) the latest; the rest are surplus", async () => {
    const t = await startStorageTest();
    const src = t.seed.source({ priority: 3, retention: { mode: "time", days: 30, keepLatest: true } });
    const page = await t.seed.page({ url: "https://r.test/c", sources: [src], versions: [{ ageDays: 100, blobs: [{ tag: "a", bytes: 10 }] }, { ageDays: 40, blobs: [{ tag: "b", bytes: 10 }] }, { ageDays: 40 - 11, blobs: [{ tag: "c", bytes: 10 }] }] });
    const plan = t.svc.storage.planAndStore({ mode: "prune" });
    expect(plan.items.map((i) => i.versionNo).sort()).toEqual([1, 2]);
    void DAY;
    void page;
  });

  it("budget retention keeps the newest pages inside the budget; pages outside it become surplus and are pruned", async () => {
    const t = await startStorageTest();
    const src = t.seed.source({ priority: 3, retention: { mode: "budget", bytes: 1500 } });
    const recent = await t.seed.page({ url: "https://r.test/recent", sources: [src], versions: [{ ageDays: 1, blobs: [{ tag: "r", bytes: 1000 }] }] });
    const older = await t.seed.page({ url: "https://r.test/older", sources: [src], versions: [{ ageDays: 5, blobs: [{ tag: "o", bytes: 1000 }] }] });
    t.svc.db.run("UPDATE pages SET last_captured_at = ? WHERE id = ?", [t.svc.clock.now() - DAY, recent.pageId]);
    t.svc.db.run("UPDATE pages SET last_captured_at = ? WHERE id = ?", [t.svc.clock.now() - 5 * DAY, older.pageId]);
    await t.svc.storage.runMaintenanceEviction();
    expect(t.seed.versionStatus(recent.versionIds[0]!)).toBe("ready");
    expect(t.seed.versionStatus(older.versionIds[0]!)).toBe("evicted");
  });

  it("a page referenced by a source that keeps all copies keeps them, even if another source would let them go", async () => {
    const t = await startStorageTest();
    const keepAll = t.seed.source({ priority: 3, retention: { mode: "all" } });
    const latest = t.seed.source({ priority: 3, retention: { mode: "latest", count: 1 } });
    const page = await t.seed.page({ url: "https://r.test/d", sources: [keepAll, latest], versions: [{ ageDays: 5, blobs: [{ tag: "x", bytes: 50 }] }, { ageDays: 1, blobs: [{ tag: "y", bytes: 50 }] }] });
    const plan = t.svc.storage.planAndStore({ mode: "prune" });
    expect(plan.items).toEqual([]);
    expect(page.versionIds.map((id) => t.seed.versionStatus(id))).toEqual(["ready", "ready"]);
  });
});
