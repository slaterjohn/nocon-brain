import { describe, expect, it } from "vitest";
import { fuse, providerWeights } from "../../src/online/rrf.js";

const o = { k: 60, topN: 30 };

describe("weighted reciprocal rank fusion (O-05)", () => {
  it("matches the hand-computed table for fixed lists", () => {
    const out = fuse([
      { kind: "local", id: "archive", name: "Archive", weight: 1.5, keys: ["a", "b", "c"] },
      { kind: "provider", id: "p1", name: "P1", weight: 1, keys: ["b", "d", "a"] },
      { kind: "provider", id: "p2", name: "P2", weight: 0.7, keys: ["d", "b", "e"] },
    ], o);
    const score = (k: string) => out.find((x) => x.key === k)!.score;
    expect(score("a")).toBeCloseTo(1.5 / 61 + 1 / 63, 10);
    expect(score("b")).toBeCloseTo(1.5 / 62 + 1 / 61 + 0.7 / 62, 10);
    expect(score("c")).toBeCloseTo(1.5 / 63, 10);
    expect(score("d")).toBeCloseTo(1 / 62 + 0.7 / 61, 10);
    expect(score("e")).toBeCloseTo(0.7 / 63, 10);
    // Local hits first (b is promoted above a by the providers), then the online-only ones by score.
    expect(out.map((x) => x.key)).toEqual(["b", "a", "c", "d", "e"]);
    expect(out.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("breaks ties deterministically: local, score, provider rank, then the key", () => {
    const a = fuse([
      { kind: "provider", id: "p1", name: "P1", weight: 1, keys: ["z", "y"] },
      { kind: "provider", id: "p2", name: "P2", weight: 1, keys: ["y", "z"] },
    ], o);
    // Equal scores and equal best rank: the key string decides.
    expect(a.map((x) => x.key)).toEqual(["y", "z"]);
    const b = fuse([
      { kind: "provider", id: "p1", name: "P1", weight: 1, keys: ["m"] },
      { kind: "provider", id: "p2", name: "P2", weight: 1, keys: ["k"] },
    ], o);
    expect(b.map((x) => x.key)).toEqual(["k", "m"]);
    // The same input in another order of lists gives the same output.
    const c = fuse([
      { kind: "provider", id: "p2", name: "P2", weight: 1, keys: ["k"] },
      { kind: "provider", id: "p1", name: "P1", weight: 1, keys: ["m"] },
    ], o);
    expect(c.map((x) => x.key)).toEqual(b.map((x) => x.key));
  });

  it("only the top N of each list count and duplicates in a list count once", () => {
    const keys = Array.from({ length: 50 }, (_, i) => `k${i}`);
    const out = fuse([{ kind: "provider", id: "p", name: "P", weight: 1, keys: ["k0", "k0", ...keys] }], { k: 60, topN: 5 });
    expect(out.map((x) => x.key)).toEqual(["k0", "k1", "k2", "k3", "k4"]);
  });

  it("halves a second provider that overlaps an earlier one by at least half", () => {
    const w = providerWeights([
      { id: "a", weight: 1, keys: ["1", "2", "3", "4"] },
      { id: "b", weight: 1, keys: ["1", "2", "9", "8"] },
      { id: "c", weight: 1, keys: ["x", "y", "z"] },
    ], 0.7);
    expect(w.get("a")).toBe(1);
    expect(w.get("b")).toBe(0.7);
    expect(w.get("c")).toBe(1);
  });
});
