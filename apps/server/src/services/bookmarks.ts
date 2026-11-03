import type { Clock } from "@ncb/shared";
import { AppError, newId } from "@ncb/shared";
import type { Db } from "@ncb/db";
import type { ServedFrom } from "@ncb/db/schema";
import { normaliseUrl } from "@ncb/fetch";
import type { PipelineService } from "../pipeline/service.js";
import type { SettingsService } from "./settings.js";
import type { WikipediaZim } from "../wikipedia/zim-map.js";
import { encodeTitle } from "../wikipedia/url.js";

const iso = (ms: number | null | undefined): string | undefined => (ms == null ? undefined : new Date(ms).toISOString());

export interface BookmarkDto {
  id: string;
  originalUrl: string;
  title: string;
  archive?: { pageId: string; versionId?: string; availability: "archived" | "partial" | "evicted" | "failed" };
  zim?: { zimId: string; path: string };
  collectionId?: string;
  /** Priority the bookmark's reference was created at (`browser.bookmarkPriority`); Phase 6 reads it. */
  referencePriority: number;
  createdAt: string;
}

interface BmRow {
  id: number; public_id: string; original_url: string; url_key: string; title: string; page_id: number | null; version_id: number | null;
  reference_priority: number; created_at: number; zim_package_id: number | null; zim_path: string | null;
}

const zimPseudoUrl = (zimId: string, path: string): string => `zim://${zimId}/${path.split("/").map(encodeURIComponent).join("/")}`;
const zimPseudoKey = (zimId: string, path: string): string => `zim:${zimId}:${path}`;

/**
 * Bookmarks (A-17). A bookmark keeps the original URL; its archive reference is looked up by URL when it is listed, so a page
 * saved after the bookmark was made is found without a second step. `reference_priority` records the configured
 * `browser.bookmarkPriority` at creation: Phase 6 turns it into the page's effective priority.
 */
export class BookmarksService {
  /** Discovery's bookmark collector: a bookmark of an address that has no saved copy yet. */
  onCreated?: (v: { url: string; archived: boolean }) => void;

  constructor(private readonly o: { db: Db; clock: Clock; settings: SettingsService; pipeline: PipelineService; wikipediaZim?: WikipediaZim; onReferencesChanged?: (pageIds: number[]) => void }) {}

  /** A bookmark is a reference to its page (Phase 6): refresh the page's cached priority. */
  private touch(urlKey: string): void {
    if (!this.o.onReferencesChanged) return;
    const p = this.o.db.get<{ id: number }>("SELECT id FROM pages WHERE url_key = ?", [urlKey]);
    if (p) this.o.onReferencesChanged([p.id]);
  }

  private key(url: string): string {
    const z = /^zim:\/\/([A-Za-z0-9_-]{1,64})\/(.*)$/.exec(url);
    if (z) {
      try { return zimPseudoKey(z[1]!, decodeURIComponent(z[2]!)); } catch { return zimPseudoKey(z[1]!, z[2]!); }
    }
    try {
      return this.o.pipeline.urlKey(url);
    } catch {
      throw new AppError("bad_request", "That is not a web address. Check it and try again.");
    }
  }

  private dto(r: BmRow): BookmarkDto {
    const { db, pipeline } = this.o;
    const page = (r.original_url.startsWith("zim://") ? undefined : pipeline.findPageByUrl(r.original_url)) ?? (r.page_id != null ? pipeline.getPage(r.page_id) : undefined);
    const usable = page && page.latestVersionId != null && (page.availability === "archived" || page.availability === "partial");
    const pinned = r.version_id != null ? db.get<{ public_id: string }>("SELECT public_id FROM page_versions WHERE id = ?", [r.version_id]) : undefined;
    const zim = r.zim_package_id != null && r.zim_path != null
      ? db.get<{ public_id: string }>("SELECT public_id FROM zim_packages WHERE id = ?", [r.zim_package_id])
      : undefined;
    return {
      id: r.public_id, originalUrl: r.original_url, title: r.title || page?.title || r.zim_path?.replace(/_/g, " ") || r.original_url,
      ...(zim ? { zim: { zimId: zim.public_id, path: r.zim_path! } } : {}),
      ...(page && usable
        ? { archive: { pageId: page.publicId, ...(pinned ? { versionId: pinned.public_id } : page.latestVersionPublicId ? { versionId: page.latestVersionPublicId } : {}), availability: page.availability as "archived" | "partial" } }
        : {}),
      referencePriority: r.reference_priority, createdAt: iso(r.created_at)!,
    };
  }

