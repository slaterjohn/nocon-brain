import { z } from "zod";
import type { Db } from "@ncb/db";
import { AppError, newId, parsePriority, priorityToCode, type Clock, type PriorityNumber } from "@ncb/shared";
import { parseOrThrow } from "../lib/zod.js";
import { COLLECTION_ICONS, DEFAULT_ICON, FAVOURITES_ICON, isIcon } from "./icons.js";
import { ruleSchema, ruleToSql, type Rule } from "./rules.js";
import type { ActivityLog } from "../services/activity.js";

export const MAX_DEPTH = 8;

const priority = z.union([z.enum(["P1", "P2", "P3", "P4"]), z.number().int().min(1).max(4)], { error: "Use P1, P2, P3 or P4" }).transform((v) => parsePriority(v) as PriorityNumber);
const icon = z.string().refine((s) => isIcon(s), { message: `Choose an icon from the list (${COLLECTION_ICONS.length} available)` });

export const collectionCreateSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(120, "Use at most 120 characters"),
  description: z.string().trim().max(1000).optional(),
  icon: icon.optional(),
  kind: z.enum(["manual", "auto", "saved_search", "favourites"]).default("manual"),
  savedSearchId: z.string().max(64).optional(),
  parentId: z.string().max(64).nullable().optional(),
  rule: ruleSchema.optional(),
  priorityFloor: priority.nullable().optional(),
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional(),
});
export const collectionPatchSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(120).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  icon: icon.optional(),
  parentId: z.string().max(64).nullable().optional(),
  rule: ruleSchema.optional(),
  priorityFloor: priority.nullable().optional(),
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional(),
});
export const itemRefSchema = z.union([z.object({ pageId: z.string().min(1).max(64) }), z.object({ zimId: z.string().min(1).max(64), path: z.string().min(1).max(2000) })]);
export const itemsBodySchema = z.object({ add: z.array(itemRefSchema).max(500).default([]), remove: z.array(itemRefSchema).max(500).default([]) });

export interface CollectionOut {
  id: string;
  name: string;
  description: string | null;
  icon: string;
  kind: "manual" | "auto" | "saved_search" | "favourites";
  parentId: string | null;
  rule: Rule | { savedSearchId: string } | null;
  priorityFloor: "P1" | "P2" | "P3" | "P4" | null;
  sortOrder: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  children?: CollectionOut[];
}

interface Row {
  id: number; public_id: string; name: string; description: string | null; icon: string; kind: CollectionOut["kind"]; parent_id: number | null;
  rule_json: string | null; priority_floor: number | null; sort_order: number; created_at: number; updated_at: number; deleted_at: number | null;
}

const iso = (n: number): string => new Date(n).toISOString();

export class CollectionService {
  /** Set by the server: the saved-search link for `kind: saved_search` (S-12). */
  savedSearches?: { ref(publicId: string): { id: number; publicId: string }; link(savedId: number, collectionId: number): void };
  constructor(private readonly o: { db: Db; clock: Clock; activity?: ActivityLog }) {}

  private get db(): Db {
    return this.o.db;
  }

  // ---- reading -------------------------------------------------------------------------------

  private rowById(id: number): Row | undefined {
    return this.db.get<Row>("SELECT * FROM collections WHERE id = ? AND deleted_at IS NULL", [id]);
  }

  rowByPublic(publicId: string): Row {
    const r = this.db.get<Row>("SELECT * FROM collections WHERE public_id = ? AND deleted_at IS NULL", [publicId]);
    if (!r) throw new AppError("not_found", "That collection does not exist.");
    return r;
  }

  private out(r: Row): CollectionOut {
    const parent = r.parent_id == null ? null : (this.db.get<{ public_id: string }>("SELECT public_id FROM collections WHERE id = ?", [r.parent_id])?.public_id ?? null);
    return {
      id: r.public_id, name: r.name, description: r.description, icon: r.icon, kind: r.kind, parentId: parent,
      rule: r.rule_json ? (JSON.parse(r.rule_json) as Rule | { savedSearchId: string }) : null,
      priorityFloor: r.priority_floor == null ? null : priorityToCode(r.priority_floor as PriorityNumber),
      sortOrder: r.sort_order, itemCount: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM collection_memberships WHERE collection_id = ?", [r.id])!.n,
      createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    };
  }

  get(publicId: string): CollectionOut {
    return this.out(this.rowByPublic(publicId));
  }

