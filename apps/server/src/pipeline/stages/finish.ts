import { createHash } from "node:crypto";
import type { StageContext, StageFn } from "../types.js";
import { deleteVersion } from "../store.js";
import { supersededBy } from "../policy.js";
import { stageDetail, version } from "./shared.js";

export const PIPELINE_VERSION = "1";
export const REWRITER_VERSION = "prep-1";

/** A stable, URL-safe key for a resource, derived from its referenced URL. */
export const resourceKey = (url: string): string => "r" + createHash("sha256").update(url).digest("hex").slice(0, 15);

/**
 * Stage 11 (default): the resource table the archive listener serves sub-resources from. The rendering code
 * (task A-12) can replace this stage through `PipelineDeps.stageOverrides.render_prep` when it needs to do more
 * (allowlist-checked document, CSS rewriting); the table below is the contract either way.
 */
export const renderPrep: StageFn = (ctx) => {
  const { db } = ctx.deps;
  const v = version(ctx);
  const rows = db.all<{ referenced_url: string; role: string; asset_id: number; status: string; via_asset_id: number | null }>(
    `SELECT r.referenced_url, r.role, r.asset_id, r.via_asset_id, a.status FROM asset_references r JOIN assets a ON a.id = r.asset_id
     WHERE r.version_id = ? AND r.role <> 'document' ORDER BY r.id`, [v.id]);
  db.transaction(() => {
    db.run("DELETE FROM version_resources WHERE version_id = ?", [v.id]);
    const viaUrl = (assetId: number | null): string | null =>
      assetId === null ? null : (db.get<{ u: string }>("SELECT MIN(referenced_url) AS u FROM asset_references WHERE version_id = ? AND asset_id = ?", [v.id, assetId])?.u ?? null);
    for (const r of rows) {
      const via = viaUrl(r.via_asset_id);
      const status = r.status === "ok" ? "ok" : r.status === "blocked" ? "blocked" : r.status === "skipped" ? "skipped" : "missing";
      db.run(
        `INSERT INTO version_resources (version_id, resource_key, url, asset_id, via_resource_key, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [v.id, resourceKey(r.referenced_url), r.referenced_url, status === "ok" ? r.asset_id : null, via ? resourceKey(via) : null, r.role, status],
      );
    }
    db.run("UPDATE page_versions SET rewriter_version = ? WHERE id = ?", [REWRITER_VERSION, v.id]);
  });
  return { detail: { resources: rows.length } };
};

export const skippedStage = (until: string): StageFn => () => ({ detail: { skipped: until } });

/** Pages that the version's links point at (for inbound-count recomputation). */
function linkTargets(ctx: StageContext, versionId: number | null): number[] {
  if (!versionId) return [];
  return ctx.deps.db.all<{ id: number }>("SELECT DISTINCT to_page_id AS id FROM links WHERE from_version_id = ? AND to_page_id IS NOT NULL", [versionId]).map((r) => r.id);
}

export function recomputeInbound(ctx: StageContext, pageIds: Iterable<number>): void {
  const { db } = ctx.deps;
  for (const id of new Set(pageIds)) {
    db.run(
      `UPDATE pages SET inbound_count = (
         SELECT COUNT(DISTINCT l.from_page_id) FROM links l JOIN pages fp ON fp.id = l.from_page_id AND fp.latest_version_id = l.from_version_id
         WHERE l.to_page_id = pages.id AND l.from_page_id <> pages.id) WHERE id = ?`, [id]);
  }
}

/**
 * Stage 15: atomic finalisation (task A-05). One transaction flips the version to ready or partial, moves
 * `pages.latest_version_id`, resolves links in both directions, applies the versioning policy and finishes the
 * download job. Before it commits, readers never see the version.
 */
export const status: StageFn = (ctx) => {
  const { db, blobs, clock } = ctx.deps;
  const v = version(ctx);
  const now = clock.now();
  const assetsDetail = stageDetail(ctx, "assets");
  const readableDetail = stageDetail(ctx, "readable") as { method?: string; rejected?: string };

  const failedAssets = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM asset_references r JOIN assets a ON a.id = r.asset_id WHERE r.version_id = ? AND a.status IN ('error','blocked')`, [v.id])!.n;
  let partial: "assets_missing" | "truncated" | "reader_only" | "size_cap" | null = null;
  if (assetsDetail.capHit || readableDetail.rejected === "too_large") partial = "size_cap";
  else if (failedAssets > 0) partial = "assets_missing";
  else if (readableDetail.rejected) partial = "truncated";
  else if (readableDetail.method === "body_text" || readableDetail.method === "none") partial = "reader_only";
  const nextStatus = partial ? "partial" : "ready";

  const result = db.transaction(() => {
    const page = db.get<{ id: number; latest_version_id: number | null; first_captured_at: number | null; effective_priority: number | null }>(
      "SELECT id, latest_version_id, first_captured_at, effective_priority FROM pages WHERE id = ?", [v.pageId])!;
    const oldTargets = linkTargets(ctx, page.latest_version_id);
    const jobPriority = v.downloadJobId ? db.get<{ priority: number }>("SELECT priority FROM download_jobs WHERE id = ?", [v.downloadJobId])?.priority : undefined;

    db.run(
      `UPDATE page_versions SET status = ?, partial_reason = ?, extractor_version = ?, pipeline_version = ?, retained = 1 WHERE id = ?`,
      [nextStatus, partial, readableDetail ? "1" : null, PIPELINE_VERSION, v.id],
    );
    const meta = db.get<{ title: string | null; language: string | null }>("SELECT title, language FROM page_versions WHERE id = ?", [v.id])!;
    db.run(
      `UPDATE pages SET latest_version_id = ?, title = ?, language = ?, availability = ?, content_type = 'html',
         effective_priority = MIN(COALESCE(effective_priority, 4), ?), first_captured_at = COALESCE(first_captured_at, ?),
         last_captured_at = ?, last_checked_at = ? WHERE id = ?`,
      [v.id, meta.title, meta.language, partial ? "partial" : "archived", jobPriority ?? page.effective_priority ?? 3, v.fetchedAt, v.fetchedAt, now, v.pageId],
    );

    // Links: resolve this version's targets, then point every earlier link that was waiting for this page at it.
    db.run(
      `UPDATE links SET to_page_id = COALESCE((SELECT id FROM pages WHERE url_key = links.to_url_key),
                                               (SELECT page_id FROM page_aliases WHERE url_key = links.to_url_key))
       WHERE from_version_id = ? AND to_page_id IS NULL`, [v.id]);
    db.run(
      `UPDATE links SET to_page_id = ? WHERE to_page_id IS NULL AND to_url_key IN (
         SELECT url_key FROM pages WHERE id = ? UNION SELECT url_key FROM page_aliases WHERE page_id = ?)`, [v.pageId, v.pageId, v.pageId]);

    // Versioning policy (task A-11): which earlier versions this capture supersedes.
    const existing = db.all<{ id: number; version_no: number; fetched_at: number }>(
      `SELECT id, version_no, fetched_at FROM page_versions WHERE page_id = ? AND id <> ? AND status IN ('ready','partial')`, [v.pageId, v.id])
      .map((r) => ({ id: r.id, versionNo: r.version_no, fetchedAt: r.fetched_at }));
    const doomed = supersededBy(ctx.versioning, { id: v.id, versionNo: v.versionNo, fetchedAt: v.fetchedAt }, existing);
    for (const id of doomed) deleteVersion(db, blobs, id);

    db.run("UPDATE pages SET version_count = (SELECT COUNT(*) FROM page_versions WHERE page_id = pages.id AND status IN ('ready','partial')) WHERE id = ?", [v.pageId]);
    recomputeInbound(ctx, [v.pageId, ...oldTargets, ...linkTargets(ctx, v.id)]);

    const total = db.get<{ n: number }>("SELECT COALESCE(SUM(a.size_bytes), 0) AS n FROM asset_references r JOIN assets a ON a.id = r.asset_id WHERE r.version_id = ?", [v.id])!.n;
    db.run("UPDATE page_versions SET total_bytes = ? WHERE id = ?", [total, v.id]);

    if (v.downloadJobId) {
      db.run(
        `UPDATE download_jobs SET state = 'completed', pages_done = 1, bytes_done = ?, finished_at = ?, failure_code = NULL, failure_message = NULL WHERE id = ?`, [total, now, v.downloadJobId]);
    }
    return { superseded: doomed.length, total };
  });
  return { detail: { status: nextStatus, partialReason: partial, ...result } };
};
