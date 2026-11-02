import { DEFAULT_WEIGHTS } from "./priority.js";
import { DEFAULT_TRAPS } from "./traps.js";
import {
  CrawlConfigError, LINK_REGIONS, type ConfigIssue, type CrawlConfig, type CrawlMode, type LinkPolicy, type LinkRegion, type ProfileName,
  type ResourceProfile, type ScopeConfig, type TrapConfig,
} from "./types.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Caps a profile sets. Data, not code: `docs/implementation-plan.md` C-05 and this table are the same numbers. */
export interface ProfileCaps {
  maxDepth: number;
  maxPages: number;
  maxBytes: number;
  maxDurationMs: number;
  externalDepth: number;
  regions: LinkRegion[];
  minScore: number;
  maxLinksPerPage: number;
  queryVariantBudget: number;
  calendarBudget: number;
  maxUrlsPerHost: number;
  maxFrontier: number;
}

/** Scores can go below zero deep in a site (depth is subtracted), so "no minimum" is a large negative number. */
export const NO_MIN_SCORE = -1000;

const FOCUSED_REGIONS: LinkRegion[] = ["content", "heading"];
const BALANCED_REGIONS: LinkRegion[] = ["content", "heading", "related", "nav"];

/** Pi-scaled: `pi-lite` is roughly a third to a half of `standard` for pages and bytes. */
export const PROFILES: Record<Exclude<ProfileName, "custom">, Record<ResourceProfile, ProfileCaps>> = {
  focused: {
    "pi-lite": { maxDepth: 2, maxPages: 50, maxBytes: 100 * MIB, maxDurationMs: 30 * MIN, externalDepth: 0, regions: FOCUSED_REGIONS, minScore: 55, maxLinksPerPage: 30, queryVariantBudget: 4, calendarBudget: 6, maxUrlsPerHost: 500, maxFrontier: 1_000 },
    standard: { maxDepth: 3, maxPages: 100, maxBytes: 250 * MIB, maxDurationMs: HOUR, externalDepth: 0, regions: FOCUSED_REGIONS, minScore: 55, maxLinksPerPage: 50, queryVariantBudget: 6, calendarBudget: 8, maxUrlsPerHost: 1_000, maxFrontier: 2_000 },
  },
  balanced: {
    "pi-lite": { maxDepth: 3, maxPages: 200, maxBytes: 400 * MIB, maxDurationMs: 2 * HOUR, externalDepth: 0, regions: BALANCED_REGIONS, minScore: 20, maxLinksPerPage: 60, queryVariantBudget: 8, calendarBudget: 10, maxUrlsPerHost: 2_000, maxFrontier: 5_000 },
    standard: { maxDepth: 4, maxPages: 500, maxBytes: GIB, maxDurationMs: 4 * HOUR, externalDepth: 0, regions: BALANCED_REGIONS, minScore: 20, maxLinksPerPage: 100, queryVariantBudget: 12, calendarBudget: 12, maxUrlsPerHost: 5_000, maxFrontier: 10_000 },
  },
  comprehensive: {
    "pi-lite": { maxDepth: 5, maxPages: 1_000, maxBytes: GIB, maxDurationMs: 8 * HOUR, externalDepth: 0, regions: [...LINK_REGIONS], minScore: NO_MIN_SCORE, maxLinksPerPage: 200, queryVariantBudget: 12, calendarBudget: 12, maxUrlsPerHost: 5_000, maxFrontier: 10_000 },
    standard: { maxDepth: 8, maxPages: 5_000, maxBytes: 5 * GIB, maxDurationMs: 24 * HOUR, externalDepth: 0, regions: [...LINK_REGIONS], minScore: NO_MIN_SCORE, maxLinksPerPage: 400, queryVariantBudget: 20, calendarBudget: 16, maxUrlsPerHost: 20_000, maxFrontier: 40_000 },
  },
};

/** Nothing above these is accepted, whatever the profile or override (docs/api.md: hard server-side ceilings per resource profile). */
export const HARD_CEILINGS: Record<ResourceProfile, { maxDepth: number; maxPages: number; maxBytes: number; maxDurationMs: number; externalDepth: number; maxFrontier: number; maxUrlsPerHost: number }> = {
  "pi-lite": { maxDepth: 10, maxPages: 10_000, maxBytes: 2 * GIB, maxDurationMs: 24 * HOUR, externalDepth: 2, maxFrontier: 50_000, maxUrlsPerHost: 20_000 },
  standard: { maxDepth: 20, maxPages: 100_000, maxBytes: 20 * GIB, maxDurationMs: 72 * HOUR, externalDepth: 2, maxFrontier: 200_000, maxUrlsPerHost: 100_000 },
};

