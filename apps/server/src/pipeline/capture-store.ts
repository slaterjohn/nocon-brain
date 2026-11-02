import { Readable } from "node:stream";
import { decodeHtml } from "@ncb/content";
import type { Db } from "@ncb/db";
import type { AssetHandle, CaptureStore, DocumentBody, LinkTarget, ReaderBody, ResourceRef, VersionRef, ZimEntry, ZimPackageRef } from "../archive/store.js";
import type { ZimContent } from "../zim/content.js";
import type { BlobStore } from "../services/blobs.js";

export interface SqliteCaptureStoreOptions {
  db: Db;
  blobs: BlobStore;
  /** Normalised dedup key for a URL (the pipeline's `urlKey`). */
  urlKey(url: string): string;
  connectivity(): "online" | "offline";
  /** Knowledge packages (Phase 8). Without it the listener answers every `z/` URL with its "not available" page. */
  zim?: ZimContent;
}

interface VRow {
  public_id: string;
  page_pid: string;
  status: "ready" | "partial";
  final_url: string;
  headers_json: string | null;
  id: number;
  title: string | null;
}

const VERSION_SQL = `SELECT v.id, v.public_id, p.public_id AS page_pid, v.status, v.final_url, v.headers_json, v.title
  FROM page_versions v JOIN pages p ON p.id = v.page_id`;

/** `CaptureStore` over the Phase 2 tables. Reads only; the listener never writes except `last_accessed_at`. */
export class SqliteCaptureStore implements CaptureStore {
  constructor(private readonly o: SqliteCaptureStoreOptions) {}

  private ref(r: VRow | undefined): VersionRef | null {
    if (!r) return null;
    const missing = this.o.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM version_resources WHERE version_id = ? AND status <> 'ok'", [r.id])!.n;
    return { versionId: r.public_id, pageId: r.page_pid, status: r.status, url: r.final_url, missingResources: missing };
  }

  async latestVersion(pageId: string): Promise<VersionRef | null> {
    return this.ref(this.o.db.get<VRow>(`${VERSION_SQL} WHERE p.public_id = ? AND v.id = p.latest_version_id AND v.status IN ('ready','partial')`, [pageId]));
  }

  async getVersion(versionId: string): Promise<VersionRef | null> {
    return this.ref(this.o.db.get<VRow>(`${VERSION_SQL} WHERE v.public_id = ? AND v.status IN ('ready','partial')`, [versionId]));
  }

  private row(versionId: string) {
    return this.o.db.get<VRow & { doc_sha: string | null; reader_sha: string | null }>(
      `SELECT v.id, v.public_id, p.public_id AS page_pid, v.status, v.final_url, v.headers_json, v.title, d.sha256 AS doc_sha, r.sha256 AS reader_sha
       FROM page_versions v JOIN pages p ON p.id = v.page_id LEFT JOIN blobs d ON d.id = v.document_blob_id
       LEFT JOIN version_content vc ON vc.version_id = v.id LEFT JOIN blobs r ON r.id = vc.reader_blob_id WHERE v.public_id = ?`, [versionId]);
  }

  async readDocument(version: VersionRef): Promise<DocumentBody | null> {
    const r = this.row(version.versionId);
    if (!r?.doc_sha) return null;
    const { data } = await this.o.blobs.read(r.doc_sha);
    const headers = r.headers_json ? (JSON.parse(r.headers_json) as Record<string, string>) : {};
    return { html: decodeHtml(data, headers["content-type"]).text, baseUrl: r.final_url };
  }

  async readReader(version: VersionRef): Promise<ReaderBody | null> {
    const r = this.row(version.versionId);
    if (!r?.reader_sha) return null;
    const { data } = await this.o.blobs.read(r.reader_sha);
    return { title: r.title ?? "", html: data.toString("utf8") };
  }

