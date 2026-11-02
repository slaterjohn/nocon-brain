import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Db } from "@ncb/db";
import type { Clock } from "@ncb/shared";
import { AppError, newId } from "@ncb/shared";
import type { ActivityLog } from "../services/activity.js";
import type { BlobStore } from "../services/blobs.js";
import { blobPathFor, type VolumeRow, type VolumeService } from "../services/volumes.js";
import { releaseVersionReferences } from "./executor.js";

export const INVARIANTS = ["I-1", "I-2", "I-3", "I-4", "I-5", "I-6", "I-7", "I-8", "I-9", "I-10", "I-11", "I-12", "I-13"] as const;
export type InvariantId = (typeof INVARIANTS)[number];
/** `REF` is not an invariant: pages that no source, collection, pin or bookmark references (data-model 5.1). Reported, never repaired. */
export type CheckId = InvariantId | "REF";

const TITLES: Record<CheckId, string> = {
  "I-1": "A stored file is missing from its volume or has the wrong size",
  "I-2": "A file on a volume has no database row",
  "I-3": "A reference count does not match the references",
  "I-4": "A row points at a parent that does not exist",
  "I-5": "A saved copy is stuck in capturing",
  "I-6": "A page's latest copy is not a usable copy of that page",
  "I-7": "A host's in-flight count does not match the running jobs",
  "I-8": "A space reservation belongs to a download that is over",
  "I-9": "Temporary files left behind",
  "I-10": "The search index does not match the archive",
  "I-11": "A stored file does not match its checksum",
  "I-12": "The database failed its integrity check",
  "I-13": "Protected content was removed without a record of it",
  REF: "A page is not referenced by any source, collection, pin or bookmark",
};

export interface Finding {
  invariant: CheckId;
  title: string;
  count: number;
  examples: string[];
  /** Present on a repair run: how many of the `count` were fixed. */
  repaired?: number;
  note?: string;
}

export interface MaintenanceRun {
  id: string;
  kind: "verify" | "repair" | "gc" | "backup" | "integrity_check" | "scrub";
  dryRun: boolean;
  state: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  findings: Finding[];
  /** What was looked at, so a clean report says how much it covered. */
  checked: Record<string, number>;
  skipped: { invariant: CheckId; reason: string }[];
}

export interface VerifyOptions {
  repair?: boolean;
  checks?: string[];
  /** Blobs whose checksum I-11 recomputes in one run. Default 25. */
  sampleBlobs?: number;
  /** A `capturing` version older than this with no job is stuck (I-5). Default 10 minutes. */
  capturingStaleMs?: number;
  /** Temp files older than this are leftovers (I-9). Default 24 hours. */
  tmpStaleMs?: number;
  kind?: "verify" | "repair" | "scrub" | "integrity_check";
}

export interface MaintenanceOptions {
  db: Db;
  clock: Clock;
  volumes: VolumeService;
  blobs: BlobStore;
  activity: ActivityLog;
  /** Checks the search index against the archive (I-10); `repair` enqueues a rebuild. */
  indexCheck?: (repair: boolean) => Promise<{ ok: boolean; missing: number; extra: number; mismatches: unknown[]; needsRebuild: boolean }>;
  onPageChanged?: (pageId: number) => void;
  onUsageChanged?: () => void;
}

const SAMPLE = 5;

/**
 * Verify-and-repair (task T-10): checks invariants I-1 to I-13 of docs/data-model.md section 7. Dry run is the default and changes
 * nothing in the archive (the report itself is stored in `maintenance_runs`). With `repair` each finding is fixed in the way the
 * table in section 7 says; a repair re-checks nothing it did not find, and never deletes content: files without a row go to
 * `<volume>/quarantine/`, not to the bin.
 */
export class MaintenanceService {
  constructor(private readonly o: MaintenanceOptions) {}

