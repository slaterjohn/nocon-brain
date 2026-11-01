-- 0002_job_queue: the internal persistent queue and per-host politeness state.
-- Source: docs/data-model.md section 3.5 (jobs, host_state).
-- jobs.version_id has no FOREIGN KEY until page_versions exists (Phase 2).

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('fetch','asset_fetch','process','render','index','discover','evict','gc','verify','zim_scan','wikipedia_fetch','refresh_check','export')),
  queue TEXT NOT NULL CHECK (queue IN ('crawl','process','index','maintenance')),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','held','done','failed','dead','cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  host TEXT,
  url TEXT,
  url_key TEXT,
  download_job_id INTEGER REFERENCES download_jobs(id) ON DELETE CASCADE,
  crawl_job_id INTEGER REFERENCES crawl_jobs(id) ON DELETE CASCADE,
  version_id INTEGER,
  depth INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  idempotency_key TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  run_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  worker_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
) STRICT;
-- Claim order index. The ordering columns come right after (queue, state) so SQLite walks the index in
-- claim order and stops at the first runnable row (LIMIT 1). With run_at in the middle, as first drafted
-- in data-model.md, every claim sorted all due rows: 12 ms per claim at 50,000 queued instead of ~1 ms.
CREATE INDEX jobs_claim_idx ON jobs (queue, state, priority DESC, score DESC, id);
CREATE INDEX jobs_lease_idx ON jobs (lease_until) WHERE state = 'running';
CREATE UNIQUE INDEX jobs_crawl_url_key_uq ON jobs (crawl_job_id, url_key);
CREATE INDEX jobs_download_job_idx ON jobs (download_job_id);
CREATE UNIQUE INDEX jobs_idempotency_uq ON jobs (type, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND state IN ('queued','running','held');

CREATE TABLE host_state (
  host TEXT PRIMARY KEY,
  in_flight INTEGER NOT NULL DEFAULT 0 CHECK (in_flight >= 0),
  max_concurrent INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrent >= 1),
  next_allowed_at INTEGER NOT NULL DEFAULT 0,
  crawl_delay_ms INTEGER NOT NULL DEFAULT 0,
  backoff_until INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  robots_status TEXT CHECK (robots_status IS NULL OR robots_status IN ('ok','none','disallow_all_temp')),
  robots_fetched_at INTEGER,
  robots_blob_id INTEGER REFERENCES blobs(id) ON DELETE SET NULL
) STRICT;
