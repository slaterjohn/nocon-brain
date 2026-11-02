import { describe, expect, it } from "vitest";
import { forecastStorage, planEviction, explainVersion, type PageInfo } from "../src/index.js";
import { DAY, NOW, POLICY, blob, page, ref, ver } from "./helpers.js";

const plan = (pages: PageInfo[], blobs: ReturnType<typeof blob>[], o: Partial<Parameters<typeof planEviction>[0]> = {}) =>
  planEviction({ pages, blobs, policy: POLICY, incomingPriority: 1, bytesNeeded: 100, now: NOW, ...o });

describe("T-04 planner: golden plans", () => {
  // p1 (P1, never), p2 (P2), p3 (P3), p4 (P4 latest), p4 with an older surplus version.
  const mk = () => {
    const pages = [
      page(1, [ver(10, { blobs: [{ blobId: 1, refs: 1 }] })], [ref({ priority: 1 })]),
      page(2, [ver(20, { blobs: [{ blobId: 2, refs: 1 }] })], [ref({ priority: 2 })]),
      page(3, [ver(30, { blobs: [{ blobId: 3, refs: 1 }] })], [ref({ priority: 3 })]),
      page(4, [ver(41, { fetchedAt: NOW - 5 * DAY, blobs: [{ blobId: 4, refs: 1 }] }), ver(42, { fetchedAt: NOW - DAY, blobs: [{ blobId: 5, refs: 1 }] })], [ref({ priority: 4 })]),
    ];
    const blobs = [blob(1, 500, 1), blob(2, 400, 1), blob(3, 300, 1), blob(4, 50, 1), blob(5, 60, 1)];
    return { pages, blobs };
  };

  it("order: surplus first, then P4, then P3; P2 only when permitted; never P1", () => {
    const { pages, blobs } = mk();
    const p = plan(pages, blobs, { bytesNeeded: 400 });
    expect(p.items.map((i) => [i.versionId, i.step])).toEqual([[41, "surplus_versions"], [42, "p4"], [30, "p3"]]);
    expect(p.reclaimableBytes).toBe(50 + 60 + 300);
    expect(p.sufficient).toBe(true);
    expect(p.steps.map((s) => s.step)).toEqual(["surplus_versions", "p4", "p3"]);
  });
  it("stops as soon as the need is covered", () => {
    const { pages, blobs } = mk();
    expect(plan(pages, blobs, { bytesNeeded: 40 }).items.map((i) => i.versionId)).toEqual([41]);
  });
  it("insufficient: P2 is not reachable without the permit, and the plan says so", () => {
    const { pages, blobs } = mk();
    const p = plan(pages, blobs, { bytesNeeded: 900 });
    expect(p.sufficient).toBe(false);
    expect(p.items.map((i) => i.versionId)).not.toContain(20);
    expect(p.items.map((i) => i.versionId)).not.toContain(10);
    expect(p.skipped.find((s) => s.versionId === 20)?.reason).toBe("p2_not_permitted");
    expect(p.skipped.find((s) => s.versionId === 10)?.reason).toBe("p1");
  });
  it("with the permit P2 comes last, still never P1", () => {
    const { pages, blobs } = mk();
    const p = plan(pages, blobs, { bytesNeeded: 800, policy: { ...POLICY, permitImportantEviction: true } });
    expect(p.items.map((i) => i.versionId)).toEqual([41, 42, 30, 20]);
    expect(p.sufficient).toBe(true);
    expect(p.items.some((i) => i.priority === 1)).toBe(false);
  });
  it("the incoming gate limits a P4 download to P4 content", () => {
    const { pages, blobs } = mk();
    const p = plan(pages, blobs, { incomingPriority: 4, bytesNeeded: 1000 });
    expect(p.items.map((i) => i.versionId).sort()).toEqual([41, 42]);
    expect(p.skipped.find((s) => s.versionId === 30)?.reason).toBe("priority_gate");
    expect(p.sufficient).toBe(false);
  });
  it("same input, same plan; shuffled input, same plan", () => {
    const { pages, blobs } = mk();
    const a = plan(pages, blobs, { bytesNeeded: 400 });
    const b = plan(JSON.parse(JSON.stringify(pages)), JSON.parse(JSON.stringify(blobs)), { bytesNeeded: 400 });
    const c = plan([...pages].reverse(), [...blobs].reverse(), { bytesNeeded: 400 });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
  it("zero need plans nothing; unreferenced blobs come first and can cover the need alone", () => {
    const { pages, blobs } = mk();
    expect(plan(pages, blobs, { bytesNeeded: 0 })).toMatchObject({ items: [], sufficient: true, reclaimableBytes: 0 });
    const p = plan(pages, blobs, { bytesNeeded: 100, unreferencedBlobs: [{ blobId: 99, storedBytes: 120, volumeId: 1 }] });
    expect(p.items).toEqual([]);
    expect(p.unreferencedBlobs).toEqual([{ blobId: 99, storedBytes: 120 }]);
    expect(p.steps[0]).toMatchObject({ step: "unreferenced_blobs", exclusiveBytes: 120 });
  });
  it("within a class: superseded before latest, never served before served, larger before smaller, then id", () => {
    const pages = [
      page(1, [ver(1, { lastAccessedAt: 500, blobs: [{ blobId: 1, refs: 1 }] })], [ref({ priority: 4 })]),
      page(2, [ver(2, { lastAccessedAt: null, blobs: [{ blobId: 2, refs: 1 }] })], [ref({ priority: 4 })]),
      page(3, [ver(3, { lastAccessedAt: null, blobs: [{ blobId: 3, refs: 1 }] })], [ref({ priority: 4 })]),
      page(4, [ver(4, { lastAccessedAt: 100, blobs: [{ blobId: 4, refs: 1 }] })], [ref({ priority: 4 })]),
    ];
    const blobs = [blob(1, 10, 1), blob(2, 10, 1), blob(3, 90, 1), blob(4, 10, 1)];
    expect(plan(pages, blobs, { bytesNeeded: 1000 }).items.map((i) => i.versionId)).toEqual([3, 2, 4, 1]);
  });
  it("prune mode takes only surplus versions and ignores need", () => {
    const { pages, blobs } = mk();
    const p = plan(pages, blobs, { mode: "prune", bytesNeeded: 0 });
    expect(p.items.map((i) => i.versionId)).toEqual([41]);
    expect(p.sufficient).toBe(true);
  });
  it("the throttle step is reported but deletes nothing", () => {
    const { pages, blobs } = mk();
    const p = plan(pages, blobs, { bytesNeeded: 0, throttle: { enabled: true, usedPct: 90, softPct: 85 } });
    expect(p.throttleOpportunistic).toBe(true);
    expect(p.items).toEqual([]);
    expect(p.steps[0]!.step).toBe("throttle_p4");
    expect(plan(pages, blobs, { bytesNeeded: 0, throttle: { enabled: false, usedPct: 99, softPct: 85 } }).throttleOpportunistic).toBe(false);
  });
});

describe("T-04 planner: shared assets are counted by exclusive bytes", () => {
  it("a shared asset between a P1 and a P4 page frees 0 bytes for that part", () => {
    const pages = [
      page(1, [ver(10, { blobs: [{ blobId: 7, refs: 1 }] })], [ref({ priority: 1 })]),
      page(2, [ver(20, { blobs: [{ blobId: 7, refs: 1 }, { blobId: 8, refs: 1 }] })], [ref({ priority: 4 })]),
    ];
    const blobs = [blob(7, 1000, 2), blob(8, 25, 1)];
    const p = plan(pages, blobs, { bytesNeeded: 25 });
    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ versionId: 20, exclusiveBytes: 25, soloExclusiveBytes: 25 });
    expect(p.reclaimableBytes).toBe(25);
    expect(plan(pages, blobs, { bytesNeeded: 26 }).sufficient).toBe(false);
  });
  it("a P4 version whose bytes are all shared with kept content is not worth evicting", () => {
    const pages = [
      page(1, [ver(10, { blobs: [{ blobId: 7, refs: 1 }] })], [ref({ priority: 1 })]),
      page(2, [ver(20, { blobs: [{ blobId: 7, refs: 1 }] })], [ref({ priority: 4 })]),
    ];
    const p = plan(pages, [blob(7, 1000, 2)], { bytesNeeded: 10 });
    expect(p.items).toEqual([]);
    expect(p.sufficient).toBe(false);
    expect(p.skippedCounts.no_reclaim).toBe(1);
  });
  it("two evicted versions that share a blob free it together, and it is counted once", () => {
    const pages = [
      page(1, [ver(10, { blobs: [{ blobId: 7, refs: 1 }] })], [ref({ priority: 4 })]),
      page(2, [ver(20, { blobs: [{ blobId: 7, refs: 1 }, { blobId: 8, refs: 1 }] })], [ref({ priority: 4 })]),
    ];
    const p = plan(pages, [blob(7, 100, 2), blob(8, 10, 1)], { bytesNeeded: 110 });
    expect(p.items.map((i) => i.exclusiveBytes).sort((a, b) => a - b)).toEqual([10, 100]);
    expect(p.reclaimableBytes).toBe(110);
    expect(p.sufficient).toBe(true);
  });
  it("a blob with a reference outside the inventory (refs < totalRefs) is never counted as freed", () => {
    const pages = [page(1, [ver(10, { blobs: [{ blobId: 7, refs: 1 }] })], [ref({ priority: 4 })])];
    expect(plan(pages, [blob(7, 500, 2)], { bytesNeeded: 1 }).sufficient).toBe(false);
  });
  it("only bytes on the target volume count; offline volumes count for nothing", () => {
    const pages = [page(1, [ver(10, { blobs: [{ blobId: 1, refs: 1 }, { blobId: 2, refs: 1 }] })], [ref({ priority: 4 })])];
    const blobs = [blob(1, 100, 1, 1), blob(2, 300, 1, 2)];
    expect(plan(pages, blobs, { bytesNeeded: 50, volumeId: 1 }).reclaimableBytes).toBe(100);
    expect(plan(pages, blobs, { bytesNeeded: 50, volumeId: 2 }).reclaimableBytes).toBe(300);
    expect(plan(pages, blobs, { bytesNeeded: 50, unavailableVolumeIds: [2] }).reclaimableBytes).toBe(100);
  });
});

