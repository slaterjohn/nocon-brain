-- 0007_downloads_refresh: downloads queue API, resource limits and refresh (Phase 3, tasks C-08, C-10, C-11).
--
--   * download_jobs.paused_by_limit: 1 when the disk guard paused the job (volume_full); only those are resumed when space returns.
--   * download_jobs.attempts: how many times the Human retried the job.
--   * download_jobs.summary_json: counters that belong to one kind of job (refresh: checked, unchanged, changed, gone, failed).
--   * pages.gone_at, pages.gone_status: the page answered 404 or 410 on a refresh. The page and its versions are kept.
--   * idempotency_keys: `Idempotency-Key` for POST /api/downloads (24 h window, survives a restart).

ALTER TABLE download_jobs ADD COLUMN paused_by_limit INTEGER NOT NULL DEFAULT 0 CHECK (paused_by_limit IN (0,1));
ALTER TABLE download_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE download_jobs ADD COLUMN summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json));

ALTER TABLE pages ADD COLUMN gone_at INTEGER;
ALTER TABLE pages ADD COLUMN gone_status INTEGER;

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  download_job_id INTEGER NOT NULL REFERENCES download_jobs(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
