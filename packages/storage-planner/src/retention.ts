import type { PageInfo, RetentionAtom, RetentionSpec, VersionInfo } from "./types.js";

const DAY_MS = 86_400_000;

export const isLive = (v: Pick<VersionInfo, "status">): boolean => v.status === "ready" || v.status === "partial";

/** Live versions, most recent first: `fetchedAt` descending, then id descending. The order every retention rule uses. */
export function liveVersionsNewestFirst(versions: readonly VersionInfo[]): VersionInfo[] {
  return versions.filter(isLive).sort((a, b) => b.fetchedAt - a.fetchedAt || b.id - a.id);
}

/** The page's latest live version: the pointer if it names a live version, otherwise the newest live one. */
export function latestLive(page: Pick<PageInfo, "latestVersionId" | "versions">): VersionInfo | undefined {
  const sorted = liveVersionsNewestFirst(page.versions);
  const pointed = page.latestVersionId === null ? undefined : sorted.find((v) => v.id === page.latestVersionId);
  return pointed ?? sorted[0];
}

function atomRetained(
  atom: RetentionAtom, page: Pick<PageInfo, "latestVersionId" | "versions">, now: number, budgetIncluded: boolean | undefined,
): Set<number> {
  const sorted = liveVersionsNewestFirst(page.versions);
  const latest = latestLive(page);
  const out = new Set<number>();
  switch (atom.mode) {
    case "all":
      for (const v of sorted) out.add(v.id);
      break;
    case "latest":
      for (const v of sorted.slice(0, Math.max(1, Math.floor(atom.count)))) out.add(v.id);
      if (latest) out.add(latest.id);
      break;
    case "time": {
      const cutoff = now - atom.days * DAY_MS;
      for (const v of sorted) if (v.fetchedAt >= cutoff) out.add(v.id);
      if (atom.keepLatest !== false && latest) out.add(latest.id);
      break;
    }
    case "budget":
      // Whole pages are in or out of the budget: the latest version is kept, every other version is surplus.
      if (budgetIncluded !== false && latest) out.add(latest.id);
      break;
  }
  return out;
}

/**
 * The ids of the versions of `page` that a retention rule retains (docs/data-model.md 5.3). Deterministic: the same page, spec,
 * `now` and budget flags always give the same set. `budgetIncluded` has one entry per budget atom, in order of appearance.
 */
export function retainedVersionIds(
  spec: RetentionSpec, page: Pick<PageInfo, "latestVersionId" | "versions">, now: number, budgetIncluded: readonly boolean[] = [],
): Set<number> {
  if (spec.mode !== "custom") return atomRetained(spec, page, now, budgetIncluded[0]);
  let budgetIdx = 0;
  const sets = spec.rules.map((atom) => atomRetained(atom, page, now, atom.mode === "budget" ? budgetIncluded[budgetIdx++] : undefined));
  if (sets.length === 0) return new Set();
  if (spec.combine === "union") return new Set(sets.flatMap((s) => [...s]));
  return new Set([...sets[0]!].filter((id) => sets.every((s) => s.has(id))));
}

export interface BudgetPage {
  pageId: number;
  /** `pages.last_captured_at`. Pages with none sort last. */
  lastCapturedAt: number | null;
  /** The blobs of the page's latest version with their stored size. */
  blobs: { blobId: number; storedBytes: number }[];
}

/**
 * Budget retention across a source's pages (5.3): the most recently captured pages come first, and bytes are counted once per
 * blob inside the source ("exclusive within source"). Pages are included until adding the next one would exceed `budgetBytes`.
 * Returns the ids of the pages whose latest version fits.
 */
export function evaluateBudget(pages: readonly BudgetPage[], budgetBytes: number): Set<number> {
  const ordered = [...pages].sort((a, b) => (b.lastCapturedAt ?? -1) - (a.lastCapturedAt ?? -1) || a.pageId - b.pageId);
  const counted = new Set<number>();
  const included = new Set<number>();
  let total = 0;
  for (const p of ordered) {
    let add = 0;
    const fresh: number[] = [];
    for (const b of p.blobs) {
      if (!counted.has(b.blobId) && !fresh.includes(b.blobId)) {
        add += b.storedBytes;
        fresh.push(b.blobId);
      }
    }
    if (total + add > budgetBytes) break;
    total += add;
    for (const id of fresh) counted.add(id);
    included.add(p.pageId);
  }
  return included;
}
