/**
 * Clocks and clock-jump safety (task F-18, risk R-35).
 *
 * A Raspberry Pi without a real-time clock can boot offline with a wrong date and then jump when
 * NTP arrives. Anything that measures an interval inside a running process (leases, rate limits,
 * backoff) must use `steadyClock`, which follows the monotonic timer. Anything that must be tied to
 * calendar time (schedules, session expiry) uses the wall clock and consults a `ClockJumpDetector`.
 */
export interface Clock {
  /** Wall-clock time in Unix milliseconds. Can jump in either direction. */
  now(): number;
  /** Monotonic milliseconds from an arbitrary origin. Never goes backwards. */
  monotonic(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => Number(process.hrtime.bigint() / 1_000_000n),
};

/** A controllable clock for tests. `advance` moves both clocks; `jumpWall` moves only the wall clock. */
export class FakeClock implements Clock {
  private wall: number;
  private mono: number;

  constructor(startWall = 1_700_000_000_000, startMono = 1_000) {
    this.wall = startWall;
    this.mono = startMono;
  }

  now(): number {
    return this.wall;
  }

  monotonic(): number {
    return this.mono;
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error("advance() cannot go backwards; use jumpWall()");
    this.wall += ms;
    this.mono += ms;
  }

  /** Simulates NTP, a manual change or a wrong boot date: wall time moves, monotonic time does not. */
  jumpWall(deltaMs: number): void {
    this.wall += deltaMs;
  }
}

/**
 * A clock whose `now()` is "wall time at creation plus elapsed monotonic time". It ignores later wall
 * jumps, so persisted lease and backoff timestamps written with it stay consistent while the process
 * runs. Across a restart the anchor is taken again, which is why startup recovery must not trust
 * old lease values (the queue offers `reapExpired({ all: true })` for that).
 */
export function steadyClock(base: Clock = systemClock): Clock {
  const wall0 = base.now();
  const mono0 = base.monotonic();
  return {
    now: () => wall0 + (base.monotonic() - mono0),
    monotonic: () => base.monotonic(),
  };
}

export interface ClockJump {
  direction: "forward" | "backward";
  /** Wall time moved by this many ms more (positive) or fewer (negative) than monotonic time did. */
  deltaMs: number;
  detectedAtWall: number;
}

export interface ClockJumpDetectorOptions {
  clock?: Clock;
  /** Smallest wall/monotonic disagreement that counts as a jump. Default 5000 ms. */
  thresholdMs?: number;
  /** How long `inGrace()` stays true after a jump (monotonic). Default 60000 ms. */
  graceMs?: number;
  onJump?: (jump: ClockJump) => void;
}

/**
 * Compares how far the wall clock moved with how far the monotonic clock moved between two checks.
 * The two should agree; a disagreement above the threshold is a jump. Call `check()` on a timer
 * (`start()`) and before any decision that depends on calendar time.
 */
export class ClockJumpDetector {
  private readonly clock: Clock;
  private readonly thresholdMs: number;
  private readonly graceMs: number;
  private readonly onJump?: (jump: ClockJump) => void;
  private lastWall: number;
  private lastMono: number;
  private graceUntilMono = -Infinity;
  private timer?: NodeJS.Timeout;
  readonly jumps: ClockJump[] = [];

  constructor(opts: ClockJumpDetectorOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.thresholdMs = opts.thresholdMs ?? 5_000;
    this.graceMs = opts.graceMs ?? 60_000;
    this.onJump = opts.onJump;
    this.lastWall = this.clock.now();
    this.lastMono = this.clock.monotonic();
  }

  /** Returns the jump since the previous check, or null. Updates the reference point either way. */
  check(): ClockJump | null {
    const wall = this.clock.now();
    const mono = this.clock.monotonic();
    const drift = wall - this.lastWall - (mono - this.lastMono);
    this.lastWall = wall;
    this.lastMono = mono;
    if (Math.abs(drift) < this.thresholdMs) return null;
    const jump: ClockJump = { direction: drift > 0 ? "forward" : "backward", deltaMs: drift, detectedAtWall: wall };
    this.graceUntilMono = mono + this.graceMs;
    this.jumps.push(jump);
    if (this.jumps.length > 50) this.jumps.shift();
    this.onJump?.(jump);
    return jump;
  }

  /** True shortly after a jump. Expiry sweeps and schedulers should skip destructive work while true. */
  inGrace(): boolean {
    return this.clock.monotonic() < this.graceUntilMono;
  }

  start(intervalMs = 1_000): void {
    this.stop();
    this.timer = setInterval(() => this.check(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * Whether a persisted expiry has passed, tolerant of clock jumps. During the grace period after a
 * jump nothing counts as expired, so a forward jump cannot expire every session at once and the next
 * sweep after the grace period decides on the corrected time.
 */
export function isExpired(expiresAt: number, clock: Clock, detector?: ClockJumpDetector): boolean {
  detector?.check();
  if (detector?.inGrace()) return false;
  return clock.now() >= expiresAt;
}

/**
 * Stops a schedule running twice. A slot is the planned run time. A slot runs at most once, only
 * slots later than the last one that ran are eligible (so a backwards jump cannot replay a slot),
 * and when several slots are overdue after a forward jump or a long pause only the latest runs
 * (missed-run policy "run once").
 */
export class ScheduleGate {
  private readonly lastSlot = new Map<string, number>();

  constructor(initial: Record<string, number> = {}) {
    for (const [k, v] of Object.entries(initial)) this.lastSlot.set(k, v);
  }

  /** `dueSlots` are planned run times (Unix ms) the schedule has produced up to the present. */
  claim(key: string, dueSlots: number[], now: number): number | null {
    const last = this.lastSlot.get(key) ?? -Infinity;
    const eligible = dueSlots.filter((s) => s <= now && s > last);
    if (eligible.length === 0) return null;
    const slot = Math.max(...eligible);
    this.lastSlot.set(key, slot);
    return slot;
  }

  lastRun(key: string): number | undefined {
    return this.lastSlot.get(key);
  }
}
