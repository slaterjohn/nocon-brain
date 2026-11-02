import type { Db } from "@ncb/db";
import type { Clock } from "@ncb/shared";
import { versionPriorities, type Priority } from "@ncb/storage-planner";
import type { VolumeService } from "../services/volumes.js";
import type { StorageInventory } from "./inventory.js";

export interface UsageRow {
  key: string;
  label?: string;
  /** Bytes only this group uses: removing the group frees them. */
  exclusiveBytes: number;
  /** Bytes this group uses that another group uses too. Counted under every group that uses them. */
  sharedBytes: number;
  blobCount: number;
}

export interface UsageReport {
  by: "priority" | "source" | "kind" | "volume";
  volumeId?: string;
  /** Deduplicated stored bytes of every blob in scope: the figure to compare with the disk. Each blob is counted once. */
  totalBytes: number;
  blobCount: number;
  /** Bytes of blobs nothing references (waiting for the garbage collector). Part of `totalBytes`. */
  unreferencedBytes: number;
  items: UsageRow[];
  computedAt: string;
}

interface BlobAgg {
  id: number;
  bytes: number;
  kind: string;
  volumeId: number;
  prio: Priority | 0; // 0: no live reference
  classes: Set<number>;
  sources: Set<string>;
}

const PRIO_KEYS = ["P1", "P2", "P3", "P4"] as const;

/** Usage by priority, source, kind and volume (task T-06): exclusive and shared bytes, deduplicated totals, and the `storage_usage_cache`. */
export class UsageService {
  private dirty = true;

  constructor(private readonly o: { db: Db; clock: Clock; inventory: StorageInventory; volumes: VolumeService }) {}

  invalidate(): void {
    this.dirty = true;
  }

  /** Walks the archive once and aggregates per blob. */
  private scan(): { blobs: Map<number, BlobAgg>; sourceNames: Map<string, string> } {
    const { db, clock, inventory } = this.o;
    const now = clock.now();
    const blobs = new Map<number, BlobAgg>();
    for (const b of db.all<{ id: number; stored_bytes: number; kind: string; volume_id: number }>("SELECT id, stored_bytes, kind, volume_id FROM blobs ORDER BY id")) {
      blobs.set(b.id, { id: b.id, bytes: b.stored_bytes, kind: b.kind, volumeId: b.volume_id, prio: 0, classes: new Set(), sources: new Set() });
    }
    const sourceNames = new Map<string, string>();
    const ids = inventory.allPageIds();
    for (let i = 0; i < ids.length; i += 300) {
      for (const page of inventory.loadPages(ids.slice(i, i + 300))) {
        const per = versionPriorities(page, now);
        const srcKeys = page.refs.filter((r) => r.kind === "source");
        for (const r of srcKeys) sourceNames.set(r.id, r.label ?? r.id);
        const keys = srcKeys.length ? srcKeys.map((r) => r.id) : ["unassigned"];
        for (const v of page.versions) {
          if (v.status === "evicted") continue;
          const p = per.get(v.id)!.priority;
          for (const u of v.blobs) {
            const agg = blobs.get(u.blobId);
            if (!agg) continue;
            if (agg.prio === 0 || p < agg.prio) agg.prio = p;
            agg.classes.add(p);
            for (const k of keys) agg.sources.add(k);
          }
        }
      }
    }
    sourceNames.set("unassigned", "Not in any source");
    return { blobs, sourceNames };
  }

