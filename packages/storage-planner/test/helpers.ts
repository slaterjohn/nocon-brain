import type { BlobInfo, PageInfo, Policy, Priority, Reference, RetentionSpec, VersionInfo } from "../src/index.js";

export const NOW = 1_800_000_000_000;
export const DAY = 86_400_000;

export const POLICY: Policy = { permitImportantEviction: false, pruneSurplusVersions: true };

export function ref(p: Partial<Reference> & { priority: Priority }): Reference {
  return { kind: "source", id: "src_a", retention: { mode: "latest", count: 1 }, autoEvict: true, ...p };
}

export function ver(id: number, o: Partial<VersionInfo> & { blobs?: VersionInfo["blobs"] } = {}): VersionInfo {
  return { id, versionNo: id, fetchedAt: NOW - (100 - id) * DAY, status: "ready", lastAccessedAt: null, blobs: [], ...o };
}

export function page(id: number, versions: VersionInfo[], refs: Reference[], o: Partial<PageInfo> = {}): PageInfo {
  const latest = [...versions].sort((a, b) => b.fetchedAt - a.fetchedAt || b.id - a.id)[0];
  return { id, url: `https://example.test/${id}`, latestVersionId: latest?.id ?? null, versions, refs, ...o };
}

export const blob = (id: number, storedBytes: number, totalRefs: number, volumeId = 1): BlobInfo => ({ id, storedBytes, totalRefs, volumeId });

export const retention = {
  all: { mode: "all" } as RetentionSpec,
  latest: (count: number): RetentionSpec => ({ mode: "latest", count }),
};
