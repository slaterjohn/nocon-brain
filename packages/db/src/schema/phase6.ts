import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { users } from "./identity.js";
import { pages } from "./pages.js";
import { volumes } from "./storage.js";

// Mirrors migrations/0012_intelligent_storage.sql (docs/data-model.md "Phase 6 as built").
// volume_reservations.priority and .source_id are added to the table in storage.ts.

export const pagePins = sqliteTable(
  "page_pins",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    pageId: integer("page_id").notNull().references(() => pages.id, { onDelete: "cascade" }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull(),
    reason: text("reason"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [unique().on(t.pageId, t.userId), index("page_pins_page_idx").on(t.pageId)],
);

export const evictionRuns = sqliteTable(
  "eviction_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicId: text("public_id").notNull().unique(),
    trigger: text("trigger", { enum: ["admission", "threshold", "prune", "manual", "recovery"] }).notNull(),
    state: text("state", { enum: ["running", "done", "failed", "interrupted"] }).notNull(),
    incomingPriority: integer("incoming_priority").notNull(),
    bytesNeeded: integer("bytes_needed").notNull().default(0),
    volumeId: integer("volume_id").references(() => volumes.id, { onDelete: "set null" }),
    versionsPlanned: integer("versions_planned").notNull().default(0),
    versionsEvicted: integer("versions_evicted").notNull().default(0),
    versionsSkipped: integer("versions_skipped").notNull().default(0),
    bytesFreed: integer("bytes_freed").notNull().default(0),
    blobsDeleted: integer("blobs_deleted").notNull().default(0),
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("eviction_runs_started_idx").on(t.startedAt)],
);

export const storageAudit = sqliteTable(
  "storage_audit",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: ["evicted", "deleted"] }).notNull(),
    at: integer("at").notNull(),
    runId: integer("run_id").references(() => evictionRuns.id, { onDelete: "set null" }),
    pageId: integer("page_id").notNull(),
    pageUrl: text("page_url").notNull(),
    versionId: integer("version_id"),
    versionNo: integer("version_no"),
    priority: integer("priority"),
    surplus: integer("surplus").notNull().default(0),
    step: text("step"),
    reason: text("reason").notNull(),
    trigger: text("trigger"),
    exclusiveBytes: integer("exclusive_bytes").notNull().default(0),
    refsJson: text("refs_json"),
    confirmedProtected: integer("confirmed_protected").notNull().default(0),
    userId: integer("user_id"),
  },
  (t) => [index("storage_audit_page_idx").on(t.pageId, t.at), index("storage_audit_version_idx").on(t.versionId), index("storage_audit_at_idx").on(t.at)],
);

export const maintenanceRuns = sqliteTable(
  "maintenance_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicId: text("public_id").notNull().unique(),
    kind: text("kind", { enum: ["verify", "repair", "gc", "backup", "integrity_check", "scrub"] }).notNull(),
    dryRun: integer("dry_run").notNull().default(1),
    state: text("state", { enum: ["running", "done", "failed"] }).notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    reportJson: text("report_json"),
  },
  (t) => [index("maintenance_runs_started_idx").on(t.startedAt)],
);
