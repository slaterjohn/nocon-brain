/** Shapes shared by the index implementation and its callers (S-01). */

export type DocType = "html" | "pdf" | "image" | "text" | "other";
export type FtsGroup = "en" | "default";

/** One searchable page, as the loader builds it from `main.db` and the stored content. */
export interface IndexDoc {
  pageId: number;
  versionId: number | null;
  publicPageId: string;
  url: string;
  domain: string;
  registrableDomain: string;
  title: string;
  description: string;
  keywords: string;
  headings: string;
  body: string;
  /** Primary language subtag ("en"), null when unknown. */
  lang: string | null;
  type: DocType;
  origin: string;
  capturedAt: number | null;
  publishedAt: number | null;
  availability: "archived" | "partial";
  priority: number | null;
  inlinks: number;
  contentHash: string | null;
  sourceIds: string[];
  collectionIds: string[];
}

export interface IndexStats {
  generationId: number;
  schemaVersion: number;
  builtAt: number | null;
  lastAppliedOutboxId: number;
  docs: number;
  groups: { en: number; default: number };
  vocabTerms: number;
  sizeBytes: number;
  lastOptimizeAt: number | null;
  tokenizers: string;
}

export interface Filters {
  sources?: string[];
  collections?: string[];
  domains?: string[];
  types?: string[];
  languages?: string[];
  availability?: string[];
  downloadedFrom?: number;
  downloadedTo?: number;
  publishedFrom?: number;
  publishedTo?: number;
}

export interface SearchParams {
  query: string;
  page?: number;
  pageSize?: number;
  filters?: Filters;
  typo?: boolean;
  synonyms?: boolean;
  group?: boolean;
  facets?: boolean;
  debug?: boolean;
}

export interface RankingWeights {
  relevance: number;
  exactTitle: number;
  freshness: number;
  linkGraph: number;
  preference: number;
  cached: number;
}

export interface RankingConfig {
  weights: RankingWeights;
  preferences: { domains: Record<string, number>; sources: Record<string, number> };
  /** Freshness half-life style constant in days: freshness = exp(-ageDays / freshnessDays). */
  freshnessDays: number;
  /** Candidate cap per query. */
  candidateCap: number;
}

export interface SynonymEntry { term: string; expansions: string[]; kind: "twoway" | "oneway" }
export interface SynonymConfig { enabled: boolean; items: SynonymEntry[] }

export interface ScoreComponent { name: "relevance" | "exactTitle" | "freshness" | "linkGraph" | "preference" | "cached"; weight: number; value: number; contribution: number }
export interface ScoreExplanation { total: number; bm25: number; components: ScoreComponent[]; matchedBy: "and" | "or" | "corrected" | "exact_title" }

export interface Hit {
  docId: number;
  pageId: number;
  publicPageId: string;
  url: string;
  domain: string;
  title: string;
  titleHtml: string;
  snippet: string;
  type: DocType;
  lang: string | null;
  capturedAt: number | null;
  publishedAt: number | null;
  availability: "archived" | "partial";
  score: number;
  rank: number;
  explain?: ScoreExplanation;
  alsoAt?: { pageId: number; publicPageId: string; url: string; title: string }[];
}

export interface Facet { value: string; label: string; count: number }
export interface Facets {
  sources: Facet[]; collections: Facet[]; domains: Facet[]; types: Facet[]; languages: Facet[]; availability: Facet[];
  downloaded: Facet[]; published: Facet[]; approximate: boolean;
}

export interface DidYouMean { text: string; corrected: { from: string; to: string }[]; appliedAutomatically: boolean }

export interface SearchOutput {
  parsed: { terms: string[]; phrases: string[]; excluded: string[]; operators: Record<string, string>; warnings: string[] };
  hits: Hit[];
  total: number;
  totalCapped: boolean;
  facets?: Facets;
  didYouMean?: DidYouMean;
  tookMs: number;
  hasMore: boolean;
  plan?: unknown;
}

export type Suggestion =
  | { kind: "title"; text: string; url: string; pageId: string; domain: string }
  | { kind: "query"; text: string }
  | { kind: "domain"; text: string; count: number }
  | { kind: "term"; text: string };

export interface SuggestOutput { items: Suggestion[]; didYouMean?: DidYouMean; tookMs: number }

export interface BuildOptions {
  generationId: number;
  /** Highest outbox id observed when the build began; replay starts after it. */
  outboxStart: number;
}

/**
 * The seam between the app and the search engine (docs/technology-decisions.md, D-Search). The FTS5 implementation
 * lives in this package; another engine can implement the same methods. Writers and readers are separate roles:
 * `upsert`, `remove`, `patch` and `rebuild` are used by the one writer, `search` and `suggest` by read-only connections.
 */
export interface SearchIndex {
  upsert(doc: IndexDoc): void;
  remove(pageId: number): boolean;
  search(params: SearchParams): SearchOutput;
  suggest(q: string, limit: number): SuggestOutput;
  rebuild(docs: Iterable<IndexDoc>, opts: BuildOptions): { docs: number; ms: number };
  stats(): IndexStats;
  close(): void;
}
