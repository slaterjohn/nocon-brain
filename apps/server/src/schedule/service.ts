import { z } from "zod";
import type { Db } from "@ncb/db";
import { AppError, newId, type Clock } from "@ncb/shared";
import { parseOrThrow } from "../lib/zod.js";
import { cronFor, latestSlotAtOrBefore, nextSlot, ScheduleError, validateCron, type ScheduleSpec } from "./cron.js";
import { isValidTimezone } from "./time.js";
import { ALL_DAYS, DAY_NAMES, daysToMask, groupStatus, maskToDays, type WindowSpec, type WindowStatus } from "./windows.js";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, "Use a 24-hour time such as 22:00");
const toMinute = (s: string): number => {
  const [h, m] = s.split(":").map(Number);
  return h! * 60 + m!;
};
const fromMinute = (n: number): string => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

export const windowInputSchema = z
  .object({
    name: z.string().trim().max(80).default(""),
    days: z.array(z.enum(DAY_NAMES)).min(1, "Choose at least one day").default([...DAY_NAMES]),
    start: hhmm.refine((s) => s !== "24:00", "Use a start time before 24:00"),
    end: hhmm,
    timezone: z.string().trim().min(1).max(64).default("UTC"),
    limits: z.object({ concurrency: z.number().int().min(1).max(64).optional(), bandwidthKbps: z.number().int().min(0).max(10_000_000).optional() }).optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.start === v.end) ctx.addIssue({ code: "custom", path: ["end"], message: "The end must differ from the start (use an end earlier than the start to run past midnight)" });
    if (!isValidTimezone(v.timezone)) ctx.addIssue({ code: "custom", path: ["timezone"], message: `"${v.timezone}" is not a time zone name such as Europe/London` });
  });
export type WindowInput = z.infer<typeof windowInputSchema>;