  compute(by: UsageReport["by"], volumeInternalId?: number, volumePublicId?: string): UsageReport {
    const { blobs, sourceNames } = this.scan();
    const inScope = [...blobs.values()].filter((b) => volumeInternalId === undefined || b.volumeId === volumeInternalId);
    const rows = new Map<string, UsageRow>();
    const row = (key: string, label?: string): UsageRow => {
      let r = rows.get(key);
      if (!r) rows.set(key, (r = { key, ...(label ? { label } : {}), exclusiveBytes: 0, sharedBytes: 0, blobCount: 0 }));
      return r;
    };
    let unreferenced = 0;
    for (const b of inScope) {
      if (b.prio === 0) unreferenced += b.bytes;
      switch (by) {
        case "priority": {
          const r = row(b.prio === 0 ? "unreferenced" : `P${b.prio}`);
          r.blobCount++;
          if (b.classes.size > 1) r.sharedBytes += b.bytes;
          else r.exclusiveBytes += b.bytes;
          break;
        }
        case "source": {
          const keys = b.sources.size ? [...b.sources] : ["unreferenced"];
          for (const k of keys) {
            const r = row(k, k === "unreferenced" ? "Not used by anything" : sourceNames.get(k));
            r.blobCount++;
            if (keys.length > 1) r.sharedBytes += b.bytes;
            else r.exclusiveBytes += b.bytes;
          }
          break;
        }
        case "kind": {
          const r = row(b.kind);
          r.blobCount++;
          r.exclusiveBytes += b.bytes;
          break;
        }
        case "volume": {
          const v = this.o.volumes.byId(b.volumeId);
          const r = row(v?.publicId ?? String(b.volumeId), v?.name);
          r.blobCount++;
          r.exclusiveBytes += b.bytes;
          break;
        }
      }
    }
    if (by === "priority") for (const k of PRIO_KEYS) row(k);
    if (by === "volume") for (const v of this.o.volumes.list()) row(v.publicId, v.name);
    const order = by === "priority" ? [...PRIO_KEYS, "unreferenced"] : [...rows.keys()].sort();
    const items = order.filter((k) => rows.has(k)).map((k) => rows.get(k)!);
    return {
      by, ...(volumePublicId ? { volumeId: volumePublicId } : {}), totalBytes: inScope.reduce((n, b) => n + b.bytes, 0), blobCount: inScope.length,
      unreferencedBytes: unreferenced, items, computedAt: new Date(this.o.clock.now()).toISOString(),
    };
  }

  /** `usageByPriority` of the volume object: bytes of blobs by their effective priority. Unreferenced blobs are listed under P4. */
  byPriorityForVolume(volumeId: number): Record<"P1" | "P2" | "P3" | "P4", number> {
    const r = this.compute("priority", volumeId);
    const out = { P1: 0, P2: 0, P3: 0, P4: 0 };
    for (const i of r.items) {
      const k = i.key === "unreferenced" ? "P4" : (i.key as keyof typeof out);
      out[k] += i.exclusiveBytes + i.sharedBytes;
    }
    return out;
  }

  /** Recomputes everything and writes `storage_usage_cache` (per volume, dimension and key). */
  refreshCache(): void {
    const { db, clock, volumes } = this.o;
    const now = clock.now();
    const reports = volumes.list().flatMap((v) => (["priority", "source", "kind"] as const).map((dim) => ({ v, dim, r: this.compute(dim, v.id, v.publicId) })));
    db.transaction(() => {
      db.run("DELETE FROM storage_usage_cache");
      for (const { v, dim, r } of reports) {
        for (const i of r.items) {
          db.run(
            "INSERT INTO storage_usage_cache (volume_id, dimension, key, bytes, blob_count, shared_bytes, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [v.id, dim, i.key, i.exclusiveBytes + i.sharedBytes, i.blobCount, i.sharedBytes, now],
          );
        }
      }
    });
    this.dirty = false;
  }

  /** Bytes the pages of a source reference (each blob once): what a source budget is measured against. */
  sourceBytes(sourceId: number): number {
    return this.o.db.get<{ n: number }>(
      `SELECT COALESCE(SUM(b.stored_bytes), 0) AS n FROM blobs b WHERE b.id IN (
         SELECT a.blob_id FROM page_sources ps JOIN page_versions pv ON pv.page_id = ps.page_id AND pv.status IN ('ready','partial','capturing')
           JOIN asset_references ar ON ar.version_id = pv.id JOIN assets a ON a.id = ar.asset_id WHERE ps.source_id = @src AND a.blob_id IS NOT NULL
         UNION SELECT vc.text_blob_id FROM page_sources ps JOIN page_versions pv ON pv.page_id = ps.page_id JOIN version_content vc ON vc.version_id = pv.id WHERE ps.source_id = @src AND vc.text_blob_id IS NOT NULL
         UNION SELECT vc.reader_blob_id FROM page_sources ps JOIN page_versions pv ON pv.page_id = ps.page_id JOIN version_content vc ON vc.version_id = pv.id WHERE ps.source_id = @src AND vc.reader_blob_id IS NOT NULL
         UNION SELECT vc.outline_blob_id FROM page_sources ps JOIN page_versions pv ON pv.page_id = ps.page_id JOIN version_content vc ON vc.version_id = pv.id WHERE ps.source_id = @src AND vc.outline_blob_id IS NOT NULL
         UNION SELECT d.original_blob_id FROM import_documents d JOIN page_sources ps ON ps.page_id = d.page_id WHERE ps.source_id = @src)`,
      { src: sourceId },
    )!.n;
  }
}