  list(userId: number, q: { q?: string; url?: string; limit?: number } = {}): BookmarkDto[] {
    const where = ["user_id = ?", "deleted_at IS NULL"];
    const args: (string | number)[] = [userId];
    if (q.url) {
      where.push("url_key = ?");
      args.push(this.key(q.url));
    }
    if (q.q) {
      where.push("(instr(lower(title), lower(?)) > 0 OR instr(lower(original_url), lower(?)) > 0)");
      args.push(q.q, q.q);
    }
    return this.o.db
      .all<BmRow>(`SELECT * FROM bookmarks WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`, [...args, q.limit ?? 200])
      .map((r) => this.dto(r));
  }

  /**
   * Creates the bookmark, or returns the existing one for the same address. An entry of a knowledge package is bookmarked by `zimId` and
   * `zimPath`; a Wikipedia address that an enabled package holds also keeps the package entry (task Z-06), so it opens offline.
   */
  async create(userId: number, input: { url?: string; title?: string; versionId?: string; zimId?: string; zimPath?: string }): Promise<{ bookmark: BookmarkDto; created: boolean }> {
    const { db, clock, settings, pipeline } = this.o;
    let normalized: string;
    let zimRef: { rowId: number; publicId: string; path: string } | undefined;
    if (input.zimId) {
      const z = db.get<{ id: number; public_id: string }>("SELECT id, public_id FROM zim_packages WHERE public_id = ? AND state <> 'removing'", [input.zimId]);
      if (!z) throw new AppError("not_found", "That knowledge package does not exist.");
      if (input.zimPath === undefined || input.zimPath === "") throw new AppError("bad_request", "Say which entry of the package to bookmark.");
      zimRef = { rowId: z.id, publicId: z.public_id, path: input.zimPath };
      normalized = input.url && /^https?:\/\//i.test(input.url) ? normaliseUrl(input.url, { queryPolicy: "keep_all" }).fetchUrl : zimPseudoUrl(z.public_id, input.zimPath);
    } else {
      if (!input.url) throw new AppError("bad_request", "Enter the address of the page to bookmark.");
      try {
        const n = normaliseUrl(input.url, { queryPolicy: "keep_all" });
        if (n.hasCredentials) throw new AppError("bad_request", "Addresses with a username or password cannot be bookmarked.");
        normalized = n.fetchUrl;
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw new AppError("bad_request", "That is not a web address. Check it and try again.");
      }
      if (this.o.wikipediaZim?.hasAny()) {
        const hit = await this.o.wikipediaZim.findUrl(normalized).catch(() => undefined);
        if (hit) {
          const row = db.get<{ id: number }>("SELECT id FROM zim_packages WHERE public_id = ?", [hit.zimId]);
          if (row) zimRef = { rowId: row.id, publicId: hit.zimId, path: hit.path };
        }
      }
    }
    const key = zimRef && normalized.startsWith("zim://") ? zimPseudoKey(zimRef.publicId, zimRef.path) : this.key(normalized);
    const existing = db.get<BmRow>("SELECT * FROM bookmarks WHERE user_id = ? AND url_key = ? AND deleted_at IS NULL", [userId, key]);
    if (existing) return { bookmark: this.dto(existing), created: false };

    const page = normalized.startsWith("zim://") ? undefined : pipeline.findPageByUrl(normalized);
    let versionRow: number | null = null;
    if (input.versionId) {
      const v = pipeline.getVersion(input.versionId);
      if (!v || (page && v.pageId !== page.id)) throw new AppError("bad_request", "That saved copy does not belong to this page.");
      versionRow = v.id;
    }
    const priority = (settings.internal("browser") as { bookmarkPriority: number }).bookmarkPriority;
    const title = (input.title ?? page?.title ?? (zimRef ? zimRef.path.replace(/_/g, " ") : "")).trim().slice(0, 300);
    const row = db.transaction(
      () => {
        const res = db.run(
          `INSERT INTO bookmarks (public_id, user_id, original_url, url_key, title, page_id, version_id, zim_package_id, zim_path, reference_priority, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [newId("bm"), userId, normalized, key, title, page?.id ?? null, versionRow, zimRef?.rowId ?? null, zimRef?.path ?? null, priority, clock.now()],
        );
        return db.get<BmRow>("SELECT * FROM bookmarks WHERE id = ?", [Number(res.lastInsertRowid)])!;
      },
      { durable: true },
    );
    this.touch(key);
    if (!normalized.startsWith("zim://")) {
      try { this.onCreated?.({ url: normalized, archived: !!page && (page.availability === "archived" || page.availability === "partial") || !!zimRef }); } catch { /* discovery never breaks bookmarks */ }
    }
    return { bookmark: this.dto(row), created: true };
  }

  update(userId: number, id: string, patch: { title?: string }): BookmarkDto {
    const r = this.o.db.get<BmRow>("SELECT * FROM bookmarks WHERE public_id = ? AND user_id = ? AND deleted_at IS NULL", [id, userId]);
    if (!r) throw new AppError("not_found", "That bookmark no longer exists.");
    if (patch.title !== undefined) this.o.db.run("UPDATE bookmarks SET title = ? WHERE id = ?", [patch.title.trim().slice(0, 300), r.id]);
    return this.dto(this.o.db.get<BmRow>("SELECT * FROM bookmarks WHERE id = ?", [r.id])!);
  }

  remove(userId: number, id: string): void {
    const key = this.o.db.get<{ url_key: string }>("SELECT url_key FROM bookmarks WHERE public_id = ? AND user_id = ?", [id, userId])?.url_key;
    const res = this.o.db.run(
      "UPDATE bookmarks SET deleted_at = ? WHERE public_id = ? AND user_id = ? AND deleted_at IS NULL", [this.o.clock.now(), id, userId]);
    if (res.changes === 0) throw new AppError("not_found", "That bookmark no longer exists.");
    if (key) this.touch(key);
  }
}

export interface HistoryDto {
  id: string;
  url: string;
  title: string;
  visitedAt: string;
  servedFrom: ServedFrom;
  pageId?: string;
  /** A visit to a knowledge-package entry (`servedFrom: "zim"`): the package and the entry. */
  zim?: { zimId: string; path: string };
}

interface HRow {
  id: number; public_id: string; url: string; title: string; visited_at: number; served_from: ServedFrom; page_pid: string | null; zim_pid: string | null;
}

/**
 * Browsing history (A-17). Recording follows `privacy.history.enabled`: switched off, nothing is written; "clear" deletes rows.
 * Each entry carries the cached/live marker (`served_from`).
 */
export class HistoryService {
  private readonly seen = new Set<string>();
  /** Discovery's visit collector. Called only after a visit was written, so it never fires while history is off. */
  onRecorded?: (v: { url: string; servedFrom: ServedFrom; archived: boolean }) => void;

  constructor(private readonly o: { db: Db; clock: Clock; settings: SettingsService; pipeline: PipelineService; wikipediaZim?: WikipediaZim }) {}

  get enabled(): boolean {
    return (this.o.settings.internal("privacy") as { history: { enabled: boolean } }).history.enabled;
  }

  record(userId: number, v: { url: string; title?: string; servedFrom: ServedFrom; pageId?: string }): boolean {
    if (!this.enabled) return false;
    const { db, clock, pipeline } = this.o;
    let key: string;
    try {
      key = pipeline.urlKey(v.url);
    } catch {
      return false;
    }
    const page = v.pageId ? pipeline.getPage(v.pageId) : undefined;
    db.run(
      `INSERT INTO history_entries (public_id, user_id, url, url_key, title, visited_at, page_id, served_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId("hs"), userId, v.url, key, (v.title ?? page?.title ?? "").slice(0, 300), clock.now(), page?.id ?? null, v.servedFrom],
    );
    try { this.onRecorded?.({ url: v.url, servedFrom: v.servedFrom, archived: !!page && (page.availability === "archived" || page.availability === "partial") }); } catch { /* discovery never breaks history */ }
    return true;
  }

  /**
   * A visit to a knowledge-package entry (task Z-06). A Wikipedia package entry is kept under its Wikipedia address, so it also finds the page in
   * the archive; other entries are kept under `zim://<package>/<path>`.
   */
  recordZimFromFrame(userId: number, frameId: string, seq: number, v: { url: string; title: string; zimId: string; path: string }): void {
    const k = `${frameId}:${seq}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value as string);
    if (!this.enabled) return;
    const { db, clock } = this.o;
    const pkg = db.get<{ id: number }>("SELECT id FROM zim_packages WHERE public_id = ?", [v.zimId]);
    if (!pkg) return;
    let key: string;
    if (v.url.startsWith("zim://")) key = zimPseudoKey(v.zimId, v.path);
    else {
      try { key = this.o.pipeline.urlKey(v.url); } catch { return; }
    }
    db.run(
      `INSERT INTO history_entries (public_id, user_id, url, url_key, title, visited_at, page_id, zim_package_id, served_from) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'zim')`,
      [newId("hs"), userId, v.url, key, v.title.slice(0, 300), clock.now(), pkg.id],
    );
  }

  /** One visit per document the listener served to a frame (the shell reads frame state after every `load`). */
  recordFromFrame(userId: number, frameId: string, seq: number, v: { url: string; title: string; pageId: string }): void {
    const k = `${frameId}:${seq}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value as string);
    this.record(userId, { ...v, servedFrom: "archive" });
  }

