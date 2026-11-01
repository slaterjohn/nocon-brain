import type { Clock } from "@ncb/shared";
import { AppError } from "@ncb/shared";
import type { Db } from "@ncb/db";
import { MAX_HITS, normaliseTerm, sanitizeHtml } from "@ncb/render";
import type { CaptureStore } from "../archive/store.js";
import type { ActivityLog } from "./activity.js";
import type { BrowserService, PageSummary, ApiVersionSummary } from "./browser.js";
import type { BlobStore } from "./blobs.js";
import type { PipelineService } from "../pipeline/service.js";
import { deleteVersion } from "../pipeline/store.js";

export interface DeletePreview {
  versions: number;
  exclusiveBytes: number;
  sharedBytesKept: number;
  references: { sources: string[]; collections: string[]; bookmarks: number; pins: ("P1" | "P2" | "P3" | "P4")[] };
  requiresConfirmation: boolean;
}

export interface FindResult {
  query: string;
  count: number;
  /** Element ids in the highlighted document (`#ncb-hit-N`). */
  anchors: string[];
  /** More matches exist than the highlight limit. */
  truncated: boolean;
}

export interface ListPagesQuery {
  q?: string;
  domain?: string;
  availability?: string[];
  sort?: "captured" | "title" | "size" | "site";
  limit: number;
  offset: number;
}

/**
 * The archive's page-level reads and the explicit deletion that the Library uses (A-14 to A-18). Find-in-page lives here
 * because it must give the same count as the listener's highlight, so both run the same sanitiser with the same matcher.
 */
export class LibraryService {
  constructor(private readonly o: {
    db: Db; clock: Clock; pipeline: PipelineService; browser: BrowserService; store: CaptureStore; blobs: BlobStore; activity: ActivityLog;
  }) {}

