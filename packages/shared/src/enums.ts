/** Storage priority. Lower number = more important (docs/data-model.md section 1). */
export const PRIORITIES = [1, 2, 3, 4] as const;
export type PriorityNumber = (typeof PRIORITIES)[number];
export type PriorityCode = "P1" | "P2" | "P3" | "P4";
export type PriorityName = "Protected" | "Important" | "Standard" | "Opportunistic";

export const Priority = {
  Protected: 1,
  Important: 2,
  Standard: 3,
  Opportunistic: 4,
} as const satisfies Record<PriorityName, PriorityNumber>;

export const PRIORITY_NAMES: Record<PriorityNumber, PriorityName> = {
  1: "Protected",
  2: "Important",
  3: "Standard",
  4: "Opportunistic",
};

export function priorityToCode(p: PriorityNumber): PriorityCode {
  return `P${p}` as PriorityCode;
}

/** Accepts 1..4 or "P1".."P4" (the API form). Returns undefined for anything else. */
export function parsePriority(v: unknown): PriorityNumber | undefined {
  if (typeof v === "number" && (PRIORITIES as readonly number[]).includes(v)) return v as PriorityNumber;
  if (typeof v === "string") {
    const m = /^P([1-4])$/.exec(v);
    if (m) return Number(m[1]) as PriorityNumber;
  }
  return undefined;
}

/** True when `a` is at least as important as `b` (numerically lower or equal). */
export function isAtLeastAsImportant(a: PriorityNumber, b: PriorityNumber): boolean {
  return a <= b;
}

/** Internal queue (`jobs` table). Docs: data-model.md section 3.5. */
export const JOB_STATES = ["queued", "running", "held", "done", "failed", "dead", "cancelled"] as const;
export type JobState = (typeof JOB_STATES)[number];

export const JOB_TYPES = [
  "fetch", "asset_fetch", "process", "render", "index", "discover", "evict", "gc", "verify",
  "zim_scan", "wikipedia_fetch", "refresh_check", "export",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_QUEUES = ["crawl", "process", "index", "maintenance"] as const;
export type JobQueueName = (typeof JOB_QUEUES)[number];

/** User-visible download jobs (`download_jobs` table). */
export const DOWNLOAD_JOB_STATES = ["queued", "running", "paused", "completed", "failed", "cancelled"] as const;
export type DownloadJobState = (typeof DOWNLOAD_JOB_STATES)[number];

export const DOWNLOAD_JOB_KINDS = [
  "capture", "explore", "mirror", "refresh", "wikipedia", "zim_import", "import", "discovery", "coverage",
] as const;
export type DownloadJobKind = (typeof DOWNLOAD_JOB_KINDS)[number];

export const DOWNLOAD_REQUESTED_BY = ["user", "schedule", "discovery", "search", "system"] as const;
export type DownloadRequestedBy = (typeof DOWNLOAD_REQUESTED_BY)[number];

export const FAILURE_CODES = [
  "network", "robots_blocked", "ssrf_blocked", "size_cap", "disk_full", "timeout", "http_4xx",
  "http_5xx", "parse_error", "limit_reached", "cancelled_by_user", "internal",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_AREAS = ["crawl", "pipeline", "storage", "search", "auth", "system", "zim", "provider"] as const;
export type LogArea = (typeof LOG_AREAS)[number];
