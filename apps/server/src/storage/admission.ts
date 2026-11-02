import type { Db } from "@ncb/db";
import type { Clock } from "@ncb/shared";
import type { EvictionPlan, Priority } from "@ncb/storage-planner";
import type { ActivityLog } from "../services/activity.js";
import type { SettingsService } from "../services/settings.js";
import type { VolumeRow, VolumeService } from "../services/volumes.js";
import type { EvictionExecutor } from "./executor.js";
import type { UsageService } from "./usage.js";

export type DenyCode = "throttled" | "no_eligible_space" | "source_budget" | "volume_unavailable";

/** The admission gate said no. `throttled` and `volume_unavailable` are worth retrying later; the other two are final for this job. */
export class AdmissionDenied extends Error {
  constructor(readonly code: DenyCode, message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "AdmissionDenied";
  }
}

export interface AdmissionTicket {
  downloadJobId: number;
  volumeId: number;
  reservedBytes: number;
  additive: boolean;
}

export interface AdmitRequest {
  downloadJobId: number;
  priority: Priority;
  sourceId?: number | null;
  /** Expected bytes (document and assets). Defaults to an estimate from what the source has saved so far. */
  bytes?: number;
  /** Add to what the job already reserved (a crawl, one page at a time) instead of replacing it. */
  additive?: boolean;
  /** Started by the Human: never throttled. */
  userInitiated?: boolean;
}

export interface AdmissionOptions {
  db: Db;
  clock: Clock;
  volumes: VolumeService;
  usage: UsageService;
  settings: Pick<SettingsService, "internal">;
  activity: ActivityLog;
  executor: EvictionExecutor;
  /** The planner entry point of the storage service: a dry-run plan for `bytesNeeded` on a volume. */
  plan: (a: { bytesNeeded: number; incomingPriority: Priority; volumeId: number }) => EvictionPlan;
  /** Seconds a reservation lives without being renewed. Default 1800. */
  reservationTtlMs?: number;
  throttleRetryMs?: number;
  /** Called with the download job id when it starts or stops waiting because of the throttle (so the downloads API can publish it). */
  onThrottleChange?: (downloadJobId: number) => void;
}

const DEFAULT_BYTES = 1024 * 1024;
const MIN_BYTES = 64 * 1024;

/**
 * Admission control (task T-07). Before a download writes anything it asks for room:
 *
 *  1. a source over its storage budget is refused (`source_budget`);
 *  2. an Opportunistic (P4) background download waits while a volume is above its soft threshold (`throttled`);
 *  3. the room is reserved on a volume (the source's preferred one, else the one with most room) so concurrent downloads cannot
 *     overcommit it;
 *  4. when there is not enough room the planner is asked what can be removed for a download of this priority: if that covers the need
 *     the executor frees it, otherwise the download fails with `no_eligible_space` and nothing is deleted.
 *
 * The hard floor (free space below the volume's reserve) is also guarded where files are written (`VolumeService.pickWritable`) and
 * by the disk guard in the resource governor, which pauses background downloads.
 */
export class AdmissionService {
  private chain: Promise<unknown> = Promise.resolve();
  private lastThrottleLog = -Infinity;
  /** Download jobs whose last admission attempt was throttled, with the monotonic time of that attempt. */
  private readonly throttled = new Map<number, number>();
  private clockMono(): number {
    return this.o.clock.monotonic();
  }

  constructor(private readonly o: AdmissionOptions) {}

  /** True while the job is waiting because P4 is paused above the soft threshold (its last attempt was throttled and is not stale). */
  isThrottled(downloadJobId: number): boolean {
    const at = this.throttled.get(downloadJobId);
    if (at === undefined) return false;
    if (this.clockMono() - at > (this.o.throttleRetryMs ?? 30_000) * 3) {
      this.throttled.delete(downloadJobId);
      return false;
    }
    return true;
  }

  /** How many downloads are waiting because of the throttle now. */
  throttledCount(): number {
    let n = 0;
    for (const id of [...this.throttled.keys()]) if (this.isThrottled(id)) n++;
    return n;
  }

  private setThrottled(id: number, on: boolean): void {
    const was = this.throttled.has(id);
    if (on) this.throttled.set(id, this.clockMono());
    else this.throttled.delete(id);
    if (on !== was) this.o.onThrottleChange?.(id);
  }