  async verify(opts: VerifyOptions = {}): Promise<MaintenanceRun> {
    const { db, clock } = this.o;
    const repair = opts.repair === true;
    const want = new Set<string>(opts.checks && opts.checks.length ? opts.checks : [...INVARIANTS, "REF"]);
    for (const c of want) if (!(INVARIANTS as readonly string[]).includes(c) && c !== "REF") throw new AppError("bad_request", `Unknown check "${c}". Use I-1 to I-13 or REF.`);
    const publicId = newId("mnt");
    const startedAt = clock.now();
    const kind = opts.kind ?? (repair ? "repair" : "verify");
    db.run("INSERT INTO maintenance_runs (public_id, kind, dry_run, state, started_at) VALUES (?, ?, ?, 'running', ?)", [publicId, kind, repair ? 0 : 1, startedAt]);
    const run: MaintenanceRun = { id: publicId, kind, dryRun: !repair, state: "running", startedAt: new Date(startedAt).toISOString(), findings: [], checked: {}, skipped: [] };
    try {
      const volumes = this.o.volumes.list();
      const add = (invariant: CheckId, count: number, examples: string[], repaired?: number, note?: string): void => {
        if (count > 0) run.findings.push({ invariant, title: TITLES[invariant], count, examples: examples.slice(0, SAMPLE), ...(repair ? { repaired: repaired ?? 0 } : {}), ...(note ? { note } : {}) });
      };
      const todo: [CheckId, () => Promise<void> | void][] = [
        ["I-1", () => this.i1(volumes, repair, run, add)],
        ["I-2", () => this.i2(volumes, repair, run, add)],
        // I-4 runs before I-3: dangling references must be gone before the counts are compared with them.
        ["I-4", () => this.i4(repair, add)],
        ["I-3", () => this.i3(repair, run, add)],
        ["I-5", () => this.i5(repair, opts.capturingStaleMs ?? 600_000, add)],
        ["I-6", () => this.i6(repair, add)],
        ["I-7", () => this.i7(repair, add)],
        ["I-8", () => this.i8(repair, add)],
        ["I-9", () => this.i9(volumes, repair, opts.tmpStaleMs ?? 86_400_000, run, add)],
        ["I-10", () => this.i10(repair, run, add)],
        ["I-11", () => this.i11(volumes, repair, opts.sampleBlobs ?? 25, run, add)],
        ["I-12", () => this.i12(run, add)],
        ["I-13", () => this.i13(add)],
        ["REF", () => this.orphans(add)],
      ];
      for (const [id, fn] of todo) if (want.has(id)) await fn();
      run.findings.sort((a, b) => (a.invariant < b.invariant ? -1 : 1));
      run.findings.sort((a, b) => order(a.invariant) - order(b.invariant));
      run.state = "done";
    } catch (e) {
      run.state = "failed";
      run.findings.push({ invariant: "I-12", title: "The check itself failed", count: 1, examples: [String(e instanceof Error ? e.message : e)] });
    }
    const finishedAt = clock.now();
    run.finishedAt = new Date(finishedAt).toISOString();
    db.run("UPDATE maintenance_runs SET state = ?, finished_at = ?, report_json = ? WHERE public_id = ?", [run.state, finishedAt, JSON.stringify(run), publicId]);
    const bad = run.findings.filter((f) => f.invariant !== "REF");
    this.o.activity.write({
      level: bad.some((f) => f.invariant === "I-13") ? "error" : bad.length ? "warn" : "info", area: "storage",
      message: `${repair ? "Repair" : "Check"} finished: ${bad.length === 0 ? "no problems found" : `${bad.length} kind${bad.length === 1 ? "" : "s"} of problem found`}`,
      details: { runId: publicId, dryRun: !repair, findings: run.findings.map((f) => ({ invariant: f.invariant, count: f.count, repaired: f.repaired })) },
    });
    if (repair) this.o.onUsageChanged?.();
    return run;
  }

