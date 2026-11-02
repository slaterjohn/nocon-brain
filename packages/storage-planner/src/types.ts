/** Storage priority: 1 Protected, 2 Important, 3 Standard, 4 Opportunistic. A lower number is more important. */
export type Priority = 1 | 2 | 3 | 4;
export const PRIORITIES: readonly Priority[] = [1, 2, 3, 4];

export type RetentionAtom =
  | { mode: "all" }
  | { mode: "latest"; count: number }
  | { mode: "time"; days: number; keepLatest?: boolean }
  | { mode: "budget"; bytes: number };
export type RetentionSpec = RetentionAtom | { mode: "custom"; combine: "union" | "intersection"; rules: RetentionAtom[] };

export type ReferenceKind = "source" | "collection" | "pin" | "bookmark";

/** An active reference to a page (docs/data-model.md 5.1). Inactive references (soft-deleted source) are simply not passed in. */
export interface Reference {
  kind: ReferenceKind;
  /** Public id of the source, collection or bookmark; `pin` for a pin. Used in explanations only. */
  id: string;
  label?: string;
  priority: Priority;
  /** Collection floors, pins and bookmarks retain the latest version only: `{ mode: "latest", count: 1 }`. */
  retention: RetentionSpec;
  /** Whether this reference permits automatic eviction of the page. A single `false` vetoes the whole page (5.2 rule 3). */
  autoEvict: boolean;
  /**
   * For `budget` retention (alone or inside `custom`): whether this page's latest version fits inside the source budget, one entry
   * per budget atom in order of appearance. Produced by `evaluateBudget`. Missing means "fits".
   */
  budgetIncluded?: boolean[];
}

export type VersionStatus = "capturing" | "ready" | "partial" | "failed" | "evicting" | "evicted";

/** One use of a blob by a version. `refs` is how many reference rows the version holds on it. */
export interface BlobUse {
  blobId: number;
  refs: number;
}

export interface VersionInfo {
  id: number;
  versionNo: number;
  fetchedAt: number;
  status: VersionStatus;
  lastAccessedAt: number | null;
  blobs: BlobUse[];
}

export interface PageInfo {
  id: number;
  url: string;
  latestVersionId: number | null;
  versions: VersionInfo[];
  refs: Reference[];
  /** A running job is writing to this page (5.2 rule 1). */
  busy?: boolean;
}

export interface BlobInfo {
  id: number;
  storedBytes: number;
  /** Every reference to the blob that exists, from any version, import or content row. Recounted from the reference rows, never the cached `refcount`. */
  totalRefs: number;
  volumeId: number;
}

export interface Policy {
  permitImportantEviction: boolean;
  pruneSurplusVersions: boolean;
  /** Upper bound for the bytes a maintenance (prune) run reclaims. Does not limit space-pressure plans. */
  maxEvictionBatchBytes?: number | null;
}

export type SkipReason = "p1" | "retained" | "source_auto_eviction_off" | "p2_not_permitted" | "priority_gate" | "in_use" | "no_reclaim" | "not_on_volume";

/** The class a version is in for eviction purposes. `surplus` counts as priority 4 but is evicted first (step 2). */
export type VersionClass = { priority: Priority; surplus: boolean };
