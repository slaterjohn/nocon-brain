import { CronExpressionParser } from "cron-parser";
import { isValidTimezone } from "./time.js";

export interface ScheduleSpec {
  kind: "manual" | "hourly" | "daily" | "weekly" | "cron";
  minute?: number;
  time?: string;
  dayOfWeek?: number;
  cron?: string;
}

export class ScheduleError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
  }
}

/** Shortest gap between runs that is accepted for a custom cron expression. */
export const MIN_CRON_GAP_MS = 5 * 60_000;

export function cronFor(spec: ScheduleSpec): string | null {
  switch (spec.kind) {
    case "manual": return null;
    case "hourly": return `${spec.minute ?? 0} * * * *`;
    case "daily":
    case "weekly": {
      const [h, m] = (spec.time ?? "03:00").split(":").map(Number);
      return spec.kind === "daily" ? `${m} ${h} * * *` : `${m} ${h} * * ${spec.dayOfWeek ?? 1}`;
    }
    case "cron": {
      const expr = (spec.cron ?? "").trim().replace(/\s+/g, " ");
      if (!expr) throw new ScheduleError("Enter a cron expression", "cron");
      if (expr.split(" ").length !== 5) throw new ScheduleError("Use five fields: minute, hour, day of month, month, day of week", "cron");
      return expr;
    }
  }
}

function parse(expr: string, tz: string, at: number) {
  return CronExpressionParser.parse(expr, { currentDate: new Date(at), tz });
}

/** Throws `ScheduleError` (with the field name) for a bad zone or expression, or one that runs more often than every five minutes. */
export function validateCron(expr: string, tz: string): void {
  if (!isValidTimezone(tz)) throw new ScheduleError(`"${tz}" is not a time zone name such as Europe/London`, "timezone");
  try {
    const it = parse(expr, tz, Date.UTC(2025, 0, 1));
    let prev = it.next().toDate().getTime();
    for (let i = 0; i < 20; i++) {
      const n = it.next().toDate().getTime();
      if (n - prev < MIN_CRON_GAP_MS) throw new ScheduleError("A schedule cannot run more often than every 5 minutes", "cron");
      prev = n;
    }
  } catch (e) {
    if (e instanceof ScheduleError) throw e;
    throw new ScheduleError(`That is not a valid cron expression (${(e as Error).message})`, "cron");
  }
}

/** First slot strictly after `after`. */
export function nextSlot(expr: string, tz: string, after: number): number | null {
  try {
    return parse(expr, tz, after).next().toDate().getTime();
  } catch {
    return null;
  }
}

/** Latest slot at or before `now`, or null when there is none in the last `lookbackMs` (default 400 days). */
export function latestSlotAtOrBefore(expr: string, tz: string, now: number): number | null {
  try {
    const it = parse(expr, tz, now + 1000);
    for (let i = 0; i < 3; i++) {
      const s = it.prev().toDate().getTime();
      if (s <= now) return s;
    }
  } catch {
    /* an expression that never matches has no previous slot */
  }
  return null;
}
