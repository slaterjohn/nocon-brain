import { describe, expect, it } from "vitest";
import { JOB_STATES } from "@ncb/shared";
import { assertTransition, backoffDelayMs, canTransition, InvalidTransitionError, isTerminal } from "../src/index.js";

describe("job state machine", () => {
  it("allows the documented transitions", () => {
    const ok: [string, string][] = [
      ["queued", "running"], ["queued", "held"], ["queued", "cancelled"],
      ["running", "done"], ["running", "failed"], ["running", "queued"], ["running", "dead"], ["running", "cancelled"],
      ["held", "queued"], ["held", "cancelled"], ["failed", "queued"], ["dead", "queued"],
    ];
    for (const [a, b] of ok) expect(canTransition(a as never, b as never), `${a}->${b}`).toBe(true);
  });

  it("refuses everything else", () => {
    const bad: [string, string][] = [
      ["queued", "done"], ["queued", "dead"], ["held", "running"], ["done", "queued"], ["cancelled", "queued"],
      ["failed", "running"], ["dead", "running"], ["done", "done"],
    ];
    for (const [a, b] of bad) expect(canTransition(a as never, b as never), `${a}->${b}`).toBe(false);
    expect(() => assertTransition("done", "queued")).toThrow(InvalidTransitionError);
  });

  it("done and cancelled are the only terminal states", () => {
    expect(JOB_STATES.filter(isTerminal).sort()).toEqual(["cancelled", "done"]);
  });
});

describe("backoffDelayMs", () => {
  const noJitter = { baseMs: 1000, factor: 2, maxMs: 60_000, jitter: 0 };

  it("grows exponentially and caps", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelayMs(n, noJitter))).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  it("applies jitter within the fraction", () => {
    const lo = backoffDelayMs(3, { ...noJitter, jitter: 0.25 }, () => 0);
    const hi = backoffDelayMs(3, { ...noJitter, jitter: 0.25 }, () => 1);
    const mid = backoffDelayMs(3, { ...noJitter, jitter: 0.25 }, () => 0.5);
    expect([lo, mid, hi]).toEqual([3000, 4000, 5000]);
  });

  it("never exceeds the cap even with jitter", () => {
    expect(backoffDelayMs(20, { ...noJitter, jitter: 0.5 }, () => 1)).toBe(60_000);
  });
});