  list(limit = 50): { items: Pick<MaintenanceRun, "id" | "kind" | "dryRun" | "state" | "startedAt" | "finishedAt">[] } {
    return {
      items: this.o.db.all<{ public_id: string; kind: MaintenanceRun["kind"]; dry_run: number; state: MaintenanceRun["state"]; started_at: number; finished_at: number | null }>(
        "SELECT public_id, kind, dry_run, state, started_at, finished_at FROM maintenance_runs ORDER BY id DESC LIMIT ?", [limit])
        .map((r) => ({ id: r.public_id, kind: r.kind, dryRun: r.dry_run === 1, state: r.state, startedAt: new Date(r.started_at).toISOString(), ...(r.finished_at ? { finishedAt: new Date(r.finished_at).toISOString() } : {}) })),
    };
  }

  get(id: string): MaintenanceRun {
    const r = this.o.db.get<{ report_json: string | null }>("SELECT report_json FROM maintenance_runs WHERE public_id = ?", [id]);
    if (!r) throw new AppError("not_found", "That maintenance run does not exist.");
    return JSON.parse(r.report_json ?? "{}") as MaintenanceRun;
  }

  // ---- individual checks ---------------------------------------------------------------------

  private online(volumes: VolumeRow[], run: MaintenanceRun, inv: CheckId): VolumeRow[] {
    const ok: VolumeRow[] = [];
    for (const v of volumes) {
      if (v.state === "offline" || v.state === "disabled") run.skipped.push({ invariant: inv, reason: `Volume "${v.name}" is ${v.state}; its files were not checked.` });
      else ok.push(v);
    }
    return ok;
  }

  /** I-1: every `ready` blob has a file of the expected size. */
  private async i1(volumes: VolumeRow[], repair: boolean, run: MaintenanceRun, add: AddFn): Promise<void> {
    const { db } = this.o;
    const bad: { id: number; sha: string }[] = [];
    let checked = 0;
    for (const v of this.online(volumes, run, "I-1")) {
      for (const b of db.all<{ id: number; sha256: string; compression: string; stored_bytes: number }>("SELECT id, sha256, compression, stored_bytes FROM blobs WHERE volume_id = ? AND state = 'ready' ORDER BY id", [v.id])) {
        checked++;
        try {
          const st = await fsp.stat(blobPathFor(v.rootPath, b.sha256, b.compression === "zstd"));
          if (st.size !== b.stored_bytes) bad.push({ id: b.id, sha: b.sha256 });
        } catch {
          bad.push({ id: b.id, sha: b.sha256 });
        }
      }
    }
    run.checked["blobs"] = checked;
    let repaired = 0;
    if (repair) {
      db.transaction(() => {
        for (const b of bad) {
          db.run("UPDATE blobs SET state = 'missing' WHERE id = ?", [b.id]);
          // Every live copy that uses the file is no longer whole.
          const vids = db.all<{ id: number }>(
            `SELECT DISTINCT pv.id FROM page_versions pv WHERE pv.status = 'ready' AND (
               pv.id IN (SELECT ar.version_id FROM asset_references ar JOIN assets a ON a.id = ar.asset_id WHERE a.blob_id = @b)
               OR pv.id IN (SELECT version_id FROM version_content WHERE text_blob_id = @b OR reader_blob_id = @b OR outline_blob_id = @b OR extraction_blob_id = @b))`, { b: b.id });
          for (const v of vids) {
            db.run("UPDATE page_versions SET status = 'partial', partial_reason = COALESCE(partial_reason, 'assets_missing') WHERE id = ?", [v.id]);
            const pg = db.get<{ page_id: number }>("SELECT page_id FROM page_versions WHERE id = ?", [v.id])!;
            db.run("UPDATE pages SET availability = 'partial' WHERE id = ? AND latest_version_id = ? AND availability = 'archived'", [pg.page_id, v.id]);
          }
          repaired++;
        }
      });
    }
    add("I-1", bad.length, bad.map((b) => b.sha), repaired, repair ? "Marked missing; the copies that use them are now partial and can be saved again." : undefined);
  }

