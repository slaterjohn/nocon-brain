-- 0001_foundation: identity, settings, volumes and storage, download jobs, activity log.
-- Source: docs/data-model.md sections 3.1, 3.2 and 3.5 (download_jobs, crawl_jobs).
-- Hand-written because drizzle-kit cannot emit STRICT tables or COLLATE NOCASE (see implementation-plan F-03).
-- download_jobs/crawl_jobs: source_id, config_id and candidate_id have no FOREIGN KEY yet; the target
-- tables arrive in Phase 2/3 and a table rebuild adds the constraints then.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  disabled_at INTEGER
) STRICT;

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT,
  revoked_at INTEGER
) STRICT;
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
) STRICT;

CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT
) STRICT;

-- Storage (3.2) ------------------------------------------------------------------------------

CREATE TABLE volumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL,
  marker_uuid TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('online','offline','readonly','draining','disabled')),
  quota_bytes INTEGER CHECK (quota_bytes IS NULL OR quota_bytes >= 0),
  reserve_free_bytes INTEGER NOT NULL CHECK (reserve_free_bytes >= 0),
  soft_threshold_pct INTEGER NOT NULL DEFAULT 85 CHECK (soft_threshold_pct BETWEEN 1 AND 100),
  evict_start_pct INTEGER NOT NULL DEFAULT 90 CHECK (evict_start_pct BETWEEN 1 AND 100),
  evict_target_pct INTEGER NOT NULL DEFAULT 80 CHECK (evict_target_pct BETWEEN 1 AND 100),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  stat_total INTEGER,
  stat_free INTEGER,
  stat_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX volumes_one_default ON volumes (is_default) WHERE is_default = 1;

CREATE TABLE storage_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('global','volume')),
  volume_id INTEGER REFERENCES volumes(id) ON DELETE CASCADE,
  permit_important_eviction INTEGER NOT NULL DEFAULT 0 CHECK (permit_important_eviction IN (0,1)),
  throttle_opportunistic INTEGER NOT NULL DEFAULT 1 CHECK (throttle_opportunistic IN (0,1)),
  prune_surplus_versions INTEGER NOT NULL DEFAULT 1 CHECK (prune_surplus_versions IN (0,1)),
  orphan_grace_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (orphan_grace_seconds >= 0),
  max_eviction_batch_bytes INTEGER CHECK (max_eviction_batch_bytes IS NULL OR max_eviction_batch_bytes > 0),
  updated_at INTEGER NOT NULL,
  CHECK ((scope = 'global' AND volume_id IS NULL) OR (scope = 'volume' AND volume_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX storage_policies_one_global ON storage_policies (scope) WHERE scope = 'global';
CREATE UNIQUE INDEX storage_policies_one_per_volume ON storage_policies (volume_id) WHERE scope = 'volume';

-- User-visible jobs (3.5) ---------------------------------------------------------------------

CREATE TABLE download_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  source_id INTEGER,
  config_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('capture','explore','mirror','refresh','wikipedia','zim_import','import','discovery','coverage')),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','paused','completed','failed','cancelled')),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 4),
  queue_order INTEGER NOT NULL DEFAULT 0,
  requested_url TEXT,
  requested_by TEXT NOT NULL CHECK (requested_by IN ('user','schedule','discovery','search','system')),
  candidate_id INTEGER,
  estimated_pages INTEGER,
  estimated_bytes INTEGER,
  pages_done INTEGER NOT NULL DEFAULT 0,
  pages_failed INTEGER NOT NULL DEFAULT 0,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN ('network','robots_blocked','ssrf_blocked','size_cap','disk_full','timeout','http_4xx','http_5xx','parse_error','limit_reached','cancelled_by_user','internal')),
  failure_message TEXT,
  scheduled_for INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX download_jobs_state_idx ON download_jobs (state, priority, queue_order);
CREATE INDEX download_jobs_source_idx ON download_jobs (source_id);

CREATE TABLE crawl_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  download_job_id INTEGER NOT NULL UNIQUE REFERENCES download_jobs(id) ON DELETE CASCADE,
  source_id INTEGER,
  config_id INTEGER,
  mode TEXT NOT NULL,
  max_depth INTEGER,
  max_pages INTEGER,
  max_bytes INTEGER,
  deadline_at INTEGER,
  seed_urls_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(seed_urls_json)),
  pages_discovered INTEGER NOT NULL DEFAULT 0,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  pages_failed INTEGER NOT NULL DEFAULT 0,
  bytes_fetched INTEGER NOT NULL DEFAULT 0,
  depth_reached INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT CHECK (stop_reason IS NULL OR stop_reason IN ('completed','max_pages','max_bytes','max_depth','deadline','source_budget','volume_full','cancelled')),
  finished_at INTEGER
) STRICT;

CREATE TABLE volume_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  volume_id INTEGER NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
  download_job_id INTEGER NOT NULL REFERENCES download_jobs(id) ON DELETE CASCADE,
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
  written_bytes INTEGER NOT NULL DEFAULT 0 CHECK (written_bytes >= 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX volume_reservations_volume_idx ON volume_reservations (volume_id);

CREATE TABLE blobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256 TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0),
  compression TEXT NOT NULL DEFAULT 'none' CHECK (compression IN ('none','zstd')),
  mime TEXT,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('document','css','image','font','media','pdf','text','reader','json','other')),
  volume_id INTEGER NOT NULL REFERENCES volumes(id),
  refcount INTEGER NOT NULL DEFAULT 0 CHECK (refcount >= 0),
  zero_since INTEGER,
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('writing','ready','missing','quarantined')),
  verified_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX blobs_zero_since_idx ON blobs (volume_id, zero_since) WHERE zero_since IS NOT NULL;
CREATE INDEX blobs_volume_kind_idx ON blobs (volume_id, kind);

CREATE TABLE storage_usage_cache (
  volume_id INTEGER NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL CHECK (dimension IN ('priority','source','kind')),
  key TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  blob_count INTEGER NOT NULL DEFAULT 0,
  shared_bytes INTEGER NOT NULL DEFAULT 0,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (volume_id, dimension, key)
) STRICT;

-- Activity log (3.1) --------------------------------------------------------------------------

CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  area TEXT NOT NULL CHECK (area IN ('crawl','pipeline','storage','search','auth','system','zim','provider')),
  message TEXT NOT NULL,
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
  download_job_id INTEGER REFERENCES download_jobs(id) ON DELETE SET NULL,
  job_id INTEGER,
  version_id INTEGER,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
) STRICT;
CREATE INDEX activity_log_at_idx ON activity_log (at);
CREATE INDEX activity_log_area_at_idx ON activity_log (area, at);
CREATE INDEX activity_log_download_job_at_idx ON activity_log (download_job_id, at);
