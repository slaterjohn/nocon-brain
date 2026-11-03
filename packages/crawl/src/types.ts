/** Shared types for the crawl rules. Everything here is plain JSON so a resolved config can be stored and replayed. */

export type CrawlMode = "capture" | "explore" | "mirror";
export type ProfileName = "focused" | "balanced" | "comprehensive" | "custom";
export type ResourceProfile = "pi-lite" | "standard";
export type QueryPolicyName = "keep_all" | "strip_tracking" | "allowlist" | "drop_all";
/** Link regions as the extractor reports them (`links.region`). `content` is the main article. */
export type LinkRegion = "content" | "heading" | "related" | "nav" | "footer" | "other";
export const LINK_REGIONS: readonly LinkRegion[] = ["content", "heading", "related", "nav", "footer", "other"];

/** How far "internal" reaches from the start URLs. */
export type InternalRule = "host" | "subdomains" | "registrable";

export interface ScopeConfig {
  /**
   * `host`: exactly the start hosts. `subdomains`: a start host and everything below it (a leading `www.` is ignored).
   * `registrable`: any host with the same registrable domain, using the public suffix list (private suffixes such as
   * `github.io` count, so `a.github.io` and `b.github.io` are different sites).
   */
  internal: InternalRule;
  /** Extra internal domains. `example.com` matches the host and its subdomains, `*.example.com` only subdomains. */
  allowedDomains: string[];
  /** Same syntax. Beats everything else. */
  excludedDomains: string[];
  /** Internal URLs must match one of these (empty = no restriction). A plain path is a prefix at a segment boundary; anything with `* ? [ {` is a glob. */
  allowedPaths: string[];
  /** Same syntax. Beats `allowedPaths`, and applies to external URLs too. */
  excludedPaths: string[];
  /** Deepest link distance from a start URL. */
  maxDepth: number;
  /** 0 = never leave the internal scope. 1 = fetch external pages one hop away (and no further). */
  externalDepth: number;
  /** URLs with more query parameters than this are skipped. */
  maxQueryParams: number;
}

export interface QueryConfig {
  policy: QueryPolicyName;
  /** For `allowlist`: the only parameters kept. */
  allowParams: string[];
}

export interface PriorityWeights {
  /** Base score by region. The order content > heading > related > nav > footer is what the weights default to. */
  region: Record<LinkRegion, number>;
  /** Multiplier for the extractor's own adjustment (anchor quality, URL shape, position), which is clamped to [-0.08, 0.06]. */
  quality: number;
  /** Subtracted per level of depth of the target. */
  depth: number;
  /** Subtracted from external targets. */
  external: number;
  /** Tie-break: earlier links in the document score slightly higher. */
  position: number;
}

export interface LinkPolicy {
  /** Only links in these regions are followed. */
  regions: LinkRegion[];
  /** Links whose total priority is below this are not followed. */
  minScore: number;
  /** At most this many links are followed from one page (best first). */
  maxLinksPerPage: number;
  weights: PriorityWeights;
  /** Follow `rel="nofollow"` links. Default false. */
  followNofollow: boolean;
}

export interface TrapConfig {
  /** One segment repeated this many times in a row is a trap (`/a/a/a`); a block of 2 to 4 segments repeating one time fewer is too (`/a/b/a/b`). */
  repeatThreshold: number;
  /** One segment appearing more than this many times anywhere in the path. */
  maxSegmentOccurrences: number;
  maxPathSegments: number;
  /** Distinct date-templated pages per URL template. */
  calendarBudget: number;
  /** Dates further than this from the first one seen on a template are skipped. */
  calendarWindowDays: number;
  /** Distinct query variants per path. */
  queryVariantBudget: number;
  /** This many identical-content pages in a row from one URL family blocks the family. */
  duplicateStreak: number;
  /** URLs queued per host. */
  maxUrlsPerHost: number;
  /** Rows waiting in the frontier. */
  maxFrontier: number;
}

export interface PolitenessConfig {
  /** Minimum gap between two requests to one host. Raised to the robots.txt `Crawl-delay` when that is larger. */
  minDelayMs: number;
  /** Simultaneous requests per host. Fixed at 1 unless the operator raises it. */
  perHostConcurrency: number;
  /** Parallel sub-resource fetches during a page capture. */
  assetConcurrency: number;
}

export interface CrawlLimits {
  maxPages: number;
  maxBytes: number;
  /** Wall-clock budget, excluding time spent paused. */
  maxDurationMs: number;
}

/** A crawl of Wikipedia articles (task Z-08): the engine asks the Wikipedia adapter which links to skip and which to try first. */
export interface WikipediaCrawlOptions {
  language: string;
  /** Save the images of each article, with their licence details. */
  images: boolean;
  /** An article that an enabled knowledge package already holds is linked to the package copy, not fetched. */
  preferZim: boolean;
  skipDisambiguation: boolean;
  skipLists: boolean;
  skipYears: boolean;
}

/** What `startCrawl` takes: a fully resolved crawl. Build it with `resolveCrawlConfig`. */
export interface CrawlConfig {
  startUrls: string[];
  mode: CrawlMode;
  profile: ProfileName;
  resource: ResourceProfile;
  limits: CrawlLimits;
  scope: ScopeConfig;
  query: QueryConfig;
  links: LinkPolicy;
  politeness: PolitenessConfig;
  traps: TrapConfig;
  /** Passed to the capture pipeline for every page. */
  capture?: { priority?: 1 | 2 | 3 | 4; versioning?: unknown; caps?: Record<string, number> };
  sourceId?: number;
  configId?: number;
  requestedBy?: "user" | "schedule" | "discovery" | "search" | "system";
  /** Download queue priority 1 (protected) to 4. Default 3. */
  priority?: 1 | 2 | 3 | 4;
  /** Set for a Wikipedia crawl: the engine then uses the Wikipedia adapter (skip rules, lead-first ranking, no robots.txt for the API). */
  wikipedia?: WikipediaCrawlOptions;
}

export type StopReason = "completed" | "max_pages" | "max_bytes" | "max_depth" | "deadline" | "source_budget" | "volume_full" | "cancelled";

export interface ConfigIssue {
  path: string;
  message: string;
}

export class CrawlConfigError extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super(`Invalid crawl configuration: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.name = "CrawlConfigError";
  }
}
