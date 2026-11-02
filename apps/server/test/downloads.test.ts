import { describe, expect, it } from "vitest";
import { FAILURE_CODES } from "@ncb/shared";
import { FAILURE_INFO, failureFor, PAUSE_MESSAGES, STOP_MESSAGES } from "../src/downloads/failures.js";
import { ACTIONS, allowed, next, RETRYABLE_KINDS, TARGET, type DownloadAction, type DownloadState } from "../src/downloads/state.js";
import { BandwidthLimiter } from "../src/limits/bandwidth.js";
import { RESOURCE_PRESETS, THROTTLE_THRESHOLDS } from "../src/limits/presets.js";

const STATES: DownloadState[] = ["queued", "running", "paused", "completed", "failed", "cancelled"];
const ACTION_LIST: DownloadAction[] = ["pause", "resume", "cancel", "retry", "setPriority"];

describe("C-08 download state machine", () => {
  // The allowed transitions of docs/data-model.md 3.5, written out so the table is checked against the doc and not against itself.
  const doc: Record<string, DownloadState> = {
    "queued pause": "paused", "running pause": "paused", "paused resume": "queued", "failed retry": "queued",
    "queued cancel": "cancelled", "running cancel": "cancelled", "paused cancel": "cancelled",
  };

  it.each(STATES.flatMap((s) => ACTION_LIST.map((a) => [s, a] as const)))("%s + %s", (state, action) => {
    const key = `${state} ${action}`;
    if (action === "setPriority") {
      expect(allowed(state, action)).toBe(state === "queued" || state === "running" || state === "paused");
      return;
    }
    if (doc[key]) {
      expect(allowed(state, action)).toBe(true);
      expect(next(state, action)).toBe(doc[key]);
    } else {
      expect(allowed(state, action)).toBe(false);
      expect(next(state, action)).toBeUndefined();
    }
  });

  it("completed and cancelled are terminal", () => {
    expect(ACTIONS.completed).toEqual([]);
    expect(ACTIONS.cancelled).toEqual([]);
    expect(Object.keys(TARGET).sort()).toEqual(["cancel", "pause", "resume", "retry"]);
  });

  it("only captures and refreshes can be retried", () => {
    expect([...RETRYABLE_KINDS].sort()).toEqual(["capture", "refresh"]);
  });
});

describe("C-08 failure messages", () => {
  it("has a plain message, a hint and a retry flag for every failure code", () => {
    for (const code of FAILURE_CODES) {
      const f = FAILURE_INFO[code];
      expect(f, code).toBeDefined();
      expect(f.message.length).toBeGreaterThan(10);
      expect(f.hint.length).toBeGreaterThan(10);
      expect(f.message + f.hint).not.toMatch(/[A-Z]{3,}_|undefined|\bnull\b/);
    }
    expect(Object.keys(FAILURE_INFO).sort()).toEqual([...FAILURE_CODES].sort());
  });

  it("appends the specific reason and falls back to internal for an unknown code", () => {
    expect(failureFor("http_5xx", "The server answered 503.")).toMatchObject({ code: "http_5xx", retryable: true });
    expect(failureFor("http_5xx", "The server answered 503.").message).toContain("503");
    expect(failureFor("nonsense")).toMatchObject({ code: "internal" });
    expect(failureFor(null).message).toBe(FAILURE_INFO.internal.message);
    expect(failureFor("robots_blocked").retryable).toBe(false);
  });

  it("explains every pause reason and every crawl stop reason", () => {
    expect(Object.keys(PAUSE_MESSAGES).sort()).toEqual(["offline", "user", "volume_full", "window_closed"]);
    for (const r of ["completed", "max_pages", "max_bytes", "max_depth", "deadline", "source_budget", "volume_full", "cancelled"]) expect(STOP_MESSAGES[r], r).toBeTruthy();
  });
});

describe("C-10 bandwidth limiter", () => {
  it("is a no-op without a rate", () => {
    const l = new BandwidthLimiter(() => 0);
    expect(l.take(1_000_000)).toBe(0);
    expect(l.transform()).toBeUndefined();
  });

  it("spaces bytes at the configured rate after the burst, and shares one budget", () => {
    let now = 1000;
    const l = new BandwidthLimiter(() => now, 100);
    l.setRate(1000); // 1000 bytes per second
    expect(l.take(100)).toBe(0); // inside the 100 ms burst
    expect(l.take(100)).toBeCloseTo(100, 0); // the next 100 bytes wait 100 ms
    expect(l.take(1000)).toBeCloseTo(1100, 0);
    now += 5000; // idle: the debt is gone, but no more than the burst is saved up
    expect(l.take(100)).toBe(0);
    expect(l.take(100)).toBeCloseTo(100, 0);
    expect(l.throttledBytes).toBe(1400);
  });

  it("ignores nonsense rates", () => {
    const l = new BandwidthLimiter();
    l.setRate(-5);
    expect(l.rate).toBe(0);
    l.setRate(Number.NaN);
    expect(l.rate).toBe(0);
    l.setRate(12.9);
    expect(l.rate).toBe(12);
  });
});

describe("C-10 presets", () => {
  it("pi-lite is more conservative than standard in every number", () => {
    const p = RESOURCE_PRESETS["pi-lite"];
    const s = RESOURCE_PRESETS.standard;
    expect(p.maxFetchConcurrency).toBeLessThan(s.maxFetchConcurrency);
    expect(p.perHostDelayMs).toBeGreaterThan(s.perHostDelayMs);
    expect(p.extractWorkers).toBeLessThan(s.extractWorkers);
    expect(p.workerMemoryMb).toBeLessThan(s.workerMemoryMb);
    expect(THROTTLE_THRESHOLDS.medium.lagMs).toBeLessThan(THROTTLE_THRESHOLDS.low.lagMs);
    expect(p.cpuThrottle).toBe("medium");
  });
});
