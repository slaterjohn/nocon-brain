-- 0016_blob_reference_indexes: Phase 9 (task H-09), found by the 500,000-page scale test.
-- Every question of the form "what still uses this file?" (reference counts, the unreferenced-file search, the eviction planner's
-- shared-file count, verify I-3) looks a blob up in version_content by one of its four blob columns. None had an index, so each lookup
-- scanned the whole table and the work grew with the square of the library: verify's reference-count check took 63 s at 30,000 pages.
-- With these indexes it is one lookup per file. They add a few percent to the cost of saving a page and nothing else.
--
-- The same test found that removing a saved copy scanned all of page_versions to clear `duplicate_of_version_id` (the foreign key to the copy
-- being removed had no index), `DELETE FROM blobs` scanned it again for `document_blob_id` (24 ms a file at 100,000 pages), and so did deleting a style sheet or image that nothing uses any more (`via_asset_id`, the asset that
-- pulled another one in, had no index either). Both made eviction slow down as the library grew: 25 ms a copy at 60,000 pages and 83 ms at 100,000.

CREATE INDEX version_content_text_blob_idx ON version_content (text_blob_id);
CREATE INDEX version_content_reader_blob_idx ON version_content (reader_blob_id);
CREATE INDEX version_content_outline_blob_idx ON version_content (outline_blob_id);
CREATE INDEX version_content_extraction_blob_idx ON version_content (extraction_blob_id);
CREATE INDEX import_documents_original_blob_idx ON import_documents (original_blob_id);
CREATE INDEX page_versions_duplicate_of_idx ON page_versions (duplicate_of_version_id) WHERE duplicate_of_version_id IS NOT NULL;
CREATE INDEX asset_references_via_asset_idx ON asset_references (via_asset_id) WHERE via_asset_id IS NOT NULL;
-- Foreign keys that point at a parent row that eviction or deletion removes. SQLite checks the child table on every delete of the parent,
-- so an unindexed child column means a scan per deleted row.
CREATE INDEX page_versions_document_blob_idx ON page_versions (document_blob_id) WHERE document_blob_id IS NOT NULL;
CREATE INDEX pages_latest_version_idx ON pages (latest_version_id) WHERE latest_version_id IS NOT NULL;
CREATE INDEX history_entries_page_idx ON history_entries (page_id) WHERE page_id IS NOT NULL;
CREATE INDEX bookmarks_version_idx ON bookmarks (version_id) WHERE version_id IS NOT NULL;
CREATE INDEX search_history_clicked_page_idx ON search_history (clicked_page_id) WHERE clicked_page_id IS NOT NULL;
