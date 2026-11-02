-- 0006_sources_collections: sources, versioned configs, collections, memberships, page_sources, url_exclusions,
-- schedules and download windows (Phase 3, tasks C-06, C-07, C-09, C-13). Source: docs/data-model.md section 3.3.
--
-- Differences from the doc (recorded in docs/data-model.md "Phase 3 notes"):
--   * sources.paused_at: "pause scheduled work" is separate from `enabled`. A paused source keeps its references.
--   * page_sources.priority_override: the priority a capture was admitted at when it differs from the source default
--     (a Quick save at P1). Phase 6 reads COALESCE(priority_override, sources.priority).
--   * source_discovered_urls: what a sitemap or feed run has already seen, so later runs add only new items.
--   * schedules.last_slot_at, spec_json; download_windows.name; download_jobs.paused_by_window.
--   * public ids for schedules and windows use the prefixes sch_ and win_.
-- The second half rebuilds download_jobs, crawl_jobs, page_versions and bookmarks to add the foreign keys earlier
-- migrations left as plain integers. The `-- ncb:fk` lines are executed by the migration runner with foreign keys
-- switched off, using the 12-step procedure from https://www.sqlite.org/lang_altertable.html#otheralter.

CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('single_page','website','section','linked_collection','sitemap','feed','saved_search','knowledge_package','imported_documents')),
  adapter TEXT NOT NULL DEFAULT 'http' CHECK (adapter IN ('http','wikipedia','zim','import')),
  start_url TEXT,
  strategy TEXT NOT NULL CHECK (strategy IN ('capture','explore','mirror')),
  profile TEXT NOT NULL CHECK (profile IN ('focused','balanced','comprehensive','custom')),
  current_config_id INTEGER REFERENCES source_configs(id) ON DELETE SET NULL,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 4),
  retention_mode TEXT NOT NULL CHECK (retention_mode IN ('all','latest','time','budget','custom')),
  retention_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(retention_json)),
  automatic_eviction INTEGER NOT NULL CHECK (automatic_eviction IN (0,1)),
  storage_budget_bytes INTEGER,
  preferred_volume_id INTEGER REFERENCES volumes(id) ON DELETE SET NULL,
  discovery_enabled INTEGER NOT NULL DEFAULT 0 CHECK (discovery_enabled IN (0,1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  system_kind TEXT CHECK (system_kind IS NULL OR system_kind IN ('quick_saves','browsing_cache','imports')),
  saved_search_id INTEGER,
  paused_at INTEGER,
  last_run_at INTEGER,
  next_run_at INTEGER,
  last_status TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE UNIQUE INDEX sources_system_kind_uq ON sources (system_kind) WHERE system_kind IS NOT NULL;
CREATE INDEX sources_live_idx ON sources (deleted_at, enabled);

CREATE TABLE source_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  created_at INTEGER NOT NULL,
  UNIQUE (source_id, version)
) STRICT;

CREATE TABLE collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT NOT NULL DEFAULT 'folder',
  kind TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','auto','saved_search','favourites')),
  parent_id INTEGER REFERENCES collections(id) ON DELETE RESTRICT,
  rule_json TEXT CHECK (rule_json IS NULL OR json_valid(rule_json)),
  priority_floor INTEGER CHECK (priority_floor IS NULL OR priority_floor BETWEEN 1 AND 4),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE INDEX collections_parent_idx ON collections (parent_id);
-- At most one live favourites collection in v1 (becomes (user_id, kind) with multi-user).
CREATE UNIQUE INDEX collections_one_favourites ON collections (kind) WHERE kind = 'favourites' AND deleted_at IS NULL;

-- Nesting guard in the database as well as the service: no self-parent, no cycle, ancestors at most 7 deep (depth cap 8).
CREATE TRIGGER collections_parent_ins BEFORE INSERT ON collections WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'collection nesting too deep') WHERE (
    WITH RECURSIVE anc(id, d) AS (SELECT NEW.parent_id, 1 UNION ALL SELECT c.parent_id, anc.d + 1 FROM collections c JOIN anc ON c.id = anc.id WHERE c.parent_id IS NOT NULL AND anc.d < 20)
    SELECT MAX(d) FROM anc) >= 8;
END;
CREATE TRIGGER collections_parent_upd BEFORE UPDATE OF parent_id ON collections WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'collection cycle') WHERE NEW.parent_id = NEW.id OR EXISTS (
    WITH RECURSIVE anc(id) AS (SELECT NEW.parent_id UNION ALL SELECT c.parent_id FROM collections c JOIN anc ON c.id = anc.id WHERE c.parent_id IS NOT NULL)
    SELECT 1 FROM anc WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'collection nesting too deep') WHERE (
    WITH RECURSIVE anc(id, d) AS (SELECT NEW.parent_id, 1 UNION ALL SELECT c.parent_id, anc.d + 1 FROM collections c JOIN anc ON c.id = anc.id WHERE c.parent_id IS NOT NULL AND anc.d < 20)
    SELECT MAX(d) FROM anc) >= 8;
