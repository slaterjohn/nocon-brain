import { z } from "zod";
import { HARD_CEILINGS } from "@ncb/crawl";
import type { ResourceProfile } from "@ncb/crawl";

const MIB = 1024 * 1024;

/**
 * The most each discovery limit may ever be on a resource profile. The numbers are the crawl engine's hard ceilings
 * (`HARD_CEILINGS` in packages/crawl/src/profiles.ts), so discovery cannot be set to do more than a crawl is allowed to:
 *   depth -> maxDepth, queue length and candidate pool -> maxFrontier, requests a day -> maxPages, bytes a day -> maxBytes.
 */
export function profileMaximums(profile: ResourceProfile): { maxDepth: number; maxQueued: number; maxCandidates: number; maxRequestsPerDay: number; maxBytesPerDay: number } {
  const c = HARD_CEILINGS[profile];
  return { maxDepth: c.maxDepth, maxQueued: c.maxFrontier, maxCandidates: c.maxFrontier, maxRequestsPerDay: c.maxPages, maxBytesPerDay: c.maxBytes };
}

const bool = (d: boolean) => z.boolean().default(d);
const intIn = (d: number, min: number, max: number) => z.number().int().min(min).max(max).default(d);
const MAX_INT = 2 ** 40;

export const WEIGHT_NAMES = [
  "inboundArchivedLinks", "collectionRelevance", "searchFrequency", "bookmarks", "recentActivity", "sourcePriority", "estimatedCost", "storageHeadroom",
] as const;
export type WeightName = (typeof WEIGHT_NAMES)[number];

export const DEFAULT_WEIGHTS: Record<WeightName, number> = {
  inboundArchivedLinks: 30, collectionRelevance: 20, searchFrequency: 10, bookmarks: 25, recentActivity: 10, sourcePriority: 10,
  estimatedCost: -10, storageHeadroom: -15,
};

const weight = (name: WeightName) => z.number().min(-100).max(100).default(DEFAULT_WEIGHTS[name]);

/** The `discovery` settings group (docs/api.md "Discovery (Phase 7, as built)"). Everything is off by default. */
export function buildDiscoverySchema() {
  return z.object({
    /** Master switch. While it is off nothing collects, scores new candidates, runs or auto-caches. */
    enabled: bool(false),
    passive: z.object({
      fromLinks: bool(false),
      fromVisits: bool(false),
      fromBookmarks: bool(false),
      fromMissingLinks: bool(false),
      fromSavedSearches: bool(false),
    }).default({ fromLinks: false, fromVisits: false, fromBookmarks: false, fromMissingLinks: false, fromSavedSearches: false }),
    searchDriven: z.object({
      searchesInfluenceDiscovery: bool(false),
      autoCacheOpenedOnlinePages: bool(false),
      prioritiseFrequentTopics: bool(false),
      requireApproval: bool(true),
      backgroundBudget: z.object({
        maxRequestsPerDay: intIn(50, 0, MAX_INT),
        maxBytesPerDay: intIn(100 * MIB, 0, MAX_INT),
      }).default({ maxRequestsPerDay: 50, maxBytesPerDay: 100 * MIB }),
    }).default({
      searchesInfluenceDiscovery: false, autoCacheOpenedOnlinePages: false, prioritiseFrequentTopics: false, requireApproval: true,
      backgroundBudget: { maxRequestsPerDay: 50, maxBytesPerDay: 100 * MIB },
    }),
    active: z.object({
      mode: z.enum(["off", "approval", "automatic"]).default("off"),
      /** Public IDs of the sources automatic mode may download candidates for. Empty means none. */
      allowedSourceIds: z.array(z.string().min(1).max(64)).max(50).default([]),
      maxCandidatesPerRun: intIn(10, 1, MAX_INT),
      maxDepth: intIn(1, 1, 100),
      maxQueued: intIn(20, 1, MAX_INT),
      maxBytesPerDay: intIn(100 * MIB, 0, MAX_INT),
      maxRequestsPerDay: intIn(50, 0, MAX_INT),
      perSiteDailyCap: intIn(10, 1, MAX_INT),
      respectSchedule: bool(true),
      onlyWhenOnline: z.literal(true).default(true),
      /** Automatic mode downloads a candidate only when its score is at least this. */
      minScore: z.number().min(-1000).max(1000).default(10),
      /** Set by the server when automatic mode is switched on (the confirmation the Human gave). */
      automaticAcknowledgedAt: z.iso.datetime().nullable().default(null),
    }).default({
      mode: "off", allowedSourceIds: [], maxCandidatesPerRun: 10, maxDepth: 1, maxQueued: 20, maxBytesPerDay: 100 * MIB, maxRequestsPerDay: 50,
      perSiteDailyCap: 10, respectSchedule: true, onlyWhenOnline: true, minScore: 10, automaticAcknowledgedAt: null,
    }),
    pool: z.object({
      /** Most candidates waiting (new or approved) at once. A full pool refuses newcomers. */
      maxCandidates: intIn(500, 1, MAX_INT),
      expireAfterDays: intIn(30, 1, 3650),
      /** Most links one saved page may add as candidates. */
      maxLinksPerPage: intIn(25, 1, 200),
    }).default({ maxCandidates: 500, expireAfterDays: 30, maxLinksPerPage: 25 }),
    /** The global ceiling. Nothing the other keys say can go above it, and it cannot go above the resource profile's maximum. */
    ceilings: z.object({
      maxDepth: intIn(3, 1, MAX_INT),
      maxQueued: intIn(100, 1, MAX_INT),
      maxRequestsPerDay: intIn(200, 0, MAX_INT),
      maxBytesPerDay: intIn(512 * MIB, 0, MAX_INT),
    }).default({ maxDepth: 3, maxQueued: 100, maxRequestsPerDay: 200, maxBytesPerDay: 512 * MIB }),
    weights: z.object({
      inboundArchivedLinks: weight("inboundArchivedLinks"),
      collectionRelevance: weight("collectionRelevance"),
      searchFrequency: weight("searchFrequency"),
      bookmarks: weight("bookmarks"),
      recentActivity: weight("recentActivity"),
      sourcePriority: weight("sourcePriority"),
      estimatedCost: weight("estimatedCost"),
      storageHeadroom: weight("storageHeadroom"),
    }).default(DEFAULT_WEIGHTS),
  });
}

