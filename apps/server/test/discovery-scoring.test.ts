import { describe, expect, it } from "vitest";
import { score, rawValues, COST_FULL_BYTES, type Signals } from "../src/discovery/scoring.js";
import { DEFAULT_WEIGHTS, WEIGHT_NAMES, buildDiscoverySchema, effectiveLimits, profileMaximums, validateDiscoverySettings } from "../src/discovery/settings.js";

const DAY = 86_400_000;
const base: Signals = {
  inboundArchivedLinks: 0, linkingPagesInCollections: 0, searchDays: 0, bookmarkHits: 0, sinceSeenMs: 0, bestSourcePriority: null, estimatedBytes: null, storagePressure: 0,
};

describe("scoring (D-03)", () => {
  it("is deterministic: the same facts and weights always give the same score and components", () => {
    const s: Signals = { ...base, inboundArchivedLinks: 4, linkingPagesInCollections: 2, bookmarkHits: 1, sinceSeenMs: 3 * DAY, bestSourcePriority: 2, estimatedBytes: 1_000_000, storagePressure: 0.4, searchDays: 2 };
    const a = score(s, DEFAULT_WEIGHTS);
    const b = score({ ...s }, { ...DEFAULT_WEIGHTS });
    expect(b).toEqual(a);
    expect(a.components.map((c) => c.name)).toEqual([...WEIGHT_NAMES]);
  });

  it("the components add up to the score exactly", () => {
    const s: Signals = { ...base, inboundArchivedLinks: 7, linkingPagesInCollections: 3, bookmarkHits: 2, sinceSeenMs: 9 * DAY + 12345, bestSourcePriority: 3, estimatedBytes: 777_777, storagePressure: 0.337, searchDays: 5 };
    const r = score(s, { ...DEFAULT_WEIGHTS, bookmarks: 33.3333333, estimatedCost: -7.7777777 });
    expect(r.components.reduce((n, c) => n + c.contribution, 0)).toBeCloseTo(r.score, 12);
    for (const c of r.components) expect(c.contribution).toBeCloseTo(c.raw * c.weight, 6);
  });

  it("each raw value is between 0 and 1 and moves the documented way", () => {
    const more = (k: keyof Signals, v: number) => rawValues({ ...base, [k]: v } as Signals);
    expect(more("inboundArchivedLinks", 3).inboundArchivedLinks).toBeCloseTo(0.5, 9);
    expect(more("inboundArchivedLinks", 30).inboundArchivedLinks).toBeGreaterThan(more("inboundArchivedLinks", 3).inboundArchivedLinks);
    expect(rawValues({ ...base, inboundArchivedLinks: 4, linkingPagesInCollections: 1 }).collectionRelevance).toBeCloseTo(0.25, 9);
    expect(rawValues({ ...base, inboundArchivedLinks: 0, linkingPagesInCollections: 5 }).collectionRelevance).toBe(0);
    expect(more("bookmarkHits", 1).bookmarks).toBeCloseTo(0.5, 9);
    expect(rawValues({ ...base, sinceSeenMs: 0 }).recentActivity).toBe(1);
    expect(rawValues({ ...base, sinceSeenMs: 7 * DAY }).recentActivity).toBeCloseTo(0.5, 9);
    expect(rawValues({ ...base, bestSourcePriority: 1 }).sourcePriority).toBe(1);
    expect(rawValues({ ...base, bestSourcePriority: 4 }).sourcePriority).toBe(0.25);
    expect(rawValues({ ...base, bestSourcePriority: null }).sourcePriority).toBe(0);
    expect(rawValues({ ...base, estimatedBytes: COST_FULL_BYTES * 10 }).estimatedCost).toBe(1);
    expect(rawValues({ ...base, storagePressure: 7 }).storageHeadroom).toBe(1);
    expect(rawValues({ ...base, storagePressure: NaN }).storageHeadroom).toBe(0);
    for (const v of Object.values(rawValues({ ...base, inboundArchivedLinks: 99, bookmarkHits: 99, searchDays: 99, estimatedBytes: 1e12, storagePressure: 1, sinceSeenMs: -5 }))) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("changing a weight changes the ranking as documented", () => {
    const withLinks: Signals = { ...base, inboundArchivedLinks: 6 };
    const withBookmark: Signals = { ...base, bookmarkHits: 1 };
    const rank = (w: typeof DEFAULT_WEIGHTS) => (score(withLinks, w).score >= score(withBookmark, w).score ? "links first" : "bookmark first");
    // 6 links: 6/9 = 0.667 x 30 = 20; one bookmark: 0.5 x 25 = 12.5
    expect(rank(DEFAULT_WEIGHTS)).toBe("links first");
    expect(rank({ ...DEFAULT_WEIGHTS, bookmarks: 90 })).toBe("bookmark first");
    expect(rank({ ...DEFAULT_WEIGHTS, inboundArchivedLinks: 0 })).toBe("bookmark first");
    // Negative weights push a candidate down: a bigger download scores lower.
    const small = score({ ...base, estimatedBytes: 100_000 }, DEFAULT_WEIGHTS).score;
    const big = score({ ...base, estimatedBytes: COST_FULL_BYTES }, DEFAULT_WEIGHTS).score;
    expect(big).toBeLessThan(small);
    expect(score({ ...base, estimatedBytes: COST_FULL_BYTES }, { ...DEFAULT_WEIGHTS, estimatedCost: 0 }).score).toBe(score(base, { ...DEFAULT_WEIGHTS, estimatedCost: 0 }).score);
  });
});

describe("discovery settings", () => {
  const schema = buildDiscoverySchema();

  it("every default is off or conservative", () => {
    const d = schema.parse({});
    expect(d.enabled).toBe(false);
    expect(d.passive).toEqual({ fromLinks: false, fromVisits: false, fromBookmarks: false, fromMissingLinks: false, fromSavedSearches: false });
    expect(d.searchDriven).toMatchObject({ searchesInfluenceDiscovery: false, autoCacheOpenedOnlinePages: false, prioritiseFrequentTopics: false, requireApproval: true });
    expect(d.active.mode).toBe("off");
    expect(d.active.allowedSourceIds).toEqual([]);
    expect(d.active.onlyWhenOnline).toBe(true);
    expect(d.weights).toEqual(DEFAULT_WEIGHTS);
    expect(validateDiscoverySettings(d, "pi-lite")).toEqual([]);          // the defaults fit the smaller profile
    expect(schema.parse({ active: { onlyWhenOnline: true } }).active.onlyWhenOnline).toBe(true);
    expect(schema.safeParse({ active: { onlyWhenOnline: false } }).success).toBe(false);
    expect(schema.safeParse({ weights: { bookmarks: 101 } }).success).toBe(false);
  });

  it("the ceiling and everything under it is checked against the profile and the ceiling", () => {
    const d = schema.parse({ ceilings: { maxDepth: 11 } });
    expect(validateDiscoverySettings(d, "pi-lite").map((i) => i.path)).toContain("ceilings.maxDepth");
    expect(validateDiscoverySettings(d, "standard")).toEqual([]);
    const e = schema.parse({ active: { maxDepth: 5 } });
    expect(validateDiscoverySettings(e, "standard").map((i) => i.path)).toEqual(["active.maxDepth"]);
  });

  it("the limits in force are the smallest of the setting, the ceiling and the profile maximum", () => {
    const d = schema.parse({ active: { maxDepth: 2, maxRequestsPerDay: 50 }, ceilings: { maxDepth: 3, maxRequestsPerDay: 20 } });
    const eff = effectiveLimits(d, "pi-lite");
    expect(eff.maxDepth).toBe(2);
    expect(eff.active.maxRequestsPerDay).toBe(20);
    const wild = schema.parse({ active: { maxDepth: 100, maxQueued: 1e12, maxBytesPerDay: 2 ** 40 }, ceilings: { maxDepth: 1e6, maxQueued: 1e12, maxRequestsPerDay: 1e12, maxBytesPerDay: 2 ** 40 } });
    const max = profileMaximums("pi-lite");
    const eff2 = effectiveLimits(wild, "pi-lite");
    expect(eff2.maxDepth).toBe(max.maxDepth);
    expect(eff2.maxQueued).toBe(max.maxQueued);
    expect(eff2.active.maxBytesPerDay).toBe(max.maxBytesPerDay);
  });
});
