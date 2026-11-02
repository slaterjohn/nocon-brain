import fs from "node:fs";
import path from "node:path";
import { newId } from "@ncb/shared";
import { startBrowserServer, type BrowserTest } from "../integration/browser/helpers.js";
import type { StartOptions } from "../integration/server/helpers.js";
import { blobPathFor } from "@ncb/server";

export const DAY = 86_400_000;

export type RetentionIn = { mode: string; [k: string]: unknown };

export interface BlobSpec {
  /** Blobs with the same tag and size are the same blob (shared between pages). */
  tag: string;
  bytes: number;
}

export interface VersionSpec {
  ageDays?: number;
  blobs?: BlobSpec[];
  status?: "ready" | "partial" | "capturing" | "failed";
  lastAccessedDaysAgo?: number;
}

export interface PageSpec {
  url: string;
  sources?: number[];
  versions?: VersionSpec[];
  pin?: 1 | 2 | 3 | 4;
  bookmark?: 1 | 2 | 3 | 4;
  collectionFloor?: 1 | 2 | 3 | 4;
}

export interface SeededPage {
  pageId: number;
  publicId: string;
  versionIds: number[];
  versionPublicIds: string[];
  blobShas: string[];
}

/** Bytes with a recognisable tag at the front, padded to exactly `bytes`. Stored uncompressed (kind "other"), so stored size = bytes. */
export const payload = (b: BlobSpec): Buffer => Buffer.from(`${b.tag}:`.padEnd(b.bytes, "."), "utf8").subarray(0, b.bytes);

/** Builds an archive directly in the database (and real blob files) so a test controls priorities, versions and sharing exactly. */
export class Seeder {
  private n = 0;
  constructor(readonly t: BrowserTest) {}