  async listResources(versionId: string): Promise<ResourceRef[]> {
    return this.o.db
      .all<{ url: string; key: string; mime: string | null }>(
        `SELECT r.url, r.resource_key AS key, b.mime FROM version_resources r JOIN page_versions v ON v.id = r.version_id
         JOIN assets a ON a.id = r.asset_id JOIN blobs b ON b.id = a.blob_id WHERE v.public_id = ? AND r.status = 'ok' ORDER BY r.id`, [versionId])
      .map((r) => ({ url: r.url, assetKey: r.key, contentType: r.mime ?? undefined }));
  }

  async getAsset(versionId: string, assetKey: string): Promise<AssetHandle | null> {
    const r = this.o.db.get<{ sha256: string; mime: string | null; size_bytes: number }>(
      `SELECT b.sha256, b.mime, b.size_bytes FROM version_resources r JOIN page_versions v ON v.id = r.version_id
       JOIN assets a ON a.id = r.asset_id JOIN blobs b ON b.id = a.blob_id
       WHERE v.public_id = ? AND r.resource_key = ? AND r.status = 'ok' AND v.status IN ('ready','partial')`, [versionId, assetKey]);
    if (!r) return null;
    const blobs = this.o.blobs;
    return {
      contentType: r.mime ?? "application/octet-stream",
      size: r.size_bytes,
      sha256: r.sha256,
      open(range) {
        if (!range) {
          const out = new Readable({ read() {} });
          blobs.open(r.sha256).then(({ stream }) => stream.on("data", (c) => out.push(c)).on("end", () => out.push(null)).on("error", (e) => out.destroy(e)), (e) => out.destroy(e));
          return out;
        }
        const out = new Readable({ read() {} });
        blobs.read(r.sha256).then(({ data }) => { out.push(data.subarray(range.start, range.end + 1)); out.push(null); }, (e) => out.destroy(e));
        return out;
      },
      async readAll(maxBytes) {
        if (r.size_bytes > maxBytes) throw new Error("asset too large");
        return (await blobs.read(r.sha256)).data;
      },
    };
  }

  async lookupLinks(urls: string[]): Promise<Map<string, LinkTarget>> {
    const out = new Map<string, LinkTarget>();
    const { db } = this.o;
    for (const u of urls) {
      let key: string;
      try {
        key = this.o.urlKey(u);
      } catch {
        continue;
      }
      const p = db.get<{ public_id: string; availability: string; status: string | null }>(
        `SELECT p.public_id, p.availability, v.status FROM pages p LEFT JOIN page_versions v ON v.id = p.latest_version_id
         WHERE p.id = COALESCE((SELECT id FROM pages WHERE url_key = ?), (SELECT page_id FROM page_aliases WHERE url_key = ?))`, [key, key]);
      if (p && (p.status === "ready" || p.status === "partial")) {
        out.set(u, { kind: "page", pageId: p.public_id, status: p.status });
        continue;
      }
      const queued = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type = 'fetch' AND url_key = ? AND state IN ('queued','running','held')", [key])!.n;
      if (queued > 0) out.set(u, { kind: "queued" });
      else if (p) out.set(u, { kind: "unavailable" });
    }
    return out;
  }

  connectivity(): "online" | "offline" {
    return this.o.connectivity();
  }

  getZimEntry(zimId: string, path: string): Promise<ZimEntry | null> {
    return this.o.zim ? this.o.zim.entry(zimId, path) : Promise.resolve(null);
  }

  zimPackage(zimId: string): Promise<ZimPackageRef | null> {
    return this.o.zim ? this.o.zim.package(zimId) : Promise.resolve(null);
  }

  zimExists(zimId: string, paths: string[]): Promise<Set<string>> {
    return this.o.zim ? this.o.zim.exists(zimId, paths) : Promise.resolve(new Set());
  }

  touchVersions(versionIds: string[], atMs: number): void {
    const { db } = this.o;
    db.transaction(() => {
      for (const id of versionIds) db.run("UPDATE page_versions SET last_accessed_at = ? WHERE public_id = ?", [atMs, id]);
    });
  }
}