export const scheduleBodySchema = z.object({
  sourceId: z.string().max(64).nullable().optional(),
  kind: z.enum(["manual", "hourly", "daily", "weekly", "cron"]),
  minute: z.number().int().min(0).max(59).optional(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time such as 03:30").optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  cron: z.string().trim().max(120).optional(),
  timezone: z.string().trim().min(1).max(64).default("UTC"),
  windowId: z.string().max(64).nullable().optional(),
  window: windowInputSchema.optional(),
  missedRunPolicy: z.enum(["skip", "run_once"]).default("run_once"),
  enabled: z.boolean().default(true),
});
export const scheduleSourceBodySchema = scheduleBodySchema.omit({ sourceId: true });
export const schedulePatchSchema = scheduleBodySchema.omit({ sourceId: true }).partial().extend({ kind: z.enum(["manual", "hourly", "daily", "weekly", "cron"]).optional() });

export interface WindowOut {
  id: string;
  sourceId: string | null;
  name: string;
  days: (typeof DAY_NAMES)[number][];
  start: string;
  end: string;
  timezone: string;
  limits: { concurrency?: number; bandwidthKbps?: number } | null;
  enabled: boolean;
}

export interface ScheduleOut {
  id: string;
  sourceId: string | null;
  kind: "manual" | "hourly" | "daily" | "weekly" | "cron";
  minute?: number;
  time?: string;
  dayOfWeek?: number;
  cron?: string;
  /** The cron expression every kind but manual reduces to. */
  expression: string | null;
  timezone: string;
  windowId: string | null;
  window: WindowOut | null;
  missedRunPolicy: "skip" | "run_once";
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

interface ScheduleRow {
  id: number; public_id: string; source_id: number | null; kind: string; cron_expr: string | null; spec_json: string; timezone: string;
  window_id: number | null; missed_run_policy: string; next_run_at: number | null; last_run_at: number | null; last_slot_at: number | null;
  enabled: number; created_at: number; updated_at: number;
}
interface WindowRow {
  id: number; public_id: string; source_id: number | null; name: string; days_mask: number; start_minute: number; end_minute: number;
  timezone: string; limits_json: string | null; enabled: number;
}

const iso = (n: number | null): string | null => (n == null ? null : new Date(n).toISOString());

export class ScheduleService {
  constructor(private readonly o: { db: Db; clock: Clock }) {}

  private get db(): Db {
    return this.o.db;
  }

  // ---- windows -------------------------------------------------------------------------------

  private windowOut(r: WindowRow): WindowOut {
    const sourceId = r.source_id == null ? null : (this.db.get<{ public_id: string }>("SELECT public_id FROM sources WHERE id = ?", [r.source_id])?.public_id ?? null);
    return {
      id: r.public_id, sourceId, name: r.name, days: maskToDays(r.days_mask), start: fromMinute(r.start_minute), end: r.end_minute === 1440 ? "24:00" : fromMinute(r.end_minute),
      timezone: r.timezone, limits: r.limits_json ? (JSON.parse(r.limits_json) as WindowOut["limits"]) : null, enabled: r.enabled === 1,
    };
  }

  private insertWindow(w: WindowInput, sourceRowId: number | null): number {
    const res = this.db.run(
      `INSERT INTO download_windows (public_id, source_id, name, days_mask, start_minute, end_minute, timezone, limits_json, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId("win"), sourceRowId, w.name, daysToMask(w.days), toMinute(w.start), w.end === "24:00" ? 1440 : toMinute(w.end), w.timezone,
        w.limits ? JSON.stringify(w.limits) : null, w.enabled ? 1 : 0, this.o.clock.now()],
    );
    return Number(res.lastInsertRowid);
  }

  listGlobalWindows(): WindowOut[] {
    return this.db.all<WindowRow>("SELECT * FROM download_windows WHERE source_id IS NULL ORDER BY id").map((r) => this.windowOut(r));
  }

  /** Replaces the global windows. An empty list means downloads may run at any time. */
  replaceGlobalWindows(input: unknown): WindowOut[] {
    const list = parseOrThrow(z.object({ windows: z.array(windowInputSchema).max(14) }), input).windows;
    this.db.transaction(() => {
      // Schedules that pointed at an old global window lose the link (ON DELETE SET NULL) and fall back to the new set.
      this.db.run("DELETE FROM download_windows WHERE source_id IS NULL");
      for (const w of list) this.insertWindow(w, null);
    }, { durable: true });
    return this.listGlobalWindows();
  }

  windowSpecs(rows: WindowRow[]): WindowSpec[] {
    return rows.map((r) => ({ daysMask: r.days_mask, startMinute: r.start_minute, endMinute: r.end_minute, timezone: r.timezone, enabled: r.enabled === 1 }));
  }

  globalWindowSpecs(): WindowSpec[] {
    return this.windowSpecs(this.db.all<WindowRow>("SELECT * FROM download_windows WHERE source_id IS NULL AND enabled = 1"));
  }

  /** Windows that govern one source's work: the window of its schedules (if any), else its own windows. */
  sourceWindowSpecs(sourceRowId: number): WindowSpec[] {
    const own = this.db.all<WindowRow>("SELECT * FROM download_windows WHERE source_id = ? AND enabled = 1", [sourceRowId]);
    return this.windowSpecs(own);
  }

  scheduleWindowSpecs(s: ScheduleRow): WindowSpec[] {
    if (s.window_id !== null) {
      const w = this.db.get<WindowRow>("SELECT * FROM download_windows WHERE id = ? AND enabled = 1", [s.window_id]);
      return w ? this.windowSpecs([w]) : [];
    }
    return s.source_id === null ? [] : this.sourceWindowSpecs(s.source_id);
  }

  /** Status of the global windows, for the queue summary. */
  globalStatus(now = this.o.clock.now()): WindowStatus {
    return groupStatus(this.globalWindowSpecs(), now);
  }

  // ---- schedules -----------------------------------------------------------------------------

  private specOf(r: ScheduleRow): ScheduleSpec {
    return { kind: r.kind as ScheduleSpec["kind"], ...(JSON.parse(r.spec_json) as Partial<ScheduleSpec>) };
  }

  private out(r: ScheduleRow): ScheduleOut {
    const spec = this.specOf(r);
    const sourceId = r.source_id == null ? null : (this.db.get<{ public_id: string }>("SELECT public_id FROM sources WHERE id = ?", [r.source_id])?.public_id ?? null);
    const w = r.window_id == null ? null : this.db.get<WindowRow>("SELECT * FROM download_windows WHERE id = ?", [r.window_id]);
    return {
      id: r.public_id, sourceId, kind: spec.kind, minute: spec.minute, time: spec.time, dayOfWeek: spec.dayOfWeek, cron: spec.cron,
      expression: r.cron_expr, timezone: r.timezone, windowId: w?.public_id ?? null, window: w ? this.windowOut(w) : null,
      missedRunPolicy: r.missed_run_policy as "skip" | "run_once", enabled: r.enabled === 1, nextRunAt: iso(r.next_run_at), lastRunAt: iso(r.last_run_at),
    };
  }

  rowByPublic(id: string): ScheduleRow {
    const r = this.db.get<ScheduleRow>("SELECT * FROM schedules WHERE public_id = ?", [id]);
    if (!r) throw new AppError("not_found", "That schedule does not exist.");
    return r;
  }

  get(id: string): ScheduleOut {
    return this.out(this.rowByPublic(id));
  }

  list(filter: { sourceId?: number | null } = {}): ScheduleOut[] {
    const rows = filter.sourceId === undefined
      ? this.db.all<ScheduleRow>("SELECT * FROM schedules ORDER BY id")
      : this.db.all<ScheduleRow>("SELECT * FROM schedules WHERE source_id IS ? ORDER BY id", [filter.sourceId]);
    return rows.map((r) => this.out(r));
  }

  /** Due-candidate rows for the scheduler. */
  enabledRows(): ScheduleRow[] {
    return this.db.all<ScheduleRow>("SELECT * FROM schedules WHERE enabled = 1 AND kind <> 'manual' AND cron_expr IS NOT NULL ORDER BY id");
  }

  private resolveWindow(input: { windowId?: string | null; window?: WindowInput }, sourceRowId: number | null): number | null | undefined {
    if (input.window) return this.insertWindow(input.window, sourceRowId);
    if (input.windowId === undefined) return undefined;
    if (input.windowId === null) return null;
    const w = this.db.get<{ id: number }>("SELECT id FROM download_windows WHERE public_id = ?", [input.windowId]);
    if (!w) throw new AppError("bad_request", "That download window does not exist.", { fields: [{ in: "body", path: "windowId", message: "Choose a window that exists" }] });
    return w.id;
  }

  private prepare(spec: ScheduleSpec, tz: string): { expr: string | null; next: number | null } {
    try {
      const expr = cronFor(spec);
      if (!expr) return { expr: null, next: null };
      validateCron(expr, tz);
      return { expr, next: nextSlot(expr, tz, this.o.clock.now()) };
    } catch (e) {
      if (e instanceof ScheduleError) {
        throw new AppError("bad_request", e.message, { fields: [{ in: "body", path: e.field, message: e.message }] });
      }
      throw e;
    }
  }

  create(sourceRowId: number | null, body: unknown): ScheduleOut {
    const v = parseOrThrow(scheduleSourceBodySchema, body);
    const spec: ScheduleSpec = { kind: v.kind, minute: v.minute, time: v.time, dayOfWeek: v.dayOfWeek, cron: v.cron };
    const { expr, next } = this.prepare(spec, v.timezone);
    const now = this.o.clock.now();
    const id = this.db.transaction(() => {
      const windowId = this.resolveWindow(v, sourceRowId) ?? null;
      const specJson = JSON.stringify({ minute: v.minute, time: v.time, dayOfWeek: v.dayOfWeek, cron: v.cron });
      // last_slot_at = now: slots up to the moment of creation count as already handled, so a new daily 03:00 schedule
      // made at 10:00 does not run at once for the 03:00 it just missed.
      const res = this.db.run(
        `INSERT INTO schedules (public_id, source_id, kind, cron_expr, spec_json, timezone, window_id, missed_run_policy, next_run_at, last_slot_at, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId("sch"), sourceRowId, v.kind, expr, specJson, v.timezone, windowId, v.missedRunPolicy, next, now, v.enabled ? 1 : 0, now, now],
      );
      return Number(res.lastInsertRowid);
    }, { durable: true });
    this.syncSourceNextRun(sourceRowId);
    return this.out(this.db.get<ScheduleRow>("SELECT * FROM schedules WHERE id = ?", [id])!);
  }

  update(publicId: string, body: unknown): ScheduleOut {
    const cur = this.rowByPublic(publicId);
    const v = parseOrThrow(schedulePatchSchema, body);
    const curSpec = this.specOf(cur);
    const spec: ScheduleSpec = {
      kind: v.kind ?? curSpec.kind,
      minute: v.minute ?? curSpec.minute, time: v.time ?? curSpec.time, dayOfWeek: v.dayOfWeek ?? curSpec.dayOfWeek, cron: v.cron ?? curSpec.cron,
    };
    const tz = v.timezone ?? cur.timezone;
    const { expr, next } = this.prepare(spec, tz);
    const now = this.o.clock.now();
    this.db.transaction(() => {
      const windowId = this.resolveWindow(v, cur.source_id);
      const timingChanged = expr !== cur.cron_expr || tz !== cur.timezone;
      this.db.run(
        `UPDATE schedules SET kind = ?, cron_expr = ?, spec_json = ?, timezone = ?, window_id = ?, missed_run_policy = ?, enabled = ?, next_run_at = ?,
           last_slot_at = ?, updated_at = ? WHERE id = ?`,
        [spec.kind, expr, JSON.stringify({ minute: spec.minute, time: spec.time, dayOfWeek: spec.dayOfWeek, cron: spec.cron }), tz,
          windowId === undefined ? cur.window_id : windowId, v.missedRunPolicy ?? cur.missed_run_policy, (v.enabled ?? cur.enabled === 1) ? 1 : 0, next,
          timingChanged ? now : cur.last_slot_at, now, cur.id],
      );
    }, { durable: true });
    this.syncSourceNextRun(cur.source_id);
    return this.get(publicId);
  }

  remove(publicId: string): void {
    const cur = this.rowByPublic(publicId);
    this.db.transaction(() => {
      this.db.run("DELETE FROM schedules WHERE id = ?", [cur.id]);
      // A window made for this schedule alone (source-scoped, no other schedule uses it) goes with it.
      if (cur.window_id !== null) {
        this.db.run(
          `DELETE FROM download_windows WHERE id = ? AND source_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM schedules WHERE window_id = download_windows.id)`,
          [cur.window_id],
        );
      }
    }, { durable: true });
    this.syncSourceNextRun(cur.source_id);
  }

  /** The earliest next run among a source's enabled schedules, kept on `sources.next_run_at` for lists. */
  syncSourceNextRun(sourceRowId: number | null): void {
    if (sourceRowId === null) return;
    const n = this.db.get<{ n: number | null }>("SELECT MIN(next_run_at) AS n FROM schedules WHERE source_id = ? AND enabled = 1", [sourceRowId])?.n ?? null;
    this.db.run("UPDATE sources SET next_run_at = ? WHERE id = ?", [n, sourceRowId]);
  }

  /** After a slot is handled: advances `next_run_at` from `now`. */
  markRan(row: ScheduleRow, slot: number, ran: boolean, now: number): void {
    const next = row.cron_expr ? nextSlot(row.cron_expr, row.timezone, now) : null;
    this.db.run("UPDATE schedules SET last_slot_at = ?, last_run_at = CASE WHEN ? THEN ? ELSE last_run_at END, next_run_at = ?, updated_at = ? WHERE id = ?", [
      slot, ran ? 1 : 0, now, next, now, row.id,
    ]);
    this.syncSourceNextRun(row.source_id);
  }

  /** Recomputes `next_run_at` for every schedule from the current time (after a clock jump or at start-up). */
  recomputeAll(now: number): void {
    for (const r of this.db.all<ScheduleRow>("SELECT * FROM schedules WHERE cron_expr IS NOT NULL")) {
      const next = nextSlot(r.cron_expr!, r.timezone, now);
      if (next !== r.next_run_at) this.db.run("UPDATE schedules SET next_run_at = ? WHERE id = ?", [next, r.id]);
    }
    this.db.run("UPDATE sources SET next_run_at = (SELECT MIN(next_run_at) FROM schedules s WHERE s.source_id = sources.id AND s.enabled = 1)");
  }

  latestSlot(row: ScheduleRow, now: number): number | null {
    return row.cron_expr ? latestSlotAtOrBefore(row.cron_expr, row.timezone, now) : null;
  }
}

export type { ScheduleRow, WindowRow };
export { ALL_DAYS };
