import type { RetentionSpec, Schedule, Source } from "./types";
import { formatBytes } from "./utils";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

export function describeSchedule(s: Schedule | null | undefined): string {
  if (!s || s.kind === "manual") return "Only when you run it";
  let base: string;
  switch (s.kind) {
    case "hourly": base = `Every hour, at ${String(s.minute ?? 0).padStart(2, "0")} minutes past`; break;
    case "daily": base = `Every day at ${s.time ?? "00:00"}`; break;
    case "weekly": base = `Every ${DAYS[s.dayOfWeek ?? 0]} at ${s.time ?? "00:00"}`; break;
    default: base = `On a schedule (${s.cron ?? s.expression ?? "custom"})`;
  }
  if (s.kind !== "hourly" && s.timezone) base += ` (${s.timezone})`;
  if (!s.enabled) base += ", switched off";
  return base;
}

export function describeWindow(w: Schedule["window"]): string {
  if (!w) return "Any time";
  const days = w.days.length === 7 ? "every day" : w.days.map((d) => DAY_SHORT[d] ?? d).join(", ");
  return `${w.start} to ${w.end}, ${days} (${w.timezone})`;
}

export function describeRetention(r: RetentionSpec): string {
  switch (r.mode) {
    case "all": return "Keep every version";
    case "latest": return r.count === 1 ? "Keep the latest version only" : `Keep the latest ${r.count} versions`;
    case "time": return `Keep versions for ${r.days} ${r.days === 1 ? "day" : "days"}`;
    case "budget": return `Stay within ${formatBytes(r.bytes)}`;
    default: return "Custom rules";
  }
}

/** The status badge. The API moves `lastStatus` off "running" when a run ends, so the UI shows it as it is. */
export function sourceStatus(s: Source): { label: string; variant: "success" | "warning" | "destructive" | "secondary" } {
  if (!s.enabled) return { label: "Switched off", variant: "secondary" };
  if (s.paused) return { label: "Paused", variant: "warning" };
  const last = s.lastStatus;
  switch (last) {
    case "running": return { label: "Running", variant: "warning" };
    case "ok": return { label: "Up to date", variant: "success" };
    case "failed": return { label: "Last run failed", variant: "destructive" };
    case "cancelled": return { label: "Last run cancelled", variant: "secondary" };
    case "paused": return { label: "Paused", variant: "warning" };
    default: return { label: "Not run yet", variant: "secondary" };
  }
}
