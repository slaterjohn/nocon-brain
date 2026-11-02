import type { Db } from "@ncb/db";
import type { Clock } from "@ncb/shared";
import { pagePriority, versionPriorities } from "@ncb/storage-planner";
import type { StorageInventory } from "./inventory.js";

/**
 * The cached columns `pages.effective_priority` and `page_versions.retained` are hints for the library, the search ranking and the
 * UI (data-model 5.1). This recomputes them from the reference rows (task T-01). The executor never reads them.
 */
export class PriorityCache {
  constructor(private readonly o: { db: Db; clock: Clock; inventory: StorageInventory }) {}

  /** Recomputes the cache for pages. Returns how many pages changed their effective priority. */
  recomputePages(pageIds: number[]): number {
    const { db, clock, inventory } = this.o;
    const now = clock.now();
    let changed = 0;
    for (let i = 0; i < pageIds.length; i += 200) {
      const pages = inventory.loadPages(pageIds.slice(i, i + 200));
      db.transaction(() => {
        for (const p of pages) {
          const prio = pagePriority(p, now);
          const hasLive = p.versions.some((v) => v.status === "ready" || v.status === "partial");
          const r = db.run("UPDATE pages SET effective_priority = ? WHERE id = ? AND effective_priority IS NOT ?", [hasLive || p.refs.length > 0 ? prio : 4, p.id, hasLive || p.refs.length > 0 ? prio : 4]);
          changed += r.changes;
          const per = versionPriorities(p, now);
          for (const v of p.versions) {
            if (v.status !== "ready" && v.status !== "partial") continue;
            db.run("UPDATE page_versions SET retained = ? WHERE id = ? AND retained <> ?", [per.get(v.id)!.surplus ? 0 : 1, v.id, per.get(v.id)!.surplus ? 0 : 1]);
          }
        }
      });
    }
    return changed;
  }

  recomputePage(pageId: number): boolean {
    return this.recomputePages([pageId]) > 0;
  }

  recomputeVersion(versionId: number): void {
    const r = this.o.db.get<{ page_id: number }>("SELECT page_id FROM page_versions WHERE id = ?", [versionId]);
    if (r) this.recomputePage(r.page_id);
  }

  /** Every page that has a live version using the blob. */
  recomputeBlob(blobId: number): number {
    const ids = this.o.db.all<{ page_id: number }>(
      `SELECT DISTINCT pv.page_id FROM page_versions pv WHERE pv.id IN (
         SELECT ar.version_id FROM asset_references ar JOIN assets a ON a.id = ar.asset_id WHERE a.blob_id = @b
         UNION SELECT version_id FROM version_content WHERE text_blob_id = @b OR reader_blob_id = @b OR outline_blob_id = @b OR extraction_blob_id = @b)`, { b: blobId });
    return this.recomputePages(ids.map((r) => r.page_id));
  }

  recomputeSource(sourceId: number): number {
    const ids = this.o.db.all<{ page_id: number }>("SELECT page_id FROM page_sources WHERE source_id = ?", [sourceId]);
    return this.recomputePages(ids.map((r) => r.page_id));
  }

  /** The whole archive, in chunks that yield to the event loop between them. */
  async recomputeAll(): Promise<{ pages: number; changed: number }> {
    const ids = this.o.inventory.allPageIds();
    let changed = 0;
    for (let i = 0; i < ids.length; i += 200) {
      changed += this.recomputePages(ids.slice(i, i + 200));
      await new Promise((r) => setImmediate(r));
    }
    return { pages: ids.length, changed };
  }
}
