import { eligibility } from "./eligibility.js";
import { isLive, latestLive } from "./retention.js";
import type { BlobInfo, PageInfo, Policy, Priority, SkipReason } from "./types.js";

export type PlanStep = "throttle_p4" | "unreferenced_blobs" | "surplus_versions" | "p4" | "p3" | "p2";

export interface PlanInput {
  pages: readonly PageInfo[];
  /** Every blob used by a version of `pages`, with `totalRefs` recounted from the reference rows. */
  blobs: readonly BlobInfo[];
  /** Blobs nothing references, already past the grace period. Reclaiming them loses no content. */
  unreferencedBlobs?: readonly { blobId: number; storedBytes: number; volumeId: number }[];
  policy: Policy;
  incomingPriority: Priority;
  bytesNeeded: number;
  /** `pressure`: free `bytesNeeded` by the full order. `prune`: only surplus versions and unreferenced blobs (maintenance). */
  mode?: "pressure" | "prune";
  /** Count only bytes of blobs on this volume. Versions with nothing to free there are skipped. */
  volumeId?: number;
  /** Blobs on these volumes cannot be deleted now (offline), so they count for nothing. */
  unavailableVolumeIds?: readonly number[];
  now: number;
  /** Step 0: P4 downloads are throttled while a volume is above its soft threshold. Nothing is deleted for it. */
  throttle?: { enabled: boolean; usedPct: number; softPct: number };
  /** How many skipped versions to list (counts are always complete). Default 200. */
  maxSkippedListed?: number;
}

export interface PlanItem {
  versionId: number;
  versionNo: number;
  pageId: number;
  pageUrl: string;
  /** The class the version was in: 1 to 4, where `surplus` versions are 4. */
  priority: Priority;
  surplus: boolean;
  isLatest: boolean;
  step: Exclude<PlanStep, "throttle_p4" | "unreferenced_blobs">;
  /** Bytes this version frees given the versions chosen before it. */
  exclusiveBytes: number;
  /** Bytes it would free on its own. */
  soloExclusiveBytes: number;
  lastAccessedAt: number | null;
  reason: string;
}

export interface PlanSkip {
  versionId: number;
  pageId: number;
  pageUrl: string;
  reason: SkipReason;
}

export interface EvictionPlan {
  incomingPriority: Priority;
  bytesNeeded: number;
  mode: "pressure" | "prune";
  /** Bytes the plan frees (exclusive bytes of the items plus unreferenced blobs). */
  reclaimableBytes: number;
  /** False means the eligible content cannot cover `bytesNeeded`: the plan is `insufficient` and must not be executed. */
  sufficient: boolean;
  throttleOpportunistic: boolean;
  steps: { step: PlanStep; versions: number; exclusiveBytes: number }[];
  items: PlanItem[];
  unreferencedBlobs: { blobId: number; storedBytes: number }[];
  skipped: PlanSkip[];
  skippedCounts: Partial<Record<SkipReason, number>>;
}

const STEP_OF_CLASS: Record<2 | 3 | 4, PlanItem["step"]> = { 2: "p2", 3: "p3", 4: "p4" };

function describe(item: Omit<PlanItem, "reason">, incoming: Priority, mode: "pressure" | "prune"): string {
  const name = { 1: "Protected", 2: "Important", 3: "Standard", 4: "Opportunistic" }[item.priority];
  const why = mode === "prune" ? "tidying up" : `making room for a P${incoming} download`;
  if (item.surplus) {
    return item.isLatest
      ? `No source, collection, pin or bookmark keeps this copy, so it is surplus and goes first when ${why}.`
      : `An older copy that no source's retention rule keeps any more (surplus), removed first when ${why}.`;
  }
  const order = item.isLatest ? "the current copy" : "an older copy";
  return `${name} (P${item.priority}) content, ${order}, ${item.lastAccessedAt === null ? "never opened" : "least recently opened"} among the eligible copies, reclaimed when ${why}.`;
}

/**
 * The eviction planner (docs/data-model.md 5.4). Pure and deterministic: the same input gives the same plan, nothing reads a clock,
 * a random source or the disk. It never contains a P1 version, never counts a shared asset more than once, and an `insufficient`
 * plan deletes nothing (the executor refuses it).
 *
 * Order: unreferenced blobs, surplus versions (older first), then P4, P3 and, only if permitted, P2, within a class superseded
 * copies before the latest, least recently opened first, larger first, then version id. Stops once `bytesNeeded` is covered.
 */