END;

CREATE TABLE source_collections (
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, collection_id)
) STRICT;
CREATE INDEX source_collections_collection_idx ON source_collections (collection_id);

CREATE TABLE collection_memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  zim_package_id INTEGER,
  zim_path TEXT,
  added_by TEXT NOT NULL CHECK (added_by IN ('user','rule','source')),
  added_at INTEGER NOT NULL,
  CHECK ((page_id IS NOT NULL) <> (zim_package_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX collection_memberships_page_uq ON collection_memberships (collection_id, page_id) WHERE page_id IS NOT NULL;
CREATE UNIQUE INDEX collection_memberships_zim_uq ON collection_memberships (collection_id, zim_package_id, zim_path) WHERE zim_package_id IS NOT NULL;
CREATE INDEX collection_memberships_page_idx ON collection_memberships (page_id);

-- The source reference (docs/data-model.md 5.1). Phase 6: reference priority = COALESCE(priority_override, sources.priority);
-- retention and automatic_eviction come from the source row; the reference is active while sources.deleted_at IS NULL
-- (disabled and paused sources still count). Deleting a source removes its rows.
CREATE TABLE page_sources (
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  discovered_via TEXT NOT NULL DEFAULT 'manual' CHECK (discovered_via IN ('seed','link','sitemap','feed','search','manual')),
  depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0),
  priority_override INTEGER CHECK (priority_override IS NULL OR priority_override BETWEEN 1 AND 4),
  PRIMARY KEY (page_id, source_id)
) STRICT;
CREATE INDEX page_sources_source_idx ON page_sources (source_id);

CREATE TABLE source_discovered_urls (
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  url_key TEXT NOT NULL,
  url TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('sitemap','feed')),
  item_date INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, url_key)
) STRICT;

CREATE TABLE url_exclusions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
  url_key TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('deleted_by_user','blocked','trap')),
  created_at INTEGER NOT NULL,
  UNIQUE (source_id, url_key)
) STRICT;
-- UNIQUE treats NULLs as distinct, so the "all sources" rows need their own index.
CREATE UNIQUE INDEX url_exclusions_global_uq ON url_exclusions (url_key) WHERE source_id IS NULL;

CREATE TABLE download_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  days_mask INTEGER NOT NULL CHECK (days_mask BETWEEN 1 AND 127),
  start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute INTEGER NOT NULL CHECK (end_minute BETWEEN 0 AND 1440 AND end_minute <> start_minute),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  limits_json TEXT CHECK (limits_json IS NULL OR json_valid(limits_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX download_windows_source_idx ON download_windows (source_id);

CREATE TABLE schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('manual','hourly','daily','weekly','cron')),
  cron_expr TEXT,
  spec_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(spec_json)),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  window_id INTEGER REFERENCES download_windows(id) ON DELETE SET NULL,
  missed_run_policy TEXT NOT NULL DEFAULT 'run_once' CHECK (missed_run_policy IN ('skip','run_once')),
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_slot_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX schedules_due_idx ON schedules (enabled, next_run_at);
CREATE INDEX schedules_source_idx ON schedules (source_id);

ALTER TABLE download_jobs ADD COLUMN paused_by_window INTEGER NOT NULL DEFAULT 0 CHECK (paused_by_window IN (0,1));

-- Before the foreign keys go on, any value in those columns must point at a real row. Nothing could have created a source
-- or a collection before this migration, so a non-NULL value can only be stale and is cleared.
UPDATE download_jobs SET source_id = NULL WHERE source_id IS NOT NULL;
UPDATE download_jobs SET config_id = NULL WHERE config_id IS NOT NULL;
UPDATE crawl_jobs SET source_id = NULL WHERE source_id IS NOT NULL;
UPDATE crawl_jobs SET config_id = NULL WHERE config_id IS NOT NULL;
UPDATE page_versions SET source_id = NULL WHERE source_id IS NOT NULL;
UPDATE bookmarks SET collection_id = NULL WHERE collection_id IS NOT NULL;

-- Foreign keys for columns that were plain integers. Executed after the statements above.
-- ncb:fk download_jobs.source_id REFERENCES sources(id) ON DELETE SET NULL
-- ncb:fk download_jobs.config_id REFERENCES source_configs(id) ON DELETE SET NULL
-- ncb:fk crawl_jobs.source_id REFERENCES sources(id) ON DELETE SET NULL
-- ncb:fk crawl_jobs.config_id REFERENCES source_configs(id) ON DELETE SET NULL
-- ncb:fk page_versions.source_id REFERENCES sources(id) ON DELETE SET NULL
-- ncb:fk bookmarks.collection_id REFERENCES collections(id) ON DELETE SET NULL
