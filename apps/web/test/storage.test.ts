import { describe, expect, it } from "vitest";
import {
  asPriority, barScale, barWidths, confidenceText, fromBytes, fullAtText, growthText, kindLabel, maintenanceHeadline, planHeadline, projectedUsedText, rangeText,
  skippedSummary, splitTotals, thresholdErrors, toBytes, usageLabel, volumeRoomBytes, volumeUsedPct, waitText, SKIP_REASON_TEXT,
  type EvictionPlan, type UsageRow,
} from "../lib/storage";

const GB = 1024 ** 3;
const row = (key: string, exclusiveBytes: number, sharedBytes = 0, blobCount = 1): UsageRow => ({ key, exclusiveBytes, sharedBytes, blobCount });

describe("volume numbers", () => {
  it("uses the quota as the room when there is one, otherwise own bytes plus free space", () => {
    expect(volumeRoomBytes({ quotaBytes: 100, usedBytes: 10, availableBytes: 500 })).toBe(100);
    expect(volumeRoomBytes({ quotaBytes: null, usedBytes: 40, availableBytes: 60 })).toBe(100);
  });
  it("rounds disk usage to a whole percent, counts reservations and stays within 0 to 100", () => {
    expect(volumeUsedPct({ quotaBytes: null, usedBytes: 40, availableBytes: 60, reservedBytes: 0 })).toBe(40);
    expect(volumeUsedPct({ quotaBytes: 1000, usedBytes: 333, availableBytes: 0, reservedBytes: 0 })).toBe(33);
    expect(volumeUsedPct({ quotaBytes: 100, usedBytes: 90, availableBytes: 0, reservedBytes: 30 })).toBe(100);
    expect(volumeUsedPct({ quotaBytes: null, usedBytes: 0, availableBytes: 0, reservedBytes: 0 })).toBe(0);
  });
});

describe("priority codes", () => {
  it("reads numbers and codes alike", () => {
    expect(asPriority(1)).toBe("P1");
    expect(asPriority("P3")).toBe("P3");
    expect(asPriority("4")).toBe("P4");
    expect(asPriority(0)).toBeNull();
    expect(asPriority(5)).toBeNull();
    expect(asPriority(null)).toBeNull();
    expect(asPriority("urgent")).toBeNull();
  });
});

describe("usage rows", () => {
  it("names priorities, unreferenced files, kinds, sources and unassigned content", () => {
    expect(usageLabel("priority", row("P1", 1))).toBe("P1 Protected");
    expect(usageLabel("priority", row("P4", 1))).toBe("P4 Opportunistic");
    expect(usageLabel("priority", row("unreferenced", 1))).toBe("Unused files (counted as Opportunistic)");
    expect(usageLabel("source", { ...row("src_1", 1), label: "Quick saves" })).toBe("Quick saves");
    expect(usageLabel("source", row("unassigned", 1))).toBe("Not in any source");
    expect(usageLabel("kind", row("stylesheet", 1))).toBe("Style sheets");
    expect(kindLabel("some_new_kind")).toBe("Some new kind");
  });
  it("sums exclusive and shared separately", () => {
    expect(splitTotals([row("a", 10, 5, 2), row("b", 1, 0, 3)])).toEqual({ exclusive: 11, shared: 5, files: 5 });
  });
  it("scales bars against the widest row and never hides a non-zero part", () => {
    const rows = [row("a", 800, 200), row("b", 1, 0), row("c", 0, 0)];
    expect(barScale(rows)).toBe(1000);
    expect(barWidths(rows[0]!, 1000)).toEqual({ exclusive: "80%", shared: "20%" });
    expect(barWidths(rows[1]!, 1000).exclusive).toBe("1%");
    expect(barWidths(rows[2]!, 1000)).toEqual({ exclusive: "0%", shared: "0%" });
    expect(barWidths(rows[0]!, 0)).toEqual({ exclusive: "0%", shared: "0%" });
  });
});

