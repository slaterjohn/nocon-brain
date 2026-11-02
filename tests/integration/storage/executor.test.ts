import { describe, expect, it } from "vitest";
import { archiveSignature, expectConsistent, startStorageTest } from "../../storage-safety/helpers.js";

describe("T-04 / T-05 planning and execution against a real database", () => {
  async function fixture() {
    const t = await startStorageTest();
    const p1 = t.seed.source({ name: "Keep", priority: 1, retention: { mode: "all" }, automaticEviction: true });
    const p3 = t.seed.source({ name: "Standard", priority: 3, retention: { mode: "latest", count: 1 } });
    const p4 = t.seed.source({ name: "Opportunistic", priority: 4, retention: { mode: "latest", count: 1 } });
    const protectedPage = await t.seed.page({ url: "https://keep.test/a", sources: [p1], versions: [{ blobs: [{ tag: "k", bytes: 5000 }] }] });
    const std = await t.seed.page({ url: "https://std.test/a", sources: [p3], versions: [{ ageDays: 5, blobs: [{ tag: "s-old", bytes: 3000 }] }, { ageDays: 1, blobs: [{ tag: "s-new", bytes: 2000 }] }] });
    const opp = await t.seed.page({ url: "https://opp.test/a", sources: [p4], versions: [{ blobs: [{ tag: "o", bytes: 1000 }] }] });
    return { t, protectedPage, std, opp, ids: { p1, p3, p4 } };
  }

  it("dry run changes nothing, the plan explains itself, and running it frees the space P4 before P3 and never P1", async () => {
    const { t, protectedPage, std, opp } = await fixture();
    const before = archiveSignature(t);
    const res = await t.api("POST", "/api/storage/eviction/plan", { bytesNeeded: 4000, incomingPriority: "P1" });
    expect(res.status).toBe(200);
    expect(archiveSignature(t)).toEqual(before);
    const plan = res.body;
    expect(plan).toMatchObject({ sufficient: true, insufficient: false, mode: "pressure", incomingPriority: "P1" });
    // the surplus older copy of the P3 page goes first, then the P4 page, then the P3 latest
    expect(plan.items.map((i: { pageUrl: string; step: string }) => [i.pageUrl, i.step])).toEqual([
      ["https://std.test/a", "surplus_versions"], ["https://opp.test/a", "p4"], ["https://std.test/a", "p3"],
    ].slice(0, plan.items.length));
    expect(plan.items.every((i: { reason: string }) => i.reason.length > 10)).toBe(true);
    expect(plan.skipped.find((s: { pageUrl: string }) => s.pageUrl === "https://keep.test/a")?.reason).toBe("p1");

    const run = await t.api("POST", "/api/storage/eviction/run", { planId: plan.planId });
    expect(run.status).toBe(200);
    expect(run.body.evicted).toBe(plan.items.length);
    expect(t.seed.versionStatus(protectedPage.versionIds[0]!)).toBe("ready");
    expect(t.seed.blobExists(protectedPage.blobShas[0]!)).toBe(true);
    expect(t.seed.versionStatus(std.versionIds[0]!)).toBe("evicted");
    expect(t.seed.blobExists(std.blobShas[0]!)).toBe(false);
    expectConsistent(t, expect);
    // every eviction has a reason in the audit trail and in the activity log
    const audit = t.svc.db.all<{ kind: string; reason: string; version_id: number; priority: number }>("SELECT kind, reason, version_id, priority FROM storage_audit ORDER BY id");
    expect(audit.length).toBe(run.body.evicted);
    expect(audit.every((a) => a.kind === "evicted" && a.reason.length > 10 && a.priority !== 1)).toBe(true);
    const logs = t.svc.db.all<{ message: string; version_id: number }>("SELECT message, version_id FROM activity_log WHERE area = 'storage' AND version_id IS NOT NULL");
    expect(logs.length).toBeGreaterThanOrEqual(audit.length);
    void opp;
  });

  it("a plan that cannot cover the need is insufficient and running it deletes nothing", async () => {
    const { t } = await fixture();
    const before = archiveSignature(t);
    const plan = (await t.api("POST", "/api/storage/eviction/plan", { bytesNeeded: 1_000_000, incomingPriority: "P1" })).body;
    expect(plan).toMatchObject({ sufficient: false, insufficient: true });
    const run = await t.api("POST", "/api/storage/eviction/run", { planId: plan.planId });
    expect(run.status).toBe(409);
    expect(archiveSignature(t)).toEqual(before);
    // admission refuses too, with a clear error, and removes nothing
    await expect(t.svc.storage.admission.admit({ downloadJobId: 1, priority: 1, bytes: 1_000_000_000_000 })).rejects.toMatchObject({ code: "no_eligible_space" });
    expect(archiveSignature(t)).toEqual(before);
  });

  it("the executor re-derives eligibility: a plan made before a page became Protected removes nothing of it", async () => {
    const { t, opp } = await fixture();
    const plan = (await t.api("POST", "/api/storage/eviction/plan", { bytesNeeded: 5500, incomingPriority: "P1" })).body;
    expect(plan.items.some((i: { pageUrl: string }) => i.pageUrl === "https://opp.test/a")).toBe(true);
    // the Human pins the page at P1 after the plan was made, and the cached priority is stale on purpose
    await t.api("PUT", `/api/storage/pages/${opp.publicId}/pin`, { priority: "P1" });
    t.svc.db.run("UPDATE pages SET effective_priority = 4 WHERE id = ?", [opp.pageId]);
    const run = await t.api("POST", "/api/storage/eviction/run", { planId: plan.planId });
    expect(run.status).toBe(200);
    expect(run.body.skipped.find((s: { versionId: string }) => s.versionId)).toBeTruthy();
    expect(t.seed.versionStatus(opp.versionIds[0]!)).toBe("ready");
    expect(t.seed.blobExists(opp.blobShas[0]!)).toBe(true);
    expectConsistent(t, expect);
  });
});