  list(userId: number, q: { q?: string; from?: number; to?: number; limit?: number } = {}): HistoryDto[] {
    const where = ["h.user_id = ?"];
    const args: (string | number)[] = [userId];
    if (q.q) {
      where.push("(instr(lower(h.title), lower(?)) > 0 OR instr(lower(h.url), lower(?)) > 0)");
      args.push(q.q, q.q);
    }
    if (q.from != null) {
      where.push("h.visited_at >= ?");
      args.push(q.from);
    }
    if (q.to != null) {
      where.push("h.visited_at <= ?");
      args.push(q.to);
    }
    return this.o.db
      .all<HRow>(
        `SELECT h.id, h.public_id, h.url, h.title, h.visited_at, h.served_from, p.public_id AS page_pid, z.public_id AS zim_pid FROM history_entries h
         LEFT JOIN pages p ON p.id = h.page_id LEFT JOIN zim_packages z ON z.id = h.zim_package_id WHERE ${where.join(" AND ")} ORDER BY h.visited_at DESC, h.id DESC LIMIT ?`, [...args, q.limit ?? 200])
      .map((r) => {
        const path = r.zim_pid ? this.zimPathOf(r.url, r.zim_pid) : undefined;
        return {
          id: r.public_id, url: r.url, title: r.title || r.url, visitedAt: iso(r.visited_at)!, servedFrom: r.served_from,
          ...(r.page_pid ? { pageId: r.page_pid } : {}),
          ...(r.zim_pid && path !== undefined ? { zim: { zimId: r.zim_pid, path } } : {}),
        };
      });
  }

  /** The entry path behind a history row of a package: from the `zim://` address, or the title of the Wikipedia address. */
  private zimPathOf(url: string, zimId: string): string | undefined {
    const m = /^zim:\/\/([^/]+)\/(.*)$/.exec(url);
    if (m && m[1] === zimId) { try { return decodeURIComponent(m[2]!); } catch { return m[2]; } }
    return this.o.wikipediaZim?.target(url)?.title;
  }

  clear(userId: number, before?: number): number {
    return before == null
      ? this.o.db.run("DELETE FROM history_entries WHERE user_id = ?", [userId]).changes
      : this.o.db.run("DELETE FROM history_entries WHERE user_id = ? AND visited_at < ?", [userId, before]).changes;
  }

  remove(userId: number, id: string): void {
    const r = this.o.db.run("DELETE FROM history_entries WHERE public_id = ? AND user_id = ?", [id, userId]);
    if (r.changes === 0) throw new AppError("not_found", "That history entry no longer exists.");
  }
}