export type DiscoverySettings = z.output<ReturnType<typeof buildDiscoverySchema>>;

export interface SettingsIssue {
  path: string;
  message: string;
}

const fmt = (n: number) => n.toLocaleString("en-GB");

/**
 * Cross-field checks that need the resource profile: the global ceiling may not exceed the profile's maximum, and the limits below it
 * may not exceed the ceiling. Returns the problems with their field paths (empty when valid).
 */
export function validateDiscoverySettings(s: DiscoverySettings, profile: ResourceProfile): SettingsIssue[] {
  const issues: SettingsIssue[] = [];
  const max = profileMaximums(profile);
  const over = (path: string, v: number, limit: number, what: string, why: string) => {
    if (v > limit) issues.push({ path, message: `${what} cannot be more than ${fmt(limit)}${why}.` });
  };
  const on = ` on the ${profile} profile`;
  over("ceilings.maxDepth", s.ceilings.maxDepth, max.maxDepth, "The depth ceiling", on);
  over("ceilings.maxQueued", s.ceilings.maxQueued, max.maxQueued, "The queue ceiling", on);
  over("ceilings.maxRequestsPerDay", s.ceilings.maxRequestsPerDay, max.maxRequestsPerDay, "The requests-a-day ceiling", on);
  over("ceilings.maxBytesPerDay", s.ceilings.maxBytesPerDay, max.maxBytesPerDay, "The bytes-a-day ceiling", on);
  over("pool.maxCandidates", s.pool.maxCandidates, max.maxCandidates, "The candidate pool", on);
  const below = " (the global ceiling; raise the ceiling first)";
  over("active.maxDepth", s.active.maxDepth, s.ceilings.maxDepth, "Depth", below);
  over("active.maxQueued", s.active.maxQueued, s.ceilings.maxQueued, "Queue length", below);
  over("active.maxCandidatesPerRun", s.active.maxCandidatesPerRun, s.ceilings.maxQueued, "Candidates per run", below);
  over("active.maxRequestsPerDay", s.active.maxRequestsPerDay, s.ceilings.maxRequestsPerDay, "Requests a day", below);
  over("active.maxBytesPerDay", s.active.maxBytesPerDay, s.ceilings.maxBytesPerDay, "Bytes a day", below);
  over("active.perSiteDailyCap", s.active.perSiteDailyCap, s.ceilings.maxRequestsPerDay, "Requests per site a day", below);
  over("searchDriven.backgroundBudget.maxRequestsPerDay", s.searchDriven.backgroundBudget.maxRequestsPerDay, s.ceilings.maxRequestsPerDay, "Background requests a day", below);
  over("searchDriven.backgroundBudget.maxBytesPerDay", s.searchDriven.backgroundBudget.maxBytesPerDay, s.ceilings.maxBytesPerDay, "Background bytes a day", below);
  return issues;
}

/** What discovery may actually do right now: every limit is the smallest of the setting, the global ceiling and the profile maximum. */
export interface EffectiveLimits {
  maxDepth: number;
  maxQueued: number;
  maxCandidatesPerRun: number;
  maxCandidates: number;
  active: { maxRequestsPerDay: number; maxBytesPerDay: number };
  background: { maxRequestsPerDay: number; maxBytesPerDay: number };
  perSiteDailyCap: number;
}

export function effectiveLimits(s: DiscoverySettings, profile: ResourceProfile): EffectiveLimits {
  const m = profileMaximums(profile);
  const lo = (...xs: number[]) => Math.max(0, Math.min(...xs));
  const c = s.ceilings;
  const requests = lo(c.maxRequestsPerDay, m.maxRequestsPerDay);
  const bytes = lo(c.maxBytesPerDay, m.maxBytesPerDay);
  const queued = lo(s.active.maxQueued, c.maxQueued, m.maxQueued);
  return {
    maxDepth: Math.max(1, lo(s.active.maxDepth, c.maxDepth, m.maxDepth)),
    maxQueued: queued,
    maxCandidatesPerRun: lo(s.active.maxCandidatesPerRun, queued),
    maxCandidates: lo(s.pool.maxCandidates, m.maxCandidates),
    active: { maxRequestsPerDay: lo(s.active.maxRequestsPerDay, requests), maxBytesPerDay: lo(s.active.maxBytesPerDay, bytes) },
    background: { maxRequestsPerDay: lo(s.searchDriven.backgroundBudget.maxRequestsPerDay, requests), maxBytesPerDay: lo(s.searchDriven.backgroundBudget.maxBytesPerDay, bytes) },
    perSiteDailyCap: lo(s.active.perSiteDailyCap, requests),
  };
}
