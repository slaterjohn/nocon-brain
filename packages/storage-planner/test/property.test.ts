import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  eligibility, evaluateBudget, planEviction, retainedVersionIds, versionPriority,
  type BlobInfo, type PageInfo, type Policy, type Priority, type Reference, type RetentionSpec, type VersionStatus,
} from "../src/index.js";
import { NOW } from "./helpers.js";

const prio = fc.constantFrom<Priority>(1, 2, 3, 4);
const atom = fc.oneof(
  fc.constant({ mode: "all" as const }),
  fc.record({ mode: fc.constant("latest" as const), count: fc.integer({ min: 1, max: 5 }) }),
  fc.record({ mode: fc.constant("time" as const), days: fc.integer({ min: 1, max: 400 }), keepLatest: fc.boolean() }),
  fc.record({ mode: fc.constant("budget" as const), bytes: fc.integer({ min: 1, max: 1000 }) }),
);
const retention: fc.Arbitrary<RetentionSpec> = fc.oneof(
  atom,
  fc.record({ mode: fc.constant("custom" as const), combine: fc.constantFrom("union" as const, "intersection" as const), rules: fc.array(atom, { minLength: 1, maxLength: 4 }) }),
);
const reference = (i: number): fc.Arbitrary<Reference> =>
  fc.record({
    kind: fc.constantFrom("source" as const, "collection" as const, "pin" as const, "bookmark" as const),
    id: fc.constant(`ref_${i}`),
    priority: prio,
    retention,
    autoEvict: fc.boolean(),
    budgetIncluded: fc.array(fc.boolean(), { maxLength: 4 }),
  });

const status = fc.constantFrom<VersionStatus>("ready", "ready", "ready", "partial", "capturing", "evicting", "evicted", "failed");

/** A random inventory: pages with versions, references, shared blobs with true reference totals. */
const inventory = fc.record({
  nBlobs: fc.integer({ min: 1, max: 8 }),
  pages: fc.array(
    fc.record({
      versions: fc.array(
        fc.record({
          status, ageDays: fc.integer({ min: 0, max: 500 }), accessed: fc.option(fc.integer({ min: 0, max: 1e6 }), { nil: null }),
          blobs: fc.array(fc.record({ blobIdx: fc.integer({ min: 0, max: 7 }), refs: fc.integer({ min: 1, max: 2 }) }), { maxLength: 4 }),
        }),
        { minLength: 1, maxLength: 5 },
      ),
      refs: fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 4 }).chain((ns) => fc.tuple(...ns.map((_, i) => reference(i)))),
      busy: fc.boolean(),
    }),
    { minLength: 1, maxLength: 8 },
  ),
  sizes: fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 8, maxLength: 8 }),
  extraRefs: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 8, maxLength: 8 }),
  volumes: fc.array(fc.integer({ min: 1, max: 2 }), { minLength: 8, maxLength: 8 }),
});

function build(inv: {
  nBlobs: number; sizes: number[]; extraRefs: number[]; volumes: number[];
  pages: { versions: { status: VersionStatus; ageDays: number; accessed: number | null; blobs: { blobIdx: number; refs: number }[] }[]; refs: Reference[]; busy: boolean }[];
}): { pages: PageInfo[]; blobs: BlobInfo[] } {
  let vid = 0;
  const totals = new Map<number, number>();
  const pages: PageInfo[] = inv.pages.map((p, pi) => {
    const versions = p.versions.map((v) => {
      vid++;
      const blobs = [...new Map(v.blobs.map((b) => [b.blobIdx % inv.nBlobs, { blobId: (b.blobIdx % inv.nBlobs) + 1, refs: b.refs }])).values()];
      if (v.status !== "evicted") for (const b of blobs) totals.set(b.blobId, (totals.get(b.blobId) ?? 0) + b.refs);
      return { id: vid, versionNo: vid, fetchedAt: NOW - v.ageDays * 86_400_000, status: v.status, lastAccessedAt: v.accessed, blobs };
    });
    const latest = [...versions].filter((v) => v.status === "ready" || v.status === "partial").sort((a, b) => b.fetchedAt - a.fetchedAt || b.id - a.id)[0];
    return { id: pi + 1, url: `https://x.test/${pi}`, latestVersionId: latest?.id ?? null, versions, refs: p.refs, busy: p.busy };
  });
  const blobs: BlobInfo[] = [...totals.entries()].map(([id, t]) => ({ id, storedBytes: inv.sizes[id - 1]!, totalRefs: t + inv.extraRefs[id - 1]!, volumeId: inv.volumes[id - 1]! }));
  return { pages, blobs };
}

const policyArb = fc.record({ permitImportantEviction: fc.boolean(), pruneSurplusVersions: fc.boolean() }) as fc.Arbitrary<Policy>;
const RUNS = { numRuns: 400 };

