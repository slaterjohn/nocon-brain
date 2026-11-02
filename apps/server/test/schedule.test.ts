import { describe, expect, it } from "vitest";
import { cronFor, latestSlotAtOrBefore, nextSlot, ScheduleError, validateCron } from "../src/schedule/cron.js";
import { isValidTimezone, localParts, localToUtc, offsetMs } from "../src/schedule/time.js";
import { combineStatus, daysToMask, groupStatus, maskToDays, mergeIntervals, windowIntervals, type WindowSpec } from "../src/schedule/windows.js";

const t = (s: string) => Date.parse(s);
const iso = (n: number | null) => (n === null ? null : new Date(n).toISOString());

describe("C-09 cron computation", () => {
  it("builds the cron expression for each kind", () => {
    expect(cronFor({ kind: "manual" })).toBeNull();
    expect(cronFor({ kind: "hourly", minute: 15 })).toBe("15 * * * *");
    expect(cronFor({ kind: "hourly" })).toBe("0 * * * *");
    expect(cronFor({ kind: "daily", time: "03:30" })).toBe("30 3 * * *");
    expect(cronFor({ kind: "weekly", time: "09:00", dayOfWeek: 1 })).toBe("0 9 * * 1");
    expect(cronFor({ kind: "cron", cron: "  0   */6 * * * " })).toBe("0 */6 * * *");
  });

  it("rejects bad zones and expressions with the field that is wrong", () => {
    expect(() => validateCron("0 3 * * *", "Mars/Olympus")).toThrow(expect.objectContaining({ field: "timezone" }));
    expect(() => validateCron("nonsense", "UTC")).toThrow(expect.objectContaining({ field: "cron" }));
    expect(() => validateCron("* * * * *", "UTC")).toThrow(/every 5 minutes/);
    expect(() => validateCron("*/4 * * * *", "UTC")).toThrow(/every 5 minutes/);
    expect(() => validateCron("*/5 * * * *", "UTC")).not.toThrow();
    expect(() => cronFor({ kind: "cron", cron: "0 0 0 * * *" })).toThrow(ScheduleError);
    expect(() => cronFor({ kind: "cron" })).toThrow(/Enter a cron expression/);
  });

  it("computes a daily time in a zone across the spring and autumn changes", () => {
    // Europe/London: clocks go forward at 01:00 UTC on 29 March 2026 and back at 01:00 UTC on 25 October 2026.
    const s1 = nextSlot("0 3 * * *", "Europe/London", t("2026-03-28T12:00:00Z"))!;
    expect(iso(s1)).toBe("2026-03-29T02:00:00.000Z"); // 03:00 BST
    expect(iso(nextSlot("0 3 * * *", "Europe/London", s1))).toBe("2026-03-30T02:00:00.000Z");
    expect(iso(nextSlot("0 3 * * *", "Europe/London", t("2026-03-27T12:00:00Z")))).toBe("2026-03-28T03:00:00.000Z"); // 03:00 GMT
    expect(iso(nextSlot("0 3 * * *", "Europe/London", t("2026-10-24T12:00:00Z")))).toBe("2026-10-25T03:00:00.000Z");
  });

  it("a local time that does not exist runs once, not twice and not never", () => {
    const slots: string[] = [];
    let at = t("2026-03-27T12:00:00Z");
    for (let i = 0; i < 4; i++) {
      at = nextSlot("30 2 * * *", "Europe/London", at)!;
      slots.push(iso(at)!);
    }
    expect(slots).toEqual(["2026-03-28T02:30:00.000Z", "2026-03-29T01:30:00.000Z", "2026-03-30T01:30:00.000Z", "2026-03-31T01:30:00.000Z"]);
  });

  it("a local time that happens twice runs once", () => {
    const from = t("2026-10-24T12:00:00Z");
    const to = t("2026-10-26T12:00:00Z");
    const slots: number[] = [];
    for (let s = nextSlot("30 1 * * *", "Europe/London", from); s !== null && s < to; s = nextSlot("30 1 * * *", "Europe/London", s)) slots.push(s);
    expect(slots.map(iso)).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"]);
  });

  it("zones with a half-hour offset land on the right UTC minute", () => {
    expect(iso(nextSlot("15 * * * *", "Asia/Kolkata", t("2026-01-01T12:00:00Z")))).toBe("2026-01-01T12:45:00.000Z");
    expect(iso(nextSlot("0 9 * * *", "Asia/Kolkata", t("2026-01-01T12:00:00Z")))).toBe("2026-01-02T03:30:00.000Z");
  });

  it("weekly keeps the local weekday and time through a DST change", () => {
    // New York starts summer time on Sunday 8 March 2026.
    expect(iso(nextSlot("0 9 * * 1", "America/New_York", t("2026-03-02T15:00:00Z")))).toBe("2026-03-09T13:00:00.000Z");
    expect(iso(nextSlot("0 9 * * 1", "America/New_York", t("2026-03-01T00:00:00Z")))).toBe("2026-03-02T14:00:00.000Z");
  });

  it("finds the latest slot at or before now, including a slot exactly now", () => {
    expect(iso(latestSlotAtOrBefore("0 * * * *", "UTC", t("2026-05-01T10:30:00Z")))).toBe("2026-05-01T10:00:00.000Z");
    expect(iso(latestSlotAtOrBefore("0 * * * *", "UTC", t("2026-05-01T10:00:00Z")))).toBe("2026-05-01T10:00:00.000Z");
    expect(iso(latestSlotAtOrBefore("0 3 * * 1", "UTC", t("2026-05-01T10:30:00Z")))).toBe("2026-04-27T03:00:00.000Z");
  });
});

