import type { Db } from "@ncb/db";
import type { JobQueue } from "@ncb/db";
import { ClockJumpDetector, ScheduleGate, steadyClock, type Clock } from "@ncb/shared";
import type { ActivityLog } from "../services/activity.js";
import type { EventBus } from "../services/events.js";
import type { ScheduleRow, ScheduleService } from "./service.js";
import { combineStatus, groupStatus, type WindowSpec, type WindowStatus } from "./windows.js";

/** A wall clock earlier than this is a Pi that booted offline with the wrong date; nothing is scheduled until it is corrected. */
export const MIN_PLAUSIBLE_TIME = Date.UTC(2020, 0, 1);

export interface SchedulerOptions {
  db: Db;
  /** Wall clock. Slots are calendar times, so they are compared with this. */
  clock: Clock;
  service: ScheduleService;
  queue: Pick<JobQueue, "holdByDownloadJob" | "resumeByDownloadJob">;
  activity: ActivityLog;
  events: EventBus;
  /** Starts a run of the source. Called at most once per slot. */
  run(sourceRowId: number, ctx: { slot: number; scheduleId: string }): void | Promise<void>;
  /** Minimum time between ticks, measured on the monotonic clock. Default 15 s. */
  tickMs?: number;
  /** A skipped-policy schedule still runs when it is at most this late. Default 10 minutes. */
  graceMs?: number;
  detector?: ClockJumpDetector;
}

export interface TickResult {
  ran: string[];
  skipped: string[];
  waiting: string[];
  paused: number;
  resumed: number;
  /** Why the tick did nothing, when it did not run. */
  idle?: "throttled" | "clock_jump" | "clock_implausible";
}

/**
 * The scheduler tick (task C-09). Called by the job runner's loop; it throttles itself. Each tick:
 *  1. ignores itself while the wall clock is implausible or just jumped (ClockJumpDetector), so a jump cannot start a burst of runs;
 *  2. enforces download windows on download jobs: pauses jobs when a window closes, resumes the ones it paused when one opens;
 *  3. for every enabled schedule finds the latest slot at or before now and claims it through a `ScheduleGate`. A slot runs once,
 *     overdue slots collapse into the latest (or are dropped, under the `skip` policy), and a backwards jump cannot replay a slot.
 *     The claim is saved before the run starts, so a crash cannot run a slot twice.
 * Tick pacing uses `steadyClock` (monotonic); slots use the wall clock.
 */
export class Scheduler {
  private readonly steady: Clock;
  private readonly gate = new ScheduleGate();
  private readonly seeded = new Set<number>();
  private readonly detector: ClockJumpDetector;
  private readonly tickMs: number;
  private readonly graceMs: number;
  private lastTickMono = -Infinity;
  private waitingLogged = new Set<number>();

  constructor(private readonly o: SchedulerOptions) {
    this.steady = steadyClock(o.clock);
    this.tickMs = o.tickMs ?? 15_000;
    this.graceMs = o.graceMs ?? 10 * 60_000;
    this.detector = o.detector ?? new ClockJumpDetector({
      clock: o.clock,
      onJump: (j) => {
        o.activity.write({ level: "warn", area: "system", message: `The system clock moved ${j.direction === "forward" ? "forward" : "back"} by ${Math.round(Math.abs(j.deltaMs) / 1000)} seconds. Scheduled runs are paused for a minute while this settles.`, details: j });
        this.seeded.clear(); // re-read the claimed slots from the database after the grace period
      },
    });
  }

  get jumpDetector(): ClockJumpDetector {
    return this.detector;
  }

  // ---- windows -------------------------------------------------------------------------------

  private groupsFor(sourceRowId: number | null, scheduleWindow?: WindowSpec[]): WindowSpec[][] {
    const groups: WindowSpec[][] = [this.o.service.globalWindowSpecs()];
    const own = scheduleWindow ?? (sourceRowId === null ? [] : this.o.service.sourceWindowSpecs(sourceRowId));
    if (own.length) groups.push(own);
    return groups;
  }

  private status(groups: WindowSpec[][], now: number): WindowStatus {
    return combineStatus(groups.map((g) => groupStatus(g, now)));
  }

  /**
   * Whether work for a source may run now. User-initiated work (`requestedBy: "user"`) is never held by a window. The crawl
   * engine calls this before it starts a fetch for a scheduled or background job.
   */
  isOpen(sourceRowId: number | null, requestedBy: string, now = this.o.clock.now()): WindowStatus {
    if (requestedBy === "user") return { open: true };
    return this.status(this.groupsFor(sourceRowId), now);
  }

