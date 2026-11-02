-- 0008_imports: imported documents (Phase 3, task C-14). docs/data-model.md "Phase 3 notes".
--
-- An upload becomes an ordinary page and version (pages.origin = 'import'). The version's document blob is the HTML the
-- pipeline reads (the upload itself for HTML; derived deterministically for Markdown, text and PDF). The upload's own
-- bytes are kept here, so a better converter or PDF extractor can re-derive the document later and the original can be
-- downloaded. Rendered captures (C-16) need no column: page_versions.render_mode = 'browser' is the "rendered" flag.

CREATE TABLE import_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL UNIQUE REFERENCES page_versions(id) ON DELETE CASCADE,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('html','pdf','text','markdown')),
  filename TEXT NOT NULL,
  declared_mime TEXT,
  detected_mime TEXT NOT NULL,
  original_blob_id INTEGER NOT NULL REFERENCES blobs(id) ON DELETE RESTRICT,
  size_bytes INTEGER NOT NULL,
  page_count INTEGER,
  info_json TEXT CHECK (info_json IS NULL OR json_valid(info_json)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX import_documents_page_idx ON import_documents (page_id);
CREATE INDEX import_documents_source_idx ON import_documents (source_id);
