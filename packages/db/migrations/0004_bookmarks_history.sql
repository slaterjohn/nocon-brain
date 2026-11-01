-- 0004_bookmarks_history: bookmarks and browsing history (Phase 2, task A-17).
-- Source: docs/data-model.md section 3.8 (bookmarks, history_entries). Hand-written for STRICT tables and partial indexes.
--
-- Deliberate differences from the doc (recorded in docs/data-model.md as Phase 2 notes):
--   * bookmarks.collection_id and bookmarks.zim_package_id are plain integers: `collections` and `zim_packages` arrive
--     in later phases and a table rebuild adds the foreign keys then (same approach as download_jobs.source_id).
--   * bookmarks.reference_priority stores the value of `browser.bookmarkPriority` at the time of the bookmark. Phase 6
--     (storage priorities) reads it when it computes a page's effective priority; nothing reads it before then.
--   * No frame-grant table: archive tokens are stateless signed capabilities (docs/api.md section 5).

CREATE TABLE bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_url TEXT NOT NULL,
  url_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  version_id INTEGER REFERENCES page_versions(id) ON DELETE SET NULL,
  zim_package_id INTEGER,
  zim_path TEXT,
  collection_id INTEGER,
  reference_priority INTEGER NOT NULL DEFAULT 2 CHECK (reference_priority BETWEEN 1 AND 4),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;
CREATE INDEX bookmarks_user_created_idx ON bookmarks (user_id, created_at);
CREATE INDEX bookmarks_url_key_idx ON bookmarks (url_key);
CREATE INDEX bookmarks_page_idx ON bookmarks (page_id);
-- One live bookmark per user and URL.
CREATE UNIQUE INDEX bookmarks_user_url_uq ON bookmarks (user_id, url_key) WHERE deleted_at IS NULL;

CREATE TABLE history_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  url_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  visited_at INTEGER NOT NULL,
  page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  zim_package_id INTEGER,
  served_from TEXT NOT NULL CHECK (served_from IN ('archive','cache','zim','live','offline'))
) STRICT;
CREATE INDEX history_user_visited_idx ON history_entries (user_id, visited_at);
CREATE INDEX history_url_key_idx ON history_entries (url_key);
