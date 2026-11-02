import { describe, expect, it } from "vitest";
import { blobPriorities, evaluateBudget, pagePriority, retainedVersionIds, versionPriority, type RetentionSpec } from "../src/index.js";
import { DAY, NOW, page, ref, retention, ver } from "./helpers.js";

const three = () => [ver(1), ver(2), ver(3)]; // 3 is the newest
const ids = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe("T-02 retention evaluators", () => {
  const p = page(1, three(), []);
  it.each<[string, RetentionSpec, number[]]>([
    ["all", { mode: "all" }, [1, 2, 3]],
    ["latest 1", { mode: "latest", count: 1 }, [3]],
    ["latest 2", { mode: "latest", count: 2 }, [2, 3]],
    ["latest 99", { mode: "latest", count: 99 }, [1, 2, 3]],
    ["time 1.5 days (keepLatest default)", { mode: "time", days: 1.5, keepLatest: undefined }, [3]],
    ["time 98.5 days", { mode: "time", days: 98.5 }, [2, 3]],
    ["time 0 days, keepLatest", { mode: "time", days: 1, keepLatest: true }, [3]],
    ["time 1 day, keepLatest false (newest is 98 days old: nothing)", { mode: "time", days: 1, keepLatest: false }, []],
    ["custom union latest(1) + time(98.5)", { mode: "custom", combine: "union", rules: [{ mode: "latest", count: 1 }, { mode: "time", days: 98.5 }] }, [2, 3]],
    ["custom intersection latest(2) + time(98.5)", { mode: "custom", combine: "intersection", rules: [{ mode: "latest", count: 2 }, { mode: "time", days: 98.5 }] }, [2, 3]],
    ["custom intersection latest(1) + all", { mode: "custom", combine: "intersection", rules: [{ mode: "latest", count: 1 }, { mode: "all" }] }, [3]],
  ])("%s", (_n, spec, expected) => {
    // versions: fetchedAt = NOW - (100 - id) days, so version 3 is 97 days old.
    expect(ids(retainedVersionIds(spec, p, NOW))).toEqual(expected);
  });

  it("time uses the age of each version", () => {
    const pg = page(1, [ver(1, { fetchedAt: NOW - 10 * DAY }), ver(2, { fetchedAt: NOW - 2 * DAY }), ver(3, { fetchedAt: NOW - 20 * DAY })], []);
    expect(ids(retainedVersionIds({ mode: "time", days: 5, keepLatest: true }, pg, NOW))).toEqual([2]);
    expect(ids(retainedVersionIds({ mode: "time", days: 15, keepLatest: true }, pg, NOW))).toEqual([1, 2]);
  });

  it("ignores versions that are not ready or partial", () => {
    const pg = page(1, [ver(1), ver(2, { status: "capturing" }), ver(3, { status: "evicted" })], []);
    expect(ids(retainedVersionIds({ mode: "all" }, pg, NOW))).toEqual([1]);
  });

  it("ties on fetchedAt are broken by version id, newest id first", () => {
    const t = NOW - DAY;
    const pg = page(1, [ver(1, { fetchedAt: t }), ver(2, { fetchedAt: t }), ver(3, { fetchedAt: t })], []);
    expect(ids(retainedVersionIds({ mode: "latest", count: 2 }, pg, NOW))).toEqual([2, 3]);
  });

  it("budget retains only the latest version, and only when the page fits", () => {
    const pg = page(1, three(), []);
    expect(ids(retainedVersionIds({ mode: "budget", bytes: 10 }, pg, NOW, [true]))).toEqual([3]);
    expect(ids(retainedVersionIds({ mode: "budget", bytes: 10 }, pg, NOW, [false]))).toEqual([]);
    const spec: RetentionSpec = { mode: "custom", combine: "union", rules: [{ mode: "budget", bytes: 1 }, { mode: "latest", count: 2 }] };
    expect(ids(retainedVersionIds(spec, pg, NOW, [false]))).toEqual([2, 3]);
  });

  it("evaluateBudget: newest pages first, shared blobs counted once, order ties by page id", () => {
    const pages = [
      { pageId: 3, lastCapturedAt: 100, blobs: [{ blobId: 1, storedBytes: 40 }, { blobId: 9, storedBytes: 10 }] },
      { pageId: 2, lastCapturedAt: 200, blobs: [{ blobId: 2, storedBytes: 30 }, { blobId: 9, storedBytes: 10 }] },
      { pageId: 1, lastCapturedAt: 300, blobs: [{ blobId: 3, storedBytes: 20 }] },
      { pageId: 4, lastCapturedAt: 50, blobs: [{ blobId: 4, storedBytes: 1 }] },
    ];
    // 300: 20; 200: +30 +10 = 60; 100: +40 = 100 (shared blob 9 not counted again); 50: +1 would exceed 100
    expect([...evaluateBudget(pages, 100)].sort()).toEqual([1, 2, 3]);
    expect([...evaluateBudget(pages, 59)].sort()).toEqual([1]);
    expect([...evaluateBudget(pages, 0)]).toEqual([]);
    expect([...evaluateBudget([...pages].reverse(), 100)].sort()).toEqual([1, 2, 3]);
  });
});

