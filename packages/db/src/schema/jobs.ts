import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import {
  DOWNLOAD_JOB_KINDS, DOWNLOAD_JOB_STATES, DOWNLOAD_REQUESTED_BY, FAILURE_CODES, JOB_QUEUES, JOB_STATES, JOB_TYPES,
} from "@ncb/shared";
import { blobs } from "./storage.js";

// docs/data-model.md section 3.5. download_jobs and crawl_jobs are in migration 0001 because
// activity_log and volume_reservations point at download_jobs. Their source_id, config_id and
// candidate_id columns are plain integers for now: the sources, source_configs and
// discovery_candidates tables arrive in Phase 2/3 and a table rebuild adds the foreign keys then.

export const downloadJobs = sqliteTable(
  "download_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicId: text("public_id").notNull().unique(),
    sourceId: integer("source_id"),
    configId: integer("config_id"),
    kind: text("kind", { enum: DOWNLOAD_JOB_KINDS }).notNull(),
    state: text("state", { enum: DOWNLOAD_JOB_STATES }).notNull().default("queued"),
    priority: integer("priority").notNull(),
    queueOrder: integer("queue_order").notNull().default(0),
    requestedUrl: text("requested_url"),
    requestedBy: text("requested_by", { enum: DOWNLOAD_REQUESTED_BY }).notNull(),
    candidateId: integer("candidate_id"),
    estimatedPages: integer("estimated_pages"),
    estimatedBytes: integer("estimated_bytes"),
    pagesDone: integer("pages_done").notNull().default(0),
    pagesFailed: integer("pages_failed").notNull().default(0),
    bytesDone: integer("bytes_done").notNull().default(0),
    failureCode: text("failure_code", { enum: FAILURE_CODES }),
    failureMessage: text("failure_message"),
    scheduledFor: integer("scheduled_for"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    createdAt: integer("created_at").notNull(),
    /** 1 when the schedule scheduler paused the job at a download-window edge (0006); only those are resumed when it opens. */
    pausedByWindow: integer("paused_by_window").notNull().default(0),
  },
  (t) => [
    index("download_jobs_state_idx").on(t.state, t.priority, t.queueOrder),
    index("download_jobs_source_idx").on(t.sourceId),
  ],
);

export const crawlJobs = sqliteTable("crawl_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  downloadJobId: integer("download_job_id").notNull().unique().references(() => downloadJobs.id, { onDelete: "cascade" }),
  sourceId: integer("source_id"),
  configId: integer("config_id"),
  mode: text("mode").notNull(),
  maxDepth: integer("max_depth"),
  maxPages: integer("max_pages"),
  maxBytes: integer("max_bytes"),
  deadlineAt: integer("deadline_at"),
  seedUrlsJson: text("seed_urls_json").notNull().default("[]"),
  pagesDiscovered: integer("pages_discovered").notNull().default(0),
  pagesFetched: integer("pages_fetched").notNull().default(0),
  pagesFailed: integer("pages_failed").notNull().default(0),
  bytesFetched: integer("bytes_fetched").notNull().default(0),
  depthReached: integer("depth_reached").notNull().default(0),
  stopReason: text("stop_reason", {
    enum: ["completed", "max_pages", "max_bytes", "max_depth", "deadline", "source_budget", "volume_full", "cancelled"],
  }),
  finishedAt: integer("finished_at"),
  // Migration 0005 (crawl engine).
  configJson: text("config_json").notNull().default("{}"),
  maxDurationMs: integer("max_duration_ms"),
  startedAt: integer("started_at"),
  pausedAt: integer("paused_at"),
  pagesSkipped: integer("pages_skipped").notNull().default(0),
  stopDetail: text("stop_detail"),
});

/** Why links were not followed, per crawl (migration 0005). */
export const crawlSkips = sqliteTable(
  "crawl_skips",
  {
    crawlJobId: integer("crawl_job_id").notNull().references(() => crawlJobs.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    count: integer("count").notNull().default(0),
    sampleUrlsJson: text("sample_urls_json").notNull().default("[]"),
  },
  (t) => [primaryKey({ columns: [t.crawlJobId, t.reason] })],
);

/** Trap-rule counters and small values per crawl (migration 0005). */
export const crawlCounters = sqliteTable(
  "crawl_counters",
  {
    crawlJobId: integer("crawl_job_id").notNull().references(() => crawlJobs.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    value: integer("value").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.crawlJobId, t.kind, t.key] })],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type", { enum: JOB_TYPES }).notNull(),
    queue: text("queue", { enum: JOB_QUEUES }).notNull(),
    state: text("state", { enum: JOB_STATES }).notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    score: real("score").notNull().default(0),
    host: text("host"),
    url: text("url"),
    urlKey: text("url_key"),
    downloadJobId: integer("download_job_id").references(() => downloadJobs.id, { onDelete: "cascade" }),
    crawlJobId: integer("crawl_job_id").references(() => crawlJobs.id, { onDelete: "cascade" }),
    versionId: integer("version_id"),
    depth: integer("depth").notNull().default(0),
    payloadJson: text("payload_json").notNull().default("{}"),
    idempotencyKey: text("idempotency_key"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: integer("run_at").notNull().default(0),
    leaseUntil: integer("lease_until"),
    workerId: text("worker_id"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [
    index("jobs_claim_idx").on(t.queue, t.state, sql`${t.priority} DESC`, sql`${t.score} DESC`, t.id),
    index("jobs_lease_idx").on(t.leaseUntil).where(sql`${t.state} = 'running'`),
    uniqueIndex("jobs_crawl_url_key_uq").on(t.crawlJobId, t.urlKey),
    index("jobs_download_job_idx").on(t.downloadJobId),
    uniqueIndex("jobs_idempotency_uq")
      .on(t.type, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL AND ${t.state} IN ('queued','running','held')`),
  ],
);

export const hostState = sqliteTable("host_state", {
  host: text("host").primaryKey(),
  inFlight: integer("in_flight").notNull().default(0),
  maxConcurrent: integer("max_concurrent").notNull().default(1),
  nextAllowedAt: integer("next_allowed_at").notNull().default(0),
  crawlDelayMs: integer("crawl_delay_ms").notNull().default(0),
  backoffUntil: integer("backoff_until").notNull().default(0),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  robotsStatus: text("robots_status", { enum: ["ok", "none", "disallow_all_temp"] }),
  robotsFetchedAt: integer("robots_fetched_at"),
  robotsBlobId: integer("robots_blob_id").references(() => blobs.id, { onDelete: "set null" }),
});