  /** Serialised, so two downloads cannot both count the same free bytes. */
  admit(req: AdmitRequest): Promise<AdmissionTicket> {
    const run = this.chain.then(() => this.admitNow(req));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Bytes a capture is expected to need: 1.5 times the median size of this source's recent pages, or the archive's, or 1 MiB. */
  estimateBytes(sourceId?: number | null, capBytes?: number): number {
    const { db } = this.o;
    const median = (where: string, args: number[]): number | null => {
      const xs = db.all<{ b: number }>(`SELECT total_bytes AS b FROM page_versions WHERE total_bytes > 0 ${where} ORDER BY id DESC LIMIT 200`, args).map((r) => r.b).sort((x, y) => x - y);
      return xs.length ? xs[Math.floor(xs.length / 2)]! : null;
    };
    const observed = (sourceId != null ? median("AND source_id = ?", [sourceId]) : null) ?? median("", []);
    const est = Math.max(MIN_BYTES, Math.round((observed ?? DEFAULT_BYTES) * 1.5));
    return capBytes ? Math.min(est, capBytes) : est;
  }

  /**
   * How full a volume is, as a share of the room NoConBrain has there: its own bytes (plus what running downloads have reserved)
   * over the quota, or, without a quota, over its own bytes plus the free space. Other data on the same disk does not count as
   * "full": the hard floor (the free-space reserve) is what guards a disk shared with other things.
   */
  private volumeUse(v: VolumeRow, reservedByOthers: number): { usedPct: number; room: number; capacity: number } {
    const { volumes } = this.o;
    const free = v.statFree ?? 0;
    const used = volumes.usedBytes(v.id);
    const capacity = v.quotaBytes ?? used + free;
    const roomFree = Math.max(0, free - v.reserveFreeBytes);
    const roomQuota = v.quotaBytes !== null ? Math.max(0, v.quotaBytes - used) : Infinity;
    return {
      usedPct: capacity > 0 ? ((used + reservedByOthers) / capacity) * 100 : 0,
      room: Math.max(0, Math.min(roomFree, roomQuota) - reservedByOthers),
      capacity,
    };
  }

  private reservedByOthers(volumeId: number, jobId: number): number {
    return this.o.db.get<{ n: number }>(
      "SELECT COALESCE(SUM(MAX(reserved_bytes - written_bytes, 0)), 0) AS n FROM volume_reservations WHERE volume_id = ? AND expires_at > ? AND download_job_id <> ?",
      [volumeId, this.o.clock.now(), jobId],
    )!.n;
  }

  private async admitNow(req: AdmitRequest): Promise<AdmissionTicket> {
    const { db, clock, volumes, settings } = this.o;
    const policy = settings.internal("storage");
    let bytes = Math.max(1, Math.round(req.bytes ?? this.estimateBytes(req.sourceId)));

    // 1. Source budget.
    let preferred: number | undefined;
    if (req.sourceId != null) {
      const src = db.get<{ storage_budget_bytes: number | null; preferred_volume_id: number | null; name: string }>(
        "SELECT storage_budget_bytes, preferred_volume_id, name FROM sources WHERE id = ?", [req.sourceId]);
      preferred = src?.preferred_volume_id ?? undefined;
      if (src?.storage_budget_bytes != null) {
        const reserved = db.get<{ n: number }>(
          "SELECT COALESCE(SUM(reserved_bytes), 0) AS n FROM volume_reservations WHERE source_id = ? AND expires_at > ? AND download_job_id <> ?", [req.sourceId, clock.now(), req.downloadJobId])!.n;
        const remaining = src.storage_budget_bytes - this.o.usage.sourceBytes(req.sourceId) - reserved;
        if (remaining <= 0) {
          throw new AdmissionDenied("source_budget", `The source "${src.name}" has reached its storage budget of ${src.storage_budget_bytes.toLocaleString("en-GB")} bytes.`);
        }
        bytes = Math.min(bytes, remaining);
      }
    }

    // 2 and 3. Choose a volume: preferred first, then the one with most room.
    const writable: VolumeRow[] = [];
    for (const v of volumes.list()) {
      if (v.state !== "online") continue;
      const fresh = (await volumes.statNow(v)) ? volumes.byId(v.id)! : v;
      writable.push(fresh);
    }
    if (writable.length === 0) {
      throw new AdmissionDenied("volume_unavailable", "No storage volume is available for writing right now. Reconnect the drive or add a volume.", 60_000);
    }
    const ranked = writable
      .map((v) => ({ v, use: this.volumeUse(v, this.reservedByOthers(v.id, req.downloadJobId)) }))
      .sort((a, b) => Number(b.v.id === preferred) - Number(a.v.id === preferred) || b.use.room - a.use.room || Number(b.v.isDefault) - Number(a.v.isDefault) || a.v.id - b.v.id);

    // P4 background work waits while every candidate volume is above its soft threshold.
    if (req.priority === 4 && policy.throttleOpportunistic && !req.userInitiated && ranked.every((r) => r.use.usedPct >= r.v.softThresholdPct)) {
      // Said once in a while, so a quiet crawl has a reason on record.
      if (this.clockMono() - this.lastThrottleLog >= 600_000) {
        this.lastThrottleLog = this.clockMono();
        this.o.activity.write({ level: "info", area: "storage", message: "Opportunistic downloads are waiting because the storage volume is above its soft threshold. They continue when space is freed or the threshold is raised.", downloadJobId: req.downloadJobId });
      }
      this.setThrottled(req.downloadJobId, true);
      throw new AdmissionDenied("throttled", "Opportunistic downloads are slowed because the storage volume is nearly full.", this.o.throttleRetryMs ?? 30_000);
    }

    this.setThrottled(req.downloadJobId, false);
    let lastReason = "";
    for (const { v, use } of ranked) {
      let room = use.room;
      if (room < bytes) {
        const plan = this.o.plan({ bytesNeeded: bytes - room, incomingPriority: req.priority, volumeId: v.id });
        if (!plan.sufficient) {
          lastReason = `On "${v.name}" nothing that may be removed for a P${req.priority} download would free enough (${plan.reclaimableBytes.toLocaleString("en-GB")} of ${(bytes - room).toLocaleString("en-GB")} bytes needed).`;
          continue;
        }
        await this.o.executor.execute(plan, { trigger: "admission", volumeId: v.id });
        const refreshed = (await volumes.statNow(v)) ? volumes.byId(v.id)! : v;
        room = this.volumeUse(refreshed, this.reservedByOthers(v.id, req.downloadJobId)).room;
        if (room < bytes) {
          lastReason = `On "${v.name}" the space freed was not enough.`;
          continue;
        }
      }
      return this.reserve(req, v, bytes);
    }
    this.o.activity.write({
      level: "warn", area: "storage", downloadJobId: req.downloadJobId,
      message: `Not enough space for a P${req.priority} download and nothing eligible can be removed. ${lastReason}`,
      details: { priority: req.priority, bytes, sourceId: req.sourceId ?? null },
    });
    throw new AdmissionDenied(
      "no_eligible_space",
      "There is not enough free space for this download, and nothing that can be removed automatically would make enough room. Free some space or add a storage volume.",
    );
  }

  private reserve(req: AdmitRequest, v: VolumeRow, bytes: number): AdmissionTicket {
    const { db, clock } = this.o;
    const now = clock.now();
    const expires = now + (this.o.reservationTtlMs ?? 1_800_000);
    db.run(
      `INSERT INTO volume_reservations (volume_id, download_job_id, reserved_bytes, written_bytes, created_at, expires_at, priority, source_id)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)
       ON CONFLICT (volume_id, download_job_id) DO UPDATE SET
         reserved_bytes = ${req.additive ? "reserved_bytes + excluded.reserved_bytes" : "excluded.reserved_bytes"}, expires_at = excluded.expires_at,
         priority = excluded.priority, source_id = excluded.source_id`,
      [v.id, req.downloadJobId, bytes, now, expires, req.priority, req.sourceId ?? null],
    );
    return { downloadJobId: req.downloadJobId, volumeId: v.id, reservedBytes: bytes, additive: req.additive === true };
  }

  /** Gives a reservation back: the bytes now exist on disk (counted as usage) or the download ended. */
  release(t: AdmissionTicket): void {
    const { db } = this.o;
    if (t.additive) {
      db.run("UPDATE volume_reservations SET reserved_bytes = reserved_bytes - ? WHERE volume_id = ? AND download_job_id = ?", [t.reservedBytes, t.volumeId, t.downloadJobId]);
      db.run("DELETE FROM volume_reservations WHERE volume_id = ? AND download_job_id = ? AND reserved_bytes <= 0", [t.volumeId, t.downloadJobId]);
    } else db.run("DELETE FROM volume_reservations WHERE volume_id = ? AND download_job_id = ?", [t.volumeId, t.downloadJobId]);
  }

  /** At startup: nothing that held a reservation survives a restart, and running downloads reserve again when they resume. */
  releaseAll(): number {
    return this.o.db.run("DELETE FROM volume_reservations").changes;
  }

  releaseJob(downloadJobId: number): void {
    this.setThrottled(downloadJobId, false);
    this.o.db.run("DELETE FROM volume_reservations WHERE download_job_id = ?", [downloadJobId]);
  }

  /** Drops reservations that expired or belong to a download that is over (invariant I-8). Returns how many. */
  sweep(): number {
    return this.o.db.run(
      `DELETE FROM volume_reservations WHERE expires_at <= ? OR download_job_id IN (SELECT id FROM download_jobs WHERE state IN ('completed','failed','cancelled'))`,
      [this.o.clock.now()],
    ).changes;
  }
}
