import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { LOG_AREAS, LOG_LEVELS } from "@ncb/shared";
import { users } from "./identity.js";
import { downloadJobs } from "./jobs.js";

// Mirrors migrations/0001_foundation.sql (docs/data-model.md section 3.1, activity_log).

export const activityLog = sqliteTable(
  "activity_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
    level: text("level", { enum: LOG_LEVELS }).notNull(),
    area: text("area", { enum: LOG_AREAS }).notNull(),
    message: text("message").notNull(),
    detailsJson: text("details_json"),
    downloadJobId: integer("download_job_id").references(() => downloadJobs.id, { onDelete: "set null" }),
    jobId: integer("job_id"),
    versionId: integer("version_id"),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("activity_log_at_idx").on(t.at),
    index("activity_log_area_at_idx").on(t.area, t.at),
    index("activity_log_download_job_at_idx").on(t.downloadJobId, t.at),
  ],
);
