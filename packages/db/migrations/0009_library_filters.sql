-- 0009_library_filters: indexes for the Library list filters (GET /api/archive/pages: type, minVersions).
-- The other filters already have indexes: pages_priority_idx (priority, date range), pages_last_captured_idx,
-- page_sources_source_idx, collection_memberships_page_uq, pages_host_idx.

-- "Rendered" pages are the versions captured with the browser renderer; the partial index stays small.
CREATE INDEX page_versions_rendered_idx ON page_versions (page_id) WHERE render_mode = 'browser';
-- Imported documents by kind (pdf, markdown, text, html).
CREATE INDEX import_documents_kind_idx ON import_documents (kind, page_id);
-- Pages with more than one saved version (`minVersions=2`, the usual use of that filter).
CREATE INDEX pages_multi_version_idx ON pages (last_captured_at) WHERE version_count > 1;
