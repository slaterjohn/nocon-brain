import { describe, expect, it } from "vitest";
import { parseVersioning, periodStart, supersededBy } from "../src/pipeline/policy.js";

const DAY = 86_400_000;
const v = (id: number, versionNo: number, day: number) => ({ id, versionNo, fetchedAt: Date.UTC(2026, 0, day, 10) });

describe("A-11 versioning policy table", () => {
  const existing = [v(1, 1, 1), v(2, 2, 1), v(3, 3, 2), v(4, 4, 9)];
  const incoming = v(5, 5, 9);
  it.each([
    [{ mode: "all" }, []],
    [{ mode: "on_change" }, []],
    [{ mode: "latest_only" }, [1, 2, 3, 4]],
    [{ mode: "last_n", n: 1 }, [1, 2, 3, 4]],
    [{ mode: "last_n", n: 3 }, [1, 2]],
    [{ mode: "last_n", n: 10 }, []],
    [{ mode: "period", period: "day" }, [4]],
    [{ mode: "period", period: "month" }, [1, 2, 3, 4]],
    [{ mode: "period", period: "week" }, [4]],
  ] as const)("%j supersedes %j", (policy, doomed) => {
    expect(supersededBy(policy as never, incoming, existing).sort()).toEqual([...doomed]);
  });

  it("buckets periods in UTC with weeks starting on Monday", () => {
    const wed = Date.UTC(2026, 0, 7, 23, 59);
    expect(periodStart(wed, "day")).toBe(Date.UTC(2026, 0, 7));
    expect(periodStart(wed, "week")).toBe(Date.UTC(2026, 0, 5));
    expect(periodStart(wed, "month")).toBe(Date.UTC(2026, 0, 1));
    expect(periodStart(Date.UTC(2026, 0, 4), "week")).toBe(Date.UTC(2025, 11, 29) );
    expect(DAY).toBe(86_400_000);
  });

  it("parses loosely typed input to a safe policy", () => {
    expect(parseVersioning(undefined)).toEqual({ mode: "on_change" });
    expect(parseVersioning({ mode: "last_n", n: -4 })).toEqual({ mode: "last_n", n: 1 });
    expect(parseVersioning({ mode: "period", period: "fortnight" })).toEqual({ mode: "period", period: "day" });
    expect(parseVersioning({ mode: "bogus" })).toEqual({ mode: "on_change" });
  });
});