export function planEviction(input: PlanInput): EvictionPlan {
  const mode = input.mode ?? "pressure";
  const unavailable = new Set(input.unavailableVolumeIds ?? []);
  const counts = (b: BlobInfo): boolean => !unavailable.has(b.volumeId) && (input.volumeId === undefined || b.volumeId === input.volumeId);
  const blobById = new Map(input.blobs.map((b) => [b.id, b] as const));
  const needed = Math.max(0, input.bytesNeeded);

  const skipped: PlanSkip[] = [];
  const skippedCounts: Partial<Record<SkipReason, number>> = {};
  const skip = (page: PageInfo, versionId: number, reason: SkipReason): void => {
    skippedCounts[reason] = (skippedCounts[reason] ?? 0) + 1;
    if (skipped.length < (input.maxSkippedListed ?? 200)) skipped.push({ versionId, pageId: page.id, pageUrl: page.url, reason });
  };

  type Cand = Omit<PlanItem, "reason" | "exclusiveBytes" | "step"> & { blobs: { blobId: number; refs: number }[]; fetchedAt: number };
  const candidates: Cand[] = [];
  const effIncoming: Priority = mode === "prune" ? 1 : input.incomingPriority;
  for (const page of [...input.pages].sort((a, b) => a.id - b.id)) {
    const latest = latestLive(page);
    for (const v of [...page.versions].sort((a, b) => a.id - b.id)) {
      if (!isLive(v)) continue;
      const e = eligibility({ page, versionId: v.id, policy: input.policy, incomingPriority: effIncoming, now: input.now });
      if (!e.eligible) {
        skip(page, v.id, e.reason);
        continue;
      }
      if (mode === "prune" && !e.surplus) {
        skip(page, v.id, "retained");
        continue;
      }
      let solo = 0;
      for (const u of v.blobs) {
        const b = blobById.get(u.blobId);
        if (b && counts(b) && u.refs >= b.totalRefs) solo += b.storedBytes;
      }
      candidates.push({
        versionId: v.id, versionNo: v.versionNo, pageId: page.id, pageUrl: page.url, priority: e.priority, surplus: e.surplus,
        isLatest: latest?.id === v.id, soloExclusiveBytes: solo, lastAccessedAt: v.lastAccessedAt, blobs: v.blobs, fetchedAt: v.fetchedAt,
      });
    }
  }

  candidates.sort((a, b) => {
    if (a.surplus !== b.surplus) return a.surplus ? -1 : 1; // step 2 first
    if (a.surplus) return Number(a.isLatest) - Number(b.isLatest) || a.fetchedAt - b.fetchedAt || a.versionId - b.versionId;
    return (
      b.priority - a.priority || // class DESC
      Number(a.isLatest) - Number(b.isLatest) || // superseded copies first
      (a.lastAccessedAt ?? -Infinity) - (b.lastAccessedAt ?? -Infinity) || // never served first
      b.soloExclusiveBytes - a.soloExclusiveBytes || // larger first
      a.versionId - b.versionId
    );
  });

  // Step 1: unreferenced blobs. They lose no content, so they always come first.
  const unref = [...(input.unreferencedBlobs ?? [])]
    .filter((u) => !unavailable.has(u.volumeId) && (input.volumeId === undefined || u.volumeId === input.volumeId))
    .sort((a, b) => b.storedBytes - a.storedBytes || a.blobId - b.blobId);
  const unrefBytes = unref.reduce((n, u) => n + u.storedBytes, 0);
  let reclaimed = unrefBytes;

  const evictedRefs = new Map<number, number>();
  const freed = new Set<number>();
  const items: PlanItem[] = [];
  const batchCap = mode === "prune" && input.policy.maxEvictionBatchBytes ? input.policy.maxEvictionBatchBytes : Infinity;

  const done = (): boolean => (mode === "pressure" ? reclaimed >= needed : reclaimed >= batchCap);
  if (mode === "pressure" ? needed > 0 : true) {
    for (const c of candidates) {
      if (done()) break;
      let marginal = 0;
      const newlyFreed: number[] = [];
      for (const u of c.blobs) {
        const b = blobById.get(u.blobId);
        if (!b || freed.has(b.id)) continue;
        if ((evictedRefs.get(b.id) ?? 0) + u.refs >= b.totalRefs && counts(b)) {
          marginal += b.storedBytes;
          newlyFreed.push(b.id);
        }
      }
      // Evicting a copy whose bytes are all shared with content that stays frees nothing: not worth the loss (pressure only).
      if (mode === "pressure" && marginal === 0) {
        skippedCounts.no_reclaim = (skippedCounts.no_reclaim ?? 0) + 1;
        if (skipped.length < (input.maxSkippedListed ?? 200)) skipped.push({ versionId: c.versionId, pageId: c.pageId, pageUrl: c.pageUrl, reason: "no_reclaim" });
        continue;
      }
      for (const u of c.blobs) evictedRefs.set(u.blobId, (evictedRefs.get(u.blobId) ?? 0) + u.refs);
      for (const id of newlyFreed) freed.add(id);
      reclaimed += marginal;
      const step = c.surplus ? "surplus_versions" : STEP_OF_CLASS[c.priority as 2 | 3 | 4];
      const base = {
        versionId: c.versionId, versionNo: c.versionNo, pageId: c.pageId, pageUrl: c.pageUrl, priority: c.priority, surplus: c.surplus,
        isLatest: c.isLatest, soloExclusiveBytes: c.soloExclusiveBytes, lastAccessedAt: c.lastAccessedAt,
      };
      items.push({ ...base, step, exclusiveBytes: marginal, reason: describe({ ...base, step, exclusiveBytes: marginal }, input.incomingPriority, mode) });
    }
  }

  const sufficient = mode === "prune" ? true : reclaimed >= needed;
  const stepOrder: PlanStep[] = ["unreferenced_blobs", "surplus_versions", "p4", "p3", "p2"];
  const steps: EvictionPlan["steps"] = [];
  const throttleOpportunistic = !!input.throttle && input.throttle.enabled && input.throttle.usedPct >= input.throttle.softPct;
  if (throttleOpportunistic) steps.push({ step: "throttle_p4", versions: 0, exclusiveBytes: 0 });
  for (const s of stepOrder) {
    if (s === "unreferenced_blobs") {
      if (unref.length) steps.push({ step: s, versions: 0, exclusiveBytes: unrefBytes });
      continue;
    }
    const rows = items.filter((i) => i.step === s);
    if (rows.length) steps.push({ step: s, versions: rows.length, exclusiveBytes: rows.reduce((n, i) => n + i.exclusiveBytes, 0) });
  }

  return {
    incomingPriority: input.incomingPriority, bytesNeeded: needed, mode, reclaimableBytes: reclaimed, sufficient, throttleOpportunistic, steps,
    items, unreferencedBlobs: unref.map((u) => ({ blobId: u.blobId, storedBytes: u.storedBytes })), skipped, skippedCounts,
  };
}