  list(opts: { tree?: boolean; parentId?: string | null } = {}): CollectionOut[] {
    const rows = this.db.all<Row>("SELECT * FROM collections WHERE deleted_at IS NULL ORDER BY sort_order, LOWER(name), id");
    const outs = rows.map((r) => this.out(r));
    if (opts.tree) {
      const byId = new Map(outs.map((c) => [c.id, c]));
      const roots: CollectionOut[] = [];
      for (const c of outs) {
        c.children = [];
      }
      for (const c of outs) {
        const parent = c.parentId ? byId.get(c.parentId) : undefined;
        (parent ? parent.children! : roots).push(c);
      }
      return roots;
    }
    if (opts.parentId !== undefined) return outs.filter((c) => c.parentId === opts.parentId);
    return outs;
  }

  /** Ids of a collection and all collections below it. */
  descendantIds(id: number): number[] {
    return this.db.all<{ id: number }>(
      `WITH RECURSIVE d(id) AS (SELECT ? UNION ALL SELECT c.id FROM collections c JOIN d ON c.parent_id = d.id WHERE c.deleted_at IS NULL) SELECT id FROM d`, [id],
    ).map((r) => r.id);
  }

  private depthOf(id: number | null): number {
    let d = 0;
    let cur = id;
    while (cur !== null && d < 50) {
      d++;
      cur = this.db.get<{ parent_id: number | null }>("SELECT parent_id FROM collections WHERE id = ?", [cur])?.parent_id ?? null;
    }
    return d;
  }

  private heightOf(id: number): number {
    const kids = this.db.all<{ id: number }>("SELECT id FROM collections WHERE parent_id = ? AND deleted_at IS NULL", [id]);
    return 1 + kids.reduce((m, k) => Math.max(m, this.heightOf(k.id)), 0);
  }

  private resolveParent(parentPublic: string | null | undefined, self?: number, height = 1): number | null {
    if (parentPublic == null) return null;
    const p = this.db.get<Row>("SELECT * FROM collections WHERE public_id = ? AND deleted_at IS NULL", [parentPublic]);
    if (!p) throw new AppError("bad_request", "The parent collection does not exist.", { fields: [{ in: "body", path: "parentId", message: "Choose a collection that exists" }] });
    if (self !== undefined && this.descendantIds(self).includes(p.id)) {
      throw new AppError("bad_request", "A collection cannot be placed inside itself or one of its own sub-collections.", { fields: [{ in: "body", path: "parentId", message: "That would make a loop" }] });
    }
    if (this.depthOf(p.id) + height > MAX_DEPTH) {
      throw new AppError("bad_request", `Collections can be nested ${MAX_DEPTH} levels deep at most.`, { fields: [{ in: "body", path: "parentId", message: `At most ${MAX_DEPTH} levels` }] });
    }
    return p.id;
  }

  // ---- writing -------------------------------------------------------------------------------

