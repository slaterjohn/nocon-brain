import type { Db } from "@ncb/db";
import type { Clock } from "@ncb/shared";
import { AppError, newId } from "@ncb/shared";
import { eligibility, type EvictionPlan, type PlanItem, type SkipReason } from "@ncb/storage-planner";
import type { ActivityLog } from "../services/activity.js";
import type { BlobStore } from "../services/blobs.js";
import type { StorageInventory } from "./inventory.js";

/**
 * Where a test can stop the process (or throw) to prove the executor is crash safe (task T-05). The names follow the two phases
 * of docs/data-model.md 5.4: phase A is one transaction per version, phase B removes files and finalises.
 */
export type FaultPoint =
  | "run_started"
  | "before_version"
  | "in_version_txn" // inside the phase A transaction, after every change and before the commit (a throw rolls it back)
  | "after_version_txn"
  | "before_blobs"
  | "blob_marked" // the blob row is quarantined, the file is still there
  | "blob_unlinked" // the file is gone, the row is still there
  | "before_finalise"
  | "after_finalise"
  | "run_finished";
export type FaultHook = (point: FaultPoint, info: { versionId?: number; blobId?: number; runId?: string }) => void | Promise<void>;

export type EvictionTrigger = "admission" | "threshold" | "prune" | "manual" | "recovery";

export interface ExecuteOptions {
  trigger: EvictionTrigger;
  volumeId?: number;
  userId?: number;
}

export interface ExecuteResult {
  runId: string;
  planned: number;
  evicted: number;
  skipped: { versionId: number; reason: SkipReason | "changed" }[];
  bytesFreed: number;
  blobsDeleted: number;
  evictedVersionIds: number[];
}

export interface RecoveryReport {
  finalisedVersions: number;
  blobsDeleted: number;
  interruptedRuns: number;
}

export interface ExecutorOptions {
  db: Db;
  clock: Clock;
  blobs: BlobStore;
  inventory: StorageInventory;
  activity: ActivityLog;
  /** Called after a page changed so caches (effective priority) are refreshed. */
  onPageChanged?: (pageId: number) => void;
  onUsageChanged?: () => void;
  fault?: FaultHook;
  orphanGraceMs: () => number;
  log?: { warn(o: unknown, m?: string): void };
}

/**
 * The two-phase, crash-safe eviction executor (task T-05).
 *
 *  Phase A, one transaction per version: re-derive eligibility from the reference rows (the plan and every cached priority column
 *  are only hints), mark the version `evicting`, remove its references and release the blob counts, repoint or tombstone the page,
 *  and write the audit record and the activity-log entry. The index outbox rows come from the migration 0010 triggers on the same
 *  statements. Either all of it commits or none of it does.
 *
 *  Phase B: delete the files of blobs that nothing references any more (mark, unlink, delete the row: see
 *  `BlobStore.deleteIfUnreferenced`), then mark the versions `evicted` and drop their outgoing links.
 *
 *  A crash after phase A leaves `evicting` versions with no references and possibly unreferenced blobs; `recover()` finishes
 *  phase B. A crash during phase A rolls back. Nothing deletes a file before the database says nothing needs it.
 */
export class EvictionExecutor {
  constructor(private readonly o: ExecutorOptions) {}

  private async fault(point: FaultPoint, info: { versionId?: number; blobId?: number; runId?: string } = {}): Promise<void> {
    await this.o.fault?.(point, info);
  }