/** Politeness floors by resource profile (docs/architecture.md section 10). */
export const MIN_DELAY_MS: Record<ResourceProfile, number> = { "pi-lite": 1500, standard: 1000 };

export interface CrawlOverrides {
  limits?: Partial<CrawlConfig["limits"]>;
  scope?: Partial<ScopeConfig>;
  query?: Partial<CrawlConfig["query"]>;
  links?: Partial<Omit<LinkPolicy, "weights">> & { weights?: Partial<Omit<LinkPolicy["weights"], "region">> & { region?: Partial<LinkPolicy["weights"]["region"]> } };
  politeness?: Partial<CrawlConfig["politeness"]>;
  traps?: Partial<TrapConfig>;
}

export interface CrawlRequest {
  startUrls: string[];
  mode: CrawlMode;
  /** Default `balanced`. `custom` starts from `balanced` and needs the caps it changes in `overrides`. */
  profile?: ProfileName;
  /** From settings (`resources.profile`). Default `standard`. */
  resource?: ResourceProfile;
  /** Mirror only: stay inside the start URL's directory instead of the whole site. */
  section?: boolean;
  overrides?: CrawlOverrides;
  capture?: CrawlConfig["capture"];
  sourceId?: number;
  configId?: number;
  requestedBy?: CrawlConfig["requestedBy"];
  priority?: CrawlConfig["priority"];
}

function sectionPrefix(startUrl: string): string {
  const p = new URL(startUrl).pathname;
  const dir = p.endsWith("/") ? p : p.replace(/\/[^/]*$/, "/");
  return dir === "/" ? "/" : dir.replace(/\/$/, "");
}

