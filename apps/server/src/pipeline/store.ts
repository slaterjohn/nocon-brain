import { createHash } from "node:crypto";
import type { Db } from "@ncb/db";
import type { BlobStore } from "../services/blobs.js";

/** A version row in the shape the stages use. */
export interface VersionRow {
  id: number;
  publicId: string;
  pageId: number;
  versionNo: number;
  downloadJobId: number | null;
  sourceId: number | null;
  requestedUrl: string;
  finalUrl: string;
  status: string;
  httpStatus: number | null;
  documentBlobId: number | null;
  rawHash: string | null;
  rawBytes: number | null;
  mime: string | null;
  contentHash: string | null;
  etag: string | null;
  lastModified: string | null;
  headers: Record<string, string>;
  metadata: Record<string, unknown> | null;
  fetchedAt: number;
  wordCount: number | null;
}

interface Raw {
  id: number; public_id: string; page_id: number; version_no: number; download_job_id: number | null; source_id: number | null;
  requested_url: string; final_url: string; status: string; http_status: number | null; document_blob_id: number | null;
  raw_hash: string | null; raw_bytes: number | null; mime: string | null; content_hash: string | null; etag: string | null;
  last_modified: string | null; headers_json: string | null; metadata_json: string | null; fetched_at: number; word_count: number | null;
}

export function loadVersion(db: Db, id: number): VersionRow | undefined {
  const r = db.get<Raw>("SELECT * FROM page_versions WHERE id = ?", [id]);
  if (!r) return undefined;
  return {
    id: r.id, publicId: r.public_id, pageId: r.page_id, versionNo: r.version_no, downloadJobId: r.download_job_id, sourceId: r.source_id,
    requestedUrl: r.requested_url, finalUrl: r.final_url, status: r.status, httpStatus: r.http_status, documentBlobId: r.document_blob_id,
    rawHash: r.raw_hash, rawBytes: r.raw_bytes, mime: r.mime, contentHash: r.content_hash, etag: r.etag, lastModified: r.last_modified,
    headers: r.headers_json ? (JSON.parse(r.headers_json) as Record<string, string>) : {},
    metadata: r.metadata_json ? (JSON.parse(r.metadata_json) as Record<string, unknown>) : null,
    fetchedAt: r.fetched_at, wordCount: r.word_count,
  };
}

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Normalised main text used for change detection and exact-duplicate detection. */
export function contentHashOf(text: string): string {
  return sha256Hex(text.normalize("NFC").replace(/\s+/g, " ").trim());
}

/**
 * Sets a `version_content` blob column once. Returns true when it was newly set (and the reference was
 * counted), false when it already held a blob, which makes every stage re-runnable.
 */
export function setContentBlob(
  db: Db, blobs: BlobStore, versionId: number, column: "text_blob_id" | "reader_blob_id" | "outline_blob_id" | "extraction_blob_id", blobId: number,
): boolean {
  return db.transaction(() => {
    db.run("INSERT INTO version_content (version_id) VALUES (?) ON CONFLICT(version_id) DO NOTHING", [versionId]);
    const r = db.run(`UPDATE version_content SET ${column} = ? WHERE version_id = ? AND ${column} IS NULL`, [blobId, versionId]);
    if (r.changes === 1) blobs.addRef(blobId);
    return r.changes === 1;
  });
}

/**
 * Deletes a version row and everything hanging off it, releasing blob references so the blobs become
 * collectable. Asset rows left with no references are removed too (a blob row cannot be collected while an
 * asset still points at it).
 */
export function deleteVersion(db: Db, blobs: BlobStore, versionId: number): void {
  db.transaction(() => {
    const refs = db.all<{ blob_id: number; n: number }>(
      `SELECT a.blob_id AS blob_id, COUNT(*) AS n FROM asset_references ar JOIN assets a ON a.id = ar.asset_id
       WHERE ar.version_id = ? AND a.blob_id IS NOT NULL GROUP BY a.blob_id`, [versionId]);
    for (const r of refs) blobs.release(r.blob_id, r.n);
    const content = db.get<Record<string, number | null>>(
      "SELECT text_blob_id, reader_blob_id, outline_blob_id, extraction_blob_id FROM version_content WHERE version_id = ?", [versionId]);
    for (const id of Object.values(content ?? {})) if (id) blobs.release(id, 1);
    const assetIds = db.all<{ asset_id: number }>("SELECT DISTINCT asset_id FROM asset_references WHERE version_id = ? UNION SELECT DISTINCT via_asset_id FROM asset_references WHERE version_id = ? AND via_asset_id IS NOT NULL", [versionId, versionId]);
    db.run("UPDATE page_versions SET duplicate_of_version_id = NULL WHERE duplicate_of_version_id = ?", [versionId]);
    db.run("UPDATE pages SET latest_version_id = NULL WHERE latest_version_id = ?", [versionId]);
    db.run("DELETE FROM page_versions WHERE id = ?", [versionId]);
    for (const a of assetIds) {
      db.run(
        `DELETE FROM assets WHERE id = ? AND NOT EXISTS (SELECT 1 FROM asset_references WHERE asset_id = assets.id OR via_asset_id = assets.id)
           AND NOT EXISTS (SELECT 1 FROM version_resources WHERE asset_id = assets.id)`, [a.asset_id]);
    }
  });
}
