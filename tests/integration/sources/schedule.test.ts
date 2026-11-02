import { describe, expect, it } from "vitest";
import { Scheduler } from "../../../apps/server/src/schedule/scheduler.js";
import { startSourcesServer, useFixtures, type SourcesTest } from "./helpers.js";

const fixtures = useFixtures();
const art = () => fixtures().urls.article;

const HOUR = 3_600_000;
const iso = (n: number) => new Date(n).toISOString();

/** A server whose own scheduler loop never fires by itself: tests call `tick(true)` so every step is deterministic. */
async function server() {
  const t = await startSourcesServer({ server: { scheduler: { tickMs: 1e15 } } });
  const runs: { scheduleId: string; slot: string }[] = [];
  t.svc.events.subscribe((e) => { if (e.type === "schedule") runs.push(e.data as { scheduleId: string; slot: string }); });
  return Object.assign(t, { runs });
}
type T = Awaited<ReturnType<typeof server>>;

const source = async (t: SourcesTest, extra: Record<string, unknown> = {}) =>
  (await t.api("POST", "/api/sources", { name: "Moon", type: "single_page", startUrl: `${art()}/moon`, ...extra })).body;
const schedule = async (t: SourcesTest, sourceId: string, body: Record<string, unknown>) => {
  const r = await t.api("POST", "/api/schedules", { sourceId, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const tick = (t: T) => t.svc.scheduler.tick(true);
/** Moves the fake wall and monotonic clocks together, then ticks. */
const advance = (t: T, ms: number) => { t.fake.advance(ms); return tick(t); };
/** Leaves the clock-jump grace period (60 s of monotonic time) behind. */
const settleAfterJump = (t: T) => advance(t, 61_000);
const nextHour = (n: number) => Math.floor(n / HOUR) * HOUR + HOUR;

describe("C-09 scheduler tick with a fake clock", () => {
  it("runs an hourly schedule once per slot, not at creation and not twice", async () => {
    const t = await server();
    const s = await source(t);
    const sch = await schedule(t, s.id, { kind: "hourly", minute: 0 });
    expect(sch).toMatchObject({ kind: "hourly", expression: "0 * * * *", timezone: "UTC", missedRunPolicy: "run_once", enabled: true });
    expect(sch.nextRunAt).toBe(iso(nextHour(t.fake.now())));
    expect((await t.api("GET", `/api/sources/${s.id}`)).body.nextRunAt).toBe(sch.nextRunAt);

    expect(tick(t).ran).toEqual([]); // the slot that passed before the schedule existed is not run
    const toSlot = nextHour(t.fake.now()) - t.fake.now();
    expect(advance(t, toSlot - 1000).ran).toEqual([]);
    expect(advance(t, 2000).ran).toEqual([sch.id]);
    expect(t.runs).toHaveLength(1);
    expect(tick(t).ran).toEqual([]);
    expect(advance(t, 10 * 60_000).ran).toEqual([]);
    expect(t.runs).toHaveLength(1);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM download_jobs WHERE requested_by = 'schedule'")!.n).toBe(1);

    const after = (await t.api("GET", `/api/schedules/${sch.id}`)).body;
    expect(after.lastRunAt).toBe(iso(t.fake.now() - 10 * 60_000));
    expect(Date.parse(after.nextRunAt)).toBe(nextHour(t.fake.now()));
    await t.settled(s.id);
  });

  it("collapses slots that were missed while nothing ran (run_once) into a single run", async () => {
    const t = await server();
    const s = await source(t);
    await schedule(t, s.id, { kind: "hourly" });
    expect(advance(t, 5 * HOUR + 60_000).ran).toHaveLength(1); // five slots passed
    expect(t.runs).toHaveLength(1);
    expect(tick(t).ran).toEqual([]);
  });

  it("the skip policy drops a missed slot instead of running it late, then carries on", async () => {
    const t = await server();
    const s = await source(t);
    const sch = await schedule(t, s.id, { kind: "hourly", missedRunPolicy: "skip" });
    const r = advance(t, 5 * HOUR + 60_000);
    expect(r.ran).toEqual([]);
    expect(r.skipped).toEqual([sch.id]);
    expect(t.runs).toHaveLength(0);
    // Still on time for the next slot.
    expect(advance(t, nextHour(t.fake.now()) - t.fake.now() + 30_000).ran).toEqual([sch.id]);
    // The skipped slot counts as handled: the schedule's next run moved on.
    expect(Date.parse((await t.api("GET", `/api/schedules/${sch.id}`)).body.nextRunAt)).toBeGreaterThan(t.fake.now());
  });

  it("does nothing for manual, disabled, paused, switched-off and deleted sources", async () => {
    const t = await server();
    const manualSource = await source(t, { name: "M" });
    await schedule(t, manualSource.id, { kind: "manual" });
    const off = await source(t, { name: "Off", enabled: false });
    await schedule(t, off.id, { kind: "hourly" });
    const paused = await source(t, { name: "Paused" });
    await schedule(t, paused.id, { kind: "hourly" });
    await t.api("POST", `/api/sources/${paused.id}/pause`);
    const disabledSchedule = await source(t, { name: "DS" });
    const ds = await schedule(t, disabledSchedule.id, { kind: "hourly", enabled: false });
    const gone = await source(t, { name: "Gone" });
    await schedule(t, gone.id, { kind: "hourly" });
    await t.api("DELETE", `/api/sources/${gone.id}`);
    expect((await t.api("GET", `/api/schedules/${ds.id}`)).body.enabled).toBe(false);
    expect(advance(t, 3 * HOUR).ran).toEqual([]);
    expect(t.runs).toEqual([]);
    // Resuming picks the schedule up again from the next slot.
    await t.api("POST", `/api/sources/${paused.id}/resume`);
    expect(advance(t, HOUR).ran).toHaveLength(1);
  });

  it("runs daily and weekly schedules in their own time zone", async () => {
    const t = await server();
    const s = await source(t);
    const d = await schedule(t, s.id, { kind: "daily", time: "03:30", timezone: "Asia/Kolkata" });
    expect(d.expression).toBe("30 3 * * *");
    // 03:30 in Kolkata is 22:00 UTC the day before. The fake clock starts at 22:13 UTC on 14 Nov 2023, so the next slot is 15 Nov 22:00 UTC.
    expect(d.nextRunAt).toBe("2023-11-15T22:00:00.000Z");
    const w = await schedule(t, s.id, { kind: "weekly", time: "09:00", dayOfWeek: 1, timezone: "Europe/London" });
    expect(w.expression).toBe("0 9 * * 1");
    expect(w.nextRunAt).toBe("2023-11-20T09:00:00.000Z");
    expect(advance(t, 24 * HOUR).ran).toEqual([d.id]);
  });
});

describe("C-09 wall-clock jumps", () => {
  it("a jump forward does not start a burst: schedules wait out the grace period and then run once", async () => {
    const t = await server();
    const s = await source(t);
    const sch = await schedule(t, s.id, { kind: "hourly" });
    t.fake.jumpWall(3 * 24 * HOUR + 10 * 60_000); // NTP arrives after three days
    const first = tick(t);
    expect(first).toMatchObject({ ran: [], idle: "clock_jump" });
    expect(t.svc.scheduler.jumpDetector.jumps.at(-1)).toMatchObject({ direction: "forward" });
    expect(tick(t).idle).toBe("clock_jump");
    expect(settleAfterJump(t).ran).toEqual([sch.id]);
    expect(t.runs).toHaveLength(1); // seventy-two missed slots, one run
    expect(tick(t).ran).toEqual([]);
    expect(t.logs.join("")).toBe(""); // the guard is not noisy in the server log
    const logged = t.svc.db.get<{ message: string }>("SELECT message FROM activity_log WHERE message LIKE 'The system clock moved%' ORDER BY id DESC");
    expect(logged?.message).toMatch(/moved forward/);
  });

  it("a jump back never replays a slot that already ran, and the next new slot still runs once", async () => {
    const t = await server();
    const s = await source(t);
    const sch = await schedule(t, s.id, { kind: "hourly" });
    expect(advance(t, 2 * HOUR).ran).toEqual([sch.id]); // slot S1 runs
    expect(t.runs).toHaveLength(1);
    const slot1 = Date.parse(t.runs[0]!.slot);

    t.fake.jumpWall(-3 * HOUR); // the clock goes back before S1
    expect(tick(t)).toMatchObject({ ran: [], idle: "clock_jump" });
    expect(t.svc.scheduler.jumpDetector.jumps.at(-1)).toMatchObject({ direction: "backward" });
    expect(settleAfterJump(t).ran).toEqual([]);
    // Walking forward through the hours that already ran (and two that never did) runs nothing...
    expect(advance(t, HOUR).ran).toEqual([]);
    expect(t.fake.now()).toBeLessThan(slot1);
    expect(advance(t, HOUR).ran).toEqual([]);
    expect(t.runs).toHaveLength(1);
    // ...until time passes the last slot that ran, when the next slot runs exactly once.
    expect(advance(t, 2 * HOUR).ran).toEqual([sch.id]);
    expect(t.runs).toHaveLength(2);
    expect(Date.parse(t.runs[1]!.slot)).toBeGreaterThan(slot1);
    expect(tick(t).ran).toEqual([]);
  });

  it("a wall clock stuck at a Pi's wrong boot date schedules nothing, and recovers when the date is fixed", async () => {
    const t = await server();
    const s = await source(t);
    const sch = await schedule(t, s.id, { kind: "hourly" });
    const real = t.fake.now();
    t.fake.jumpWall(Date.UTC(1970, 0, 2) - real);
    expect(tick(t).idle).toBe("clock_implausible");
    expect(advance(t, 5 * HOUR).idle).toBe("clock_implausible");
    t.fake.jumpWall(real + 7 * HOUR - t.fake.now()); // the real time arrives, seven hours on
    expect(tick(t).idle).toBe("clock_jump");
    expect(settleAfterJump(t).ran).toEqual([sch.id]);
    expect(t.runs).toHaveLength(1);
  });

  it("claimed slots survive a restart of the scheduler (a new gate reads them from the database)", async () => {
    const t = await server();
    const s = await source(t);
    await schedule(t, s.id, { kind: "hourly" });
    expect(advance(t, HOUR + 1000).ran).toHaveLength(1);
    const again = new Scheduler({
      db: t.svc.db, clock: t.svc.clock, service: t.svc.schedules, queue: t.svc.queue, activity: t.svc.activity, events: t.svc.events,
      run: () => { throw new Error("must not run again"); },
    });
    expect(again.tick(true).ran).toEqual([]);
    t.fake.advance(HOUR);
    expect(() => again.tick(true)).not.toThrow(); // a new slot does run, and the throwing runner is reported, not raised
    expect(t.svc.db.get<{ message: string }>("SELECT message FROM activity_log WHERE message LIKE 'A scheduled run could not start%'")).toBeDefined();
  });

  it("tick pacing follows the monotonic clock: a wall jump neither starves nor floods the ticks", async () => {
    const t = await startSourcesServer({ server: { scheduler: { tickMs: 15_000 } } });
    const sch = t.svc.scheduler;
    expect(sch.tick(true).idle).toBeUndefined();
    expect(sch.tick().idle).toBe("throttled");
    t.fake.jumpWall(10 * 24 * HOUR); // wall time moves, monotonic does not
    expect(sch.tick().idle).toBe("throttled");
    t.fake.advance(15_000);
    expect(sch.tick().idle).not.toBe("throttled");
  });
});

describe("C-09 download windows", () => {
  const putWindows = (t: T, windows: unknown[]) => t.api("PUT", "/api/downloads/windows", { windows });

  it("a scheduled run that falls outside the window waits, then runs once when the window opens", async () => {
    const t = await server();
    const s = await source(t);
    const sch = await schedule(t, s.id, { kind: "hourly", window: { start: "02:00", end: "04:00", timezone: "UTC" } });
    expect(sch.window).toMatchObject({ start: "02:00", end: "04:00", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] });
    // 22:13 on 14 Nov: slots 23:00, 00:00, 01:00 pass while the window is closed.
    const waiting = advance(t, 3 * HOUR + 30 * 60_000); // 01:43
    expect(waiting).toMatchObject({ ran: [], waiting: [sch.id] });
    expect(t.runs).toHaveLength(0);
    const open = advance(t, 30 * 60_000); // 02:13: open since 02:00
    expect(open.ran).toEqual([sch.id]);
    expect(Date.parse(t.runs[0]!.slot)).toBe(Date.parse("2023-11-15T02:00:00Z")); // the latest slot, the earlier ones collapsed
    expect(advance(t, 60 * 60_000).ran).toEqual([sch.id]); // 03:13, slot 03:00 inside the window
    expect(advance(t, 60 * 60_000).ran).toEqual([]); // 04:13, window closed, slot 04:00 waits
    expect(t.runs).toHaveLength(2);
  });

  it("the skip policy measures lateness from when the window opened", async () => {
    const t = await server();
    const s = await source(t);
    await schedule(t, s.id, { kind: "hourly", missedRunPolicy: "skip", window: { start: "02:00", end: "04:00", timezone: "UTC" } });
    // First tick of the day at 02:05: slot 02:00 is only five minutes old, the window opened five minutes ago: runs.
    expect(advance(t, 3 * HOUR + 52 * 60_000).ran).toHaveLength(1);
  });

  it("running downloads pause at the window edge and resume when it opens; user work is never held", async () => {
    const t = await server();
    const mk = (state: string, by: string, withJob = true) => {
      const id = Number(t.svc.db.run(
        `INSERT INTO download_jobs (public_id, kind, state, priority, requested_by, created_at) VALUES (?, 'explore', ?, 3, ?, ?)`,
        [`dl_test_${Math.random().toString(36).slice(2)}`, state, by, t.fake.now()]).lastInsertRowid);
      if (withJob) {
        // Far in the future so the runner leaves the row alone.
        t.svc.db.run(
          `INSERT INTO jobs (type, queue, state, download_job_id, url, url_key, host, run_at, created_at) VALUES ('fetch', 'crawl', 'queued', ?, 'http://x.invalid/', ?, 'x.invalid', ?, ?)`,
          [id, `k${id}`, Date.UTC(2100, 0, 1), t.fake.now()]);
      }
      return id;
    };
    const stateOf = (id: number) => t.svc.db.get<{ state: string; paused_by_window: number }>("SELECT state, paused_by_window FROM download_jobs WHERE id = ?", [id])!;
    const childOf = (id: number) => t.svc.db.get<{ state: string }>("SELECT state FROM jobs WHERE download_job_id = ?", [id])!.state;

    expect((await putWindows(t, [{ start: "02:00", end: "04:00", timezone: "UTC" }])).status).toBe(200);
    t.fake.advance(4 * HOUR + 30 * 60_000); // 02:43, inside the window
    const scheduled = mk("running", "schedule");
    const user = mk("running", "user");
    const byUser = mk("paused", "schedule"); // paused by the Human, not by a window
    expect(tick(t)).toMatchObject({ paused: 0, resumed: 0 });

    const closed = advance(t, 80 * 60_000); // 04:03: the window has closed
    expect(closed.paused).toBe(1);
    expect(stateOf(scheduled)).toEqual({ state: "paused", paused_by_window: 1 });
    expect(childOf(scheduled)).toBe("held");
    expect(stateOf(user)).toEqual({ state: "running", paused_by_window: 0 });
    expect(stateOf(byUser)).toEqual({ state: "paused", paused_by_window: 0 });
    expect(tick(t).paused).toBe(0); // idempotent

    // A queued job that arrives while the window is shut is held as well.
    const late = mk("queued", "discovery");
    expect(tick(t).paused).toBe(1);
    expect(stateOf(late).state).toBe("paused");

    // Next night the window opens and only the window's own pauses come back.
    const opened = advance(t, 22 * HOUR); // 02:03 next day
    expect(opened.resumed).toBe(2);
    expect(stateOf(scheduled)).toEqual({ state: "queued", paused_by_window: 0 });
    expect(childOf(scheduled)).toBe("queued");
    expect(stateOf(byUser)).toEqual({ state: "paused", paused_by_window: 0 });
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity_log WHERE message LIKE 'Paused 1 download%'")!.n).toBe(2);
  });

  it("a job started outside the window waits (is paused) until the next opening", async () => {
    const t = await server();
    await putWindows(t, [{ start: "02:00", end: "04:00", timezone: "UTC" }]);
    const id = Number(t.svc.db.run(`INSERT INTO download_jobs (public_id, kind, state, priority, requested_by, created_at) VALUES ('dl_w1', 'explore', 'queued', 3, 'schedule', ?)`, [t.fake.now()]).lastInsertRowid);
    expect(tick(t).paused).toBe(1);
    expect(t.svc.db.get<{ state: string }>("SELECT state FROM download_jobs WHERE id = ?", [id])!.state).toBe("paused");
    expect(advance(t, 3 * HOUR + 50 * 60_000).resumed).toBe(1);
    expect(t.svc.db.get<{ state: string }>("SELECT state FROM download_jobs WHERE id = ?", [id])!.state).toBe("queued");
  });

  it("source windows and global windows must both be open; isOpen explains when", async () => {
    const t = await server();
    const s = await source(t);
    const rowId = t.svc.sources.resolvePublicId(s.id);
    await putWindows(t, [{ start: "00:00", end: "12:00", timezone: "UTC" }]);
    await schedule(t, s.id, { kind: "hourly", window: { start: "10:00", end: "14:00", timezone: "UTC" } });
    const at = (iso: string) => Date.parse(iso);
    expect(t.svc.scheduler.isOpen(rowId, "schedule", at("2023-11-15T11:00:00Z")).open).toBe(true);
    expect(t.svc.scheduler.isOpen(rowId, "schedule", at("2023-11-15T13:00:00Z")).open).toBe(false); // global closed
    expect(t.svc.scheduler.isOpen(rowId, "schedule", at("2023-11-15T09:00:00Z")).open).toBe(false); // source closed
    expect(t.svc.scheduler.isOpen(rowId, "user", at("2023-11-15T13:00:00Z")).open).toBe(true);
    expect(t.svc.scheduler.isOpen(null, "schedule", at("2023-11-15T13:00:00Z"))).toMatchObject({ open: false, opensAt: at("2023-11-16T00:00:00Z") });
  });

  it("global windows can be read, replaced and cleared through the API", async () => {
    const t = await server();
    expect((await t.api("GET", "/api/downloads/windows")).body).toMatchObject({ windows: [], status: { open: true } });
    const put = await putWindows(t, [{ name: "Nights", days: ["mon", "tue"], start: "23:00", end: "06:00", timezone: "Europe/London", limits: { concurrency: 4 } }]);
    expect(put.body.windows).toHaveLength(1);
    expect(put.body.windows[0]).toMatchObject({ name: "Nights", days: ["mon", "tue"], start: "23:00", end: "06:00", limits: { concurrency: 4 }, sourceId: null });
    expect(put.body.status.open).toBe(false);
    expect(put.body.status.opensAt).toMatch(/^2023-11-14T23:00:00/); // Tuesday evening, London is on GMT
    const bad = await putWindows(t, [{ start: "10:00", end: "10:00" }, { start: "25:00", end: "26:00" }, { start: "01:00", end: "02:00", timezone: "Mars/Base" }]);
    expect(bad.status).toBe(400);
    expect(bad.body.details.fields.map((f: any) => f.path)).toEqual(expect.arrayContaining(["windows.0.end", "windows.1.start", "windows.2.timezone"]));
    expect((await putWindows(t, [])).body.windows).toEqual([]);
    expect((await t.api("GET", "/api/downloads/windows")).body.status.open).toBe(true);
  });
});

describe("C-09 schedule API", () => {
  it("creates, reads, updates and deletes a schedule, computing the cron expression and next run", async () => {
    const t = await server();
    const s = await source(t, { schedule: { kind: "daily", time: "04:15", timezone: "Europe/London" } });
    expect(s.schedule).toMatchObject({ kind: "daily", time: "04:15", expression: "15 4 * * *", timezone: "Europe/London" });
    const list = (await t.api("GET", `/api/schedules?sourceId=${s.id}`)).body.items;
    expect(list).toHaveLength(1);
    const id = list[0].id;
    const upd = await t.api("PATCH", `/api/schedules/${id}`, { kind: "cron", cron: "0 */6 * * *", missedRunPolicy: "skip" });
    expect(upd.body).toMatchObject({ kind: "cron", expression: "0 */6 * * *", cron: "0 */6 * * *", missedRunPolicy: "skip", nextRunAt: "2023-11-15T00:00:00.000Z" });
    const off = await t.api("PATCH", `/api/schedules/${id}`, { enabled: false });
    expect(off.body.enabled).toBe(false);
    const manual = await t.api("PATCH", `/api/schedules/${id}`, { kind: "manual" });
    expect(manual.body).toMatchObject({ kind: "manual", expression: null, nextRunAt: null });
    expect((await t.api("DELETE", `/api/schedules/${id}`)).status).toBe(204);
    expect((await t.api("GET", `/api/schedules/${id}`)).status).toBe(404);
    expect((await t.api("GET", `/api/sources/${s.id}`)).body.nextRunAt).toBeNull();
  });

  it("refuses bad schedules with the name of the wrong field", async () => {
    const t = await server();
    const s = await source(t);
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: "cron", cron: "every day" }, "cron"],
      [{ kind: "cron", cron: "* * * * *" }, "cron"],
      [{ kind: "cron", cron: "0 0 * * * *" }, "cron"],
      [{ kind: "cron" }, "cron"],
      [{ kind: "daily", time: "25:00" }, "time"],
      [{ kind: "daily", time: "03:00", timezone: "Nowhere/Land" }, "timezone"],
      [{ kind: "weekly", dayOfWeek: 9 }, "dayOfWeek"],
      [{ kind: "hourly", minute: 75 }, "minute"],
      [{ kind: "sometimes" }, "kind"],
      [{ kind: "hourly", windowId: "win_00000000000000000000000000" }, "windowId"],
    ];
    for (const [body, field] of cases) {
      const r = await t.api("POST", "/api/schedules", { sourceId: s.id, ...body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.details.fields.map((f: any) => f.path), JSON.stringify(body)).toContain(field);
    }
    expect((await t.api("POST", "/api/schedules", { kind: "hourly" })).status).toBe(400);
    expect((await t.api("POST", "/api/schedules", { sourceId: "src_00000000000000000000000000", kind: "hourly" })).status).toBe(404);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM schedules")!.n).toBe(0);
  });

  it("a window made for a schedule goes when the schedule or its source goes; shared windows stay", async () => {
    const t = await server();
    const s = await source(t);
    const a = await schedule(t, s.id, { kind: "hourly", window: { start: "01:00", end: "02:00" } });
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM download_windows WHERE source_id IS NOT NULL")!.n).toBe(1);
    const b = await schedule(t, s.id, { kind: "daily", time: "01:30", windowId: a.windowId });
    await t.api("DELETE", `/api/schedules/${a.id}`);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM download_windows")!.n).toBe(1); // b still uses it
    await t.api("DELETE", `/api/schedules/${b.id}`);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM download_windows")!.n).toBe(0);
    await schedule(t, s.id, { kind: "hourly", window: { start: "01:00", end: "02:00" } });
    await t.api("DELETE", `/api/sources/${s.id}`);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM schedules")!.n).toBe(0);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM download_windows")!.n).toBe(0);
  });

  it("requires a session and the CSRF header for changes", async () => {
    const t = await server();
    const { call } = await import("../server/helpers.js");
    expect((await call(t, { url: "/api/schedules" })).statusCode).toBe(401);
    expect((await call(t, { method: "PUT", url: "/api/downloads/windows", body: { windows: [] } })).statusCode).toBe(401);
    expect((await call(t, { method: "PUT", url: "/api/downloads/windows", body: { windows: [] }, cookie: t.cookie, raw: true })).statusCode).toBe(403);
    expect((await call(t, { method: "POST", url: "/api/sources", body: { name: "x", type: "single_page", startUrl: "http://x.test/" } })).statusCode).toBe(401);
  });
});
