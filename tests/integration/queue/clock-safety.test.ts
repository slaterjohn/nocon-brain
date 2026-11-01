import { describe, expect, it } from "vitest";
import { ClockJumpDetector, FakeClock, ScheduleGate, steadyClock } from "@ncb/shared";
import { hostRow, setup, states } from "./helpers.js";

const DAY = 86_400_000;
const job = (o: Record<string, unknown> = {}) => ({ type: "fetch" as const, queue: "crawl" as const, ...o });

// Task F-18: leases and backoff run on the steady clock, so wall-clock jumps neither expire every
// lease at once (double-running work) nor keep dead leases alive for years.
describe("queue leases under clock jumps", () => {
  function steadySetup() {
    const base = new FakeClock();
    const s = setup({ clock: steadyClock(base), leaseMs: 60_000 });
    return { ...s, base };
  }

  it("a forward wall-clock jump does not expire running leases", () => {
    const { q, base, db } = steadySetup();
    for (let i = 0; i < 20; i++) q.enqueue(job({ host: `h${i}.test` }));
    for (let i = 0; i < 20; i++) q.claim("crawl", `w${i}`);
    base.jumpWall(30 * DAY); // NTP arrives after a boot on a stale date
    expect(q.reapExpired()).toEqual({ requeued: 0, dead: 0 });
    expect(states(db)).toEqual({ running: 20 });
    expect(q.heartbeat(1, "w0")).toBe(true);
  });

  it("a backward jump does not keep a dead worker's lease alive", () => {
    const { q, base, db } = steadySetup();
    q.enqueue(job({ host: "a.test" }));
    q.claim("crawl", "dead");
    base.jumpWall(-400 * DAY);
    base.advance(61_000); // real time passes: the lease is over on the monotonic clock
    expect(q.reapExpired()).toEqual({ requeued: 1, dead: 0 });
    expect(hostRow(db, "a.test")!.in_flight).toBe(0);
  });

  it("backoff is measured in monotonic time too", () => {
    const { q, base } = steadySetup();
    const { id } = q.enqueue(job());
    q.fail(q.claim("crawl", "w")!.id, "w", "x", { retryAfterMs: 10 * 60_000 });
    base.jumpWall(5 * DAY);
    expect(q.claim("crawl", "w")).toBeUndefined(); // still backing off
    base.advance(10 * 60_000);
    expect(q.claim("crawl", "w")!.id).toBe(id);
  });

  it("contrast: on the raw wall clock a forward jump would expire everything at once", () => {
    const base = new FakeClock();
    const { q } = setup({ clock: base, leaseMs: 60_000 });
    for (let i = 0; i < 5; i++) q.enqueue(job());
    for (let i = 0; i < 5; i++) q.claim("crawl", `w${i}`);
    base.jumpWall(DAY);
    expect(q.reapExpired().requeued).toBe(5); // why the server must pass steadyClock()
  });
});

describe("schedules under clock jumps (dispatch tick with detector and gate)", () => {
  // The dispatch rule C-09 will use: only claim a slot when no jump was just seen, once per slot.
  function tick(gate: ScheduleGate, detector: ClockJumpDetector, clock: FakeClock, slots: number[]): number | null {
    detector.check();
    if (detector.inGrace()) return null;
    return gate.claim("daily-backup", slots, clock.now());
  }

  it("does not double-run after a backward jump and does not stampede after a forward one", () => {
    const clock = new FakeClock(10 * DAY, 0);
    const detector = new ClockJumpDetector({ clock, graceMs: 60_000 });
    const gate = new ScheduleGate();
    const slots = [8 * DAY, 9 * DAY, 10 * DAY, 11 * DAY, 12 * DAY, 20 * DAY];

    expect(tick(gate, detector, clock, slots)).toBe(10 * DAY); // first run: latest due slot only

    clock.jumpWall(-2 * DAY); // wall clock reset by two days
    clock.advance(61_000);
    expect(tick(gate, detector, clock, slots)).toBeNull();
    clock.advance(2 * DAY);
    expect(tick(gate, detector, clock, slots)).toBeNull(); // the 10-day slot is not replayed

    clock.jumpWall(30 * DAY); // forward jump past several slots
    expect(tick(gate, detector, clock, slots)).toBeNull(); // in grace: wait for the clock to settle
    clock.advance(61_000);
    expect(tick(gate, detector, clock, slots)).toBe(20 * DAY); // one catch-up run, not four
    expect(tick(gate, detector, clock, slots)).toBeNull();
    expect(detector.jumps.map((j) => j.direction)).toEqual(["backward", "forward"]);
  });
});