  list(q: ListPagesQuery): { items: PageSummary[]; total: number; nextCursor?: string } {
    const { db, pipeline, browser } = this.o;
    const where = ["p.deleted_at IS NULL"];
    const args: (string | number)[] = [];
    const av = q.availability?.length ? q.availability : ["archived", "partial", "evicted"];
    where.push(`p.availability IN (${av.map(() => "?").join(",")})`);
    args.push(...av);
    if (q.q) {
      where.push("(instr(lower(COALESCE(p.title, '')), lower(?)) > 0 OR instr(lower(p.host), lower(?)) > 0 OR instr(lower(p.canonical_url), lower(?)) > 0)");
      args.push(q.q, q.q, q.q);
    }
    if (q.domain) {
      where.push("(p.host = ? OR p.registrable_domain = ?)");
      args.push(q.domain.toLowerCase(), q.domain.toLowerCase());
    }
    const order =
      q.sort === "title" ? "lower(COALESCE(p.title, p.canonical_url)) ASC, p.id ASC"
      : q.sort === "site" ? "p.host ASC, lower(COALESCE(p.title, '')) ASC, p.id ASC"
      : q.sort === "size" ? "COALESCE(v.total_bytes, 0) DESC, p.id DESC"
      : "COALESCE(p.last_captured_at, 0) DESC, p.id DESC";
    const from = "FROM pages p LEFT JOIN page_versions v ON v.id = p.latest_version_id";
    const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n ${from} WHERE ${where.join(" AND ")}`, args)!.n;
    const rows = db.all<{ id: number }>(`SELECT p.id ${from} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`, [...args, q.limit + 1, q.offset]);
    const items = rows.slice(0, q.limit).flatMap((r) => {
      const p = pipeline.getPage(r.id);
      return p ? [browser.pageSummary(p)] : [];
    });
    return { items, total, ...(rows.length > q.limit ? { nextCursor: String(q.offset + q.limit) } : {}) };
  }

  detail(idOrPublic: string): { page: PageSummary; versions: ApiVersionSummary[]; bookmarks: number } {
    const { pipeline, browser, db } = this.o;
    const p = pipeline.getPage(idOrPublic);
    if (!p) throw new AppError("not_found", "That page is not in the archive.");
    const versions = pipeline.listVersions(p.id).flatMap((v) => {
      const d = pipeline.getVersion(v.id);
      return d ? [browser.versionSummary(d)] : [];
    });
    const bookmarks = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bookmarks WHERE page_id = ? AND deleted_at IS NULL", [p.id])!.n;
    return { page: browser.pageSummary(p), versions, bookmarks };
  }

  // ---- delete --------------------------------------------------------------------------------

  preview(idOrPublic: string): DeletePreview {
    const { db, pipeline } = this.o;
    const p = pipeline.getPage(idOrPublic);
    if (!p) throw new AppError("not_found", "That page is not in the archive.");
    // A blob is "exclusive" when every reference to it comes from this page's versions.
    const rows = db.all<{ size_bytes: number; refcount: number; mine: number }>(
      `SELECT b.size_bytes, b.refcount,
              (SELECT COUNT(*) FROM asset_references ar JOIN page_versions pv ON pv.id = ar.version_id JOIN assets a2 ON a2.id = ar.asset_id
                WHERE pv.page_id = ? AND a2.blob_id = b.id)
            + (SELECT COUNT(*) FROM version_content vc JOIN page_versions pv ON pv.id = vc.version_id
                WHERE pv.page_id = ? AND (vc.text_blob_id = b.id OR vc.reader_blob_id = b.id OR vc.outline_blob_id = b.id OR vc.extraction_blob_id = b.id)) AS mine
       FROM blobs b WHERE b.id IN (
         SELECT a.blob_id FROM asset_references ar JOIN page_versions pv ON pv.id = ar.version_id JOIN assets a ON a.id = ar.asset_id WHERE pv.page_id = ? AND a.blob_id IS NOT NULL
         UNION SELECT vc.text_blob_id FROM version_content vc JOIN page_versions pv ON pv.id = vc.version_id WHERE pv.page_id = ? AND vc.text_blob_id IS NOT NULL
         UNION SELECT vc.reader_blob_id FROM version_content vc JOIN page_versions pv ON pv.id = vc.version_id WHERE pv.page_id = ? AND vc.reader_blob_id IS NOT NULL
         UNION SELECT vc.outline_blob_id FROM version_content vc JOIN page_versions pv ON pv.id = vc.version_id WHERE pv.page_id = ? AND vc.outline_blob_id IS NOT NULL)`,
      [p.id, p.id, p.id, p.id, p.id, p.id]);
    let exclusive = 0;
    let shared = 0;
    for (const r of rows) (r.refcount <= r.mine ? (exclusive += r.size_bytes) : (shared += r.size_bytes));
    const versions = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions WHERE page_id = ?", [p.id])!.n;
    const bookmarks = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bookmarks WHERE page_id = ? AND deleted_at IS NULL", [p.id])!.n;
    const protectedPrio = p.effectivePriority != null && p.effectivePriority <= 2;
    return {
      versions, exclusiveBytes: exclusive, sharedBytesKept: shared,
      references: { sources: [], collections: [], bookmarks, pins: protectedPrio ? [`P${p.effectivePriority}` as "P1" | "P2"] : [] },
      requiresConfirmation: protectedPrio,
    };
  }

  /**
   * Explicit deletion: every version goes with its blob references released, so the storage tidy-up can reclaim what nothing
   * else uses. Bookmarks that pointed here lose the archive reference but keep the address. (`url_exclusions` arrives with
   * sources in Phase 3, so a deleted page can be saved again at once.)
   */
  deletePage(idOrPublic: string, opts: { confirmProtected?: boolean } = {}): { deletedVersions: number } {
    const { db, blobs, pipeline, activity } = this.o;
    const p = pipeline.getPage(idOrPublic);
    if (!p) throw new AppError("not_found", "That page is not in the archive.");
    const prev = this.preview(idOrPublic);
    if (prev.requiresConfirmation && !opts.confirmProtected) {
      throw new AppError("conflict", "This page is protected. Confirm that you want to delete it.", { requiresConfirmation: true, preview: prev });
    }
    const count = db.transaction(() => {
      const targets = db.all<{ to_page_id: number }>("SELECT DISTINCT to_page_id FROM links WHERE from_page_id = ? AND to_page_id IS NOT NULL AND to_page_id <> ?", [p.id, p.id]);
      const versionIds = db.all<{ id: number }>("SELECT id FROM page_versions WHERE page_id = ?", [p.id]);
      for (const v of versionIds) deleteVersion(db, blobs, v.id);
      db.run("DELETE FROM pages WHERE id = ?", [p.id]);
      for (const t of targets) {
        db.run(
          `UPDATE pages SET inbound_count = (
             SELECT COUNT(DISTINCT l.from_page_id) FROM links l JOIN pages fp ON fp.id = l.from_page_id AND fp.latest_version_id = l.from_version_id
             WHERE l.to_page_id = pages.id AND l.from_page_id <> pages.id) WHERE id = ?`, [t.to_page_id]);
      }
      return versionIds.length;
    });
    activity.write({ level: "info", area: "storage", message: `Deleted saved page ${p.canonicalUrl} (${count} version${count === 1 ? "" : "s"})` });
    return { deletedVersions: count };
  }

  // ---- find in page --------------------------------------------------------------------------

  async find(versionPublicId: string, rawQuery: string): Promise<FindResult> {
    const ref = await this.o.store.getVersion(versionPublicId);
    if (!ref) throw new AppError("not_found", "That saved copy does not exist.");
    const term = normaliseTerm(rawQuery);
    if (!term) return { query: "", count: 0, anchors: [], truncated: false };
    const doc = await this.o.store.readDocument(ref);
    if (!doc) throw new AppError("not_found", "That saved copy has no page to search.");
    // Same sanitiser and matcher as the listener's `?hl=`, so the count is the number of marks the frame will show.
    const r = sanitizeHtml(doc.html, { baseUrl: doc.baseUrl, highlight: { term } });
    return { query: term, count: r.hits, anchors: Array.from({ length: r.hits }, (_, i) => `ncb-hit-${i + 1}`), truncated: r.hits >= MAX_HITS };
  }
}
