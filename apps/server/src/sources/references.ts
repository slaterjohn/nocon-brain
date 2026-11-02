import type { Db } from "@ncb/db";
import type { PriorityNumber } from "@ncb/shared";

export type DiscoveredVia = "seed" | "link" | "sitemap" | "feed" | "search" | "manual";

/**
 * Records that `pageId` was captured for `sourceId` (the source reference, docs/data-model.md 5.1). Idempotent: a repeat
 * capture only moves `last_seen_at`. A soft-deleted or unknown source is ignored, so a capture that finishes after its
 * source was deleted does not bring a reference back.
 *
 * `priority` is the priority the capture was admitted at. It is stored as `priority_override` only when it differs from the
 * source's own priority, and when several differ the most important (lowest number) is kept.
 */
export function linkPageSource(
  db: Db,
  o: { pageId: number; sourceId: number; now: number; via?: DiscoveredVia; depth?: number; priority?: number },
): boolean {
  const src = db.get<{ priority: number }>("SELECT priority FROM sources WHERE id = ? AND deleted_at IS NULL", [o.sourceId]);
  if (!src) return false;
  const override = o.priority !== undefined && o.priority !== src.priority ? o.priority : null;
  db.run(
    `INSERT INTO page_sources (page_id, source_id, first_seen_at, last_seen_at, discovered_via, depth, priority_override)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (page_id, source_id) DO UPDATE SET
       last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
       priority_override = CASE
         WHEN excluded.priority_override IS NULL THEN priority_override
         WHEN priority_override IS NULL THEN excluded.priority_override
         ELSE MIN(priority_override, excluded.priority_override) END`,
    [o.pageId, o.sourceId, o.now, o.now, o.via ?? "manual", o.depth ?? 0, override],
  );
  return true;
}

/** What Phase 6 (T-01) needs about one source reference of a page. */
export interface SourceReference {
  sourceId: number;
  sourcePublicId: string;
  /** COALESCE(page_sources.priority_override, sources.priority). */
  priority: PriorityNumber;
  retentionMode: string;
  retentionJson: string;
  automaticEviction: boolean;
  /** Always true here: soft-deleted sources have no rows. A disabled or paused source still counts. */
  active: boolean;
  systemKind: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** Every active source reference of a page. This is the source half of the reference model in data-model.md 5.1. */
export function sourceReferences(db: Db, pageId: number): SourceReference[] {
  return db
    .all<{
      source_id: number; public_id: string; priority: number; retention_mode: string; retention_json: string;
      automatic_eviction: number; system_kind: string | null; first_seen_at: number; last_seen_at: number;
    }>(
      `SELECT s.id AS source_id, s.public_id, COALESCE(ps.priority_override, s.priority) AS priority, s.retention_mode, s.retention_json,
              s.automatic_eviction, s.system_kind, ps.first_seen_at, ps.last_seen_at
       FROM page_sources ps JOIN sources s ON s.id = ps.source_id
       WHERE ps.page_id = ? AND s.deleted_at IS NULL ORDER BY s.id`,
      [pageId],
    )
    .map((r) => ({
      sourceId: r.source_id, sourcePublicId: r.public_id, priority: r.priority as PriorityNumber, retentionMode: r.retention_mode,
      retentionJson: r.retention_json, automaticEviction: r.automatic_eviction === 1, active: true, systemKind: r.system_kind,
      firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
    }));
}

/** True when the address was deleted on purpose (for this source, or for all sources) and must not be fetched again by a crawl. */
export function isExcluded(db: Db, urlKey: string, sourceId: number | null): boolean {
  return (
    db.get(
      "SELECT 1 AS x FROM url_exclusions WHERE url_key = ? AND (source_id IS NULL OR source_id = ?) LIMIT 1",
      [urlKey, sourceId],
    ) !== undefined
  );
}

export function addExclusion(db: Db, urlKey: string, sourceId: number | null, reason: "deleted_by_user" | "blocked" | "trap", now: number): void {
  if (sourceId === null) {
    db.run("INSERT INTO url_exclusions (source_id, url_key, reason, created_at) VALUES (NULL, ?, ?, ?) ON CONFLICT DO NOTHING", [urlKey, reason, now]);
  } else {
    db.run("INSERT INTO url_exclusions (source_id, url_key, reason, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", [sourceId, urlKey, reason, now]);
  }
}

export function removeExclusion(db: Db, urlKey: string): number {
  return db.run("DELETE FROM url_exclusions WHERE url_key = ?", [urlKey]).changes;
}