  /** I-2: files on a volume with no row. Repair moves them to `quarantine/`. */
  private async i2(volumes: VolumeRow[], repair: boolean, run: MaintenanceRun, add: AddFn): Promise<void> {
    const { db } = this.o;
    const strays: { file: string; root: string }[] = [];
    let walked = 0;
    for (const v of this.online(volumes, run, "I-2")) {
      const base = path.join(v.rootPath, "blobs");
      let l1: string[] = [];
      try { l1 = await fsp.readdir(base); } catch { continue; }
      const known = new Set(db.all<{ sha256: string }>("SELECT sha256 FROM blobs WHERE volume_id = ?", [v.id]).map((r) => r.sha256));
      for (const a of l1.sort()) {
        const d1 = path.join(base, a);
        if (!(await fsp.stat(d1).catch(() => null))?.isDirectory()) { strays.push({ file: d1, root: v.rootPath }); continue; }
        for (const b of (await fsp.readdir(d1)).sort()) {
          const d2 = path.join(d1, b);
          if (!(await fsp.stat(d2).catch(() => null))?.isDirectory()) { strays.push({ file: d2, root: v.rootPath }); continue; }
          for (const f of (await fsp.readdir(d2)).sort()) {
            walked++;
            const sha = f.replace(/\.zst$/, "");
            if (!/^[0-9a-f]{64}$/.test(sha) || !known.has(sha)) strays.push({ file: path.join(d2, f), root: v.rootPath });
          }
        }
      }
    }
    run.checked["files"] = walked;
    let repaired = 0;
    if (repair) {
      for (const s of strays) {
        try {
          const q = path.join(s.root, "quarantine");
          await fsp.mkdir(q, { recursive: true });
          await fsp.rename(s.file, path.join(q, `${Date.now()}-${path.basename(s.file)}`));
          repaired++;
        } catch { /* leave it; the next run reports it again */ }
      }
    }
    add("I-2", strays.length, strays.map((s) => path.relative(s.root, s.file)), repaired, repair ? "Moved to the volume's quarantine folder; nothing was deleted." : undefined);
  }

  /** I-3: `refcount` equals the references, and `zero_since` is set exactly when it is 0. */
  private i3(repair: boolean, run: MaintenanceRun, add: AddFn): void {
    const { db, clock } = this.o;
    const rows = db.all<{ id: number; sha256: string; refcount: number; zero_since: number | null; truth: number }>(
      `SELECT b.id, b.sha256, b.refcount, b.zero_since,
              (SELECT COUNT(*) FROM asset_references ar JOIN assets a ON a.id = ar.asset_id WHERE a.blob_id = b.id)
            + (SELECT COUNT(*) FROM version_content WHERE text_blob_id = b.id) + (SELECT COUNT(*) FROM version_content WHERE reader_blob_id = b.id)
            + (SELECT COUNT(*) FROM version_content WHERE outline_blob_id = b.id) + (SELECT COUNT(*) FROM version_content WHERE extraction_blob_id = b.id)
            + (SELECT COUNT(*) FROM import_documents WHERE original_blob_id = b.id) AS truth
       FROM blobs b WHERE b.state <> 'quarantined' ORDER BY b.id`);
    run.checked["blobCounts"] = rows.length;
    const bad = rows.filter((r) => r.refcount !== r.truth || (r.truth === 0) !== (r.zero_since !== null));
    // A freshly stored blob that is about to be referenced has zero_since NULL and refcount 0 (see BlobStore.put): that is not drift.
    const real = bad.filter((r) => !(r.truth === 0 && r.refcount === 0 && r.zero_since === null));
    let repaired = 0;
    if (repair) {
      db.transaction(() => {
        for (const r of real) {
          db.run("UPDATE blobs SET refcount = ?, zero_since = CASE WHEN ? = 0 THEN COALESCE(zero_since, ?) ELSE NULL END WHERE id = ?", [r.truth, r.truth, clock.now(), r.id]);
          repaired++;
        }
      });
    }
    add("I-3", real.length, real.map((r) => `${r.sha256.slice(0, 12)} refcount ${r.refcount}, references ${r.truth}`), repaired, repair ? "Recounted from the references." : undefined);
  }

