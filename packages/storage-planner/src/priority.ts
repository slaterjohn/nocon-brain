import { latestLive, retainedVersionIds } from "./retention.js";
import type { PageInfo, Priority, Reference, VersionClass, VersionInfo } from "./types.js";

/** Does reference `ref` retain version `v` of `page`? (`retains(V)` in docs/data-model.md 5.1.) */
export function retains(ref: Reference, page: Pick<PageInfo, "latestVersionId" | "versions">, v: Pick<VersionInfo, "id">, now: number): boolean {
  return retainedVersionIds(ref.retention, page, now, ref.budgetIncluded).has(v.id);
}

export interface PriorityResult {
  /** 1 to 4. A version retained by nothing is 4. */
  priority: Priority;
  /** No active reference retains the version. It counts as priority 4 and is the first to go. */
  surplus: boolean;
  retainingRefs: Reference[];
}

/**
 * `priority(V)`: the minimum priority over the active references that retain V; surplus (retained by nothing) counts as 4.
 * A disabled source still counts, a soft-deleted one is not passed in. Pure and order-independent.
 */
export function versionPriority(page: PageInfo, versionId: number, now: number): PriorityResult {
  const retainingRefs = page.refs.filter((r) => retainedVersionIds(r.retention, page, now, r.budgetIncluded).has(versionId));
  if (retainingRefs.length === 0) return { priority: 4, surplus: true, retainingRefs };
  const priority = Math.min(...retainingRefs.map((r) => r.priority)) as Priority;
  return { priority, surplus: false, retainingRefs };
}

/** All versions at once: computes each reference's retained set once. */
export function versionPriorities(page: PageInfo, now: number): Map<number, PriorityResult> {
  const sets = page.refs.map((r) => ({ r, ids: retainedVersionIds(r.retention, page, now, r.budgetIncluded) }));
  const out = new Map<number, PriorityResult>();
  for (const v of page.versions) {
    const retainingRefs = sets.filter((s) => s.ids.has(v.id)).map((s) => s.r);
    out.set(
      v.id,
      retainingRefs.length === 0
        ? { priority: 4, surplus: true, retainingRefs }
        : { priority: Math.min(...retainingRefs.map((r) => r.priority)) as Priority, surplus: false, retainingRefs },
    );
  }
  return out;
}

/** The effective priority of a page: `priority(latest version)`; a page with no live version or no references is 4. */
export function pagePriority(page: PageInfo, now: number): Priority {
  const latest = latestLive(page);
  if (!latest) return 4;
  return versionPriority(page, latest.id, now).priority;
}

export const classOf = (r: PriorityResult): VersionClass => ({ priority: r.priority, surplus: r.surplus });

/**
 * The effective priority of a blob: the minimum over the non-evicted versions that use it. `pages` may be a subset of the archive
 * when the caller only needs the blobs of those pages. A blob nothing in `pages` uses has no priority (undefined).
 */
export function blobPriorities(pages: readonly PageInfo[], now: number): Map<number, Priority> {
  const out = new Map<number, Priority>();
  for (const page of pages) {
    const prios = versionPriorities(page, now);
    for (const v of page.versions) {
      if (v.status === "evicted") continue;
      const p = prios.get(v.id)!.priority;
      for (const b of v.blobs) {
        const cur = out.get(b.blobId);
        if (cur === undefined || p < cur) out.set(b.blobId, p);
      }
    }
  }
  return out;
}
