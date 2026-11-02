-- 0010_search: local search bookkeeping in main.db (Phase 4, tasks S-01, S-02, S-12; docs/data-model.md sections 3.9, 6, 3.7).
-- `index.db` itself is a separate derived file (packages/search). Here: the outbox that feeds it, generations and jobs,
-- saved searches and the optional search history.
--
-- Deliberate differences from the doc (recorded in docs/data-model.md):
--   * `index_outbox` rows are written by TRIGGERS on pages, page_versions, collection_memberships, collections and page_sources, so a
--     change and its outbox row are always one transaction, whatever code path made the change. `op` is a hint: the consumer
--     reads the current state of the page and applies it, so rows are idempotent and coalesce per page.
--   * `saved_searches.collection_id` is a plain integer (the collection's rule_json holds the saved search id, so a foreign key
--     here would be circular). `scope` and `updated_at` are added.

CREATE TABLE index_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL CHECK (op IN ('upsert_page','delete_page','update_membership','update_priority','update_inlinks')),
  page_id INTEGER NOT NULL,
  version_id INTEGER,
  queued_at INTEGER NOT NULL
) STRICT;
CREATE INDEX index_outbox_page_idx ON index_outbox (page_id);

CREATE TABLE index_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version INTEGER NOT NULL,
  tokenizer_config_json TEXT NOT NULL CHECK (json_valid(tokenizer_config_json)),
  state TEXT NOT NULL CHECK (state IN ('building','active','retired','failed')),
  doc_count INTEGER NOT NULL DEFAULT 0,
  built_at INTEGER,
  rebuild_reason TEXT
) STRICT;

CREATE TABLE indexing_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('rebuild','reindex_page','optimize','vocab_rebuild','consistency_check')),
  scope_json TEXT CHECK (scope_json IS NULL OR json_valid(scope_json)),
  state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','cancelled')),
  docs_total INTEGER NOT NULL DEFAULT 0,
  docs_done INTEGER NOT NULL DEFAULT 0,
  generation_id INTEGER REFERENCES index_generations(id) ON DELETE SET NULL,
  error TEXT,
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
) STRICT;
CREATE INDEX indexing_jobs_created_idx ON indexing_jobs (created_at);

CREATE TABLE saved_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  filters_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(filters_json)),
  scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all','offline','online','images','documents')),
  include_online INTEGER NOT NULL DEFAULT 0 CHECK (include_online IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_result_count INTEGER,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  collection_id INTEGER
) STRICT;
CREATE INDEX saved_searches_user_idx ON saved_searches (user_id, created_at);

CREATE TABLE search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  normalised_query TEXT NOT NULL,
  at INTEGER NOT NULL,
  local_count INTEGER NOT NULL DEFAULT 0,
  online_providers_json TEXT CHECK (online_providers_json IS NULL OR json_valid(online_providers_json)),
  scope TEXT NOT NULL DEFAULT 'all',
  clicked_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL
) STRICT;
CREATE INDEX search_history_user_at_idx ON search_history (user_id, at);
CREATE INDEX search_history_norm_idx ON search_history (normalised_query);

-- Outbox triggers ------------------------------------------------------------------------------------------------------

CREATE TRIGGER idxo_pages_upsert AFTER UPDATE OF latest_version_id, availability, deleted_at, title, content_type, language ON pages
WHEN OLD.latest_version_id IS NOT NEW.latest_version_id OR OLD.availability IS NOT NEW.availability OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.title IS NOT NEW.title OR OLD.content_type IS NOT NEW.content_type OR OLD.language IS NOT NEW.language
BEGIN
  INSERT INTO index_outbox (op, page_id, version_id, queued_at)
  VALUES (CASE WHEN NEW.deleted_at IS NOT NULL THEN 'delete_page' ELSE 'upsert_page' END, NEW.id, NEW.latest_version_id, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;

CREATE TRIGGER idxo_pages_priority AFTER UPDATE OF effective_priority ON pages
WHEN OLD.effective_priority IS NOT NEW.effective_priority
BEGIN
  INSERT INTO index_outbox (op, page_id, version_id, queued_at) VALUES ('update_priority', NEW.id, NEW.latest_version_id, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;

-- In-links change often while a crawl runs; only a move between coarse buckets (exact below 16, then steps of 16) is worth an update.
CREATE TRIGGER idxo_pages_inlinks AFTER UPDATE OF inbound_count ON pages
WHEN (CASE WHEN OLD.inbound_count < 16 THEN OLD.inbound_count ELSE 16 + OLD.inbound_count / 16 END)
  IS NOT (CASE WHEN NEW.inbound_count < 16 THEN NEW.inbound_count ELSE 16 + NEW.inbound_count / 16 END)
BEGIN
  INSERT INTO index_outbox (op, page_id, version_id, queued_at) VALUES ('update_inlinks', NEW.id, NEW.latest_version_id, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;

CREATE TRIGGER idxo_pages_delete AFTER DELETE ON pages
BEGIN
  INSERT INTO index_outbox (op, page_id, version_id, queued_at) VALUES ('delete_page', OLD.id, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;

-- Eviction moves a version to evicting/evicted; deleting a version may leave the page without content.
CREATE TRIGGER idxo_versions_status AFTER UPDATE OF status ON page_versions
WHEN OLD.status IS NOT NEW.status AND (NEW.status IN ('evicting','evicted') OR OLD.status IN ('evicting','evicted'))
BEGIN
  INSERT INTO index_outbox (op, page_id, version_id, queued_at) VALUES ('upsert_page', NEW.page_id, NEW.id, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;

CREATE TRIGGER idxo_versions_delete AFTER DELETE ON page_versions
BEGIN
  INSERT INTO index_outbox (op, page_id, version_id, queued_at) VALUES ('upsert_page', OLD.page_id, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;

CREATE TRIGGER idxo_membership_insert AFTER INSERT ON collection_memberships WHEN NEW.page_id IS NOT NULL
BEGIN
  INSERT INTO index_outbox (op, page_id, version_id, queued_at) VALUES ('update_membership', NEW.page_id, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;

CREATE TRIGGER idxo_membership_delete AFTER DELETE ON collection_memberships WHEN OLD.page_id IS NOT NULL
BEGIN
  INSERT INTO index_outbox (op, page_id, version_id, queued_at) VALUES ('update_membership', OLD.page_id, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;

-- Moving or deleting a collection changes the ancestor set of every page in it and in the collections below it.
CREATE TRIGGER idxo_collections_move AFTER UPDATE OF parent_id, deleted_at ON collections
WHEN OLD.parent_id IS NOT NEW.parent_id OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  INSERT INTO index_outbox (op, page_id, version_id, queued_at)
  WITH RECURSIVE sub(id) AS (SELECT NEW.id UNION ALL SELECT c.id FROM collections c JOIN sub ON c.parent_id = sub.id)
  SELECT DISTINCT 'update_membership', m.page_id, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000
  FROM collection_memberships m WHERE m.collection_id IN (SELECT id FROM sub) AND m.page_id IS NOT NULL;
END;

CREATE TRIGGER idxo_page_sources_insert AFTER INSERT ON page_sources
BEGIN
  INSERT INTO index_outbox (op, page_id, version_id, queued_at) VALUES ('update_membership', NEW.page_id, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;

CREATE TRIGGER idxo_page_sources_delete AFTER DELETE ON page_sources
BEGIN
  INSERT INTO index_outbox (op, page_id, version_id, queued_at) VALUES ('update_membership', OLD.page_id, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;
