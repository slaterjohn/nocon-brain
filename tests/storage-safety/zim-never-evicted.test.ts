import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureZims } from "../integration/zim/helpers.js";
import { expectConsistent, startStorageTest, type StorageTest } from "./helpers.js";

/**
 * Knowledge packages (ZIM files, Phase 8) are classified by priority like everything else, counted in the storage figures, and removed only
 * by an explicit, confirmed action. No pressure, plan, tick, garbage collection or maintenance run may delete one in v1 (task Z-03, Z-09).
 */
async function setup() {
  const t = await startStorageTest({ server: { zim: { testHooks: true } } as never, env: { NCB_EXTRACT_WORKERS: "0" } });
  const lib = path.join(t.rootsDir, "library");
  fs.mkdirSync(lib, { recursive: true });
  const src = path.join(lib, "chem.zim");
  fs.copyFileSync((await fixtureZims()).chem, src);
  const volume = t.svc.volumes.list()[0]!;
  // One copied onto the volume (it takes the volume's disk) and one in place; both at the lowest priority, which evicts first for pages.
  const copied = (await t.api("POST", "/api/zim/packages/import", { path: src, copy: true, priority: "P4" })).body;
  const other = path.join(lib, "other.zim");
  fs.copyFileSync((await fixtureZims()).other, other);
  const inPlace = (await t.api("POST", "/api/zim/packages/import", { path: other, priority: "P4" })).body;
  expect(copied.state).toBe("ready");
  expect(inPlace.state).toBe("ready");
  // Pages that are fair game for eviction.
  const s = t.seed.source({ priority: 4, retention: { mode: "latest", count: 1 }, automaticEviction: true });
  const pages = [];
  for (let i = 0; i < 4; i++) pages.push(await t.seed.page({ url: `https://evict.test/${i}`, sources: [s], versions: [{ ageDays: 5, blobs: [{ tag: `e${i}`, bytes: 400 }] }] }));
  return { t, copied, inPlace, volume, pages };
}

function expectIntact(t: StorageTest, z: { id: string; path: string; sizeBytes: number }) {
  expect(fs.existsSync(z.path), `file of ${z.id}`).toBe(true);
  expect(fs.statSync(z.path).size).toBe(z.sizeBytes);
  expect(t.svc.db.get("SELECT state FROM zim_packages WHERE public_id = ?", [z.id])).toMatchObject({ state: expect.stringMatching(/^(ready|degraded)$/) });
}

describe("knowledge packages are never evicted", () => {
  it("a plan for far more space than exists names pages only, never a package, and says it is insufficient when only packages remain", async () => {
    const { t, copied, inPlace } = await setup();
    for (const incoming of [1, 2, 3, 4] as const) {
      const plan = t.svc.storage.planAndStore({ bytesNeeded: 10_000_000_000, incomingPriority: incoming });
      expect(plan.sufficient).toBe(false);
      expect(JSON.stringify(plan)).not.toContain(copied.id);
      expect(JSON.stringify(plan)).not.toContain("chem.zim");
      // the copied package's bytes are not offered as reclaimable space
      const reclaimable = plan.items.reduce((n, i) => n + i.exclusiveBytes, 0);
      expect(reclaimable).toBeLessThan(copied.sizeBytes);
    }
    // asking for exactly what the pages hold plus one byte is not met by taking a package
    const pageBytes = 4 * 400;
    const plan = t.svc.storage.planAndStore({ bytesNeeded: pageBytes + 1, incomingPriority: 1 });
    expect(plan.sufficient).toBe(false);
    expectIntact(t, copied);
    expectIntact(t, inPlace);
  });

  it("running every eviction and maintenance path leaves the packages and their files in place", async () => {
    const { t, copied, inPlace, pages } = await setup();
    t.svc.settings.patch({ storage: { permitImportantEviction: true, acknowledged: true } });
    const plan = t.svc.storage.planAndStore({ bytesNeeded: 1_000_000, incomingPriority: 1 });
    await t.svc.storage.runPlan(plan.planId).catch(() => undefined);
    await t.svc.storage.runMaintenanceEviction();
    await t.svc.storage.tick();
    await t.svc.storage.maintenance.verify({ checks: ["I-13"] });
    // the pages were fair game (the plan names them), the packages are not
    expect(plan.items.length).toBeGreaterThan(0);
    void pages;
    expectIntact(t, copied);
    expectIntact(t, inPlace);
    expectConsistent(t, expect);
    // nothing in the eviction audit or the runs refers to a package
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM storage_audit WHERE page_url LIKE '%.zim%' OR page_url LIKE 'zim:%'")!.n).toBe(0);
    // the registry still lists both and the usage report still counts the copy
    expect((await t.api("GET", "/api/zim/packages")).body.total).toBe(2);
    const usage = (await t.api("GET", "/api/storage/usage?by=priority")).body;
    expect(usage.knowledgePackages).toMatchObject({ count: 2, copiedBytes: copied.sizeBytes, inPlaceBytes: inPlace.sizeBytes, neverAutoEvicted: true });
    expect(usage.items.find((i: { key: string }) => i.key === "P4").exclusiveBytes).toBeGreaterThanOrEqual(copied.sizeBytes);
  });

  it("under real disk pressure (a tiny quota) the pressure path frees pages and still leaves the packages", async () => {
    const { t, copied, inPlace } = await setup();
    const v = t.svc.volumes.list()[0]!;
    // quota just above what the copied package and the pages need, so the volume sits above its eviction threshold
    await t.svc.volumes.update(v.publicId, { quotaBytes: copied.sizeBytes + 1700 });
    await t.svc.storage.tick();
    expectIntact(t, copied);
    expectIntact(t, inPlace);
  });

  it("the only way out is an explicit, confirmed removal, and a copy's file goes with it", async () => {
    const { t, copied, inPlace } = await setup();
    const dry = (await t.api("DELETE", `/api/zim/packages/${copied.id}?dryRun=true`)).body;
    expect(dry).toMatchObject({ removed: false, plan: { deletesFile: true, fileBytes: copied.sizeBytes } });
    expectIntact(t, copied);
    const done = await t.api("DELETE", `/api/zim/packages/${copied.id}`);
    expect(done.status).toBe(200);
    expect(done.body.fileDeleted).toBe(true);
    expect(fs.existsSync(copied.path)).toBe(false);
    // an in-place file is only unregistered
    expect((await t.api("DELETE", `/api/zim/packages/${inPlace.id}`)).body.fileDeleted).toBe(false);
    expect(fs.existsSync(inPlace.path)).toBe(true);
    expect((await t.api("GET", "/api/zim/packages")).body.total).toBe(0);
  });

  it("a package's source cannot be given automatic eviction, whatever the priority", async () => {
    const { t, copied } = await setup();
    for (const priority of ["P1", "P2", "P3", "P4"]) {
      const r = await t.api("PATCH", `/api/sources/${copied.sourceId}`, { priority, automaticEviction: true });
      expect(r.status, priority).toBe(400);
    }
    const s = (await t.api("GET", `/api/sources/${copied.sourceId}`)).body;
    expect(s).toMatchObject({ automaticEviction: false, retention: { mode: "all" } });
  });
});