  async execute(plan: EvictionPlan, opts: ExecuteOptions): Promise<ExecuteResult> {
    // An insufficient plan deletes nothing. Maintenance (prune) plans have no target to miss.
    if (plan.mode === "pressure" && !plan.sufficient) {
      throw new AppError("conflict", "That plan cannot free enough space, so nothing was removed.", { kind: "plan_insufficient" });
    }
    const { db, clock } = this.o;
    const runPublic = newId("evr");
    const startedAt = clock.now();
    db.run(
      `INSERT INTO eviction_runs (public_id, trigger, state, incoming_priority, bytes_needed, volume_id, versions_planned, started_at) VALUES (?, ?, 'running', ?, ?, ?, ?, ?)`,
      [runPublic, opts.trigger, plan.incomingPriority, plan.bytesNeeded, opts.volumeId ?? null, plan.items.length, startedAt],
    );
    const runId = db.get<{ id: number }>("SELECT id FROM eviction_runs WHERE public_id = ?", [runPublic])!.id;
    const result: ExecuteResult = { runId: runPublic, planned: plan.items.length, evicted: 0, skipped: [], bytesFreed: 0, blobsDeleted: 0, evictedVersionIds: [] };
    const touched = new Set<number>();
    try {
      await this.fault("run_started", { runId: runPublic });
      for (const item of plan.items) {
        await this.fault("before_version", { versionId: item.versionId, runId: runPublic });
        const r = this.phaseA(item, plan, { runId, trigger: opts.trigger, userId: opts.userId });
        if (r.ok) {
          result.evicted++;
          result.evictedVersionIds.push(item.versionId);
          for (const b of r.blobIds) touched.add(b);
        } else result.skipped.push({ versionId: item.versionId, reason: r.reason });
        await this.fault("after_version_txn", { versionId: item.versionId, runId: runPublic });
      }
      await this.fault("before_blobs", { runId: runPublic });
      for (const u of plan.unreferencedBlobs) touched.add(u.blobId);
      const graceMs = this.o.orphanGraceMs();
      const planned = new Set(plan.unreferencedBlobs.map((u) => u.blobId));
      for (const blobId of [...touched].sort((a, b) => a - b)) {
        // Blobs this run just un-referenced go at once (the version is already gone from the database); blobs that were already
        // orphaned were only planned because they are past the grace period, which is re-checked here.
        const r = await this.o.blobs.deleteIfUnreferenced(blobId, {
          minZeroForMs: planned.has(blobId) ? graceMs : 0,
          hooks: { afterMark: () => this.fault("blob_marked", { blobId, runId: runPublic }), afterUnlink: () => this.fault("blob_unlinked", { blobId, runId: runPublic }) },
        });
        if (r.deleted) {
          result.blobsDeleted++;
          result.bytesFreed += r.bytes;
        }
      }
      await this.fault("before_finalise", { runId: runPublic });
      for (const id of result.evictedVersionIds) {
        this.finaliseVersion(id);
        await this.fault("after_finalise", { versionId: id, runId: runPublic });
      }
      db.run(
        `UPDATE eviction_runs SET state = 'done', versions_evicted = ?, versions_skipped = ?, bytes_freed = ?, blobs_deleted = ?, finished_at = ? WHERE id = ?`,
        [result.evicted, result.skipped.length, result.bytesFreed, result.blobsDeleted, clock.now(), runId],
      );
      await this.fault("run_finished", { runId: runPublic });
    } catch (e) {
      // A simulated crash never gets here (the process is gone); a thrown fault or a real error leaves the run `failed` and the
      // database consistent: `recover()` finishes whatever phase A committed.
      db.run("UPDATE eviction_runs SET state = 'failed', error = ?, finished_at = ? WHERE id = ? AND state = 'running'", [String(e instanceof Error ? e.message : e).slice(0, 500), clock.now(), runId]);
      throw e;
    } finally {
      this.o.onUsageChanged?.();
    }
    if (result.evicted > 0 || result.blobsDeleted > 0) {
      this.o.activity.write({
        level: "info", area: "storage",
        message: `Freed ${result.bytesFreed.toLocaleString("en-GB")} bytes: ${result.evicted} saved cop${result.evicted === 1 ? "y" : "ies"} removed (${opts.trigger})`,
        details: { runId: runPublic, trigger: opts.trigger, evicted: result.evicted, skipped: result.skipped.length, blobsDeleted: result.blobsDeleted },
      });
    }
    return result;
  }

