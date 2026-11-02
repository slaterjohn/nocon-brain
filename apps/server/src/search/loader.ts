import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { IndexDoc } from "@ncb/search";

/** Reads one page from `main.db` and its stored text into an index document (S-02). Works on any synchronous connection. */
export interface SyncDb {
  get<T>(sql: string, params?: unknown[]): T | undefined;
  all<T>(sql: string, params?: unknown[]): T[];
}

interface PageRow {
  id: number; public_id: string; canonical_url: string; host: string; registrable_domain: string; origin: string; content_type: string | null;
  title: string | null; language: string | null; latest_version_id: number | null; availability: string; effective_priority: number | null;
  inbound_count: number; deleted_at: number | null; last_captured_at: number | null; first_captured_at: number | null;
}
interface VersionRow {
  id: number; status: string; title: string | null; description: string | null; language: string | null; published_at: number | null; fetched_at: number;
  content_hash: string | null; final_url: string;
}

export const ELIGIBLE_SQL = `p.deleted_at IS NULL AND p.availability IN ('archived','partial') AND v.status IN ('ready','partial')`;

export function countEligible(db: SyncDb): number {
  return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM pages p JOIN page_versions v ON v.id = p.latest_version_id WHERE ${ELIGIBLE_SQL}`)!.n;
}

export function eligibleIdsAfter(db: SyncDb, after: number, limit: number): number[] {
  return db.all<{ id: number }>(
    `SELECT p.id AS id FROM pages p JOIN page_versions v ON v.id = p.latest_version_id WHERE ${ELIGIBLE_SQL} AND p.id > ? ORDER BY p.id LIMIT ?`, [after, limit]).map((r) => r.id);
}

export function isEligible(db: SyncDb, pageId: number): boolean {
  return !!db.get(`SELECT 1 AS x FROM pages p JOIN page_versions v ON v.id = p.latest_version_id WHERE ${ELIGIBLE_SQL} AND p.id = ?`, [pageId]);
}

/** Reads a blob's decoded bytes straight from its volume. Returns null when the blob or its file is missing. */
export function readBlobSync(db: SyncDb, blobId: number | null | undefined, maxBytes = 2_000_000): Buffer | null {
  if (blobId == null) return null;
  const row = db.get<{ sha256: string; compression: string; state: string; root_path: string }>(
    "SELECT b.sha256, b.compression, b.state, v.root_path FROM blobs b JOIN volumes v ON v.id = b.volume_id WHERE b.id = ?", [blobId]);
  if (!row || row.state !== "ready" || !/^[0-9a-f]{64}$/.test(row.sha256)) return null;
  const file = path.join(row.root_path, "blobs", row.sha256.slice(0, 2), row.sha256.slice(2, 4), row.compression === "zstd" ? `${row.sha256}.zst` : row.sha256);
  try {
    const raw = fs.readFileSync(file);
    const out = row.compression === "zstd" ? zlib.zstdDecompressSync(raw) : raw;
    return out.length > maxBytes ? out.subarray(0, maxBytes) : out;
  } catch {
    return null;
  }
}

/** Source and collection ids for a page, with the ancestors of its collections. */
export function membershipOf(db: SyncDb, pageId: number): { sourceIds: string[]; collectionIds: string[] } {
  const sourceIds = db.all<{ public_id: string }>(
    "SELECT s.public_id FROM page_sources ps JOIN sources s ON s.id = ps.source_id WHERE ps.page_id = ? AND s.deleted_at IS NULL ORDER BY s.id", [pageId]).map((r) => r.public_id);
  const collectionIds = db.all<{ public_id: string }>(
    `WITH RECURSIVE anc(id, parent_id) AS (
       SELECT c.id, c.parent_id FROM collections c WHERE c.deleted_at IS NULL AND c.id IN (SELECT collection_id FROM collection_memberships WHERE page_id = ?)
       UNION
       SELECT c.id, c.parent_id FROM collections c JOIN anc ON c.id = anc.parent_id WHERE c.deleted_at IS NULL)
     SELECT public_id FROM collections WHERE id IN (SELECT id FROM anc) ORDER BY id`, [pageId]).map((r) => r.public_id);
  return { sourceIds, collectionIds };
}

export type LoadResult = { doc: IndexDoc } | { gone: true; reason: string };

/** The index document for a page, or why it should not be in the index. */
export function loadDoc(db: SyncDb, pageId: number): LoadResult {
  const p = db.get<PageRow>("SELECT * FROM pages WHERE id = ?", [pageId]);
  if (!p) return { gone: true, reason: "no such page" };
  if (p.deleted_at !== null) return { gone: true, reason: "deleted" };
  if (p.availability !== "archived" && p.availability !== "partial") return { gone: true, reason: `availability ${p.availability}` };
  if (p.latest_version_id === null) return { gone: true, reason: "no version" };
  const v = db.get<VersionRow>("SELECT id, status, title, description, language, published_at, fetched_at, content_hash, final_url FROM page_versions WHERE id = ?", [p.latest_version_id]);
  if (!v || (v.status !== "ready" && v.status !== "partial")) return { gone: true, reason: `version ${v?.status ?? "missing"}` };
  const content = db.get<{ text_blob_id: number | null; outline_blob_id: number | null; keywords_json: string | null }>(
    "SELECT text_blob_id, outline_blob_id, keywords_json FROM version_content WHERE version_id = ?", [v.id]);
  const body = readBlobSync(db, content?.text_blob_id)?.toString("utf8") ?? "";
  let headings = "";
  const outline = readBlobSync(db, content?.outline_blob_id);
  if (outline) {
    try {
      const o = JSON.parse(outline.toString("utf8")) as { sections?: { level: number; heading: string }[] };
      headings = (o.sections ?? []).filter((s) => s.level > 0 && s.heading).map((s) => s.heading).join("\n");
    } catch { /* an unreadable outline only costs the headings */ }
  }
  let keywords = "";
  if (content?.keywords_json) {
    try { keywords = (JSON.parse(content.keywords_json) as string[]).join(" "); } catch { /* ignore */ }
  }
  const m = membershipOf(db, p.id);
  const type = (p.content_type ?? "html") as IndexDoc["type"];
  return {
    doc: {
      pageId: p.id, versionId: v.id, publicPageId: p.public_id, url: p.canonical_url, domain: p.host, registrableDomain: p.registrable_domain,
      title: (v.title ?? p.title ?? "").trim() || p.canonical_url, description: v.description ?? "", keywords, headings, body,
      lang: v.language ?? p.language, type, origin: p.origin, capturedAt: p.last_captured_at ?? v.fetched_at, publishedAt: v.published_at,
      availability: p.availability as "archived" | "partial", priority: p.effective_priority, inlinks: p.inbound_count, contentHash: v.content_hash,
      sourceIds: m.sourceIds, collectionIds: m.collectionIds,
    },
  };
}
