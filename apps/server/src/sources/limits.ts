import type { PriorityNumber } from "@ncb/shared";

export type ResourceProfile = "pi-lite" | "standard";
export type SourceProfile = "focused" | "balanced" | "comprehensive" | "custom";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/**
 * Hard server-side ceilings for a source's crawl limits (docs/api.md section 7). They depend on the resource profile
 * chosen in setup (and never above the crawl engine's own ceilings in @ncb/crawl), so a Raspberry Pi cannot be asked to hold a 100,000-page mirror by accident. No request can raise them.
 */
export interface SourceCeilings {
  depth: number;
  maxPages: number;
  maxBytes: number;
  maxDurationSeconds: number;
  concurrency: number;
  retries: number;
  externalDepth: number;
  /** Smallest delay between requests to one host. */
  minPerDomainDelayMs: number;
}

export const CEILINGS: Record<ResourceProfile, SourceCeilings> = {
  "pi-lite": {
    depth: 5, maxPages: 5_000, maxBytes: 2 * GIB, maxDurationSeconds: 6 * 3600, concurrency: 2, retries: 3, externalDepth: 1, minPerDomainDelayMs: 1500,
  },
  standard: {
    depth: 10, maxPages: 100_000, maxBytes: 20 * GIB, maxDurationSeconds: 72 * 3600, concurrency: 8, retries: 5, externalDepth: 2, minPerDomainDelayMs: 1000,
  },
};

export interface ProfilePreset {
  depth: number;
  maxPages: number;
  maxBytes: number;
  maxDurationSeconds: number;
  concurrency: number;
}

/** Starting values for each named profile. They are clamped to the ceilings of the resource profile, never raised. */
export const PRESETS: Record<Exclude<SourceProfile, "custom">, ProfilePreset> = {
  focused: { depth: 1, maxPages: 50, maxBytes: 200 * MIB, maxDurationSeconds: 1800, concurrency: 2 },
  balanced: { depth: 3, maxPages: 500, maxBytes: 2 * GIB, maxDurationSeconds: 7200, concurrency: 4 },
  comprehensive: { depth: 6, maxPages: 5_000, maxBytes: 20 * GIB, maxDurationSeconds: 6 * 3600, concurrency: 4 },
};

export function ceilingsFor(profile: ResourceProfile): SourceCeilings {
  return CEILINGS[profile] ?? CEILINGS.standard;
}

export function presetFor(profile: SourceProfile, ceilings: SourceCeilings): ProfilePreset {
  const p = PRESETS[profile === "custom" ? "balanced" : profile];
  return {
    depth: Math.min(p.depth, ceilings.depth),
    maxPages: Math.min(p.maxPages, ceilings.maxPages),
    maxBytes: Math.min(p.maxBytes, ceilings.maxBytes),
    maxDurationSeconds: Math.min(p.maxDurationSeconds, ceilings.maxDurationSeconds),
    concurrency: Math.min(p.concurrency, ceilings.concurrency),
  };
}

export const DEFAULT_SOURCE_PRIORITY: PriorityNumber = 3;
