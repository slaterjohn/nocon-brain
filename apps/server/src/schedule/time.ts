/** Time zone arithmetic with `Intl` only (no date library). Used for download windows; cron-parser does its own for cron. */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string): boolean {
  try {
    fmt(tz);
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Monday ... 6 = Sunday. */
  weekday: number;
}

export function localParts(ms: number, tz: string): LocalParts {
  const p: Record<string, number> = {};
  for (const part of fmt(tz).formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number(part.value);
  const weekday = (new Date(Date.UTC(p.year!, p.month! - 1, p.day!)).getUTCDay() + 6) % 7;
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour!, minute: p.minute!, weekday };
}

/** Offset of `tz` from UTC at the instant `ms`, in ms (positive east of Greenwich). */
export function offsetMs(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  return asUtc - Math.floor(ms / 60_000) * 60_000;
}

/**
 * The UTC instant at which the wall clock in `tz` reads `minuteOfDay` on the given local date. `dayOffset` moves the date
 * (it may be negative). A local time that does not exist (spring forward) resolves to the instant just after the gap; an
 * ambiguous one (autumn) resolves to its first occurrence.
 */
export function localToUtc(date: { year: number; month: number; day: number }, minuteOfDay: number, tz: string, dayOffset = 0): number {
  const guess = Date.UTC(date.year, date.month - 1, date.day + dayOffset, 0, minuteOfDay, 0);
  const o1 = offsetMs(guess, tz);
  const t1 = guess - o1;
  const o2 = offsetMs(t1, tz);
  return o2 === o1 ? t1 : guess - o2;
}