/** The defaults for a mode, profile and resource profile, with any overrides applied. Throws `CrawlConfigError` when a value is invalid or above a hard ceiling. */
export function resolveCrawlConfig(req: CrawlRequest): CrawlConfig {
  const profile: ProfileName = req.profile ?? "balanced";
  const resource: ResourceProfile = req.resource ?? "standard";
  const caps = PROFILES[profile === "custom" ? "balanced" : profile][resource];
  const o = req.overrides ?? {};
  const issues: ConfigIssue[] = [];

  if (req.startUrls.length === 0) issues.push({ path: "startUrls", message: "Add at least one start address." });
  for (const [i, u] of req.startUrls.entries()) {
    try {
      const url = new URL(u);
      if (url.protocol !== "http:" && url.protocol !== "https:") issues.push({ path: `startUrls.${i}`, message: "Only http and https addresses can be crawled." });
      if (url.username || url.password) issues.push({ path: `startUrls.${i}`, message: "Addresses with a username or password cannot be crawled." });
    } catch {
      issues.push({ path: `startUrls.${i}`, message: "That is not a web address." });
    }
  }
  if (profile === "custom" && !req.overrides?.limits) issues.push({ path: "limits", message: "A custom profile needs its own limits." });

  const mirror = req.mode === "mirror";
  const capture = req.mode === "capture";
  const regions = mirror ? [...LINK_REGIONS] : caps.regions;
  const scope: ScopeConfig = {
    internal: mirror ? "subdomains" : "registrable",
    allowedDomains: [],
    excludedDomains: [],
    allowedPaths: mirror && req.section && req.startUrls[0] && issues.length === 0 ? [sectionPrefix(req.startUrls[0])] : [],
    excludedPaths: [],
    maxDepth: capture ? 0 : caps.maxDepth,
    externalDepth: mirror || capture ? 0 : caps.externalDepth,
    maxQueryParams: 6,
    ...o.scope,
  };
  const links: LinkPolicy = {
    regions,
    minScore: mirror ? NO_MIN_SCORE : caps.minScore,
    maxLinksPerPage: caps.maxLinksPerPage,
    weights: {
      ...DEFAULT_WEIGHTS,
      ...o.links?.weights,
      region: { ...DEFAULT_WEIGHTS.region, ...o.links?.weights?.region },
    },
    followNofollow: false,
    ...stripUndefined({ regions: o.links?.regions, minScore: o.links?.minScore, maxLinksPerPage: o.links?.maxLinksPerPage, followNofollow: o.links?.followNofollow }),
  };
  const traps: TrapConfig = {
    ...DEFAULT_TRAPS,
    queryVariantBudget: caps.queryVariantBudget,
    calendarBudget: caps.calendarBudget,
    maxUrlsPerHost: caps.maxUrlsPerHost,
    maxFrontier: caps.maxFrontier,
    ...o.traps,
  };
  const config: CrawlConfig = {
    startUrls: req.startUrls,
    mode: req.mode,
    profile,
    resource,
    limits: {
      maxPages: capture ? 1 : caps.maxPages,
      maxBytes: caps.maxBytes,
      maxDurationMs: caps.maxDurationMs,
      ...o.limits,
    },
    scope,
    query: { policy: "strip_tracking", allowParams: [], ...o.query },
    links,
    politeness: { minDelayMs: MIN_DELAY_MS[resource], perHostConcurrency: 1, assetConcurrency: 1, ...o.politeness },
    traps,
    ...(req.capture ? { capture: req.capture } : {}),
    ...(req.sourceId !== undefined ? { sourceId: req.sourceId } : {}),
    ...(req.configId !== undefined ? { configId: req.configId } : {}),
    ...(req.requestedBy ? { requestedBy: req.requestedBy } : {}),
    ...(req.priority ? { priority: req.priority } : {}),
  };
  issues.push(...validateCrawlConfig(config));
  if (issues.length) throw new CrawlConfigError(issues);
  return config;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Field-level problems with a resolved config, including every hard ceiling. Empty when valid. */
export function validateCrawlConfig(c: CrawlConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const ceil = HARD_CEILINGS[c.resource];
  const int = (path: string, v: number, min: number, max: number, what: string) => {
    if (!Number.isFinite(v) || !Number.isInteger(v)) issues.push({ path, message: `${what} must be a whole number.` });
    else if (v < min) issues.push({ path, message: `${what} must be at least ${min}.` });
    else if (v > max) issues.push({ path, message: `${what} cannot be more than ${max.toLocaleString("en-GB")} on the ${c.resource} profile.` });
  };
  int("limits.maxPages", c.limits.maxPages, 1, ceil.maxPages, "Pages");
  int("limits.maxBytes", c.limits.maxBytes, 1, ceil.maxBytes, "Bytes");
  int("limits.maxDurationMs", c.limits.maxDurationMs, 1000, ceil.maxDurationMs, "Duration");
  int("scope.maxDepth", c.scope.maxDepth, 0, ceil.maxDepth, "Depth");
  int("scope.externalDepth", c.scope.externalDepth, 0, ceil.externalDepth, "External depth");
  int("traps.maxFrontier", c.traps.maxFrontier, 1, ceil.maxFrontier, "Frontier size");
  int("traps.maxUrlsPerHost", c.traps.maxUrlsPerHost, 1, ceil.maxUrlsPerHost, "URLs per host");
  int("politeness.perHostConcurrency", c.politeness.perHostConcurrency, 1, 4, "Requests per host");
  int("politeness.minDelayMs", c.politeness.minDelayMs, 0, 600_000, "Delay");
  int("politeness.assetConcurrency", c.politeness.assetConcurrency, 1, 8, "Asset concurrency");
  if (c.politeness.minDelayMs < 0) issues.push({ path: "politeness.minDelayMs", message: "Delay cannot be negative." });
  if (c.links.regions.length === 0) issues.push({ path: "links.regions", message: "Choose at least one kind of link to follow." });
  for (const r of c.links.regions) if (!LINK_REGIONS.includes(r)) issues.push({ path: "links.regions", message: `Unknown link region "${r}".` });
  if (c.query.policy === "allowlist" && c.query.allowParams.length === 0) issues.push({ path: "query.allowParams", message: "List the parameters to keep, or choose another query policy." });
  if (c.mode === "capture" && (c.limits.maxPages !== 1 || c.scope.maxDepth !== 0)) issues.push({ path: "mode", message: "Capture saves exactly one page." });
  return issues;
}
