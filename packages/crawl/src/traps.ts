import type { TrapConfig } from "./types.js";

/** Small persistent counters the stateful trap rules need. The server backs it with `crawl_counters`. */
export interface TrapStore {
  get(kind: string, key: string): number;
  add(kind: string, key: string, delta: number): number;
  set(kind: string, key: string, value: number): void;
  has(kind: string, key: string): boolean;
}

export class MemoryTrapStore implements TrapStore {
  private readonly m = new Map<string, number>();
  private k = (kind: string, key: string) => `${kind}\u0000${key}`;
  get(kind: string, key: string) { return this.m.get(this.k(kind, key)) ?? 0; }
  add(kind: string, key: string, delta: number) { const v = this.get(kind, key) + delta; this.m.set(this.k(kind, key), v); return v; }
  set(kind: string, key: string, value: number) { this.m.set(this.k(kind, key), value); }
  has(kind: string, key: string) { return this.m.has(this.k(kind, key)); }
}

export type TrapReason =
  | "trap:repeating_segments"
  | "trap:path_depth"
  | "trap:calendar_budget"
  | "trap:calendar_window"
  | "trap:query_variants"
  | "trap:duplicate_content"
  | "trap:host_budget"
  | "trap:frontier_full"
  | "trap:redirect_loop";

export const DEFAULT_TRAPS: TrapConfig = {
  repeatThreshold: 3,
  maxSegmentOccurrences: 4,
  maxPathSegments: 12,
  calendarBudget: 12,
  calendarWindowDays: 400,
  queryVariantBudget: 12,
  duplicateStreak: 5,
  maxUrlsPerHost: 5000,
  maxFrontier: 20_000,
};

// ---- stateless rules ---------------------------------------------------------------------------

/**
 * True when the path has one segment repeated `threshold` times in a row (`/a/a/a`), or a block of 2 to 4 segments repeated
 * `threshold - 1` times in a row (`/a/b/a/b`: a block that repeats is a loop, a single repeated word is sometimes real), or one
 * segment occurring more than `maxOccurrences` times anywhere.
 */
export function hasRepeatingSegments(pathname: string, threshold: number, maxOccurrences: number): boolean {
  const segs = pathname.split("/").filter(Boolean).map((s) => s.toLowerCase());
  const counts = new Map<string, number>();
  for (const s of segs) {
    const n = (counts.get(s) ?? 0) + 1;
    if (n > maxOccurrences) return true;
    counts.set(s, n);
  }
  for (let period = 1; period <= 4; period++) {
    const copies = period === 1 ? threshold : Math.max(2, threshold - 1);
    const need = period * copies;
    for (let start = 0; start + need <= segs.length; start++) {
      let ok = true;
      for (let i = period; i < need && ok; i++) if (segs[start + i] !== segs[start + (i % period)]) ok = false;
      if (ok) return true;
    }
  }
  return false;
}

export function pathSegmentCount(pathname: string): number {
  return pathname.split("/").filter(Boolean).length;
}

export interface CalendarHit {
  /** The URL with the date part replaced by `{date}`: the counter key. */
  template: string;
  /** Days since 1970-01-01 (UTC) of the date in the URL. */
  epochDay: number;
}

