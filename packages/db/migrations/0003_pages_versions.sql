-- 0003_pages_versions: pages, versions, assets, links and the pipeline state (Phase 2, tasks A-05 to A-11).
-- Source: docs/data-model.md section 3.4. Hand-written for STRICT tables and partial indexes.
--
-- Deliberate differences from the doc (all recorded in docs/data-model.md as "Phase 2 notes"):
--   * page_versions.source_id and page_versions.crawl_job_id are plain integers: `sources` and the crawl
--     frontier tables arrive in Phase 3, and a table rebuild adds the foreign keys then (same approach as
--     download_jobs.source_id in 0001). download_job_id is a real foreign key.
--   * assets.blob_id is NULLABLE: a failed or blocked fetch keeps a negative record with no blob. Uniqueness
--     of (url_key, blob_id) does not cover NULLs in SQLite, so a partial unique index covers negative rows.
--   * assets.status gains 'skipped' (per-capture cap reached; nothing was fetched).
--   * page_versions gains duplicate_of_version_id, simhash (reserved, unused), metadata_json, mime, raw_bytes.
--   * version_content gains extraction_blob_id (intermediate extraction result) and extraction_method.
--   * version_resources is new: the per-version resource table with the rewritten key the archive listener
--     serves sub-resources under (docs/architecture.md stage 11).
--   * page_pins, page_sources and url_exclusions are not created here: they depend on `sources` (Phase 3)
--     and on bookmarks (A-17).
--   * jobs.version_id still has no FOREIGN KEY: adding one to the existing table needs a rebuild, deferred to
--     the table-rebuild migration that also adds the sources foreign keys.

CREATE TABLE pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  url_key TEXT NOT NULL UNIQUE,
  canonical_url TEXT NOT NULL,
  host TEXT NOT NULL,
  registrable_domain TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'web' CHECK (origin IN ('web','wikipedia','import')),
  content_type TEXT CHECK (content_type IS NULL OR content_type IN ('html','pdf','image','text','other')),
  title TEXT,
  language TEXT,
  latest_version_id INTEGER REFERENCES page_versions(id) ON DELETE SET NULL,
  version_count INTEGER NOT NULL DEFAULT 0 CHECK (version_count >= 0),
  -- 'failed' until the first version is finalised (a page with no ready version has never succeeded).
  availability TEXT NOT NULL DEFAULT 'failed' CHECK (availability IN ('archived','partial','evicted','failed')),
  effective_priority INTEGER CHECK (effective_priority IS NULL OR effective_priority BETWEEN 1 AND 4),
  inbound_count INTEGER NOT NULL DEFAULT 0 CHECK (inbound_count >= 0),
  first_captured_at INTEGER,
  last_captured_at INTEGER,
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE INDEX pages_host_idx ON pages (host);
CREATE INDEX pages_registrable_domain_idx ON pages (registrable_domain);
CREATE INDEX pages_availability_idx ON pages (availability);
CREATE INDEX pages_last_captured_idx ON pages (last_captured_at);
CREATE INDEX pages_priority_idx ON pages (effective_priority, last_captured_at);

CREATE TABLE page_aliases (
  url_key TEXT PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('redirect','canonical','alias','trailing_slash')),
  first_seen_at INTEGER NOT NULL
) STRICT;
CREATE INDEX page_aliases_page_idx ON page_aliases (page_id);

CREATE TABLE page_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  source_id INTEGER,
  download_job_id INTEGER REFERENCES download_jobs(id) ON DELETE SET NULL,
  crawl_job_id INTEGER,
  requested_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'capturing' CHECK (status IN ('capturing','ready','partial','failed','evicting','evicted')),
  partial_reason TEXT CHECK (partial_reason IS NULL OR partial_reason IN ('assets_missing','truncated','reader_only','size_cap')),
  http_status INTEGER,
  render_mode TEXT NOT NULL DEFAULT 'plain' CHECK (render_mode IN ('plain','browser')),
  document_blob_id INTEGER REFERENCES blobs(id) ON DELETE RESTRICT,
  raw_hash TEXT,
  raw_bytes INTEGER,
  mime TEXT,
  content_hash TEXT,
  simhash TEXT,
  duplicate_of_version_id INTEGER REFERENCES page_versions(id) ON DELETE SET NULL,
  etag TEXT,
  last_modified TEXT,
  title TEXT,
  description TEXT,
  language TEXT,
  author TEXT,
  site_name TEXT,
  published_at INTEGER,
  modified_at INTEGER,
  published_source TEXT CHECK (published_source IS NULL OR published_source IN ('og','jsonld','time_element','meta','url','none')),
  published_confidence TEXT CHECK (published_confidence IS NULL OR published_confidence IN ('high','medium','low')),
  word_count INTEGER,
  total_bytes INTEGER,
  headers_json TEXT CHECK (headers_json IS NULL OR json_valid(headers_json)),
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  failure_stage TEXT,
  failure_message TEXT,
  extractor_version TEXT,
  rewriter_version TEXT,
  pipeline_version TEXT,
  retained INTEGER NOT NULL DEFAULT 1 CHECK (retained IN (0,1)),
  fetched_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  evicted_at INTEGER,
  last_accessed_at INTEGER,
  UNIQUE (page_id, version_no)
) STRICT;
CREATE INDEX page_versions_page_idx ON page_versions (page_id, version_no DESC);
CREATE INDEX page_versions_status_idx ON page_versions (status);
CREATE INDEX page_versions_content_hash_idx ON page_versions (content_hash);
CREATE INDEX page_versions_raw_hash_idx ON page_versions (raw_hash);
CREATE INDEX page_versions_source_idx ON page_versions (source_id);
CREATE INDEX page_versions_fetched_idx ON page_versions (fetched_at);
CREATE INDEX page_versions_job_idx ON page_versions (download_job_id);

