import { describe, expect, it } from "vitest";
import { expectConsistent, startStorageTest } from "./helpers.js";

describe("shared assets are counted by exclusive bytes and a blob shared with protected content is never freed", () => {
  const shared = { tag: "site.css", bytes: 4000 };

  it("a stylesheet shared by a Protected page and an Opportunistic page survives the Opportunistic page's eviction", async () => {
    const t = await startStorageTest();
    const keep = t.seed.source({ priority: 1, retention: { mode: "all" }, automaticEviction: false });
    const cheap = t.seed.source({ priority: 4 });
    const protectedPage = await t.seed.page({ url: "https://a.test/keep", sources: [keep], versions: [{ blobs: [{ tag: "keep", bytes: 1000 }, shared] }] });
    const opportunistic = await t.seed.page({ url: "https://a.test/cheap", sources: [cheap], versions: [{ blobs: [{ tag: "cheap", bytes: 500 }, shared] }] });
    const sharedSha = protectedPage.blobShas[1]!;

    // asking for the stylesheet's size cannot be met: the P4 page frees only its own 500 bytes
    const plan = t.svc.storage.planAndStore({ bytesNeeded: 4000, incomingPriority: 1 });
    expect(plan.sufficient).toBe(false);
    expect(plan.reclaimableBytes).toBe(500);
    const ok = t.svc.storage.planAndStore({ bytesNeeded: 500, incomingPriority: 1 });
    expect(ok.items).toHaveLength(1);
    expect(ok.items[0]).toMatchObject({ exclusiveBytes: 500, pageUrl: "https://a.test/cheap" });
    await t.svc.storage.runPlan(ok.planId);

    expect(t.seed.versionStatus(opportunistic.versionIds[0]!)).toBe("evicted");
    expect(t.seed.versionStatus(protectedPage.versionIds[0]!)).toBe("ready");
    expect(t.seed.blobExists(sharedSha), "the shared stylesheet is still on disk").toBe(true);
    expect(t.seed.blobExists(opportunistic.blobShas[0]!)).toBe(false);
    expect(t.svc.blobs.bySha(sharedSha)).toMatchObject({ refcount: 1, state: "ready" });
    expectConsistent(t, expect);
  });

  it("two evicted pages that share a blob only free it together, and it is counted once", async () => {
    const t = await startStorageTest();
    const cheap = t.seed.source({ priority: 4 });
    const a = await t.seed.page({ url: "https://a.test/1", sources: [cheap], versions: [{ blobs: [{ tag: "one", bytes: 100 }, shared] }] });
    const b = await t.seed.page({ url: "https://a.test/2", sources: [cheap], versions: [{ blobs: [{ tag: "two", bytes: 100 }, shared] }] });
    const plan = t.svc.storage.planAndStore({ bytesNeeded: 4200, incomingPriority: 1 });
    expect(plan.sufficient).toBe(true);
    expect(plan.reclaimableBytes).toBe(4200);
    expect(plan.items.map((i) => i.exclusiveBytes).sort((x, y) => x - y)).toEqual([100, 4100]);
    await t.svc.storage.runPlan(plan.planId);
    expect(t.seed.blobExists(a.blobShas[1]!)).toBe(false);
    expect(t.svc.blobs.bySha(a.blobShas[1]!)).toBeUndefined();
    void b;
    expectConsistent(t, expect);
  });

  it("usage by source reports shared bytes separately and the deduplicated total equals the blob sizes", async () => {
    const t = await startStorageTest();
    const s1 = t.seed.source({ name: "One", priority: 3 });
    const s2 = t.seed.source({ name: "Two", priority: 3 });
    await t.seed.page({ url: "https://a.test/1", sources: [s1], versions: [{ blobs: [{ tag: "one", bytes: 100 }, shared] }] });
    await t.seed.page({ url: "https://a.test/2", sources: [s2], versions: [{ blobs: [{ tag: "two", bytes: 200 }, shared] }] });
    const usage = (await t.api("GET", "/api/storage/usage?by=source")).body;
    expect(usage.totalBytes).toBe(100 + 200 + 4000);
    const row = (name: string) => usage.items.find((i: { label?: string }) => i.label === name);
    expect(row("One")).toMatchObject({ exclusiveBytes: 100, sharedBytes: 4000 });
    expect(row("Two")).toMatchObject({ exclusiveBytes: 200, sharedBytes: 4000 });
    const total = t.svc.db.get<{ n: number }>("SELECT SUM(stored_bytes) AS n FROM blobs")!.n;
    expect(usage.totalBytes).toBe(total);
  });
});
