/**
 * Weighted reciprocal rank fusion (docs/research/search-providers.md, docs/api.md section 6.2).
 * `score(d) = sum over lists of weight / (k + rank)`; ranks are 1-based. Pure and deterministic.
 */

export type SourceKind = "local" | "zim" | "provider";

export interface RankedList {
  kind: SourceKind;
  id: string;
  name: string;
  weight: number;
  /** Canonical keys, best first. */
  keys: string[];
}

export interface FusedItem {
  key: string;
  score: number;
  /** 1-based position in the fused order. */
  rank: number;
  sources: { kind: SourceKind; id: string; name: string; rank: number; weight: number }[];
  hasLocal: boolean;
  /** Best (smallest) rank among provider lists, Infinity when none. */
  bestProviderRank: number;
}

export interface FuseOptions {
  k: number;
  /** Only the first `topN` of each list count. */
  topN: number;
}

const EPS = 1e-12;

export function fuse(lists: RankedList[], o: FuseOptions): FusedItem[] {
  const items = new Map<string, FusedItem>();
  for (const list of lists) {
    const seen = new Set<string>();
    let rank = 0;
    for (const key of list.keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      rank++;
      if (rank > o.topN) break;
      let it = items.get(key);
      if (!it) { it = { key, score: 0, rank: 0, sources: [], hasLocal: false, bestProviderRank: Infinity }; items.set(key, it); }
      it.score += list.weight / (o.k + rank);
      it.sources.push({ kind: list.kind, id: list.id, name: list.name, rank, weight: list.weight });
      if (list.kind === "local" || list.kind === "zim") it.hasLocal = true;
      if (list.kind === "provider") it.bestProviderRank = Math.min(it.bestProviderRank, rank);
    }
  }
  const out = [...items.values()].sort(compareFused);
  out.forEach((it, i) => { it.rank = i + 1; });
  return out;
}

/** Local first, then higher score, then earlier provider rank, then the key string. */
export function compareFused(a: FusedItem, b: FusedItem): number {
  if (a.hasLocal !== b.hasLocal) return a.hasLocal ? -1 : 1;
  if (Math.abs(a.score - b.score) > EPS) return b.score - a.score;
  if (a.bestProviderRank !== b.bestProviderRank) return a.bestProviderRank - b.bestProviderRank;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Weights for provider lists. Providers are taken in `order` (priority, then id). A provider whose list overlaps an earlier
 * one in at least `threshold` of the smaller list gets its weight multiplied by `secondary`.
 */
export function providerWeights(
  lists: { id: string; weight: number; keys: string[] }[], secondary: number, threshold = 0.5,
): Map<string, number> {
  const out = new Map<string, number>();
  lists.forEach((l, i) => {
    let w = l.weight;
    const mine = new Set(l.keys);
    for (let j = 0; j < i; j++) {
      const other = lists[j]!.keys;
      const smaller = Math.min(mine.size, new Set(other).size);
      if (smaller === 0) continue;
      let common = 0;
      for (const k of new Set(other)) if (mine.has(k)) common++;
      if (common / smaller >= threshold) { w = l.weight * secondary; break; }
    }
    out.set(l.id, w);
  });
  return out;
}