describe("T-08 forecast", () => {
  const base = {
    now: NOW, horizonDays: 30, usedBytes: 1_000_000, availableBytes: 10_000_000,
    history: [100, 200, 300, 200, 100].map((b, i) => ({ dayStart: NOW - (5 - i) * DAY, bytesAdded: b * 1000 })),
    sources: [{ id: "src_b", name: "B", observedPages: 10, observedBytes: 1_000_000, plannedPages: 50 }, { id: "src_a", name: "A", observedPages: 0, observedBytes: 0, plannedPages: 10 }],
  };
  it("is deterministic and always labelled as an estimate with a low/high band and assumptions", () => {
    const a = forecastStorage(base);
    expect(forecastStorage(JSON.parse(JSON.stringify(base)))).toEqual(a);
    expect(a.estimate).toBe(true);
    expect(a.projectedUsedBytes.low).toBeLessThan(a.projectedUsedBytes.high);
    expect(a.projectedUsedBytes.low).toBeGreaterThanOrEqual(base.usedBytes);
    expect(a.assumptions.length).toBeGreaterThan(1);
    expect(a.perSource.map((s) => s.sourceId)).toEqual(["src_a", "src_b"]);
    expect(a).not.toHaveProperty("projectedUsedBytes.exact");
  });
  it("planned pages are priced at observed bytes per page (70% to 150%)", () => {
    const f = forecastStorage(base);
    const b = f.perSource.find((s) => s.sourceId === "src_b")!;
    expect(b.bytesPerPage).toEqual({ low: 70_000, high: 150_000 });
    expect(b.plannedBytes).toEqual({ low: 3_500_000, high: 7_500_000 });
  });
  it("gives an earliest and latest full date when growth is positive, and none when nothing grows", () => {
    const f = forecastStorage({ ...base, availableBytes: 3_000_000 });
    expect(f.projectedFullAt).toBeDefined();
    expect(new Date(f.projectedFullAt!.earliest).getTime()).toBeLessThanOrEqual(new Date(f.projectedFullAt!.latest ?? f.projectedFullAt!.earliest).getTime());
    expect(forecastStorage({ ...base, history: [], sources: [] }).projectedFullAt).toBeUndefined();
  });
  it("sparse history widens the band and lowers the confidence", () => {
    const f = forecastStorage({ ...base, history: [{ dayStart: NOW - DAY, bytesAdded: 1000 }], sources: [] });
    expect(f.confidence).toBe("low");
    expect(f.growthBytesPerDay.low).toBe(0);
    expect(f.growthBytesPerDay.high).toBe(2000);
    expect(f.assumptions.join(" ")).toMatch(/Only 1 day/);
  });
  it("no history and no sources: the projection equals what is used, and says so", () => {
    const f = forecastStorage({ ...base, history: [], sources: [] });
    expect(f.projectedUsedBytes).toEqual({ low: 1_000_000, high: 1_000_000 });
    expect(f.assumptions[0]).toMatch(/no saving history/);
  });
});

describe("explain", () => {
  it("says why a P1 version is kept and why a surplus one is evictable", () => {
    const pg = page(1, [ver(1), ver(2)], [ref({ priority: 1, label: "Docs" })]);
    const kept = explainVersion(pg, 2, POLICY, NOW);
    expect(kept).toMatchObject({ decision: "kept", skipReason: "p1", priority: 1 });
    expect(kept.reasons.join(" ")).toMatch(/never removed automatically/);
    const old = explainVersion(pg, 1, POLICY, NOW);
    expect(old).toMatchObject({ decision: "evictable", surplus: true, priority: 4 });
    expect(old.references[0]).toMatchObject({ retains: false });
  });
});