  /** I-4: dangling references. Foreign keys make this structural; this catches a restored or hand-edited database. */
  private i4(repair: boolean, add: AddFn): void {
    const { db } = this.o;
    const checks: [string, string, string][] = [
      ["asset_references", "version", "DELETE FROM asset_references WHERE version_id NOT IN (SELECT id FROM page_versions) OR asset_id NOT IN (SELECT id FROM assets)"],
      ["links", "version", "DELETE FROM links WHERE from_version_id NOT IN (SELECT id FROM page_versions)"],
      ["version_content", "version", "DELETE FROM version_content WHERE version_id NOT IN (SELECT id FROM page_versions)"],
      ["version_resources", "version", "DELETE FROM version_resources WHERE version_id NOT IN (SELECT id FROM page_versions)"],
    ];
    let total = 0;
    let repaired = 0;
    const examples: string[] = [];
    for (const [table, , del] of checks) {
      const where = del.slice(del.indexOf("WHERE"));
      const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} ${where}`)!.n;
      if (n > 0) examples.push(`${table}: ${n}`);
      total += n;
      if (repair && n > 0) {
        // Foreign keys are on, so these can only exist in a database that was restored or edited with them off.
        repaired += db.run(del).changes;
      }
    }
    const fk = db.pragma("foreign_key_check") as unknown[];
    if (fk.length > 0 && !examples.length) {
      total += fk.length;
      examples.push(`foreign_key_check: ${fk.length} row(s)`);
    }
    add("I-4", total, examples, repaired, repair && fk.length > 0 ? "Rows that fail a foreign key check but are not references are only reported." : undefined);
  }

  /** I-5: `capturing` versions with no live job and past the stale limit. Repair marks them failed and releases their references. */
  private i5(repair: boolean, staleMs: number, add: AddFn): void {
    const { db, clock, blobs } = this.o;
    const stale = db.all<{ id: number; page_id: number; public_id: string }>(
      `SELECT pv.id, pv.page_id, pv.public_id FROM page_versions pv
       WHERE pv.status = 'capturing' AND pv.created_at <= ? AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.version_id = pv.id AND j.state IN ('queued','running','held'))
         AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.download_job_id = pv.download_job_id AND pv.download_job_id IS NOT NULL AND j.state IN ('queued','running','held'))
       ORDER BY pv.id`, [clock.now() - staleMs]);
    let repaired = 0;
    if (repair) {
      db.transaction(() => {
        for (const v of stale) {
          releaseVersionReferences(db, blobs, v.id);
          db.run("UPDATE page_versions SET status = 'failed', failure_stage = 'maintenance', failure_message = 'The save never finished and was cleaned up.' WHERE id = ?", [v.id]);
          db.run("UPDATE pages SET latest_version_id = (SELECT id FROM page_versions WHERE page_id = ? AND status IN ('ready','partial') ORDER BY fetched_at DESC, id DESC LIMIT 1) WHERE id = ? AND latest_version_id = ?", [v.page_id, v.page_id, v.id]);
          repaired++;
        }
      });
    }
    add("I-5", stale.length, stale.map((v) => v.public_id), repaired, repair ? "Marked failed; the page can be saved again." : undefined);
  }

  /** I-6: `pages.latest_version_id` points at a ready/partial version of the same page. */
  private i6(repair: boolean, add: AddFn): void {
    const { db, onPageChanged } = this.o;
    const bad = db.all<{ id: number; public_id: string }>(
      `SELECT p.id, p.public_id FROM pages p WHERE p.latest_version_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM page_versions v WHERE v.id = p.latest_version_id AND v.page_id = p.id AND v.status IN ('ready','partial'))
       UNION SELECT p.id, p.public_id FROM pages p WHERE p.latest_version_id IS NULL AND p.availability IN ('archived','partial')
       ORDER BY 1`);
    let repaired = 0;
    if (repair) {
      db.transaction(() => {
        for (const p of bad) {
          const v = db.get<{ id: number; status: string }>("SELECT id, status FROM page_versions WHERE page_id = ? AND status IN ('ready','partial') ORDER BY fetched_at DESC, id DESC LIMIT 1", [p.id]);
          db.run("UPDATE pages SET latest_version_id = ?, availability = ? WHERE id = ?", [v?.id ?? null, v ? (v.status === "partial" ? "partial" : "archived") : "evicted", p.id]);
          repaired++;
        }
      });
      for (const p of bad) onPageChanged?.(p.id);
    }
    add("I-6", bad.length, bad.map((p) => p.public_id), repaired, repair ? "Pointed at the newest usable copy, or marked evicted when there is none." : undefined);
  }

  /** I-7: `host_state.in_flight` equals the running fetch jobs per host. */
  private i7(repair: boolean, add: AddFn): void {
    const { db } = this.o;
    const rows = db.all<{ host: string; in_flight: number; running: number }>(
      `SELECT h.host, h.in_flight, (SELECT COUNT(*) FROM jobs j WHERE j.host = h.host AND j.state = 'running') AS running FROM host_state h ORDER BY h.host`).filter((r) => r.in_flight !== r.running);
    let repaired = 0;
    if (repair) {
      db.transaction(() => {
        for (const r of rows) {
          db.run("UPDATE host_state SET in_flight = ? WHERE host = ?", [r.running, r.host]);
          repaired++;
        }
      });
    }
    add("I-7", rows.length, rows.map((r) => `${r.host}: ${r.in_flight} vs ${r.running}`), repaired, repair ? "Reset to the number of running jobs." : undefined);
  }

  /** I-8: reservations for downloads that are over (or expired). */
  private i8(repair: boolean, add: AddFn): void {
    const { db, clock } = this.o;
    const where = `expires_at <= ? OR download_job_id NOT IN (SELECT id FROM download_jobs WHERE state IN ('queued','running','paused'))`;
    const rows = db.all<{ id: number; download_job_id: number }>(`SELECT id, download_job_id FROM volume_reservations WHERE ${where} ORDER BY id`, [clock.now()]);
    const repaired = repair ? db.run(`DELETE FROM volume_reservations WHERE ${where}`, [clock.now()]).changes : 0;
    add("I-8", rows.length, rows.map((r) => `reservation ${r.id} for download ${r.download_job_id}`), repaired, repair ? "Removed." : undefined);
  }

  /** I-9: temp files older than the stale limit. */
  private async i9(volumes: VolumeRow[], repair: boolean, staleMs: number, run: MaintenanceRun, add: AddFn): Promise<void> {
    const old: string[] = [];
    let repaired = 0;
    const cutoff = Date.now() - staleMs;
    for (const v of this.online(volumes, run, "I-9")) {
      const dir = path.join(v.rootPath, "tmp");
      let names: string[] = [];
      try { names = await fsp.readdir(dir); } catch { continue; }
      for (const n of names.sort()) {
        const p = path.join(dir, n);
        const st = await fsp.stat(p).catch(() => null);
        if (!st || st.mtimeMs > cutoff) continue;
        old.push(path.join("tmp", n));
        if (repair) {
          await fsp.rm(p, { recursive: true, force: true }).catch(() => undefined);
          repaired++;
        }
      }
    }
    add("I-9", old.length, old, repaired, repair ? "Deleted." : undefined);
  }

  /** I-10: the search index matches the archive. */
  private async i10(repair: boolean, run: MaintenanceRun, add: AddFn): Promise<void> {
    if (!this.o.indexCheck) {
      run.skipped.push({ invariant: "I-10", reason: "The search index is not running in this process." });
      return;
    }
    try {
      const r = await this.o.indexCheck(repair);
      const n = r.missing + r.extra + r.mismatches.length;
      add("I-10", r.ok ? 0 : Math.max(1, n), [`${r.missing} missing, ${r.extra} extra, ${r.mismatches.length} out of date`], repair && !r.ok ? Math.max(1, n) : 0,
        repair && !r.ok ? (r.needsRebuild ? "A rebuild of the index was started." : "Repaired in place.") : undefined);
    } catch (e) {
      run.skipped.push({ invariant: "I-10", reason: e instanceof Error ? e.message : String(e) });
    }
  }

  /** I-11: recompute the checksum of a sample of stored files, the least recently verified first. */
  private async i11(volumes: VolumeRow[], repair: boolean, sample: number, run: MaintenanceRun, add: AddFn): Promise<void> {
    const r = await this.scrubSome(volumes, { maxBlobs: sample, maxBytes: Infinity, repair, run });
    run.checked["scrubbed"] = r.checked;
    add("I-11", r.bad.length, r.bad.map((b) => b.sha256), r.repaired, repair ? "Moved aside to quarantine and marked missing; the copies that use them are now partial." : undefined);
  }

  /**
   * Hash scrub (throttled by the caller): checks stored files against their SHA-256, oldest `verified_at` first, until `maxBlobs` or
   * `maxBytes` of stored data have been read. Records `verified_at` for the good ones.
   */
  async scrubSome(
    volumes: VolumeRow[], o: { maxBlobs: number; maxBytes: number; repair: boolean; run?: MaintenanceRun },
  ): Promise<{ checked: number; bytes: number; bad: { id: number; sha256: string }[]; repaired: number }> {
    const { db, clock } = this.o;
    const bad: { id: number; sha256: string }[] = [];
    let checked = 0;
    let bytes = 0;
    let repaired = 0;
    const usable = o.run ? this.online(volumes, o.run, "I-11") : volumes.filter((v) => v.state !== "offline" && v.state !== "disabled");
    for (const v of usable) {
      const rows = db.all<{ id: number; sha256: string; compression: string; stored_bytes: number }>(
        "SELECT id, sha256, compression, stored_bytes FROM blobs WHERE volume_id = ? AND state = 'ready' ORDER BY COALESCE(verified_at, 0), id LIMIT ?", [v.id, o.maxBlobs]);
      for (const b of rows) {
        if (checked >= o.maxBlobs || bytes >= o.maxBytes) break;
        checked++;
        bytes += b.stored_bytes;
        const file = blobPathFor(v.rootPath, b.sha256, b.compression === "zstd");
        let ok = false;
        try {
          const hash = createHash("sha256");
          const raw = fs.createReadStream(file);
          let stream: NodeJS.ReadableStream = raw;
          if (b.compression === "zstd") {
            const z = (await import("node:zlib")).createZstdDecompress();
            raw.on("error", (e) => z.destroy(e));
            stream = raw.pipe(z);
          }
          for await (const chunk of stream) hash.update(chunk as Buffer);
          ok = hash.digest("hex") === b.sha256;
        } catch {
          ok = false;
        }
        if (ok) db.run("UPDATE blobs SET verified_at = ? WHERE id = ?", [clock.now(), b.id]);
        else {
          bad.push({ id: b.id, sha256: b.sha256 });
          if (o.repair) {
            try {
              const q = path.join(v.rootPath, "quarantine");
              await fsp.mkdir(q, { recursive: true });
              await fsp.rename(file, path.join(q, `${Date.now()}-${path.basename(file)}`)).catch(() => undefined);
            } catch { /* the row is still marked missing */ }
            await this.i1Mark(b.id);
            repaired++;
          }
        }
      }
    }
    return { checked, bytes, bad, repaired };
  }

  private async i1Mark(blobId: number): Promise<void> {
    const { db } = this.o;
    db.transaction(() => {
      db.run("UPDATE blobs SET state = 'missing' WHERE id = ?", [blobId]);
      for (const v of db.all<{ id: number; page_id: number }>(
        `SELECT DISTINCT pv.id, pv.page_id FROM page_versions pv WHERE pv.status = 'ready' AND (
           pv.id IN (SELECT ar.version_id FROM asset_references ar JOIN assets a ON a.id = ar.asset_id WHERE a.blob_id = @b)
           OR pv.id IN (SELECT version_id FROM version_content WHERE text_blob_id = @b OR reader_blob_id = @b OR outline_blob_id = @b OR extraction_blob_id = @b))`, { b: blobId })) {
        db.run("UPDATE page_versions SET status = 'partial', partial_reason = COALESCE(partial_reason, 'assets_missing') WHERE id = ?", [v.id]);
        db.run("UPDATE pages SET availability = 'partial' WHERE id = ? AND latest_version_id = ? AND availability = 'archived'", [v.page_id, v.id]);
      }
    });
  }

  /** I-12: `PRAGMA quick_check` on `main.db`. Report only; the remedy is to restore from a backup. */
  private i12(run: MaintenanceRun, add: AddFn): void {
    const rows = this.o.db.pragma("quick_check") as { quick_check?: string }[];
    const msgs = rows.map((r) => r.quick_check ?? String(Object.values(r)[0])).filter((m) => m !== "ok");
    run.checked["quickCheck"] = 1;
    add("I-12", msgs.length, msgs, undefined, msgs.length ? "Restore from a backup (Settings, Storage, Backups)." : undefined);
  }

  /** I-13: no Protected (P1) copy was removed by eviction. Should be impossible; reported loudly if it is not. */
  private i13(add: AddFn): void {
    const { db } = this.o;
    const rows = db.all<{ id: number; public_id: string; why: string }>(
      `SELECT v.id, v.public_id,
              CASE WHEN EXISTS (SELECT 1 FROM storage_audit a WHERE a.version_id = v.id AND a.kind = 'evicted' AND a.priority = 1 AND a.surplus = 0) THEN 'evicted while Protected'
                   ELSE 'evicted with no record' END AS why
       FROM page_versions v WHERE v.status IN ('evicting','evicted')
         AND (EXISTS (SELECT 1 FROM storage_audit a WHERE a.version_id = v.id AND a.kind = 'evicted' AND a.priority = 1 AND a.surplus = 0)
              OR NOT EXISTS (SELECT 1 FROM storage_audit a WHERE a.version_id = v.id))
       ORDER BY v.id`);
    add("I-13", rows.length, rows.map((r) => `${r.public_id}: ${r.why}`), undefined, rows.length ? "This should be impossible. Do not delete anything; report it." : undefined);
  }

  /** Pages nothing references. They count as Opportunistic (P4); the Human can adopt or delete them. */
  private orphans(add: AddFn): void {
    const { db } = this.o;
    const rows = db.all<{ public_id: string }>(
      `SELECT p.public_id FROM pages p WHERE p.availability IN ('archived','partial')
         AND NOT EXISTS (SELECT 1 FROM page_sources ps JOIN sources s ON s.id = ps.source_id WHERE ps.page_id = p.id AND s.deleted_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM collection_memberships m JOIN collections c ON c.id = m.collection_id WHERE m.page_id = p.id AND c.deleted_at IS NULL AND c.priority_floor IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM page_pins x WHERE x.page_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM bookmarks b WHERE b.deleted_at IS NULL AND (b.page_id = p.id OR b.url_key = p.url_key))
       ORDER BY p.id`);
    add("REF", rows.length, rows.map((r) => r.public_id), undefined, rows.length ? "They count as Opportunistic (P4) and are the first to be removed when space runs short. Add them to a source, or delete them." : undefined);
  }
}

type AddFn = (invariant: CheckId, count: number, examples: string[], repaired?: number, note?: string) => void;
const order = (id: CheckId): number => (id === "REF" ? 99 : INVARIANTS.indexOf(id));
