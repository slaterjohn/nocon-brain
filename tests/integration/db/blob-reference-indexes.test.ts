import { describe, expect, it } from "vitest";
import { migrate, openDb } from "@ncb/db";

// H-09 / HB-24: "what still uses this file?" must be an index lookup. Without these indexes verify's reference-count check took 63 s at
// 30,000 pages, because each file's lookup scanned the whole of version_content.
describe("blob reference lookups use an index", () => {
  const db = openDb(":memory:");
  migrate(db);
  const plan = (sql: string) => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, [1]).map((r) => r.detail).join(" | ");

  it.each(["text_blob_id", "reader_blob_id", "outline_blob_id", "extraction_blob_id"])("version_content.%s", (col) => {
    expect(plan(`SELECT COUNT(*) FROM version_content WHERE ${col} = ?`)).toMatch(/USING (COVERING )?INDEX version_content_/);
  });

  it("import_documents.original_blob_id", () => {
    expect(plan("SELECT COUNT(*) FROM import_documents WHERE original_blob_id = ?")).toMatch(/USING (COVERING )?INDEX import_documents_original_blob_idx/);
  });

  it("page_versions.duplicate_of_version_id (clearing it when a copy is removed)", () => {
    expect(plan("UPDATE page_versions SET duplicate_of_version_id = NULL WHERE duplicate_of_version_id = ?")).toMatch(/USING (COVERING )?INDEX page_versions_duplicate_of_idx/);
  });

  it("deleting an asset that nothing uses looks references up by asset_id and via_asset_id", () => {
    const p = plan("DELETE FROM assets WHERE id = ? AND NOT EXISTS (SELECT 1 FROM asset_references WHERE asset_id = assets.id OR via_asset_id = assets.id)");
    expect(p).not.toMatch(/SCAN asset_references/);
  });

  it("deleting a blob does not scan page_versions for document_blob_id", () => {
    expect(plan("SELECT 1 FROM page_versions WHERE document_blob_id = ?")).toMatch(/USING (COVERING )?INDEX page_versions_document_blob_idx/);
  });

  it.each([["pages", "latest_version_id"], ["history_entries", "page_id"], ["bookmarks", "version_id"], ["search_history", "clicked_page_id"]])("%s.%s (a parent row is deleted)", (t, c) => {
    expect(plan(`SELECT 1 FROM ${t} WHERE ${c} = ?`)).toMatch(/USING (COVERING )?INDEX/);
  });

  it("assets.blob_id", () => {
    expect(plan("SELECT COUNT(*) FROM assets WHERE blob_id = ?")).toMatch(/USING (COVERING )?INDEX/);
  });
});
