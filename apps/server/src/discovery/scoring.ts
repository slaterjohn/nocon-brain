import { WEIGHT_NAMES, type WeightName } from "./settings.js";

/**
 * Candidate scoring (task D-03). A transparent weighted sum, no AI: every signal is turned into a number between 0 and 1 (`raw`),
 * multiplied by its weight (which may be negative, as for cost and storage pressure) to give that signal's `contribution`, and the
 * score is the sum of the contributions. The components are stored with the score and shown by the explain API.
 */

/** The facts a score is computed from. Counts come from the database; nothing here is text the Human typed. */
export interface Signals {
  /** Distinct archived pages that link to the candidate. */
  inboundArchivedLinks: number;
  /** Of those linking pages, how many belong to at least one collection. */
  linkingPagesInCollections: number;
  /** Days on which the candidate appeared in search results (only counted while search-driven discovery is on). */
  searchDays: number;
  /** Bookmarks of the candidate itself, plus bookmarked pages that link to it. */
  bookmarkHits: number;
  /** Milliseconds since the candidate was last seen (a link re-seen, a visit, a search). */
  sinceSeenMs: number;
  /** Priority (1 best, 4 least) of the best source among the linking pages, or null when none is known. */
  bestSourcePriority: number | null;
  /** Estimated download size in bytes, or null. */
  estimatedBytes: number | null;
  /** How full the storage is: 0 (plenty of room) to 1 (no room). */
  storagePressure: number;
}

export interface ScoreComponent {
  name: WeightName;
  raw: number;
  weight: number;
  contribution: number;
}

export interface ScoreResult {
  score: number;
  components: ScoreComponent[];
}

const DAY_MS = 86_400_000;
/** Round to six decimals so stored numbers add up exactly the way they are shown. */
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
/** n / (n + k): 0 at 0, 0.5 at k, approaching 1. */
const saturate = (n: number, k: number) => (n <= 0 ? 0 : n / (n + k));

/** Half-life of "recent activity" in days. */
export const RECENCY_HALF_LIFE_DAYS = 7;
/** A candidate this big (or bigger) gets the full cost penalty. */
export const COST_FULL_BYTES = 5 * 1024 * 1024;
const PRIORITY_RAW: Record<number, number> = { 1: 1, 2: 0.75, 3: 0.5, 4: 0.25 };

/** The raw value (0 to 1) of every signal. Pure and deterministic. */
export function rawValues(s: Signals): Record<WeightName, number> {
  const linking = Math.max(0, s.inboundArchivedLinks);
  return {
    inboundArchivedLinks: saturate(linking, 3),
    collectionRelevance: linking > 0 ? clamp01(s.linkingPagesInCollections / linking) : 0,
    searchFrequency: saturate(s.searchDays, 3),
    bookmarks: saturate(s.bookmarkHits, 1),
    recentActivity: clamp01(Math.pow(0.5, Math.max(0, s.sinceSeenMs) / (RECENCY_HALF_LIFE_DAYS * DAY_MS))),
    sourcePriority: s.bestSourcePriority == null ? 0 : (PRIORITY_RAW[Math.round(s.bestSourcePriority)] ?? 0),
    estimatedCost: s.estimatedBytes == null ? 0 : clamp01(s.estimatedBytes / COST_FULL_BYTES),
    storageHeadroom: clamp01(s.storagePressure),
  };
}

/**
 * Score from signals and weights. Components come back in the fixed order of `WEIGHT_NAMES`, each rounded to six decimals, and the
 * score is the sum of the rounded contributions, so the components add up to the score exactly.
 */
export function score(signals: Signals, weights: Record<WeightName, number>): ScoreResult {
  const raw = rawValues(signals);
  // The contribution is worked from the raw value as shown (rounded), so anyone can redo the multiplication.
  const components = WEIGHT_NAMES.map((name): ScoreComponent => ({
    name, raw: r6(raw[name]), weight: weights[name], contribution: r6(r6(raw[name]) * weights[name]),
  }));
  return { score: r6(components.reduce((n, c) => n + c.contribution, 0)), components };
}

/** One plain sentence per component, for the "why was this suggested?" view. */
export function describeComponent(c: ScoreComponent, s: Signals): string {
  const pts = `${c.contribution >= 0 ? "+" : ""}${c.contribution.toFixed(2)}`;
  switch (c.name) {
    case "inboundArchivedLinks": return `${s.inboundArchivedLinks} saved page${s.inboundArchivedLinks === 1 ? " links" : "s link"} to it (${pts})`;
    case "collectionRelevance": return `${s.linkingPagesInCollections} of the pages that link to it ${s.linkingPagesInCollections === 1 ? "is" : "are"} in one of your collections (${pts})`;
    case "searchFrequency": return s.searchDays > 0 ? `It showed up in your searches on ${s.searchDays} day${s.searchDays === 1 ? "" : "s"} (${pts})` : `No searches counted (${pts})`;
    case "bookmarks": return s.bookmarkHits > 0 ? `${s.bookmarkHits} bookmark${s.bookmarkHits === 1 ? "" : "s"} point${s.bookmarkHits === 1 ? "s" : ""} to it or to a page that links to it (${pts})` : `No bookmarks involved (${pts})`;
    case "recentActivity": return `It was last seen ${humanAge(s.sinceSeenMs)} ago (${pts})`;
    case "sourcePriority": return s.bestSourcePriority == null ? `No source of the pages linking to it is known (${pts})` : `The best source behind it has priority P${Math.round(s.bestSourcePriority)} (${pts})`;
    case "estimatedCost": return s.estimatedBytes == null ? `Download size unknown (${pts})` : `Roughly ${formatBytes(s.estimatedBytes)} to download (${pts})`;
    case "storageHeadroom": return `Storage is ${Math.round(clamp01(s.storagePressure) * 100)}% full (${pts})`;
  }
}

function humanAge(ms: number): string {
  const d = ms / DAY_MS;
  if (d >= 2) return `${Math.floor(d)} days`;
  const h = ms / 3_600_000;
  if (h >= 2) return `${Math.floor(h)} hours`;
  return `${Math.max(0, Math.floor(ms / 60_000))} minutes`;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}
