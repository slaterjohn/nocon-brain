import type { Clock, LogArea, LogLevel } from "@ncb/shared";
import { redactObject, redactText } from "@ncb/shared";
import type { Db } from "@ncb/db";

export interface ActivityEntry {
  level: LogLevel;
  area: LogArea;
  message: string;
  details?: unknown;
  downloadJobId?: number;
  jobId?: number;
  versionId?: number;
  userId?: number;
}

/** Writes `activity_log` rows. Message and details are redacted before they reach the database. */
export class ActivityLog {
  constructor(private readonly db: Db, private readonly clock: Clock, private readonly onWrite?: (e: ActivityEntry & { at: number }) => void) {}

  write(e: ActivityEntry): void {
    const at = this.clock.now();
    const message = redactText(e.message).slice(0, 2000);
    const details = e.details === undefined ? null : JSON.stringify(redactObject(e.details)).slice(0, 20_000);
    try {
      this.db.run(
        `INSERT INTO activity_log (at, level, area, message, details_json, download_job_id, job_id, version_id, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [at, e.level, e.area, message, details, e.downloadJobId ?? null, e.jobId ?? null, e.versionId ?? null, e.userId ?? null],
      );
      this.onWrite?.({ ...e, message, at });
    } catch {
      // Logging must never break the request that caused it (for example during shutdown).
    }
  }

  /** Deletes rows older than the retention window. Returns the number removed. */
  prune(retentionDays: number): number {
    return this.db.run("DELETE FROM activity_log WHERE at < ?", [this.clock.now() - retentionDays * 86_400_000]).changes;
  }
}
