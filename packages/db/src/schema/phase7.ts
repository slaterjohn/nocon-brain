import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Mirrors migrations/0013_discovery.sql (docs/data-model.md "Phase 7 as built").
// discovery_candidates gains its Phase 7 columns in search.ts.

export const discoveryLedger = sqliteTable(
  "discovery_ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    day: text("day").notNull(),
    at: integer("at").notNull(),
    lane: text("lane", { enum: ["active", "background", "auto_cache"] }).notNull(),
    candidateId: integer("candidate_id"),
    downloadJobId: integer("download_job_id"),
    host: text("host").notNull(),
    requests: integer("requests").notNull().default(1),
    reservedBytes: integer("reserved_bytes").notNull(),
    bytes: integer("bytes"),
    state: text("state", { enum: ["reserved", "settled"] }).notNull().default("reserved"),
    outcome: text("outcome", { enum: ["archived", "unchanged", "failed", "cancelled"] }),
    settledAt: integer("settled_at"),
  },
  (t) => [index("discovery_ledger_day_idx").on(t.day, t.lane), index("discovery_ledger_host_idx").on(t.day, t.host)],
);

export const discoveryState = sqliteTable("discovery_state", {
  id: integer("id").primaryKey(),
  pausedAt: integer("paused_at"),
  pausedBy: text("paused_by"),
  lastPassAt: integer("last_pass_at"),
  lastPassJson: text("last_pass_json"),
});
