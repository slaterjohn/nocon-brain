import { localParts, localToUtc } from "./time.js";

/** days_mask: bit 0 = Monday ... bit 6 = Sunday. An end before the start runs past midnight into the next day. */
export interface WindowSpec {
  daysMask: number;
  startMinute: number;
  endMinute: number;
  timezone: string;
  enabled?: boolean;
}

export const ALL_DAYS = 0b1111111;
export const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export function daysToMask(days: readonly (typeof DAY_NAMES)[number][]): number {
  return days.reduce((m, d) => m | (1 << DAY_NAMES.indexOf(d)), 0);
}
export function maskToDays(mask: number): (typeof DAY_NAMES)[number][] {
  return DAY_NAMES.filter((_, i) => (mask & (1 << i)) !== 0);
}

export type Interval = [start: number, end: number];

const DAY_MS = 86_400_000;

/** Every interval of the window that overlaps [from, to), as UTC instants. */
export function windowIntervals(w: WindowSpec, from: number, to: number): Interval[] {
  if (w.enabled === false) return [];
  const out: Interval[] = [];
  const first = localParts(from - DAY_MS, w.timezone);
  for (let i = 0; i <= Math.ceil((to - from) / DAY_MS) + 2; i++) {
    const date = { year: first.year, month: first.month, day: first.day + i };
    const noon = Date.UTC(date.year, date.month - 1, date.day);
    const d = new Date(noon);
    const weekday = (d.getUTCDay() + 6) % 7;
    if ((w.daysMask & (1 << weekday)) === 0) continue;
    const day = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    const start = localToUtc(day, w.startMinute, w.timezone);
    const end = w.endMinute > w.startMinute ? localToUtc(day, w.endMinute, w.timezone) : localToUtc(day, w.endMinute, w.timezone, 1);
    if (end > from && start < to) out.push([start, end]);
  }
  return out;
}

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

export interface WindowStatus {
  open: boolean;
  /** When the current open period began (open only). */
  since?: number;
  /** When the current open period ends (open only). */
  closesAt?: number;
  /** When the next open period begins (closed only). Undefined if none within 14 days. */
  opensAt?: number;
}

/**
 * Whether a group of windows allows downloads at `now`. A group with no enabled windows is unrestricted (always open).
 * Within a group the windows are alternatives: open when any of them is.
 */
export function groupStatus(windows: WindowSpec[], now: number): WindowStatus {
  const active = windows.filter((w) => w.enabled !== false);
  if (active.length === 0) return { open: true };
  const ivs = mergeIntervals(active.flatMap((w) => windowIntervals(w, now - 2 * DAY_MS, now + 15 * DAY_MS)));
  const cur = ivs.find(([s, e]) => s <= now && now < e);
  if (cur) return { open: true, since: cur[0], closesAt: cur[1] };
  const next = ivs.find(([s]) => s > now);
  return { open: false, opensAt: next?.[0] };
}

/** All groups must be open. Returns the combined view: open only when every group is, with the latest `since` and earliest `closesAt`. */
export function combineStatus(statuses: WindowStatus[]): WindowStatus {
  if (statuses.every((s) => s.open)) {
    const since = statuses.map((s) => s.since).filter((x): x is number => x !== undefined);
    const closes = statuses.map((s) => s.closesAt).filter((x): x is number => x !== undefined);
    return { open: true, since: since.length ? Math.max(...since) : undefined, closesAt: closes.length ? Math.min(...closes) : undefined };
  }
  const closed = statuses.filter((s) => !s.open);
  // The next time everything is open is at least the latest of the closed groups' next opening (an estimate when several are closed).
  const opens = closed.map((s) => s.opensAt);
  return { open: false, opensAt: opens.some((o) => o === undefined) ? undefined : Math.max(...(opens as number[])) };
}

/** The API shape of a status: times as ISO strings. */
export function statusToApi(s: WindowStatus): { open: boolean; since?: string; closesAt?: string; opensAt?: string } {
  const f = (n?: number) => (n === undefined ? undefined : new Date(n).toISOString());
  return { open: s.open, since: f(s.since), closesAt: f(s.closesAt), opensAt: f(s.opensAt) };
}