describe("T-01 effective priority", () => {
  it("is the minimum over the retaining references", () => {
    const pg = page(1, three(), [ref({ priority: 3 }), ref({ id: "src_b", priority: 2 }), ref({ id: "src_c", priority: 4 })]);
    expect(versionPriority(pg, 3, NOW).priority).toBe(2);
    expect(pagePriority(pg, NOW)).toBe(2);
  });
  it("a surplus version counts as P4, even when its page is P1", () => {
    const pg = page(1, three(), [ref({ priority: 1 })]);
    const old = versionPriority(pg, 1, NOW);
    expect(old).toMatchObject({ priority: 4, surplus: true });
    expect(versionPriority(pg, 3, NOW)).toMatchObject({ priority: 1, surplus: false });
  });
  it("a reference that does not retain a version does not lift its priority", () => {
    const pg = page(1, three(), [ref({ priority: 1, retention: { mode: "latest", count: 1 } }), ref({ id: "src_b", priority: 3, retention: { mode: "all" } })]);
    expect(versionPriority(pg, 2, NOW).priority).toBe(3);
    expect(versionPriority(pg, 3, NOW).priority).toBe(1);
  });
  it("a page without references is P4 and surplus", () => {
    const pg = page(1, three(), []);
    expect(pagePriority(pg, NOW)).toBe(4);
    expect(versionPriority(pg, 3, NOW).surplus).toBe(true);
  });
  it("a page with no live version is P4", () => {
    expect(pagePriority(page(1, [ver(1, { status: "evicted" })], [ref({ priority: 1 })]), NOW)).toBe(4);
  });
  it("pin, bookmark and collection references retain the latest version only", () => {
    const pg = page(1, three(), [ref({ kind: "pin", id: "pin", priority: 1, autoEvict: false })]);
    expect(versionPriority(pg, 3, NOW).priority).toBe(1);
    expect(versionPriority(pg, 2, NOW).surplus).toBe(true);
  });
  it("blob priority is the minimum over the versions that use it and skips evicted versions", () => {
    const a = page(1, [ver(1, { blobs: [{ blobId: 7, refs: 1 }, { blobId: 8, refs: 1 }] })], [ref({ priority: 1 })]);
    const b = page(2, [ver(2, { blobs: [{ blobId: 7, refs: 1 }] }), ver(3, { status: "evicted", blobs: [{ blobId: 8, refs: 1 }] })], [ref({ priority: 4 })]);
    const m = blobPriorities([a, b], NOW);
    expect(m.get(7)).toBe(1);
    expect(m.get(8)).toBe(1);
    const c = page(3, [ver(4, { blobs: [{ blobId: 5, refs: 1 }] })], [ref({ priority: 3 })]);
    expect(blobPriorities([c], NOW).get(5)).toBe(3);
  });
  it("is independent of the order of the references", () => {
    const refs = [ref({ priority: 3 }), ref({ id: "b", priority: 2 }), ref({ id: "c", priority: 4, retention: { mode: "all" } })];
    expect(versionPriority(page(1, three(), refs), 1, NOW).priority).toBe(versionPriority(page(1, three(), [...refs].reverse()), 1, NOW).priority);
  });
});
