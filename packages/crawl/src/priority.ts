import type { LinkPolicy, LinkRegion, PriorityWeights } from "./types.js";

/** The region order the product promises: main article, headings, related, navigation, footer. `other` sits just above the footer. */
export const REGION_ORDER: readonly LinkRegion[] = ["content", "heading", "related", "nav", "other", "footer"];

/** The extractor's base scores (packages/content `REGION_BASE`) on a 0-100 scale. */
export const DEFAULT_WEIGHTS: PriorityWeights = {
  region: { content: 85, heading: 65, related: 45, nav: 28, footer: 10, other: 20 },
  quality: 100,
  depth: 1,
  external: 5,
  position: 0.5,
};

/** What the extractor stored for a link (`links` table). */
export interface LinkCandidate {
  url: string;
  region: LinkRegion;
  /** The extractor's score, 0 to 1 (region base + adjustment). */
  score: number;
  features?: { adjust?: number; anchorQuality?: string; urlShape?: string; position?: number } | null;
  /** Order of first appearance in the document. */
  position: number;
  isInternal?: boolean;
  relNofollow?: boolean;
  anchorText?: string;
}

export interface PriorityComponents {
  region: number;
  quality: number;
  depth: number;
  external: number;
  position: number;
}

export interface LinkPriority {
  total: number;
  components: PriorityComponents;
  region: LinkRegion;
}

const REGION_BASE_UNIT: Record<LinkRegion, number> = { content: 0.85, heading: 0.65, related: 0.45, nav: 0.28, footer: 0.1, other: 0.2 };
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Deterministic score for a link. The components are returned so they can be stored with the frontier row and read
 * back when a crawl is debugged. The extractor's own adjustment is reused from its stored features rather than
 * recomputed from HTML.
 */
export function scoreLink(link: LinkCandidate, targetDepth: number, external: boolean, weights: PriorityWeights = DEFAULT_WEIGHTS): LinkPriority {
  const adjust = link.features?.adjust ?? Math.max(-0.08, Math.min(0.06, link.score - REGION_BASE_UNIT[link.region]));
  const pos = link.features?.position ?? 0;
  const components: PriorityComponents = {
    region: weights.region[link.region] ?? 0,
    quality: round(adjust * weights.quality),
    depth: round(-weights.depth * targetDepth),
    external: external ? -weights.external : 0,
    position: round((1 - Math.min(1, Math.max(0, pos))) * weights.position),
  };
  const total = round(components.region + components.quality + components.depth + components.external + components.position);
  return { total, components, region: link.region };
}

export interface RankedLink<T extends LinkCandidate = LinkCandidate> {
  link: T;
  priority: LinkPriority;
}

/** Best first; ties by document position, then URL, so the order never depends on input order. */
export function rankLinks<T extends LinkCandidate>(
  links: readonly T[], targetDepth: number, isExternal: (l: T) => boolean, weights: PriorityWeights = DEFAULT_WEIGHTS,
): RankedLink<T>[] {
  return links
    .map((link) => ({ link, priority: scoreLink(link, targetDepth, isExternal(link), weights) }))
    .sort((a, b) => b.priority.total - a.priority.total || a.link.position - b.link.position || (a.link.url < b.link.url ? -1 : a.link.url > b.link.url ? 1 : 0));
}

export type LinkFilterReason = "filter:region" | "filter:nofollow" | "filter:min_score";

/** Applies the profile's region, nofollow and score rules to a ranked list (the per-page cap is applied after scope and trap checks, by the engine). Returns what to follow and what was dropped (with reasons). */
export function selectLinks<T extends LinkCandidate>(ranked: readonly RankedLink<T>[], policy: LinkPolicy): { follow: RankedLink<T>[]; dropped: { item: RankedLink<T>; reason: LinkFilterReason }[] } {
  const follow: RankedLink<T>[] = [];
  const dropped: { item: RankedLink<T>; reason: LinkFilterReason }[] = [];
  for (const r of ranked) {
    if (!policy.regions.includes(r.link.region)) dropped.push({ item: r, reason: "filter:region" });
    else if (r.link.relNofollow && !policy.followNofollow) dropped.push({ item: r, reason: "filter:nofollow" });
    else if (r.priority.total < policy.minScore) dropped.push({ item: r, reason: "filter:min_score" });
    else follow.push(r);
  }
  return { follow, dropped };
}