  /** Phase A for one version. Never throws for "this version is no longer eligible": that is a skip. */
  private phaseA(
    item: PlanItem, plan: EvictionPlan, ctx: { runId: number; trigger: EvictionTrigger; userId?: number },
  ): { ok: true; blobIds: number[] } | { ok: false; reason: SkipReason | "changed" } {
    const { db, clock, inventory } = this.o;
    type Outcome = { ok: true; blobIds: number[]; pageId: number } | { ok: false; reason: SkipReason | "changed" };
    const box: { outcome: Outcome } = { outcome: { ok: false, reason: "changed" } };
    db.transaction(() => {
      const row = db.get<{ page_id: number; status: string; version_no: number }>("SELECT page_id, status, version_no FROM page_versions WHERE id = ?", [item.versionId]);
      if (!row || (row.status !== "ready" && row.status !== "partial")) {
        box.outcome = { ok: false, reason: "changed" };
        return;
      }
      // Re-derive from the reference rows, now, with the current policy. The plan is a suggestion.
      const page = inventory.loadPages([row.page_id])[0]!;
      const policy = inventory.policy();
      const e = eligibility({ page, versionId: item.versionId, policy, incomingPriority: plan.mode === "prune" ? 1 : plan.incomingPriority, now: clock.now() });
      if (!e.eligible) {
        box.outcome = { ok: false, reason: e.reason };
        this.o.activity.write({
          level: "warn", area: "storage", versionId: item.versionId,
          message: `Skipped removing ${page.url}: it is no longer eligible (${e.reason}) when checked just before removal`,
          details: { versionId: item.versionId, reason: e.reason, plannedPriority: item.priority },
        });
        return;
      }
      // I-13 belt and braces: a version that is P1 here must never get this far.
      if (e.priority === 1 && !e.surplus) throw new Error("Refusing to evict a Protected (P1) version");

      db.run("UPDATE page_versions SET status = 'evicting' WHERE id = ?", [item.versionId]);
      const blobIds = releaseVersionReferences(db, this.o.blobs, item.versionId);
      const live = db.all<{ id: number; status: string }>(
        "SELECT id, status FROM page_versions WHERE page_id = ? AND status IN ('ready','partial') ORDER BY fetched_at DESC, id DESC", [row.page_id]);
      const wasLatest = db.get<{ latest_version_id: number | null }>("SELECT latest_version_id FROM pages WHERE id = ?", [row.page_id])!.latest_version_id === item.versionId;
      if (wasLatest || live.length === 0) {
        // The newest remaining copy becomes the current one; with none left the page stays as a tombstone (links to it show "evicted").
        const availability = live.length === 0 ? "evicted" : live[0]!.status === "partial" ? "partial" : "archived";
        db.run("UPDATE pages SET latest_version_id = ?, availability = ? WHERE id = ?", [live[0]?.id ?? null, availability, row.page_id]);
      }
      db.run("UPDATE pages SET version_count = ? WHERE id = ?", [live.length, row.page_id]);
      const reason = item.reason;
      const refs = page.refs.map((r) => ({ kind: r.kind, id: r.id, label: r.label, priority: r.priority, autoEvict: r.autoEvict, retains: e.retainingRefs.includes(r) }));
      db.run(
        `INSERT INTO storage_audit (kind, at, run_id, page_id, page_url, version_id, version_no, priority, surplus, step, reason, trigger, exclusive_bytes, refs_json, user_id)
         VALUES ('evicted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [clock.now(), ctx.runId, row.page_id, page.url, item.versionId, row.version_no, e.priority, e.surplus ? 1 : 0, item.step, reason, ctx.trigger, item.exclusiveBytes, JSON.stringify(refs), ctx.userId ?? null],
      );
      // Written directly (not through ActivityLog, which swallows errors): an eviction without its log entry must not commit.
      db.run(
        `INSERT INTO activity_log (at, level, area, message, details_json, version_id, user_id) VALUES (?, 'info', 'storage', ?, ?, ?, ?)`,
        [clock.now(), `Removed saved copy ${row.version_no} of ${page.url} to free space: ${reason}`.slice(0, 2000),
          JSON.stringify({ kind: "evicted", versionId: item.versionId, pageId: row.page_id, priority: e.priority, surplus: e.surplus, step: item.step, trigger: ctx.trigger, exclusiveBytes: item.exclusiveBytes }), item.versionId, ctx.userId ?? null],
      );
      // Synchronous on purpose: a hook that throws here rolls the whole version back; one that kills the process leaves the commit unwritten.
      this.o.fault?.("in_version_txn", { versionId: item.versionId });
      box.outcome = { ok: true, blobIds, pageId: row.page_id };
    }, { durable: true });
    const outcome = box.outcome;
    if (outcome.ok) {
      this.o.onPageChanged?.(outcome.pageId);
      return { ok: true, blobIds: outcome.blobIds };
    }
    return outcome;
  }

  /** Phase B for a version: it is `evicted`, and its outgoing links go (the pages they pointed at keep their rows). */
  finaliseVersion(versionId: number): boolean {
    const { db, clock } = this.o;
    return db.transaction(() => {
      const r = db.run("UPDATE page_versions SET status = 'evicted', evicted_at = COALESCE(evicted_at, ?) WHERE id = ? AND status = 'evicting'", [clock.now(), versionId]);
      if (r.changes === 0) return false;
      const targets = db.all<{ to_page_id: number }>("SELECT DISTINCT to_page_id FROM links WHERE from_version_id = ? AND to_page_id IS NOT NULL", [versionId]);
      db.run("DELETE FROM links WHERE from_version_id = ?", [versionId]);
      for (const t of targets) {
        db.run(
          `UPDATE pages SET inbound_count = (
             SELECT COUNT(DISTINCT l.from_page_id) FROM links l JOIN pages fp ON fp.id = l.from_page_id AND fp.latest_version_id = l.from_version_id
             WHERE l.to_page_id = pages.id AND l.from_page_id <> pages.id) WHERE id = ?`, [t.to_page_id]);
      }
      return true;
    });
  }

  /**
   * Startup recovery: finish deletions a crash interrupted. Versions left `evicting` have no references (phase A commits all or
   * nothing), so they are finalised; blobs left quarantined with no references are deleted; runs still marked `running` are
   * marked `interrupted`. Unreferenced blobs this run did not get to are left for the normal garbage collection after the grace period.
   */
  async recover(): Promise<RecoveryReport> {
    const { db, clock } = this.o;
    let blobsDeleted = await this.o.blobs.finishPendingDeletes();
    const evicting = db.all<{ id: number; page_id: number }>("SELECT id, page_id FROM page_versions WHERE status = 'evicting' ORDER BY id");
    let finalised = 0;
    for (const v of evicting) {
      // Defensive: phase A removes every reference together with the status change, but a version restored from a backup might not.
      if (db.get("SELECT 1 AS x FROM asset_references WHERE version_id = ? LIMIT 1", [v.id])) {
        db.transaction(() => {
          releaseVersionReferences(db, this.o.blobs, v.id);
        });
      }
      if (this.finaliseVersion(v.id)) finalised++;
      this.o.onPageChanged?.(v.page_id);
    }
    blobsDeleted += await this.o.blobs.finishPendingDeletes();
    const interrupted = db.run("UPDATE eviction_runs SET state = 'interrupted', finished_at = ? WHERE state = 'running'", [clock.now()]).changes;
    if (finalised > 0 || blobsDeleted > 0 || interrupted > 0) {
      this.o.activity.write({
        level: "warn", area: "storage", message: `Finished an interrupted clean-up: ${finalised} saved cop${finalised === 1 ? "y" : "ies"} finalised, ${blobsDeleted} unused file${blobsDeleted === 1 ? "" : "s"} removed`,
        details: { finalised, blobsDeleted, interrupted },
      });
    }
    this.o.onUsageChanged?.();
    return { finalisedVersions: finalised, blobsDeleted, interruptedRuns: interrupted };
  }
}

/**
 * Removes every reference a version holds and releases the blob counts. Returns the blobs that may now be unreferenced. Call inside a
 * transaction. Shared by the executor (phase A) and the maintenance repair of a stale `capturing` version.
 */
export function releaseVersionReferences(db: Db, blobs: BlobStore, versionId: number): number[] {
  const touched = new Set<number>();

  const refs = db.all<{ blob_id: number; n: number }>(
    `SELECT a.blob_id AS blob_id, COUNT(*) AS n FROM asset_references ar JOIN assets a ON a.id = ar.asset_id WHERE ar.version_id = ? AND a.blob_id IS NOT NULL GROUP BY a.blob_id`, [versionId]);
  for (const r of refs) {
    blobs.release(r.blob_id, r.n);
    touched.add(r.blob_id);
  }
  const imported = db.get<{ original_blob_id: number }>("SELECT original_blob_id FROM import_documents WHERE version_id = ?", [versionId]);
  if (imported) {
    blobs.release(imported.original_blob_id, 1);
    touched.add(imported.original_blob_id);
  }
  const content = db.get<Record<string, number | null>>("SELECT text_blob_id, reader_blob_id, outline_blob_id, extraction_blob_id FROM version_content WHERE version_id = ?", [versionId]);
  for (const id of Object.values(content ?? {})) {
    if (id) {
      blobs.release(id, 1);
      touched.add(id);
    }
  }
  const assetIds = db.all<{ asset_id: number }>(
    "SELECT DISTINCT asset_id FROM asset_references WHERE version_id = ? UNION SELECT DISTINCT via_asset_id FROM asset_references WHERE version_id = ? AND via_asset_id IS NOT NULL", [versionId, versionId]);
  db.run("DELETE FROM asset_references WHERE version_id = ?", [versionId]);
  db.run("DELETE FROM version_resources WHERE version_id = ?", [versionId]);
  db.run("DELETE FROM version_content WHERE version_id = ?", [versionId]);
  db.run("DELETE FROM import_documents WHERE version_id = ?", [versionId]);
  db.run("UPDATE page_versions SET document_blob_id = NULL, duplicate_of_version_id = NULL, retained = 0 WHERE id = ?", [versionId]);
  db.run("UPDATE page_versions SET duplicate_of_version_id = NULL WHERE duplicate_of_version_id = ?", [versionId]);
  for (const a of assetIds) {
    db.run(
      `DELETE FROM assets WHERE id = ? AND NOT EXISTS (SELECT 1 FROM asset_references WHERE asset_id = assets.id OR via_asset_id = assets.id)
         AND NOT EXISTS (SELECT 1 FROM version_resources WHERE asset_id = assets.id)`, [a.asset_id]);
  }
  return [...touched];
}