CREATE TABLE version_content (
  version_id INTEGER PRIMARY KEY REFERENCES page_versions(id) ON DELETE CASCADE,
  text_blob_id INTEGER REFERENCES blobs(id) ON DELETE RESTRICT,
  reader_blob_id INTEGER REFERENCES blobs(id) ON DELETE RESTRICT,
  outline_blob_id INTEGER REFERENCES blobs(id) ON DELETE RESTRICT,
  extraction_blob_id INTEGER REFERENCES blobs(id) ON DELETE RESTRICT,
  extraction_method TEXT CHECK (extraction_method IS NULL OR extraction_method IN ('readability','defuddle','body_text','none')),
  keywords_json TEXT CHECK (keywords_json IS NULL OR json_valid(keywords_json))
) STRICT;

CREATE TABLE page_attributions (
  version_id INTEGER PRIMARY KEY REFERENCES page_versions(id) ON DELETE CASCADE,
  license_name TEXT,
  license_url TEXT,
  source_url TEXT,
  revision_id TEXT,
  history_url TEXT,
  credit_text TEXT
) STRICT;

CREATE TABLE assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blob_id INTEGER REFERENCES blobs(id) ON DELETE RESTRICT,
  url TEXT NOT NULL,
  url_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('document','css','image','font','media','pdf','other')),
  mime TEXT,
  http_status INTEGER,
  size_bytes INTEGER,
  status TEXT NOT NULL CHECK (status IN ('ok','error','blocked','skipped')),
  error_code TEXT,
  error_message TEXT,
  fetched_at INTEGER NOT NULL,
  CHECK ((status = 'ok' AND blob_id IS NOT NULL) OR (status <> 'ok' AND blob_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX assets_url_blob_uq ON assets (url_key, blob_id) WHERE blob_id IS NOT NULL;
-- One negative record per URL and failure status; a later success adds a separate row with a blob.
CREATE UNIQUE INDEX assets_negative_uq ON assets (url_key, status) WHERE blob_id IS NULL;
CREATE INDEX assets_blob_idx ON assets (blob_id);

CREATE TABLE asset_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES page_versions(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  via_asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
  role TEXT NOT NULL DEFAULT 'other' CHECK (role IN ('document','stylesheet','image','font','media','icon','other')),
  referenced_url TEXT NOT NULL,
  UNIQUE (version_id, asset_id, referenced_url)
) STRICT;
CREATE INDEX asset_references_asset_idx ON asset_references (asset_id);
CREATE INDEX asset_references_version_url_idx ON asset_references (version_id, referenced_url);

CREATE TABLE asset_attributions (
  asset_id INTEGER PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  author TEXT,
  license_name TEXT,
  license_url TEXT,
  source_page_url TEXT
) STRICT;

-- Stage 11 output: what the archive listener serves a version's sub-resources under. `resource_key` is a
-- stable, URL-safe key derived from the referenced URL; asset_id is NULL for resources that were not
-- captured (status 'missing'/'blocked'/'skipped'), so the rewriter knows the resource is absent.
CREATE TABLE version_resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES page_versions(id) ON DELETE CASCADE,
  resource_key TEXT NOT NULL,
  url TEXT NOT NULL,
  asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
  via_resource_key TEXT,
  role TEXT NOT NULL DEFAULT 'other' CHECK (role IN ('document','stylesheet','image','font','media','icon','other')),
  status TEXT NOT NULL CHECK (status IN ('ok','missing','blocked','skipped')),
  UNIQUE (version_id, resource_key),
  UNIQUE (version_id, url)
) STRICT;
CREATE INDEX version_resources_asset_idx ON version_resources (asset_id);

CREATE TABLE links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_version_id INTEGER NOT NULL REFERENCES page_versions(id) ON DELETE CASCADE,
  from_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_url TEXT NOT NULL,
  to_url_key TEXT NOT NULL,
  to_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  anchor_text TEXT,
  context TEXT,
  region TEXT NOT NULL DEFAULT 'other' CHECK (region IN ('content','heading','related','nav','footer','other')),
  score REAL NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 1),
  features_json TEXT CHECK (features_json IS NULL OR json_valid(features_json)),
  is_internal INTEGER NOT NULL DEFAULT 0 CHECK (is_internal IN (0,1)),
  rel_nofollow INTEGER NOT NULL DEFAULT 0 CHECK (rel_nofollow IN (0,1)),
  position INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX links_from_version_idx ON links (from_version_id);
CREATE INDEX links_to_url_key_idx ON links (to_url_key);
CREATE INDEX links_to_page_idx ON links (to_page_id);
CREATE INDEX links_from_to_page_idx ON links (from_page_id, to_page_id);

CREATE TABLE pipeline_stage_runs (
  version_id INTEGER NOT NULL REFERENCES page_versions(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('validate','store_original','assets','metadata','readable','sections','links','normalise','dedup','reader','render_prep','index','link_graph','candidates','status')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','done','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (version_id, stage)
) STRICT;
CREATE INDEX pipeline_stage_runs_state_idx ON pipeline_stage_runs (state);
