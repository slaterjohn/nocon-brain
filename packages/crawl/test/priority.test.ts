import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEIGHTS, rankLinks, REGION_ORDER, scoreLink, selectLinks, type LinkCandidate, type LinkPolicy, type LinkRegion, type PriorityWeights,
} from "../src/index.js";

const BASE: Record<LinkRegion, number> = { content: 0.85, heading: 0.65, related: 0.45, nav: 0.28, footer: 0.1, other: 0.2 };
const link = (region: LinkRegion, position: number, extra: Partial<LinkCandidate> = {}): LinkCandidate => ({
  url: `https://x.test/${region}/${position}`, region, score: BASE[region], features: { adjust: 0, position: position / 10 }, position, ...extra,
});

// The regions of a linkGraph page, in document order.
const page: LinkCandidate[] = [
  link("nav", 0), link("nav", 1), link("heading", 2), link("content", 3), link("content", 4), link("related", 5), link("footer", 6), link("footer", 7),
];

describe("link priority order", () => {
  it("ranks main article, then headings, related, navigation, footer", () => {
    const ranked = rankLinks(page, 1, () => false);
    const order = ranked.map((r) => r.link.region);
    const firstIndex = (r: LinkRegion) => order.indexOf(r);
    expect([firstIndex("content"), firstIndex("heading"), firstIndex("related"), firstIndex("nav"), firstIndex("footer")]).toEqual([0, 2, 3, 4, 6]);
  });

  it("is stable whatever order the links arrive in", () => {
    const a = rankLinks(page, 1, () => false).map((r) => r.link.url);
    const b = rankLinks([...page].reverse(), 1, () => false).map((r) => r.link.url);
    const c = rankLinks([...page].sort((x, y) => (x.url < y.url ? -1 : 1)), 1, () => false).map((r) => r.link.url);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("breaks ties by document position, then by URL", () => {
    const l1 = link("content", 5, { url: "https://x.test/z", features: { adjust: 0, position: 0 } });
    const l2 = link("content", 5, { url: "https://x.test/a", features: { adjust: 0, position: 0 } });
    const l3 = link("content", 2, { url: "https://x.test/m", features: { adjust: 0, position: 0 } });
    expect(rankLinks([l1, l2, l3], 1, () => false).map((r) => r.link.url)).toEqual(["https://x.test/m", "https://x.test/a", "https://x.test/z"]);
  });

  it("the default region weights follow the documented order", () => {
    const w = DEFAULT_WEIGHTS.region;
    const ordered = REGION_ORDER.map((r) => w[r]);
    expect(ordered).toEqual([...ordered].sort((x, y) => y - x));
  });

  it("the extractor adjustment never lifts a region above the one before it", () => {
    const best = (r: LinkRegion) => scoreLink(link(r, 0, { features: { adjust: 0.06, position: 0 } }), 1, false).total;
    const worst = (r: LinkRegion) => scoreLink(link(r, 9, { features: { adjust: -0.08, position: 1 } }), 1, false).total;
    expect(worst("content")).toBeGreaterThan(best("heading"));
    expect(worst("heading")).toBeGreaterThan(best("related"));
    expect(worst("related")).toBeGreaterThan(best("nav"));
    expect(worst("nav")).toBeGreaterThan(best("footer"));
  });
});

describe("components", () => {
  it("are stored with the total and add up", () => {
    const p = scoreLink(link("heading", 3, { features: { adjust: 0.03, position: 0.5 } }), 2, true);
    const sum = Object.values(p.components).reduce((a, b) => a + b, 0);
    expect(Math.round(sum * 1000) / 1000).toBe(p.total);
    expect(p.components).toEqual({ region: 65, quality: 3, depth: -2, external: -5, position: 0.25 });
  });

  it("falls back to the extractor's score when features are missing", () => {
    const p = scoreLink({ url: "u", region: "content", score: 0.89, position: 0 }, 0, false);
    expect(p.components.quality).toBe(4);
  });

  it("clamps a fallback adjustment to the extractor's range", () => {
    expect(scoreLink({ url: "u", region: "content", score: 1.5, position: 0 }, 0, false).components.quality).toBe(6);
    expect(scoreLink({ url: "u", region: "content", score: 0, position: 0 }, 0, false).components.quality).toBe(-8);
  });

  it("deeper targets and external targets score lower", () => {
    const l = link("content", 0);
    expect(scoreLink(l, 1, false).total).toBeGreaterThan(scoreLink(l, 4, false).total);
    expect(scoreLink(l, 1, false).total).toBeGreaterThan(scoreLink(l, 1, true).total);
  });
});

describe("configurable weights change the order predictably", () => {
  const w = (over: Partial<Omit<PriorityWeights, "region">> & { region?: Partial<Record<LinkRegion, number>> }): PriorityWeights => ({
    ...DEFAULT_WEIGHTS, ...over, region: { ...DEFAULT_WEIGHTS.region, ...over.region },
  });
  const order = (weights: PriorityWeights) => rankLinks(page, 1, () => false, weights).map((r) => r.link.region);

  it("raising nav above content puts navigation first", () => {
    expect(order(w({ region: { nav: 200 } }))[0]).toBe("nav");
  });
  it("zeroing the footer puts it last, and it stays there", () => {
    expect(order(w({ region: { footer: 0 } })).slice(-2)).toEqual(["footer", "footer"]);
  });
  it("swapping related and heading swaps their positions", () => {
    const o = order(w({ region: { related: 65, heading: 45 } }));
    expect(o.indexOf("related")).toBeLessThan(o.indexOf("heading"));
  });
  it("a larger position weight makes earlier links win inside a region", () => {
    const ranked = rankLinks(page.filter((l) => l.region === "content"), 1, () => false, w({ position: 50 }));
    expect(ranked[0]!.link.position).toBe(3);
  });
  it("equal region weights leave document order", () => {
    const flat = w({ region: { content: 50, heading: 50, related: 50, nav: 50, footer: 50, other: 50 } });
    expect(rankLinks(page, 1, () => false, flat).map((r) => r.link.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
  it("a heavier depth weight lowers every score by the same amount per level", () => {
    const a = scoreLink(link("content", 0), 3, false, w({ depth: 1 })).total;
    const b = scoreLink(link("content", 0), 3, false, w({ depth: 3 })).total;
    expect(a - b).toBe(6);
  });
});

describe("selectLinks", () => {
  const policy = (over: Partial<LinkPolicy> = {}): LinkPolicy => ({ regions: ["content", "heading"], minScore: 0, maxLinksPerPage: 100, weights: DEFAULT_WEIGHTS, followNofollow: false, ...over });
  const ranked = () => rankLinks(page, 1, () => false);

  it("keeps only the allowed regions", () => {
    const { follow, dropped } = selectLinks(ranked(), policy());
    expect(new Set(follow.map((r) => r.link.region))).toEqual(new Set(["content", "heading"]));
    expect(dropped.every((d) => d.reason === "filter:region")).toBe(true);
    expect(follow.length + dropped.length).toBe(page.length);
  });
  it("drops links under the minimum score", () => {
    const { follow, dropped } = selectLinks(ranked(), policy({ regions: ["content", "heading", "related", "nav", "footer"], minScore: 40 }));
    expect(follow.map((r) => r.link.region)).not.toContain("nav");
    expect(dropped.filter((d) => d.reason === "filter:min_score").length).toBe(4);
  });
  it("skips nofollow links unless asked", () => {
    const nf = [link("content", 0, { relNofollow: true }), link("content", 1)];
    expect(selectLinks(rankLinks(nf, 1, () => false), policy()).follow.length).toBe(1);
    expect(selectLinks(rankLinks(nf, 1, () => false), policy({ followNofollow: true })).follow.length).toBe(2);
  });
  it("a wider region list follows more links", () => {
    const narrow = selectLinks(ranked(), policy()).follow.length;
    const wide = selectLinks(ranked(), policy({ regions: ["content", "heading", "related", "nav", "footer", "other"] })).follow.length;
    expect(wide).toBeGreaterThan(narrow);
  });
});