  create(body: unknown): CollectionOut {
    const v = parseOrThrow(collectionCreateSchema, body);
    let savedRef: { id: number; publicId: string } | undefined;
    if (v.kind === "saved_search") {
      if (!v.savedSearchId) throw new AppError("bad_request", "A saved-search collection needs a saved search.", { fields: [{ in: "body", path: "savedSearchId", message: "Choose a saved search" }] });
      savedRef = this.savedSearches?.ref(v.savedSearchId);
      if (!savedRef) throw new AppError("not_implemented", "Saved searches are not available.");
    } else if (v.savedSearchId) {
      throw new AppError("bad_request", "Only saved-search collections take a saved search.", { fields: [{ in: "body", path: "savedSearchId", message: "Remove it or choose the saved-search kind" }] });
    }
    if (v.kind === "auto" && !v.rule) throw new AppError("bad_request", "An automatic collection needs a rule.", { fields: [{ in: "body", path: "rule", message: "Add at least one condition" }] });
    if (v.kind !== "auto" && v.rule) throw new AppError("bad_request", "Only automatic collections have a rule.", { fields: [{ in: "body", path: "rule", message: "Remove the rule or choose the automatic kind" }] });
    if (v.kind === "favourites" && this.db.get("SELECT 1 AS x FROM collections WHERE kind = 'favourites' AND deleted_at IS NULL")) {
      throw new AppError("conflict", "There is already a Favourites collection.");
    }
    if (v.rule) this.checkRuleSources(v.rule);
    const parent = this.resolveParent(v.parentId);
    const now = this.o.clock.now();
    const id = this.db.transaction(() => {
      const res = this.db.run(
        `INSERT INTO collections (public_id, name, description, icon, kind, parent_id, rule_json, priority_floor, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId("col"), v.name, v.description ?? null, v.icon ?? (v.kind === "favourites" ? FAVOURITES_ICON : DEFAULT_ICON), v.kind, parent,
          savedRef ? JSON.stringify({ savedSearchId: savedRef.publicId }) : v.rule ? JSON.stringify(v.rule) : null, v.priorityFloor ?? null, v.sortOrder ?? 0, now, now],
      );
      if (savedRef) this.savedSearches!.link(savedRef.id, Number(res.lastInsertRowid));
      return Number(res.lastInsertRowid);
    }, { durable: true });
    if (v.kind === "auto") this.applyRule(id);
    return this.out(this.rowById(id)!);
  }

  /** The single Favourites collection, created on first use. */
  ensureFavourites(): CollectionOut {
    const r = this.db.get<Row>("SELECT * FROM collections WHERE kind = 'favourites' AND deleted_at IS NULL");
    if (r) return this.out(r);
    return this.create({ name: "Favourites", kind: "favourites", icon: FAVOURITES_ICON });
  }

  update(publicId: string, body: unknown): CollectionOut {
    const cur = this.rowByPublic(publicId);
    const v = parseOrThrow(collectionPatchSchema, body);
    if (v.rule !== undefined && cur.kind !== "auto") {
      throw new AppError("bad_request", "Only automatic collections have a rule.", { fields: [{ in: "body", path: "rule", message: "This collection is not automatic" }] });
    }
    if (v.rule) this.checkRuleSources(v.rule);
    let parent: number | null | undefined;
    if (v.parentId !== undefined) parent = this.resolveParent(v.parentId, cur.id, this.heightOf(cur.id));
    const now = this.o.clock.now();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE collections SET name = ?, description = ?, icon = ?, parent_id = ?, rule_json = ?, priority_floor = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
        [v.name ?? cur.name, v.description === undefined ? cur.description : v.description, v.icon ?? cur.icon, parent === undefined ? cur.parent_id : parent,
          v.rule ? JSON.stringify(v.rule) : cur.rule_json, v.priorityFloor === undefined ? cur.priority_floor : v.priorityFloor, v.sortOrder ?? cur.sort_order, now, cur.id],
      );
    }, { durable: true });
    if (v.rule) this.applyRule(cur.id);
    if (v.priorityFloor != null) this.applyFloor(cur.id, v.priorityFloor);
    return this.out(this.rowById(cur.id)!);
  }

  /**
   * Deletes a collection. Its children move up to its parent (so nothing is lost from the tree), its memberships go, and
   * the pages stay in the archive: a collection never owns storage. The Favourites collection cannot be deleted.
   */
  remove(publicId: string): { reparented: number; membershipsRemoved: number } {
    const cur = this.rowByPublic(publicId);
    if (cur.kind === "favourites") throw new AppError("conflict", "Favourites cannot be deleted. You can rename it or empty it.");
    const now = this.o.clock.now();
    return this.db.transaction(() => {
      const kids = this.db.run("UPDATE collections SET parent_id = ?, updated_at = ? WHERE parent_id = ? AND deleted_at IS NULL", [cur.parent_id, now, cur.id]).changes;
      const members = this.db.run("DELETE FROM collection_memberships WHERE collection_id = ?", [cur.id]).changes;
      this.db.run("DELETE FROM source_collections WHERE collection_id = ?", [cur.id]);
      this.db.run("UPDATE bookmarks SET collection_id = NULL WHERE collection_id = ?", [cur.id]);
      this.db.run("UPDATE collections SET deleted_at = ?, updated_at = ?, parent_id = NULL WHERE id = ?", [now, now, cur.id]);
      return { reparented: kids, membershipsRemoved: members };
    }, { durable: true });
  }

  // ---- items ---------------------------------------------------------------------------------

  private pageRow(ref: string): { id: number } | undefined {
    return this.db.get<{ id: number }>("SELECT id FROM pages WHERE public_id = ?", [ref]);
  }

  /** Adds and removes pages. Returns what changed; pages that do not exist are reported, not silently ignored. */
  changeItems(publicId: string, body: unknown): { added: number; alreadyMember: number; removed: number; notFound: string[] } {
    const c = this.rowByPublic(publicId);
    const v = parseOrThrow(itemsBodySchema, body);
    if (c.kind === "auto") throw new AppError("conflict", "This collection fills itself from its rule. Change the rule instead of adding pages by hand.");
    if (c.kind === "saved_search") throw new AppError("conflict", "This collection fills itself from its saved search. Change the saved search instead of adding pages by hand.");
    if ([...v.add, ...v.remove].some((r) => "zimId" in r)) throw new AppError("not_implemented", "Articles from offline packages can be added once ZIM support arrives.");
    const now = this.o.clock.now();
    const res = { added: 0, alreadyMember: 0, removed: 0, notFound: [] as string[] };
    this.db.transaction(() => {
      for (const r of v.add) {
        const page = this.pageRow((r as { pageId: string }).pageId);
        if (!page) { res.notFound.push((r as { pageId: string }).pageId); continue; }
        const ins = this.db.run("INSERT INTO collection_memberships (collection_id, page_id, added_by, added_at) VALUES (?, ?, 'user', ?) ON CONFLICT DO NOTHING", [c.id, page.id, now]);
        if (ins.changes) res.added++;
        else res.alreadyMember++;
        if (c.priority_floor !== null) this.raisePageCache(page.id, c.priority_floor);
      }
      for (const r of v.remove) {
        const page = this.pageRow((r as { pageId: string }).pageId);
        if (!page) { res.notFound.push((r as { pageId: string }).pageId); continue; }
        res.removed += this.db.run("DELETE FROM collection_memberships WHERE collection_id = ? AND page_id = ?", [c.id, page.id]).changes;
      }
      this.db.run("UPDATE collections SET updated_at = ? WHERE id = ?", [now, c.id]);
    }, { durable: true });
    return res;
  }

  listItems(publicId: string, o: { limit: number; offset: number; recursive?: boolean }): { items: unknown[]; nextCursor?: string; total: number } {
    const c = this.rowByPublic(publicId);
    const ids = o.recursive ? this.descendantIds(c.id) : [c.id];
    const marks = ids.map(() => "?").join(",");
    const total = this.db.get<{ n: number }>(`SELECT COUNT(DISTINCT page_id) AS n FROM collection_memberships WHERE collection_id IN (${marks}) AND page_id IS NOT NULL`, ids)!.n;
    const rows = this.db.all<{ public_id: string; canonical_url: string; host: string; title: string | null; availability: string; effective_priority: number | null; added_by: string; added_at: number }>(
      `SELECT p.public_id, p.canonical_url, p.host, p.title, p.availability, p.effective_priority, MIN(m.added_by) AS added_by, MIN(m.added_at) AS added_at
       FROM collection_memberships m JOIN pages p ON p.id = m.page_id WHERE m.collection_id IN (${marks})
       GROUP BY p.id ORDER BY MIN(m.added_at) DESC, p.id DESC LIMIT ? OFFSET ?`,
      [...ids, o.limit, o.offset],
    );
    const items = rows.map((r) => ({
      pageId: r.public_id, url: r.canonical_url, host: r.host, title: r.title, availability: r.availability,
      effectivePriority: r.effective_priority == null ? null : priorityToCode(r.effective_priority as PriorityNumber),
      addedBy: r.added_by, addedAt: iso(r.added_at),
    }));
    const next = o.offset + rows.length;
    return { items, total, ...(next < total ? { nextCursor: String(next) } : {}) };
  }

  /** Collections a page belongs to, for the library detail and the delete preview. */
  collectionsOfPage(pageId: number): { id: string; name: string; kind: string; priorityFloor: string | null }[] {
    return this.db.all<{ public_id: string; name: string; kind: string; priority_floor: number | null }>(
      `SELECT c.public_id, c.name, c.kind, c.priority_floor FROM collection_memberships m JOIN collections c ON c.id = m.collection_id
       WHERE m.page_id = ? AND c.deleted_at IS NULL ORDER BY c.id`, [pageId],
    ).map((r) => ({ id: r.public_id, name: r.name, kind: r.kind, priorityFloor: r.priority_floor == null ? null : priorityToCode(r.priority_floor as PriorityNumber) }));
  }

  // ---- rules, sources, floors ----------------------------------------------------------------

  private checkRuleSources(rule: Rule): void {
    rule.conditions.forEach((c, i) => {
      if (c.field === "source" && !this.db.get("SELECT 1 AS x FROM sources WHERE public_id = ? AND deleted_at IS NULL", [c.value])) {
        throw new AppError("bad_request", "A source in the rule does not exist.", { fields: [{ in: "body", path: `rule.conditions.${i}.value`, message: "Choose a source that exists" }] });
      }
    });
  }

  /** Keeps the cached `pages.effective_priority` at least as important as a floor. Phase 6 recomputes it from the references. */
  private raisePageCache(pageId: number, floor: number): void {
    this.db.run("UPDATE pages SET effective_priority = MIN(COALESCE(effective_priority, 4), ?) WHERE id = ?", [floor, pageId]);
  }

  private applyFloor(collectionId: number, floor: number): void {
    this.db.run(
      `UPDATE pages SET effective_priority = MIN(COALESCE(effective_priority, 4), ?) WHERE id IN (SELECT page_id FROM collection_memberships WHERE collection_id = ? AND page_id IS NOT NULL)`,
      [floor, collectionId],
    );
  }

  /**
   * Re-evaluates an auto collection: adds matching pages (`added_by = 'rule'`) and removes rule-added members that no longer
   * match. Limited to one page when `pageId` is given. Returns the changes.
   */
  applyRule(collectionId: number, pageId?: number): { added: number; removed: number } {
    const c = this.rowById(collectionId);
    if (!c || c.kind !== "auto" || !c.rule_json) return { added: 0, removed: 0 };
    const { sql, params } = ruleToSql(JSON.parse(c.rule_json) as Rule, "p");
    const now = this.o.clock.now();
    const only = pageId === undefined ? "" : " AND p.id = ?";
    const extra = pageId === undefined ? [] : [pageId];
    return this.db.transaction(() => {
      const added = this.db.run(
        `INSERT INTO collection_memberships (collection_id, page_id, added_by, added_at)
         SELECT ?, p.id, 'rule', ? FROM pages p WHERE p.deleted_at IS NULL AND ${sql}${only} ON CONFLICT DO NOTHING`,
        [c.id, now, ...params, ...extra],
      ).changes;
      const removed = this.db.run(
        `DELETE FROM collection_memberships WHERE collection_id = ? AND added_by = 'rule' AND page_id IS NOT NULL
         ${pageId === undefined ? "" : "AND page_id = ?"}
         AND page_id NOT IN (SELECT p.id FROM pages p WHERE ${sql})`,
        [c.id, ...extra, ...params],
      ).changes;
      if (c.priority_floor !== null && added > 0) this.applyFloor(c.id, c.priority_floor);
      if (added || removed) this.db.run("UPDATE collections SET updated_at = ? WHERE id = ?", [now, c.id]);
      return { added, removed };
    });
  }

  rebuild(publicId: string): { added: number; removed: number } {
    const c = this.rowByPublic(publicId);
    if (c.kind === "saved_search") throw new AppError("conflict", "Saved-search collections are rebuilt by the search service.");
    if (c.kind !== "auto") throw new AppError("conflict", "Only automatic collections can be rebuilt. This one is filled by hand.");
    return this.applyRule(c.id);
  }

  /** Adds `pageId` to the collections its sources feed (`source_collections`), marking them `added_by = 'source'`. */
  applySourceCollections(pageId: number, sourceRowId?: number): number {
    const now = this.o.clock.now();
    const q = `SELECT sc.collection_id AS cid, c.priority_floor AS fl FROM page_sources ps JOIN source_collections sc ON sc.source_id = ps.source_id
               JOIN collections c ON c.id = sc.collection_id AND c.deleted_at IS NULL
               JOIN sources s ON s.id = ps.source_id AND s.deleted_at IS NULL WHERE ps.page_id = ?${sourceRowId === undefined ? "" : " AND ps.source_id = ?"}`;
    let n = 0;
    for (const r of this.db.all<{ cid: number; fl: number | null }>(q, sourceRowId === undefined ? [pageId] : [pageId, sourceRowId])) {
      n += this.db.run("INSERT INTO collection_memberships (collection_id, page_id, added_by, added_at) VALUES (?, ?, 'source', ?) ON CONFLICT DO NOTHING", [r.cid, pageId, now]).changes;
      if (r.fl !== null) this.raisePageCache(pageId, r.fl);
    }
    return n;
  }

  /** Called when a page was captured, re-captured or linked to a source: source collections first, then every auto rule. */
  onPageChanged(pageId: number): void {
    try {
      this.applySourceCollections(pageId);
      for (const c of this.db.all<{ id: number }>("SELECT id FROM collections WHERE kind = 'auto' AND deleted_at IS NULL")) this.applyRule(c.id, pageId);
    } catch (e) {
      // Collections are a convenience over the archive; a failure here must never fail the capture that caused it.
      this.o.activity?.write({ level: "warn", area: "system", message: `Collections could not be updated for a saved page: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /** Adds every existing page of a source to the collections the source feeds (after the source's collection list changed). */
  backfillSource(sourceRowId: number): void {
    for (const r of this.db.all<{ page_id: number }>("SELECT page_id FROM page_sources WHERE source_id = ?", [sourceRowId])) this.applySourceCollections(r.page_id, sourceRowId);
  }

  rebuildAllAuto(): void {
    for (const c of this.db.all<{ id: number }>("SELECT id FROM collections WHERE kind = 'auto' AND deleted_at IS NULL")) this.applyRule(c.id);
  }
}