const PATH_DATE = /(^|\/)((?:19|20)\d{2})[/-](0?[1-9]|1[0-2])(?:[/-](0?[1-9]|[12]\d|3[01]))?(?=\/|$|[?#])/;
const QUERY_DATE_KEYS = /^(date|day|month|year|d|ym|from|to|start|end|cal|calendar_date)$/i;
const QUERY_DATE_VAL = /^((?:19|20)\d{2})-(0?[1-9]|1[0-2])(?:-(0?[1-9]|[12]\d|3[01]))?$/;

const toEpochDay = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);

/** Finds a calendar date in the path (`/2026/11/01`, `/2026-11`) or in a date-like query value (`?date=2026-11-01`). */
export function calendarHit(url: URL): CalendarHit | null {
  const m = PATH_DATE.exec(url.pathname);
  if (m) {
    const template = url.host + url.pathname.replace(PATH_DATE, "$1{date}") + (url.search ? "?" + [...url.searchParams.keys()].sort().join("&") : "");
    return { template, epochDay: toEpochDay(+m[2]!, +m[3]!, m[4] ? +m[4] : 1) };
  }
  for (const [k, v] of url.searchParams) {
    const q = QUERY_DATE_VAL.exec(v);
    if (q && QUERY_DATE_KEYS.test(k)) {
      const rest = [...url.searchParams.keys()].filter((x) => x !== k).sort().join("&");
      return { template: `${url.host}${url.pathname}?${k}={date}&${rest}`, epochDay: toEpochDay(+q[1]!, +q[2]!, q[3] ? +q[3] : 1) };
    }
  }
  return null;
}

/** Digit runs and long hex/uuid-like segments collapse to `#`, query parameters to their sorted names: the "kind" of page a URL is. */
export function urlFamily(url: URL): string {
  const path = url.pathname.split("/").map((s) => (/^[0-9a-f]{8,}$/i.test(s) ? "#" : s.replace(/\d+/g, "#"))).join("/");
  const names = [...new Set(url.searchParams.keys())].sort();
  return url.host + path + (names.length ? "?" + names.join("&") : "");
}

export const queryPathKey = (url: URL) => url.host + url.pathname;

// ---- the guard ---------------------------------------------------------------------------------

export type TrapVerdict = { ok: true; commit(): void } | { ok: false; reason: TrapReason };

/**
 * Checks a candidate URL against every trap rule. `check` reads counters but writes nothing; call `commit()` on an
 * `ok` verdict once the URL has really been queued, so that duplicates rejected by the visited set do not use budget.
 */
export class TrapGuard {
  constructor(readonly config: TrapConfig, private readonly store: TrapStore) {}

  check(rawUrl: string): TrapVerdict {
    const c = this.config;
    const u = new URL(rawUrl);
    if (pathSegmentCount(u.pathname) > c.maxPathSegments) return { ok: false, reason: "trap:path_depth" };
    if (hasRepeatingSegments(u.pathname, c.repeatThreshold, c.maxSegmentOccurrences)) return { ok: false, reason: "trap:repeating_segments" };

    const commits: (() => void)[] = [];
    const hostEnq = this.store.get("host_enq", u.host);
    if (hostEnq >= c.maxUrlsPerHost) return { ok: false, reason: "trap:host_budget" };
    commits.push(() => this.store.add("host_enq", u.host, 1));

    const family = urlFamily(u);
    if (this.store.has("blocked_family", family)) return { ok: false, reason: "trap:duplicate_content" };

    const cal = calendarHit(u);
    if (cal) {
      if (this.store.get("cal_pages", cal.template) >= c.calendarBudget) return { ok: false, reason: "trap:calendar_budget" };
      if (this.store.has("cal_anchor", cal.template)) {
        if (Math.abs(this.store.get("cal_anchor", cal.template) - cal.epochDay) > c.calendarWindowDays) return { ok: false, reason: "trap:calendar_window" };
      } else commits.push(() => this.store.set("cal_anchor", cal.template, cal.epochDay));
      commits.push(() => this.store.add("cal_pages", cal.template, 1));
    }

    if (u.search) {
      const pk = queryPathKey(u);
      if (this.store.get("query_variants", pk) >= c.queryVariantBudget) return { ok: false, reason: "trap:query_variants" };
      commits.push(() => this.store.add("query_variants", pk, 1));
    }
    return { ok: true, commit: () => commits.forEach((f) => f()) };
  }

  /** True when the URL's family was blocked by a duplicate-content streak after it was queued. Checked again when the URL is about to be fetched. */
  isBlocked(rawUrl: string): boolean {
    return this.store.has("blocked_family", urlFamily(new URL(rawUrl)));
  }

  /**
   * Reports the content of a fetched page. Returns true when this page completed a streak of identical-content pages
   * from its URL family, which blocks the family. `duplicate` means the same text was already seen in this crawl.
   */
  observeContent(rawUrl: string, duplicate: boolean): boolean {
    const family = urlFamily(new URL(rawUrl));
    if (!duplicate) {
      this.store.set("dup_streak", family, 0);
      return false;
    }
    const n = this.store.add("dup_streak", family, 1);
    if (n >= this.config.duplicateStreak && !this.store.has("blocked_family", family)) {
      this.store.set("blocked_family", family, 1);
      return true;
    }
    return false;
  }
}
