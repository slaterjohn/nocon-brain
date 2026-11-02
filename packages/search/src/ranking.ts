import type { RankingConfig, RankingWeights, ScoreExplanation } from "./types.js";

/** Defaults are documented in docs/api.md 6.1 and fixed by a stability test (S-08). */
export const DEFAULT_WEIGHTS: RankingWeights = { relevance: 1, exactTitle: 0.6, freshness: 0.08, linkGraph: 0.06, preference: 0.1, cached: 0.03 };
export const BM25_WEIGHTS = { title: 10, headings: 5, url: 3, body: 1 } as const;

export const DEFAULT_RANKING: RankingConfig = {
  weights: DEFAULT_WEIGHTS,
  preferences: { domains: {}, sources: {} },
  freshnessDays: 365,
  candidateCap: 300,
};

const DAY = 86_400_000;
const LINK_NORM = Math.log(101);

export interface ScoreInput {
  /** FTS5 bm25 (negative; lower is better) of this document. */
  bm25: number;
  /** The best (lowest) bm25 of the candidate set. */
  bestBm25: number;
  exactTitle: boolean;
  dateForRanking: number | null;
  inlinks: number;
  availability: string;
  domain: string;
  sourceIds: string[];
  now: number;
}

/** The ranking formula (docs/api.md 6.1). Pure, so it can be tested as a table. */
export function scoreDoc(i: ScoreInput, cfg: RankingConfig, matchedBy: ScoreExplanation["matchedBy"]): ScoreExplanation {
  const w = cfg.weights;
  // bm25 is negative; relevance is |bm25| over the best |bm25| so the best candidate is 1.
  const best = Math.abs(i.bestBm25);
  const relevance = best > 0 ? Math.min(1, Math.abs(i.bm25) / best) : 1;
  const age = i.dateForRanking ? Math.max(0, (i.now - i.dateForRanking) / DAY) : null;
  const freshness = age === null ? 0 : Math.exp(-age / cfg.freshnessDays);
  const linkGraph = Math.min(1, Math.log(1 + Math.max(0, i.inlinks)) / LINK_NORM);
  let preference = cfg.preferences.domains[i.domain] ?? 0;
  for (const s of i.sourceIds) preference += cfg.preferences.sources[s] ?? 0;
  for (const [d, v] of Object.entries(cfg.preferences.domains)) if (d !== i.domain && i.domain.endsWith("." + d)) preference += v;
  preference = Math.max(-1, Math.min(1, preference));
  const cached = i.availability === "archived" ? 1 : i.availability === "partial" ? 0.5 : 0;
  const parts: [ScoreExplanation["components"][number]["name"], number, number][] = [
    ["relevance", w.relevance, relevance],
    ["exactTitle", w.exactTitle, i.exactTitle ? 1 : 0],
    ["freshness", w.freshness, freshness],
    ["linkGraph", w.linkGraph, linkGraph],
    ["preference", w.preference, preference],
    ["cached", w.cached, cached],
  ];
  const components = parts.map(([name, weight, value]) => ({ name, weight, value: round(value), contribution: round(weight * value) }));
  const total = components.reduce((a, c) => a + c.contribution, 0);
  return { total: round(total), bm25: i.bm25, components, matchedBy };
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Sort order: score, then newer date, then lower page id: deterministic. */
export function compareHits(a: { score: number; date: number; pageId: number }, b: { score: number; date: number; pageId: number }): number {
  return b.score - a.score || b.date - a.date || a.pageId - b.pageId;
}

export function mergeRanking(base: RankingConfig, patch: { weights?: Partial<RankingWeights>; preferences?: Partial<RankingConfig["preferences"]> }): RankingConfig {
  return {
    ...base,
    weights: { ...base.weights, ...(patch.weights ?? {}) },
    preferences: { domains: patch.preferences?.domains ?? base.preferences.domains, sources: patch.preferences?.sources ?? base.preferences.sources },
  };
}