describe("forecast wording is always a range", () => {
  const f = { growthBytesPerDay: { low: GB, high: 3 * GB }, projectedUsedBytes: { low: 10 * GB, high: 20 * GB }, horizonDays: 30 };
  it("gives a range for growth and used space", () => {
    expect(growthText(f)).toBe("Between 1.0 GB and 3.0 GB a day");
    expect(projectedUsedText(f)).toBe("Between 10.0 GB and 20.0 GB in 30 days");
  });
  it("says so when there is no growth", () => {
    expect(growthText({ growthBytesPerDay: { low: 0, high: 0 } })).toMatch(/No growth/);
  });
  it("describes when it could fill, with both ends when known", () => {
    const d = (s: string) => s.slice(0, 10);
    expect(fullAtText({ projectedFullAt: { earliest: "2027-01-01T00:00:00Z", latest: "2027-06-01T00:00:00Z" } }, d)).toBe("Could fill between 2027-01-01 and 2027-06-01.");
    expect(fullAtText({ projectedFullAt: { earliest: "2027-01-01T00:00:00Z" } }, d)).toMatch(/Could fill from 2027-01-01 .* does not grow/);
    expect(fullAtText({}, d)).toMatch(/ten years/);
  });
  it("collapses equal range ends", () => {
    expect(rangeText(GB, GB)).toBe("about 1.0 GB");
    expect(rangeText(GB, 2 * GB)).toBe("1.0 GB to 2.0 GB");
  });
  it("states confidence", () => {
    expect(confidenceText("low")).toMatch(/fewer than three/);
    expect(confidenceText("medium")).toBe("Medium confidence.");
  });
  it("never writes a percentage into forecast text", () => {
    const all = [growthText(f), projectedUsedText(f), fullAtText({}), confidenceText("low"), rangeText(1, 2)].join(" ");
    expect(all).not.toMatch(/%/);
  });
});

