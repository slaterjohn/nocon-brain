import { describe, expect, it } from "vitest";
import { compareHits, DEFAULT_RANKING, DEFAULT_WEIGHTS, scoreDoc } from "../src/ranking.js";

const base = { bm25: -2, bestBm25: -4, exactTitle: false, dateForRanking: Date.UTC(2026, 0, 1), inlinks: 0, availability: "archived", domain: "a.org", sourceIds: [] as string[], now: Date.UTC(2026, 0, 1) };

describe("S-08 ranking formula", () => {
  it("defaults are stable", () => {
    expect(DEFAULT_WEIGHTS).toEqual({ relevance: 1, exactTitle: 0.6, freshness: 0.08, linkGraph: 0.06, preference: 0.1, cached: 0.03 });
  });
  it.each([
    ["best bm25 gives relevance 1", { bm25: -4 }, "relevance", 1],
    ["half bm25 gives 0.5", { bm25: -2 }, "relevance", 0.5],
    ["fresh page has freshness 1", {}, "freshness", 1],
    ["one year old is e^-1", { dateForRanking: Date.UTC(2025, 0, 1) }, "freshness", Math.exp(-1)],
    ["no date means zero freshness", { dateForRanking: null }, "freshness", 0],
    ["100 in-links saturate", { inlinks: 100 }, "linkGraph", 1],
    ["no in-links", { inlinks: 0 }, "linkGraph", 0],
    ["partial pages get half the cached boost", { availability: "partial" }, "cached", 0.5],
    ["exact title", { exactTitle: true }, "exactTitle", 1],
  ])("%s", (_n, over, comp, value) => {
    const e = scoreDoc({ ...base, ...over } as never, DEFAULT_RANKING, "and");
    expect(e.components.find((c) => c.name === comp)!.value).toBeCloseTo(value as number, 5);
  });
  it("boosting a domain raises the score", () => {
    const plain = scoreDoc(base, DEFAULT_RANKING, "and").total;
    const boosted = scoreDoc(base, { ...DEFAULT_RANKING, preferences: { domains: { "a.org": 1 }, sources: {} } }, "and").total;
    expect(boosted).toBeCloseTo(plain + 0.1, 5);
  });
  it("ties break by date then page id, deterministically", () => {
    const hits = [{ score: 1, date: 5, pageId: 3 }, { score: 1, date: 9, pageId: 2 }, { score: 1, date: 9, pageId: 1 }, { score: 2, date: 1, pageId: 9 }];
    expect([...hits].sort(compareHits).map((h) => h.pageId)).toEqual([9, 1, 2, 3]);
  });
});