  private enforceWindows(now: number): { paused: number; resumed: number } {
    const { db, queue, activity, events } = this.o;
    let paused = 0;
    let resumed = 0;
    const cache = new Map<number | null, WindowStatus>();
    const statusFor = (src: number | null): WindowStatus => {
      if (!cache.has(src)) cache.set(src, this.isOpen(src, "schedule", now));
      return cache.get(src)!;
    };
    const live = db.all<{ id: number; source_id: number | null; state: string; paused_by_window: number }>(
      `SELECT id, source_id, state, paused_by_window FROM download_jobs
       WHERE requested_by <> 'user' AND (state IN ('running','queued') OR (state = 'paused' AND paused_by_window = 1))`,
    );
    for (const j of live) {
      const st = statusFor(j.source_id);
      if (!st.open && (j.state === "running" || j.state === "queued")) {
        db.transaction(() => {
          db.run("UPDATE download_jobs SET state = 'paused', paused_by_window = 1 WHERE id = ? AND state IN ('running','queued')", [j.id]);
          queue.holdByDownloadJob(j.id);
        });
        paused++;
        events.publish("download", { downloadJobId: j.id, state: "paused", reason: "window_closed" });
      } else if (st.open && j.state === "paused" && j.paused_by_window === 1) {
        db.transaction(() => {
          db.run("UPDATE download_jobs SET state = 'queued', paused_by_window = 0 WHERE id = ? AND state = 'paused'", [j.id]);
          queue.resumeByDownloadJob(j.id);
        });
        resumed++;
        events.publish("download", { downloadJobId: j.id, state: "queued", reason: "window_opened" });
      }
    }
    if (paused) activity.write({ level: "info", area: "crawl", message: `Paused ${paused} download${paused === 1 ? "" : "s"} because the download window closed. They resume when it opens.` });
    if (resumed) activity.write({ level: "info", area: "crawl", message: `Resumed ${resumed} download${resumed === 1 ? "" : "s"} because the download window opened.` });
    return { paused, resumed };
  }

  // ---- schedules -----------------------------------------------------------------------------

  private seed(row: ScheduleRow): void {
    if (this.seeded.has(row.id)) return;
    this.seeded.add(row.id);
    // The database is the record of claimed slots; the in-memory gate only has to agree with it.
    if (row.last_slot_at !== null && (this.gate.lastRun(`sch:${row.id}`) ?? -Infinity) < row.last_slot_at) {
      this.claimInMemory(row.id, row.last_slot_at);
    }
  }

  private claimInMemory(id: number, slot: number): void {
    // ScheduleGate has no setter; claiming the slot with `now = slot` records it.
    this.gate.claim(`sch:${id}`, [slot], slot);
  }

  tick(force = false): TickResult {
    const result: TickResult = { ran: [], skipped: [], waiting: [], paused: 0, resumed: 0 };
    const mono = this.steady.monotonic();
    if (!force && mono - this.lastTickMono < this.tickMs) return { ...result, idle: "throttled" };
    this.lastTickMono = mono;

    const now = this.o.clock.now();
    this.detector.check();
    if (now < MIN_PLAUSIBLE_TIME) return { ...result, idle: "clock_implausible" };
    if (this.detector.inGrace()) {
      this.o.service.recomputeAll(now);
      return { ...result, idle: "clock_jump" };
    }

    const w = this.enforceWindows(now);
    result.paused = w.paused;
    result.resumed = w.resumed;

    for (const row of this.o.service.enabledRows()) {
      this.seed(row);
      if (row.source_id !== null) {
        const s = this.o.db.get<{ enabled: number; deleted_at: number | null; paused_at: number | null }>("SELECT enabled, deleted_at, paused_at FROM sources WHERE id = ?", [row.source_id]);
        if (!s || s.deleted_at !== null || s.enabled === 0 || s.paused_at !== null) continue;
      }
      const slot = this.o.service.latestSlot(row, now);
      if (slot === null) continue;
      const key = `sch:${row.id}`;
      if (slot <= (this.gate.lastRun(key) ?? -Infinity)) continue; // already handled, or the clock went back

      const status = this.status(this.groupsFor(row.source_id, this.o.service.scheduleWindowSpecs(row)), now);
      if (!status.open) {
        result.waiting.push(row.public_id);
        if (!this.waitingLogged.has(row.id)) {
          this.waitingLogged.add(row.id);
          this.o.activity.write({ level: "info", area: "crawl", message: "A scheduled run is waiting for the download window to open.", details: { schedule: row.public_id, opensAt: status.opensAt ? new Date(status.opensAt).toISOString() : null } });
        }
        continue;
      }
      this.waitingLogged.delete(row.id);

      const claimed = this.gate.claim(key, [slot], now);
      if (claimed === null) continue;
      // Skip policy: only run if the slot is recent. Waiting for a window counts from when the window opened.
      const lateness = now - Math.max(claimed, status.since ?? claimed);
      const late = row.missed_run_policy === "skip" && lateness > this.graceMs;
      this.o.db.transaction(() => this.o.service.markRan(row, claimed, !late, now), { durable: true });
      if (late) {
        result.skipped.push(row.public_id);
        this.o.activity.write({ level: "info", area: "crawl", message: "A scheduled run was missed and skipped, as its schedule says.", details: { schedule: row.public_id, slot: new Date(claimed).toISOString() } });
        continue;
      }
      result.ran.push(row.public_id);
      this.o.events.publish("schedule", { scheduleId: row.public_id, slot: new Date(claimed).toISOString() });
      if (row.source_id !== null) {
        try {
          const p = this.o.run(row.source_id, { slot: claimed, scheduleId: row.public_id });
          if (p) void Promise.resolve(p).catch((e) => this.fail(row, e));
        } catch (e) {
          this.fail(row, e);
        }
      }
    }
    return result;
  }

  private fail(row: ScheduleRow, e: unknown): void {
    this.o.activity.write({ level: "error", area: "crawl", message: `A scheduled run could not start: ${e instanceof Error ? e.message : String(e)}`, details: { schedule: row.public_id } });
  }
}