describe("threshold validation matches the server", () => {
  it("accepts the defaults", () => expect(thresholdErrors({ softPct: 85, evictStartPct: 90, evictTargetPct: 80 })).toEqual({}));
  it("accepts soft equal to the start", () => expect(thresholdErrors({ softPct: 90, evictStartPct: 90, evictTargetPct: 80 })).toEqual({}));
  it("rejects soft above the start", () => expect(thresholdErrors({ softPct: 95, evictStartPct: 90, evictTargetPct: 80 }).softPct).toMatch(/can't be above/));
  it("rejects a target at or above the start", () => {
    expect(thresholdErrors({ softPct: 80, evictStartPct: 90, evictTargetPct: 90 }).evictTargetPct).toMatch(/below the eviction start/);
    expect(thresholdErrors({ softPct: 80, evictStartPct: 90, evictTargetPct: 95 }).evictTargetPct).toBeTruthy();
  });
  it("rejects out of range and fractional numbers", () => {
    const e = thresholdErrors({ softPct: 0, evictStartPct: 101, evictTargetPct: 80.5 });
    expect(Object.keys(e).sort()).toEqual(["evictStartPct", "evictTargetPct", "softPct"]);
  });
});

describe("sizes", () => {
  it("parses a number and unit to bytes, empty to none and bad input to undefined", () => {
    expect(toBytes("2", "GB")).toBe(2 * GB);
    expect(toBytes("0.5", "TB")).toBe(512 * GB);
    expect(toBytes("  ", "GB")).toBeNull();
    expect(toBytes("0", "GB")).toBeUndefined();
    expect(toBytes("-1", "MB")).toBeUndefined();
    expect(toBytes("abc", "MB")).toBeUndefined();
  });
  it("turns bytes back into the largest sensible unit", () => {
    expect(fromBytes(null)).toEqual({ text: "", unit: "GB" });
    expect(fromBytes(2 * GB)).toEqual({ text: "2", unit: "GB" });
    expect(fromBytes(1.5 * 1024 * GB)).toEqual({ text: "1.5", unit: "TB" });
    expect(fromBytes(300 * 1024 ** 2)).toEqual({ text: "300", unit: "MB" });
  });
});

const plan = (over: Partial<EvictionPlan>): EvictionPlan => ({
  planId: "p", createdAt: "", expiresAt: "", mode: "pressure", incomingPriority: "P1", bytesNeeded: 0, reclaimableBytes: 0, sufficient: true, insufficient: false,
  throttleOpportunistic: false, steps: [], itemsTotal: 0, items: [], unreferencedBlobs: { count: 0, bytes: 0 }, skipped: [], skippedCounts: {}, summary: "", ...over,
});

describe("eviction plan wording", () => {
  it("says honestly when nothing can be removed", () => {
    expect(planHeadline(plan({}))).toMatch(/Nothing can be removed/);
  });
  it("says insufficient plainly and that it cannot be run", () => {
    const t = planHeadline(plan({ sufficient: false, insufficient: true, itemsTotal: 2, reclaimableBytes: GB, bytesNeeded: 5 * GB }));
    expect(t).toMatch(/^Not enough/);
    expect(t).toMatch(/1\.0 GB/);
    expect(t).toMatch(/5\.0 GB is needed/);
    expect(t).toMatch(/cannot be run/);
  });
  it("describes a plan to a volume target without a byte count", () => {
    expect(planHeadline(plan({ sufficient: false, itemsTotal: 1, reclaimableBytes: 100 }))).toMatch(/target/);
  });
  it("describes a good plan with copies and unused files", () => {
    expect(planHeadline(plan({ itemsTotal: 1, reclaimableBytes: GB }))).toBe("Would free 1.0 GB from 1 saved copy.");
    expect(planHeadline(plan({ itemsTotal: 3, reclaimableBytes: 2 * GB, unreferencedBlobs: { count: 1, bytes: 10 } }))).toBe("Would free 2.0 GB from 3 saved copies and 1 unused file.");
  });
  it("orders skip reasons by count and drops zeros; every reason has text", () => {
    expect(skippedSummary({ p1: 2, retained: 5, in_use: 0 })).toEqual([{ reason: "retained", count: 5 }, { reason: "p1", count: 2 }]);
    for (const k of ["p1", "source_auto_eviction_off", "p2_not_permitted", "priority_gate", "in_use", "retained", "no_reclaim", "not_on_volume"] as const) expect(SKIP_REASON_TEXT[k]).toBeTruthy();
    expect(SKIP_REASON_TEXT.p1).toMatch(/never removed automatically/);
  });
});

describe("maintenance wording", () => {
  it("says a clean dry run changed nothing", () => {
    expect(maintenanceHeadline({ dryRun: true, state: "done", findings: [] })).toMatch(/dry run, so nothing was changed/);
  });
  it("counts problems and says a dry run changed nothing", () => {
    const t = maintenanceHeadline({ dryRun: true, state: "done", findings: [{ invariant: "I-1", title: "", count: 2, examples: [] }, { invariant: "I-3", title: "", count: 1, examples: [] }] });
    expect(t).toBe("3 problems found in 2 checks. This was a dry run: nothing was changed.");
  });
  it("counts repairs on a repair run", () => {
    expect(maintenanceHeadline({ dryRun: false, state: "done", findings: [{ invariant: "I-2", title: "", count: 1, examples: [], repaired: 1 }] })).toBe("1 problem found in 1 check. 1 repaired.");
  });
  it("reports a failed run", () => expect(maintenanceHeadline({ dryRun: true, state: "failed", findings: [] })).toMatch(/failed/));
});

describe("download wait reason", () => {
  it("explains a throttled P4 download and falls back to the server message", () => {
    expect(waitText({ reason: "throttled", message: "x" })).toMatch(/Opportunistic \(P4\) downloads are paused/);
    expect(waitText({ reason: "other", message: "Because." })).toBe("Because.");
    expect(waitText(undefined)).toBeNull();
  });
});