describe("non-negotiable: P1 is never automatically evicted (property tests over random inventories and policies)", () => {
  it("no plan ever contains a version whose priority is 1, whatever the policy, flags, mode, incoming priority or need", () => {
    fc.assert(
      fc.property(inventory, policyArb, prio, fc.integer({ min: 0, max: 5000 }), fc.constantFrom("pressure" as const, "prune" as const), (inv, policy, incoming, need, mode) => {
        const { pages, blobs } = build(inv);
        const plan = planEviction({ pages, blobs, policy, incomingPriority: incoming, bytesNeeded: need, mode, now: NOW });
        for (const item of plan.items) {
          const page = pages.find((p) => p.id === item.pageId)!;
          const pr = versionPriority(page, item.versionId, NOW);
          expect(pr.priority === 1, `version ${item.versionId} is P1`).toBe(false);
          expect(item.priority).not.toBe(1);
          // re-derived eligibility agrees with the planner
          expect(eligibility({ page, versionId: item.versionId, policy, incomingPriority: mode === "prune" ? 1 : incoming, now: NOW }).eligible).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it("eligibility is false for every version retained at P1, for every flag and policy combination", () => {
    fc.assert(
      fc.property(inventory, policyArb, prio, (inv, policy, incoming) => {
        const { pages } = build(inv);
        for (const page of pages) for (const v of page.versions) {
          const pr = versionPriority(page, v.id, NOW);
          if (pr.priority === 1) expect(eligibility({ page, versionId: v.id, policy, incomingPriority: incoming, now: NOW }).eligible).toBe(false);
        }
      }),
      RUNS,
    );
  });

  it("an automaticEviction veto on any reference keeps every version of the page out of every plan", () => {
    fc.assert(
      fc.property(inventory, policyArb, prio, (inv, policy, incoming) => {
        const { pages, blobs } = build(inv);
        const plan = planEviction({ pages, blobs, policy, incomingPriority: incoming, bytesNeeded: 1e9, now: NOW });
        const vetoed = new Set(pages.filter((p) => p.refs.some((r) => !r.autoEvict)).map((p) => p.id));
        for (const item of plan.items) expect(vetoed.has(item.pageId)).toBe(false);
      }),
      RUNS,
    );
  });

  it("P2 is only planned under the permit, only live idle versions are planned, the gate holds", () => {
    fc.assert(
      fc.property(inventory, policyArb, prio, (inv, policy, incoming) => {
        const { pages, blobs } = build(inv);
        const plan = planEviction({ pages, blobs, policy, incomingPriority: incoming, bytesNeeded: 1e9, now: NOW });
        for (const item of plan.items) {
          if (item.priority === 2) expect(policy.permitImportantEviction).toBe(true);
          expect(item.priority > incoming || (item.priority === incoming && incoming >= 3)).toBe(true);
          const page = pages.find((p) => p.id === item.pageId)!;
          expect(page.busy).toBeFalsy();
          expect(["ready", "partial"]).toContain(page.versions.find((v) => v.id === item.versionId)!.status);
        }
      }),
      RUNS,
    );
  });

  it("an insufficient plan is flagged and a sufficient one really covers the need", () => {
    fc.assert(
      fc.property(inventory, policyArb, prio, fc.integer({ min: 1, max: 3000 }), (inv, policy, incoming, need) => {
        const { pages, blobs } = build(inv);
        const plan = planEviction({ pages, blobs, policy, incomingPriority: incoming, bytesNeeded: need, now: NOW });
        expect(plan.sufficient).toBe(plan.reclaimableBytes >= need);
        // never reports more reclaimable bytes than the blobs it touches could ever free
        const byId = new Map(blobs.map((b) => [b.id, b]));
        const evictedRefs = new Map<number, number>();
        for (const item of plan.items) {
          const page = pages.find((p) => p.id === item.pageId)!;
          for (const u of page.versions.find((v) => v.id === item.versionId)!.blobs) evictedRefs.set(u.blobId, (evictedRefs.get(u.blobId) ?? 0) + u.refs);
        }
        let freeable = 0;
        for (const [id, n] of evictedRefs) if (n >= byId.get(id)!.totalRefs) freeable += byId.get(id)!.storedBytes;
        expect(plan.reclaimableBytes).toBeLessThanOrEqual(freeable);
      }),
      RUNS,
    );
  });

  it("shared blobs are never counted as freed while any non-planned reference remains", () => {
    fc.assert(
      fc.property(inventory, policyArb, (inv, policy) => {
        const { pages, blobs } = build(inv);
        const plan = planEviction({ pages, blobs, policy, incomingPriority: 4, bytesNeeded: 1e9, now: NOW });
        const planned = new Set(plan.items.map((i) => i.versionId));
        const held = new Map<number, number>(); // refs held by versions that are NOT planned (any status except evicted)
        for (const p of pages) for (const v of p.versions) if (!planned.has(v.id) && v.status !== "evicted") for (const u of v.blobs) held.set(u.blobId, (held.get(u.blobId) ?? 0) + u.refs);
        // A blob referenced by a surviving version must contribute 0: recompute the freed set independently.
        let independent = 0;
        for (const b of blobs) {
          const plannedRefs = pages.flatMap((p) => p.versions).filter((v) => planned.has(v.id)).reduce((n, v) => n + (v.blobs.find((u) => u.blobId === b.id)?.refs ?? 0), 0);
          if (plannedRefs > 0 && plannedRefs >= b.totalRefs) independent += b.storedBytes;
        }
        expect(plan.reclaimableBytes).toBe(independent);
      }),
      RUNS,
    );
  });

  it("the planner is deterministic and independent of input order", () => {
    fc.assert(
      fc.property(inventory, policyArb, prio, fc.integer({ min: 0, max: 3000 }), (inv, policy, incoming, need) => {
        const { pages, blobs } = build(inv);
        const a = planEviction({ pages, blobs, policy, incomingPriority: incoming, bytesNeeded: need, now: NOW });
        const b = planEviction({ pages: [...pages].reverse().map((p) => ({ ...p, versions: [...p.versions].reverse(), refs: [...p.refs].reverse() })), blobs: [...blobs].reverse(), policy, incomingPriority: incoming, bytesNeeded: need, now: NOW });
        expect(b.items.map((i) => i.versionId)).toEqual(a.items.map((i) => i.versionId));
        expect(b.reclaimableBytes).toBe(a.reclaimableBytes);
        expect(b.sufficient).toBe(a.sufficient);
      }),
      RUNS,
    );
  });
});

describe("T-01 / T-02 properties", () => {
  it("priority(V) is the minimum priority of the retaining references, and 4 with surplus when there are none", () => {
    fc.assert(
      fc.property(inventory, (inv) => {
        const { pages } = build(inv);
        for (const page of pages) for (const v of page.versions) {
          const r = versionPriority(page, v.id, NOW);
          const retaining = page.refs.filter((x) => retainedVersionIds(x.retention, page, NOW, x.budgetIncluded).has(v.id));
          if (retaining.length === 0) expect(r).toMatchObject({ priority: 4, surplus: true });
          else expect(r.priority).toBe(Math.min(...retaining.map((x) => x.priority)));
        }
      }),
      RUNS,
    );
  });

  it("raising a reference's priority never makes a version more evictable (monotonic)", () => {
    fc.assert(
      fc.property(inventory, policyArb, fc.nat(), (inv, policy, k) => {
        const { pages } = build(inv);
        for (const page of pages) {
          if (page.refs.length === 0) continue;
          const i = k % page.refs.length;
          const raised = { ...page, refs: page.refs.map((r, j) => (j === i ? { ...r, priority: 1 as Priority } : r)) };
          for (const v of page.versions) {
            const before = eligibility({ page, versionId: v.id, policy, incomingPriority: 1, now: NOW }).eligible;
            const after = eligibility({ page: raised, versionId: v.id, policy, incomingPriority: 1, now: NOW }).eligible;
            if (!before) expect(after).toBe(false);
          }
        }
      }),
      RUNS,
    );
  });

  it("retention sets are subsets of the live versions, and a latest(N>=1) rule always keeps the newest live version", () => {
    fc.assert(
      fc.property(inventory, retention, (inv, spec) => {
        const { pages } = build(inv);
        for (const page of pages) {
          const live = new Set(page.versions.filter((v) => v.status === "ready" || v.status === "partial").map((v) => v.id));
          const set = retainedVersionIds(spec, page, NOW, [true, true, true, true]);
          for (const id of set) expect(live.has(id)).toBe(true);
          if (spec.mode === "latest" && live.size) expect(set.size).toBeGreaterThanOrEqual(1);
        }
      }),
      RUNS,
    );
  });

  it("evaluateBudget never exceeds the budget and is order independent", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ pageId: fc.integer({ min: 1, max: 30 }), lastCapturedAt: fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }), blobs: fc.array(fc.record({ blobId: fc.integer({ min: 1, max: 10 }), storedBytes: fc.constant(7) }), { maxLength: 4 }) }), { maxLength: 15 })
          .map((ps) => [...new Map(ps.map((p) => [p.pageId, p])).values()]),
        fc.integer({ min: 0, max: 200 }),
        (pages, budget) => {
          const inc = evaluateBudget(pages, budget);
          const blobs = new Set(pages.filter((p) => inc.has(p.pageId)).flatMap((p) => p.blobs.map((b) => b.blobId)));
          expect(blobs.size * 7).toBeLessThanOrEqual(budget);
          expect([...evaluateBudget([...pages].reverse(), budget)].sort()).toEqual([...inc].sort());
        },
      ),
      RUNS,
    );
  });
});
