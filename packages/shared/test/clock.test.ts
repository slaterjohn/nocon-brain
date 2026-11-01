import { describe, expect, it } from "vitest";
import { ClockJumpDetector, FakeClock, ScheduleGate, isExpired, steadyClock, systemClock } from "../src/index.js";

const HOUR = 3_600_000;

describe("FakeClock and steadyClock", () => {
  it("advance moves both clocks, jumpWall only the wall clock", () => {
    const c = new FakeClock(1000, 0);
    c.advance(10);
    c.jumpWall(500);
    expect([c.now(), c.monotonic()]).toEqual([1510, 10]);
    expect(() => c.advance(-1)).toThrow();
  });

  it("steady time ignores wall jumps and follows monotonic time", () => {
    const base = new FakeClock(1_000_000, 0);
    const s = steadyClock(base);
    base.advance(1000);
    base.jumpWall(24 * HOUR);
    expect(s.now()).toBe(1_001_000);
    base.jumpWall(-48 * HOUR);
    base.advance(500);
    expect(s.now()).toBe(1_001_500);
  });

  it("system clock monotonic never decreases", () => {
    const a = systemClock.monotonic();
    expect(systemClock.monotonic()).toBeGreaterThanOrEqual(a);
  });
});

describe("ClockJumpDetector", () => {
  it("detects forward and backward jumps and reports direction", () => {
    const c = new FakeClock();
    const seen: string[] = [];
    const d = new ClockJumpDetector({ clock: c, thresholdMs: 5000, onJump: (j) => seen.push(j.direction) });
    c.advance(1000);
    expect(d.check()).toBeNull();
    c.jumpWall(2 * HOUR);
    expect(d.check()).toMatchObject({ direction: "forward", deltaMs: 2 * HOUR });
    c.advance(1000);
    expect(d.check()).toBeNull();
    c.jumpWall(-3 * HOUR);
    expect(d.check()).toMatchObject({ direction: "backward", deltaMs: -3 * HOUR });
    expect(seen).toEqual(["forward", "backward"]);
    expect(d.jumps).toHaveLength(2);
  });

  it("ignores small drift and slow checks", () => {
    const c = new FakeClock();
    const d = new ClockJumpDetector({ clock: c });
    c.advance(10 * 60_000); // long gap between checks is not a jump
    c.jumpWall(300);
    expect(d.check()).toBeNull();
  });

  it("is in grace after a jump, then recovers", () => {
    const c = new FakeClock();
    const d = new ClockJumpDetector({ clock: c, graceMs: 60_000 });
    expect(d.inGrace()).toBe(false);
    c.jumpWall(HOUR);
    d.check();
    expect(d.inGrace()).toBe(true);
    c.advance(59_000);
    expect(d.inGrace()).toBe(true);
    c.advance(2_000);
    expect(d.inGrace()).toBe(false);
  });
});

describe("session-style expiry", () => {
  it("a forward jump does not expire every session at once", () => {
    const c = new FakeClock();
    const d = new ClockJumpDetector({ clock: c, graceMs: 60_000 });
    const expiries = Array.from({ length: 5 }, (_, i) => c.now() + (i + 1) * HOUR);
    c.jumpWall(10 * HOUR);
    expect(expiries.map((e) => isExpired(e, c, d))).toEqual([false, false, false, false, false]);
    c.advance(61_000); // grace over: the corrected time decides
    expect(expiries.map((e) => isExpired(e, c, d))).toEqual([true, true, true, true, true]);
  });

  it("a backward jump keeps sessions valid", () => {
    const c = new FakeClock();
    const d = new ClockJumpDetector({ clock: c });
    const exp = c.now() + HOUR;
    c.jumpWall(-5 * HOUR);
    expect(isExpired(exp, c, d)).toBe(false);
  });
});

describe("ScheduleGate", () => {
  it("runs a slot once", () => {
    const g = new ScheduleGate();
    expect(g.claim("s", [100], 150)).toBe(100);
    expect(g.claim("s", [100], 160)).toBeNull();
  });

  it("does not run future slots", () => {
    expect(new ScheduleGate().claim("s", [200], 150)).toBeNull();
  });

  it("collapses missed slots after a forward jump into one run", () => {
    const g = new ScheduleGate();
    const slots = [HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR];
    expect(g.claim("s", slots, 10 * HOUR)).toBe(4 * HOUR);
    expect(g.claim("s", slots, 10 * HOUR)).toBeNull();
  });

  it("does not replay a slot after a backward jump", () => {
    const c = new FakeClock(10 * HOUR, 0);
    const g = new ScheduleGate();
    expect(g.claim("daily", [10 * HOUR], c.now())).toBe(10 * HOUR);
    c.jumpWall(-HOUR); // wall time is now 9h; the 10h slot is in the future, then due again
    expect(g.claim("daily", [10 * HOUR], c.now())).toBeNull();
    c.advance(HOUR + 1);
    expect(g.claim("daily", [10 * HOUR], c.now())).toBeNull();
    expect(g.claim("daily", [10 * HOUR, 11 * HOUR], 11 * HOUR + 5)).toBe(11 * HOUR);
  });

  it("tracks keys independently and accepts persisted state", () => {
    const g = new ScheduleGate({ a: 500 });
    expect(g.claim("a", [500], 600)).toBeNull();
    expect(g.claim("b", [500], 600)).toBe(500);
  });
});