  source(o: {
    name?: string; priority: 1 | 2 | 3 | 4; retention?: RetentionIn; automaticEviction?: boolean; storageBudgetBytes?: number; preferredVolumeId?: number;
    enabled?: boolean;
  }): number {
    const { db, clock } = this.t.svc;
    const { mode, ...rest } = o.retention ?? { mode: "latest", count: 1 };
    const r = db.run(
      `INSERT INTO sources (public_id, name, type, adapter, strategy, profile, priority, retention_mode, retention_json, automatic_eviction, storage_budget_bytes, preferred_volume_id, enabled, created_at, updated_at)
       VALUES (?, ?, 'single_page', 'http', 'capture', 'focused', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId("src"), o.name ?? `Source ${++this.n}`, o.priority, mode, JSON.stringify(rest), (o.automaticEviction ?? o.priority >= 3) ? 1 : 0, o.storageBudgetBytes ?? null,
        o.preferredVolumeId ?? null, o.enabled === false ? 0 : 1, clock.now(), clock.now()]);
    return Number(r.lastInsertRowid);
  }

  async page(spec: PageSpec): Promise<SeededPage> {
    const { db, clock, blobs } = this.t.svc;
    const now = clock.now();
    const host = new URL(spec.url).hostname;
    const pageNo = ++this.n;
    const pageRow = db.run(
      `INSERT INTO pages (public_id, url_key, canonical_url, host, registrable_domain, origin, content_type, availability, effective_priority, created_at, last_captured_at, first_captured_at)
       VALUES (?, ?, ?, ?, ?, 'web', 'html', 'archived', NULL, ?, ?, ?)`,
      [newId("pg"), spec.url, spec.url, host, host, now, now, now]);
    const pageId = Number(pageRow.lastInsertRowid);
    const out: SeededPage = { pageId, publicId: db.get<{ p: string }>("SELECT public_id AS p FROM pages WHERE id = ?", [pageId])!.p, versionIds: [], versionPublicIds: [], blobShas: [] };
    const versions = spec.versions ?? [{}];
    let latest: number | null = null;
    let latestFetched = -Infinity;
    for (const [i, v] of versions.entries()) {
      const fetched = now - (v.ageDays ?? (versions.length - 1 - i)) * DAY;
      const status = v.status ?? "ready";
      const vr = db.run(
        `INSERT INTO page_versions (public_id, page_id, version_no, requested_url, final_url, status, fetched_at, created_at, last_accessed_at, total_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId("ver"), pageId, i + 1, spec.url, spec.url, status, fetched, fetched, v.lastAccessedDaysAgo === undefined ? null : now - v.lastAccessedDaysAgo * DAY,
          (v.blobs ?? []).reduce((n, b) => n + b.bytes, 0)]);
      const versionId = Number(vr.lastInsertRowid);
      out.versionIds.push(versionId);
      out.versionPublicIds.push(db.get<{ p: string }>("SELECT public_id AS p FROM page_versions WHERE id = ?", [versionId])!.p);
      for (const b of v.blobs ?? []) {
        const put = await blobs.put(payload(b), { kind: "other" });
        const url = `https://assets.test/${put.blob.sha256}`;
        db.run("INSERT INTO assets (blob_id, url, url_key, kind, status, fetched_at, size_bytes) VALUES (?, ?, ?, 'other', 'ok', ?, ?) ON CONFLICT (url_key, blob_id) WHERE blob_id IS NOT NULL DO NOTHING", [put.blob.id, url, url, now, b.bytes]);
        const asset = db.get<{ id: number }>("SELECT id FROM assets WHERE url_key = ? AND blob_id = ?", [url, put.blob.id])!;
        const ref = db.run("INSERT INTO asset_references (version_id, asset_id, role, referenced_url) VALUES (?, ?, 'other', ?) ON CONFLICT DO NOTHING", [versionId, asset.id, url]);
        if (ref.changes === 1) blobs.addRef(put.blob.id);
        if (!out.blobShas.includes(put.blob.sha256)) out.blobShas.push(put.blob.sha256);
      }
      if ((status === "ready" || status === "partial") && fetched >= latestFetched) {
        latest = versionId;
        latestFetched = fetched;
      }
    }
    db.run("UPDATE pages SET latest_version_id = ?, version_count = ?, availability = ? WHERE id = ?", [latest, versions.filter((v) => !v.status || v.status === "ready" || v.status === "partial").length, latest ? "archived" : "failed", pageId]);
    for (const s of spec.sources ?? []) db.run("INSERT INTO page_sources (page_id, source_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)", [pageId, s, now, now]);
    const user = db.get<{ id: number }>("SELECT id FROM users ORDER BY id LIMIT 1")!.id;
    if (spec.pin) db.run("INSERT INTO page_pins (page_id, user_id, priority, created_at) VALUES (?, ?, ?, ?)", [pageId, user, spec.pin, now]);
    if (spec.bookmark) {
      db.run("INSERT INTO bookmarks (public_id, user_id, original_url, url_key, title, page_id, reference_priority, created_at) VALUES (?, ?, ?, ?, '', ?, ?, ?)", [newId("bm"), user, spec.url, spec.url, pageId, spec.bookmark, now]);
    }
    if (spec.collectionFloor) {
      const c = db.run("INSERT INTO collections (public_id, name, priority_floor, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [newId("col"), `Floor ${pageNo}`, spec.collectionFloor, now, now]);
      db.run("INSERT INTO collection_memberships (collection_id, page_id, added_by, added_at) VALUES (?, ?, 'user', ?)", [Number(c.lastInsertRowid), pageId, now]);
    }
    this.t.svc.storage.priority.recomputePage(pageId);
    return out;
  }

  /** File path of a blob on its volume. */
  blobFile(sha: string): string {
    const b = this.t.svc.blobs.bySha(sha)!;
    const v = this.t.svc.volumes.byId(b.volumeId)!;
    return blobPathFor(v.rootPath, sha, b.compression === "zstd");
  }

  blobExists(sha: string): boolean {
    const b = this.t.svc.blobs.bySha(sha);
    if (!b) return false;
    return fs.existsSync(this.blobFile(sha));
  }

  versionStatus(versionId: number): string {
    return this.t.svc.db.get<{ s: string }>("SELECT status AS s FROM page_versions WHERE id = ?", [versionId])!.s;
  }
}

