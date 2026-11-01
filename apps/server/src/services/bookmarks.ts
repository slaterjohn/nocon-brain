import type { Clock } from "@ncb/shared";
import { AppError, newId } from "@ncb/shared";
import type { Db } from "@ncb/db";
import type { ServedFrom } from "@ncb/db/schema";
import { normaliseUrl } from "@ncb/fetch";
import type { PipelineService } from "../pipeline/service.js";
import type { SettingsService } from "./settings.js";

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
  reference_priority: number; created_at: number;
}

/**
 * Bookmarks (A-17). A bookmark keeps the original URL; its archive reference is looked up by URL when it is listed, so a page
 * saved after the bookmark was made is found without a second step. `reference_priority` records the configured
 * `browser.bookmarkPriority` at creation: Phase 6 turns it into the page's effective priority.
 */
export class BookmarksService {
  constructor(private readonly o: { db: Db; clock: Clock; settings: SettingsService; pipeline: PipelineService }) {}

  private key(url: string): string {
    try {
      return this.o.pipeline.urlKey(url);
    } catch {
      throw new AppError("bad_request", "That is not a web address. Check it and try again.");
    }
  }

  private dto(r: BmRow): BookmarkDto {
    const { db, pipeline } = this.o;
    const page = pipeline.findPageByUrl(r.original_url) ?? (r.page_id != null ? pipeline.getPage(r.page_id) : undefined);
    const usable = page && page.latestVersionId != null && (page.availability === "archived" || page.availability === "partial");
    const pinned = r.version_id != null ? db.get<{ public_id: string }>("SELECT public_id FROM page_versions WHERE id = ?", [r.version_id]) : undefined;
    return {
      id: r.public_id, originalUrl: r.original_url, title: r.title || page?.title || r.original_url,
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

  /** Creates the bookmark, or returns the existing one for the same address. */
  create(userId: number, input: { url: string; title?: string; versionId?: string }): { bookmark: BookmarkDto; created: boolean } {
    const { db, clock, settings, pipeline } = this.o;
    let normalized: string;
    try {
      const n = normaliseUrl(input.url, { queryPolicy: "keep_all" });
      if (n.hasCredentials) throw new AppError("bad_request", "Addresses with a username or password cannot be bookmarked.");
      normalized = n.fetchUrl;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("bad_request", "That is not a web address. Check it and try again.");
    }
    const key = this.key(normalized);
    const existing = db.get<BmRow>("SELECT * FROM bookmarks WHERE user_id = ? AND url_key = ? AND deleted_at IS NULL", [userId, key]);
    if (existing) return { bookmark: this.dto(existing), created: false };

    const page = pipeline.findPageByUrl(normalized);
    let versionRow: number | null = null;
    if (input.versionId) {
      const v = pipeline.getVersion(input.versionId);
      if (!v || (page && v.pageId !== page.id)) throw new AppError("bad_request", "That saved copy does not belong to this page.");
      versionRow = v.id;
    }
    const priority = (settings.internal("browser") as { bookmarkPriority: number }).bookmarkPriority;
    const title = (input.title ?? page?.title ?? "").trim().slice(0, 300);
    const row = db.transaction(
      () => {
        const res = db.run(
          `INSERT INTO bookmarks (public_id, user_id, original_url, url_key, title, page_id, version_id, reference_priority, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [newId("bm"), userId, normalized, key, title, page?.id ?? null, versionRow, priority, clock.now()],
        );
        return db.get<BmRow>("SELECT * FROM bookmarks WHERE id = ?", [Number(res.lastInsertRowid)])!;
      },
      { durable: true },
    );
    return { bookmark: this.dto(row), created: true };
  }

  update(userId: number, id: string, patch: { title?: string }): BookmarkDto {
    const r = this.o.db.get<BmRow>("SELECT * FROM bookmarks WHERE public_id = ? AND user_id = ? AND deleted_at IS NULL", [id, userId]);
    if (!r) throw new AppError("not_found", "That bookmark no longer exists.");
    if (patch.title !== undefined) this.o.db.run("UPDATE bookmarks SET title = ? WHERE id = ?", [patch.title.trim().slice(0, 300), r.id]);
    return this.dto(this.o.db.get<BmRow>("SELECT * FROM bookmarks WHERE id = ?", [r.id])!);
  }

  remove(userId: number, id: string): void {
    const res = this.o.db.run(
      "UPDATE bookmarks SET deleted_at = ? WHERE public_id = ? AND user_id = ? AND deleted_at IS NULL", [this.o.clock.now(), id, userId]);
    if (res.changes === 0) throw new AppError("not_found", "That bookmark no longer exists.");
  }
}

export interface HistoryDto {
  id: string;
  url: string;
  title: string;
  visitedAt: string;
  servedFrom: ServedFrom;
  pageId?: string;
}

interface HRow {
  id: number; public_id: string; url: string; title: string; visited_at: number; served_from: ServedFrom; page_pid: string | null;
}

/**
 * Browsing history (A-17). Recording follows `privacy.history.enabled`: switched off, nothing is written; "clear" deletes rows.
 * Each entry carries the cached/live marker (`served_from`).
 */
export class HistoryService {
  private readonly seen = new Set<string>();

  constructor(private readonly o: { db: Db; clock: Clock; settings: SettingsService; pipeline: PipelineService }) {}

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
    return true;
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
        `SELECT h.id, h.public_id, h.url, h.title, h.visited_at, h.served_from, p.public_id AS page_pid FROM history_entries h
         LEFT JOIN pages p ON p.id = h.page_id WHERE ${where.join(" AND ")} ORDER BY h.visited_at DESC, h.id DESC LIMIT ?`, [...args, q.limit ?? 200])
      .map((r) => ({
        id: r.public_id, url: r.url, title: r.title || r.url, visitedAt: iso(r.visited_at)!, servedFrom: r.served_from,
        ...(r.page_pid ? { pageId: r.page_pid } : {}),
      }));
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
