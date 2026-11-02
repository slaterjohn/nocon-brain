-- 0005_crawl: crawl engine state (tasks C-01 to C-05).
-- crawl_jobs and jobs (the frontier, visited set UNIQUE (crawl_job_id, url_key)) exist from 0001/0002. This adds only
-- what the engine needs on top: the resolved config (so a restart resumes with the same rules), timing columns for
-- pause/resume, a per-reason skip tally, and persistent counters for the trap budgets.

ALTER TABLE crawl_jobs ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json));
ALTER TABLE crawl_jobs ADD COLUMN max_duration_ms INTEGER;
ALTER TABLE crawl_jobs ADD COLUMN started_at INTEGER;
ALTER TABLE crawl_jobs ADD COLUMN paused_at INTEGER;
ALTER TABLE crawl_jobs ADD COLUMN pages_skipped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crawl_jobs ADD COLUMN stop_detail TEXT;

-- Why links were not followed. `reason` is `scope:*`, `trap:*`, `robots`, `depth`, `limit:*` or `filter:*`.
CREATE TABLE crawl_skips (
  crawl_job_id INTEGER NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  sample_urls_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sample_urls_json)),
  PRIMARY KEY (crawl_job_id, reason)
) STRICT, WITHOUT ROWID;

-- Counters and small values the trap rules keep per crawl (query variants per path, calendar templates, duplicate streaks, host budgets).
CREATE TABLE crawl_counters (
  crawl_job_id INTEGER NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (crawl_job_id, kind, key)
) STRICT, WITHOUT ROWID;