export interface StorageTest extends BrowserTest {
  seed: Seeder;
}

/** A browser-test server (signed-in administrator, search index running) with a Seeder. */
export async function startStorageTest(opts: StartOptions & { quotaBytes?: number; reserveFreeBytes?: number; signIn?: boolean } = {}): Promise<StorageTest> {
  const { quotaBytes, reserveFreeBytes, ...rest } = opts;
  const t = await startBrowserServer({ ...rest, server: { storageTickMs: 0, ...(rest.server ?? {}) } });
  if (quotaBytes !== undefined || reserveFreeBytes !== undefined) {
    const v = t.svc.volumes.list()[0]!;
    await t.svc.volumes.update(v.publicId, { ...(quotaBytes !== undefined ? { quotaBytes } : {}), ...(reserveFreeBytes !== undefined ? { reserveFreeBytes } : {}) });
  }
  return Object.assign(t, { seed: new Seeder(t) }) as StorageTest;
}

export function secondVolume(t: BrowserTest, name = "Second"): ReturnType<BrowserTest["svc"]["volumes"]["register"]> {
  const dir = path.join(t.rootsDir, "vol2");
  fs.mkdirSync(dir, { recursive: true });
  return t.svc.volumes.register({ path: dir, name });
}

/** Snapshot of everything a dry run must not touch. */
export function archiveSignature(t: BrowserTest): Record<string, unknown> {
  const q = <X>(sql: string) => t.svc.db.all<X>(sql);
  return {
    versions: q("SELECT id, status, page_id FROM page_versions ORDER BY id"),
    pages: q("SELECT id, latest_version_id, availability, effective_priority FROM pages ORDER BY id"),
    blobs: q("SELECT id, sha256, refcount, state, zero_since FROM blobs ORDER BY id"),
    refs: q("SELECT COUNT(*) AS n FROM asset_references"),
    audit: q("SELECT COUNT(*) AS n FROM storage_audit"),
    outbox: q("SELECT COUNT(*) AS n FROM index_outbox"),
    files: allFiles(t),
  };
}

export function allFiles(t: BrowserTest): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(t.rootsDir, p));
    }
  };
  walk(t.rootsDir);
  return out.sort();
}

/** The structural invariants every test of the executor checks at the end. */
export function expectConsistent(t: BrowserTest, expect: typeof import("vitest").expect): void {
  const db = t.svc.db;
  // no ready blob without its file
  for (const b of db.all<{ sha256: string; volume_id: number; compression: string; state: string }>("SELECT sha256, volume_id, compression, state FROM blobs WHERE state = 'ready'")) {
    const v = t.svc.volumes.byId(b.volume_id)!;
    expect(fs.existsSync(blobPathFor(v.rootPath, b.sha256, b.compression === "zstd")), `file of blob ${b.sha256}`).toBe(true);
  }
  // refcount equals the references
  const bad = db.all<{ id: number }>(
    `SELECT b.id FROM blobs b WHERE b.refcount <> (
       (SELECT COUNT(*) FROM asset_references ar JOIN assets a ON a.id = ar.asset_id WHERE a.blob_id = b.id)
       + (SELECT COUNT(*) FROM version_content WHERE text_blob_id = b.id OR reader_blob_id = b.id OR outline_blob_id = b.id OR extraction_blob_id = b.id)
       + (SELECT COUNT(*) FROM import_documents WHERE original_blob_id = b.id))`);
  expect(bad, "refcounts match the references").toEqual([]);
  // nothing left evicting
  expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions WHERE status = 'evicting'")!.n, "no version left evicting").toBe(0);
  // latest pointers valid
  expect(db.all("SELECT p.id FROM pages p WHERE p.latest_version_id IS NOT NULL AND p.latest_version_id NOT IN (SELECT id FROM page_versions WHERE page_id = p.id AND status IN ('ready','partial'))")).toEqual([]);
  // no foreign key violations
  expect(db.pragma("foreign_key_check")).toEqual([]);
}
