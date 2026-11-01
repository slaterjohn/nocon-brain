import type { VersioningPolicy } from "./types.js";

export const DEFAULT_VERSIONING: VersioningPolicy = { mode: "on_change" };

export function parseVersioning(v: unknown): VersioningPolicy {
  if (!v || typeof v !== "object") return DEFAULT_VERSIONING;
  const o = v as { mode?: unknown; n?: unknown; period?: unknown };
  switch (o.mode) {
    case "latest_only":
    case "all":
    case "on_change":
      return { mode: o.mode };
    case "last_n":
      return { mode: "last_n", n: Math.max(1, Math.min(1000, Math.floor(Number(o.n) || 1))) };
    case "period":
      return { mode: "period", period: o.period === "week" || o.period === "month" ? o.period : "day" };
    default:
      return DEFAULT_VERSIONING;
  }
}

/** Start of the UTC day, ISO week (Monday) or month containing `ms`. */
export function periodStart(ms: number, period: "day" | "week" | "month"): number {
  const d = new Date(ms);
  if (period === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (period === "day") return day;
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return day - dow * 86_400_000;
}

export function periodEnd(start: number, period: "day" | "week" | "month"): number {
  if (period === "day") return start + 86_400_000;
  if (period === "week") return start + 7 * 86_400_000;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export interface VersionStub {
  id: number;
  versionNo: number;
  fetchedAt: number;
}

/**
 * Which existing versions become surplus when `incoming` is finalised (docs/data-model.md 4.2). Pure, so the
 * policy table is unit-tested without a database. `existing` holds the page's ready/partial versions other
 * than `incoming`. `on_change` and `all` never supersede anything: on_change decides at creation time.
 */
export function supersededBy(policy: VersioningPolicy, incoming: VersionStub, existing: VersionStub[]): number[] {
  switch (policy.mode) {
    case "all":
    case "on_change":
      return [];
    case "latest_only":
      return existing.map((v) => v.id);
    case "last_n": {
      const all = [...existing, incoming].sort((a, b) => b.versionNo - a.versionNo);
      return all.slice(policy.n).map((v) => v.id).filter((id) => id !== incoming.id);
    }
    case "period": {
      const start = periodStart(incoming.fetchedAt, policy.period);
      const end = periodEnd(start, policy.period);
      return existing.filter((v) => v.fetchedAt >= start && v.fetchedAt < end).map((v) => v.id);
    }
  }
}