describe("C-09 time zone helpers", () => {
  it("validates zone names", () => {
    expect(isValidTimezone("Europe/London")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
  });
  it("converts between local and UTC both sides of a change", () => {
    expect(localParts(t("2026-07-01T23:30:00Z"), "Europe/London")).toMatchObject({ day: 2, hour: 0, minute: 30 });
    expect(offsetMs(t("2026-01-01T00:00:00Z"), "Europe/London")).toBe(0);
    expect(offsetMs(t("2026-07-01T00:00:00Z"), "Europe/London")).toBe(3_600_000);
    expect(iso(localToUtc({ year: 2026, month: 7, day: 1 }, 22 * 60, "Europe/London"))).toBe("2026-07-01T21:00:00.000Z");
    expect(iso(localToUtc({ year: 2026, month: 7, day: 1 }, 22 * 60, "Europe/London", 1))).toBe("2026-07-02T21:00:00.000Z");
  });
});

const overnight: WindowSpec = { daysMask: daysToMask(["mon", "tue", "wed", "thu", "fri"]), startMinute: 22 * 60, endMinute: 6 * 60, timezone: "Europe/London" };

describe("C-09 download windows", () => {
  it("masks and day lists round trip, Monday first", () => {
    expect(daysToMask(["mon"])).toBe(1);
    expect(daysToMask(["sun"])).toBe(64);
    expect(maskToDays(0b1000101)).toEqual(["mon", "wed", "sun"]);
  });

  it("an overnight window belongs to the day it starts on", () => {
    // Wed 4 March 2026 23:00 GMT: open since Wed 22:00, closes Thu 06:00.
    const open = groupStatus([overnight], t("2026-03-04T23:00:00Z"));
    expect(open).toEqual({ open: true, since: t("2026-03-04T22:00:00Z"), closesAt: t("2026-03-05T06:00:00Z") });
    // Thu midday: closed, next opens Thu 22:00.
    expect(iso(groupStatus([overnight], t("2026-03-05T12:00:00Z")).opensAt ?? null)).toBe("2026-03-05T22:00:00.000Z");
    // Friday night runs into Saturday morning, Saturday night does not start a window.
    expect(groupStatus([overnight], t("2026-03-07T03:00:00Z")).open).toBe(true);
    const sat = groupStatus([overnight], t("2026-03-07T12:00:00Z"));
    expect(sat.open).toBe(false);
    expect(iso(sat.opensAt ?? null)).toBe("2026-03-09T22:00:00.000Z"); // Monday evening
  });

  it("follows local time through summer time", () => {
    // 22:00 London is 21:00 UTC in July.
    expect(groupStatus([overnight], t("2026-07-01T21:30:00Z")).open).toBe(true);
    expect(groupStatus([overnight], t("2026-07-01T20:30:00Z")).open).toBe(false);
  });

  it("a window inside the clock-change gap lasts as long as the clocks allow", () => {
    const w: WindowSpec = { daysMask: daysToMask(["sun"]), startMinute: 60, endMinute: 180, timezone: "Europe/London" }; // 01:00-03:00 on 29 March 2026
    const [iv] = windowIntervals(w, t("2026-03-29T00:00:00Z"), t("2026-03-30T00:00:00Z"));
    expect(iv![1] - iv![0]).toBe(3_600_000);
  });

  it("no windows means always open; several windows are alternatives", () => {
    expect(groupStatus([], t("2026-03-04T12:00:00Z"))).toEqual({ open: true });
    expect(groupStatus([{ ...overnight, enabled: false }], t("2026-03-04T12:00:00Z"))).toEqual({ open: true });
    const morning: WindowSpec = { daysMask: 127, startMinute: 5 * 60, endMinute: 7 * 60, timezone: "Europe/London" };
    expect(groupStatus([overnight, morning], t("2026-03-04T06:30:00Z")).open).toBe(true);
    expect(mergeIntervals([[0, 5], [4, 9], [20, 30]])).toEqual([[0, 9], [20, 30]]);
    // Adjacent windows merge into one open period.
    const night: WindowSpec = { daysMask: 127, startMinute: 22 * 60, endMinute: 6 * 60, timezone: "UTC" };
    const early: WindowSpec = { daysMask: 127, startMinute: 6 * 60, endMinute: 8 * 60, timezone: "UTC" };
    expect(groupStatus([night, early], t("2026-03-04T07:00:00Z")).since).toBe(t("2026-03-03T22:00:00Z"));
  });

  it("all groups must be open; the next opening is the latest of the closed ones", () => {
    const g1 = { open: true, since: 10, closesAt: 100 };
    const g2 = { open: true, since: 20, closesAt: 50 };
    expect(combineStatus([g1, g2])).toEqual({ open: true, since: 20, closesAt: 50 });
    expect(combineStatus([g1, { open: false, opensAt: 500 }, { open: false, opensAt: 900 }])).toEqual({ open: false, opensAt: 900 });
    expect(combineStatus([g1, { open: false }])).toEqual({ open: false, opensAt: undefined });
  });
});
