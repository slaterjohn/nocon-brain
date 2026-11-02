import type { Db } from "@ncb/db";
import {
  evaluateBudget, type BlobInfo, type PageInfo, type Policy, type Priority, type Reference, type RetentionSpec, type VersionInfo, type VersionStatus,
} from "@ncb/storage-planner";
import type { SettingsService } from "../services/settings.js";

const LATEST_ONE: RetentionSpec = { mode: "latest", count: 1 };
const CHUNK = 400;
const marks = (n: number): string => Array.from({ length: n }, () => "?").join(",");

function chunks<T>(xs: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Number of times `usesSql` repeats its predicate (once per kind of use). */
const USE_KINDS = 6;

/** The SQL that lists every (version, blob) use with how many reference rows back it. Mirrors `blobInUse` in services/blobs.ts. */
const usesSql = (pred: (versionColumn: string) => string): string => `
  SELECT version_id, blob_id, COUNT(*) AS n FROM (
    SELECT ar.version_id AS version_id, a.blob_id AS blob_id FROM asset_references ar JOIN assets a ON a.id = ar.asset_id WHERE a.blob_id IS NOT NULL AND ${pred("ar.version_id")}
    UNION ALL SELECT version_id, text_blob_id FROM version_content WHERE text_blob_id IS NOT NULL AND ${pred("version_id")}
    UNION ALL SELECT version_id, reader_blob_id FROM version_content WHERE reader_blob_id IS NOT NULL AND ${pred("version_id")}
    UNION ALL SELECT version_id, outline_blob_id FROM version_content WHERE outline_blob_id IS NOT NULL AND ${pred("version_id")}
    UNION ALL SELECT version_id, extraction_blob_id FROM version_content WHERE extraction_blob_id IS NOT NULL AND ${pred("version_id")}
    UNION ALL SELECT version_id, original_blob_id FROM import_documents WHERE ${pred("version_id")}
  ) GROUP BY version_id, blob_id`;

export interface InventoryOptions {
  db: Db;
  settings: Pick<SettingsService, "internal">;
}

/**
 * Reads the archive's reference tables into the shapes the pure planner works on. Everything here is a read; the executor calls it
 * again inside its transaction, so nothing computed earlier (and no cached priority column) decides a delete.
 */
export class StorageInventory {
  constructor(private readonly o: InventoryOptions) {}

  policy(): Policy {
    const s = this.o.settings.internal("storage");
    return { permitImportantEviction: s.permitImportantEviction, pruneSurplusVersions: s.pruneSurplusVersions, maxEvictionBatchBytes: s.maxEvictionBatchBytes };
  }

  /** Pages that have at least one version that is not evicted. */
  allPageIds(): number[] {
    return this.o.db.all<{ id: number }>("SELECT DISTINCT page_id AS id FROM page_versions WHERE status <> 'evicted' ORDER BY page_id").map((r) => r.id);
  }

  /** Pages with a version being captured: a running job is writing to them, so they are left alone (5.2 rule 1). */
  busyPageIds(pageIds?: number[]): Set<number> {
    const rows = pageIds
      ? chunks(pageIds).flatMap((c) => this.o.db.all<{ page_id: number }>(`SELECT DISTINCT page_id FROM page_versions WHERE status = 'capturing' AND page_id IN (${marks(c.length)})`, c))
      : this.o.db.all<{ page_id: number }>("SELECT DISTINCT page_id FROM page_versions WHERE status = 'capturing'");
    return new Set(rows.map((r) => r.page_id));
  }

  /** Reference rows for the given pages (data-model 5.1): sources, collection floors, pins, bookmarks. */
  private referencesFor(pageIds: number[]): Map<number, Reference[]> {
    const { db } = this.o;
    const out = new Map<number, Reference[]>(pageIds.map((id) => [id, []]));
    for (const c of chunks(pageIds)) {
      const q = marks(c.length);
      for (const r of db.all<{
        page_id: number; source_id: number; public_id: string; name: string; priority: number; retention_mode: string; retention_json: string; automatic_eviction: number;
      }>(
        `SELECT ps.page_id, s.id AS source_id, s.public_id, s.name, COALESCE(ps.priority_override, s.priority) AS priority, s.retention_mode, s.retention_json, s.automatic_eviction
         FROM page_sources ps JOIN sources s ON s.id = ps.source_id WHERE s.deleted_at IS NULL AND ps.page_id IN (${q}) ORDER BY ps.page_id, s.id`, c)) {
        const retention = (r.retention_mode === "all" ? { mode: "all" } : { mode: r.retention_mode, ...(JSON.parse(r.retention_json) as object) }) as RetentionSpec;
        const ref: Reference = {
          kind: "source", id: r.public_id, label: r.name, priority: r.priority as Priority, retention, autoEvict: r.automatic_eviction === 1,
        };
        const atoms = retention.mode === "custom" ? retention.rules : [retention];
        const budgets = atoms.filter((a) => a.mode === "budget");
        if (budgets.length > 0) {
          ref.budgetIncluded = budgets.map((b) => this.budgetSet(r.source_id, (b as { bytes: number }).bytes).has(r.page_id));
        }
        out.get(r.page_id)!.push(ref);
      }
      for (const r of db.all<{ page_id: number; public_id: string; name: string; priority_floor: number }>(
        `SELECT m.page_id, c.public_id, c.name, c.priority_floor FROM collection_memberships m JOIN collections c ON c.id = m.collection_id
         WHERE c.deleted_at IS NULL AND c.priority_floor IS NOT NULL AND m.page_id IN (${q}) ORDER BY m.page_id, c.id`, c)) {
        out.get(r.page_id)!.push({ kind: "collection", id: r.public_id, label: r.name, priority: r.priority_floor as Priority, retention: LATEST_ONE, autoEvict: true });
      }
      for (const r of db.all<{ page_id: number; priority: number; reason: string | null }>(
        `SELECT page_id, priority, reason FROM page_pins WHERE page_id IN (${q}) ORDER BY page_id, id`, c)) {
        out.get(r.page_id)!.push({ kind: "pin", id: "pin", label: r.reason ?? "Kept by you", priority: r.priority as Priority, retention: LATEST_ONE, autoEvict: r.priority !== 1 });
      }
      for (const r of db.all<{ page_id: number; public_id: string; title: string; reference_priority: number }>(
        `SELECT p.id AS page_id, b.public_id, b.title, b.reference_priority FROM bookmarks b JOIN pages p ON (b.page_id = p.id OR b.url_key = p.url_key)
         WHERE b.deleted_at IS NULL AND p.id IN (${q}) GROUP BY p.id, b.id ORDER BY p.id, b.id`, c)) {
        out.get(r.page_id)!.push({ kind: "bookmark", id: r.public_id, label: r.title || undefined, priority: r.reference_priority as Priority, retention: LATEST_ONE, autoEvict: true });
      }
    }
    return out;
  }

  private budgetCache = new Map<string, Set<number>>();

  /** Which of a source's pages fit inside `bytes` (task T-02). Cached for the lifetime of one load. */
  private budgetSet(sourceId: number, bytes: number): Set<number> {
    const key = `${sourceId}:${bytes}`;
    const hit = this.budgetCache.get(key);
    if (hit) return hit;
    const { db } = this.o;
    const rows = db.all<{ page_id: number; last_captured_at: number | null; blob_id: number; stored_bytes: number }>(
      `SELECT p.id AS page_id, p.last_captured_at, u.blob_id, b.stored_bytes
       FROM page_sources ps JOIN pages p ON p.id = ps.page_id JOIN (${usesSql((col) => `${col} IN (SELECT p2.latest_version_id FROM page_sources ps2 JOIN pages p2 ON p2.id = ps2.page_id WHERE ps2.source_id = ${Math.trunc(sourceId)})`)}) u ON u.version_id = p.latest_version_id
       JOIN blobs b ON b.id = u.blob_id WHERE ps.source_id = ?`, [sourceId]);
    const pages = new Map<number, { pageId: number; lastCapturedAt: number | null; blobs: { blobId: number; storedBytes: number }[] }>();
    for (const r of rows) {
      let p = pages.get(r.page_id);
      if (!p) pages.set(r.page_id, (p = { pageId: r.page_id, lastCapturedAt: r.last_captured_at, blobs: [] }));
      p.blobs.push({ blobId: r.blob_id, storedBytes: r.stored_bytes });
    }
    const included = evaluateBudget([...pages.values()], bytes);
    this.budgetCache.set(key, included);
    return included;
  }

  /** Pages with their versions, blob uses and references. */
  loadPages(pageIds: number[]): PageInfo[] {
    const { db } = this.o;
    this.budgetCache = new Map();
    const ids = [...new Set(pageIds)].sort((a, b) => a - b);
    if (ids.length === 0) return [];
    const refs = this.referencesFor(ids);
    const busy = this.busyPageIds(ids);
    const out: PageInfo[] = [];
    for (const c of chunks(ids)) {
      const q = marks(c.length);
      const pages = db.all<{ id: number; canonical_url: string; latest_version_id: number | null }>(`SELECT id, canonical_url, latest_version_id FROM pages WHERE id IN (${q}) ORDER BY id`, c);
      const versions = db.all<{ id: number; page_id: number; version_no: number; fetched_at: number; status: VersionStatus; last_accessed_at: number | null }>(
        `SELECT id, page_id, version_no, fetched_at, status, last_accessed_at FROM page_versions WHERE page_id IN (${q}) ORDER BY page_id, id`, c);
      const uses = db.all<{ version_id: number; blob_id: number; n: number }>(
        usesSql((col) => `${col} IN (SELECT id FROM page_versions WHERE page_id IN (${q}))`), Array.from({ length: USE_KINDS }, () => c).flat());
      const byVersion = new Map<number, { blobId: number; refs: number }[]>();
      for (const u of uses) {
        const l = byVersion.get(u.version_id) ?? [];
        l.push({ blobId: u.blob_id, refs: u.n });
        byVersion.set(u.version_id, l);
      }
      const vByPage = new Map<number, VersionInfo[]>();
      for (const v of versions) {
        const l = vByPage.get(v.page_id) ?? [];
        l.push({ id: v.id, versionNo: v.version_no, fetchedAt: v.fetched_at, status: v.status, lastAccessedAt: v.last_accessed_at, blobs: (byVersion.get(v.id) ?? []).sort((a, b) => a.blobId - b.blobId) });
        vByPage.set(v.page_id, l);
      }
      for (const p of pages) {
        out.push({ id: p.id, url: p.canonical_url, latestVersionId: p.latest_version_id, versions: vByPage.get(p.id) ?? [], refs: refs.get(p.id) ?? [], busy: busy.has(p.id) });
      }
    }
    return out;
  }

  /** Every blob the given pages use, with `totalRefs` recounted from the reference rows across the whole archive. */
  blobsFor(pages: readonly PageInfo[]): BlobInfo[] {
    const ids = new Set<number>();
    for (const p of pages) for (const v of p.versions) for (const b of v.blobs) ids.add(b.blobId);
    return this.blobInfos([...ids]);
  }

  blobInfos(blobIds: number[]): BlobInfo[] {
    const { db } = this.o;
    const out: BlobInfo[] = [];
    const ids = [...blobIds].sort((a, b) => a - b);
    for (const c of chunks(ids, 150)) {
      const q = marks(c.length);
      const totals = new Map<number, number>();
      for (const r of db.all<{ blob_id: number; n: number }>(
        `SELECT blob_id, SUM(n) AS n FROM (
           SELECT a.blob_id AS blob_id, COUNT(*) AS n FROM asset_references ar JOIN assets a ON a.id = ar.asset_id WHERE a.blob_id IN (${q}) GROUP BY a.blob_id
           UNION ALL SELECT text_blob_id, COUNT(*) FROM version_content WHERE text_blob_id IN (${q}) GROUP BY text_blob_id
           UNION ALL SELECT reader_blob_id, COUNT(*) FROM version_content WHERE reader_blob_id IN (${q}) GROUP BY reader_blob_id
           UNION ALL SELECT outline_blob_id, COUNT(*) FROM version_content WHERE outline_blob_id IN (${q}) GROUP BY outline_blob_id
           UNION ALL SELECT extraction_blob_id, COUNT(*) FROM version_content WHERE extraction_blob_id IN (${q}) GROUP BY extraction_blob_id
           UNION ALL SELECT original_blob_id, COUNT(*) FROM import_documents WHERE original_blob_id IN (${q}) GROUP BY original_blob_id
         ) GROUP BY blob_id`, [...c, ...c, ...c, ...c, ...c, ...c])) totals.set(r.blob_id, r.n);
      // A version still being captured also holds its original document by hash before its asset reference exists.
      for (const r of db.all<{ id: number; stored_bytes: number; volume_id: number; held: number }>(
        `SELECT b.id, b.stored_bytes, b.volume_id,
                (SELECT COUNT(*) FROM page_versions pv WHERE pv.status = 'capturing' AND pv.raw_hash = b.sha256
                   AND NOT EXISTS (SELECT 1 FROM asset_references ar JOIN assets a ON a.id = ar.asset_id WHERE ar.version_id = pv.id AND a.blob_id = b.id)) AS held
         FROM blobs b WHERE b.id IN (${q}) ORDER BY b.id`, c)) {
        out.push({ id: r.id, storedBytes: r.stored_bytes, volumeId: r.volume_id, totalRefs: (totals.get(r.id) ?? 0) + r.held });
      }
    }
    return out;
  }

  /** Blobs nothing references (counted from the rows), unreferenced for longer than `graceMs`: reclaiming them loses no content. */
  unreferencedBlobs(graceMs: number, now: number): { blobId: number; storedBytes: number; volumeId: number }[] {
    return this.o.db.all<{ id: number; stored_bytes: number; volume_id: number }>(
      `SELECT b.id, b.stored_bytes, b.volume_id FROM blobs b
       WHERE b.state IN ('ready','missing') AND b.zero_since IS NOT NULL AND b.zero_since <= ? AND b.refcount = 0
         AND NOT EXISTS (SELECT 1 FROM asset_references ar JOIN assets a ON a.id = ar.asset_id WHERE a.blob_id = b.id)
         AND NOT EXISTS (SELECT 1 FROM version_content vc WHERE vc.text_blob_id = b.id OR vc.reader_blob_id = b.id OR vc.outline_blob_id = b.id OR vc.extraction_blob_id = b.id)
         AND NOT EXISTS (SELECT 1 FROM import_documents d WHERE d.original_blob_id = b.id)
         AND NOT EXISTS (SELECT 1 FROM page_versions pv WHERE pv.status = 'capturing' AND (pv.raw_hash = b.sha256 OR pv.document_blob_id = b.id))
       ORDER BY b.id`, [now - graceMs]).map((r) => ({ blobId: r.id, storedBytes: r.stored_bytes, volumeId: r.volume_id }));
  }
}
