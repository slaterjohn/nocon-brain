import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { blobs } from "./storage.js";
import { pages, pageVersions } from "./pages.js";
import { sources } from "./sources.js";

// Mirrors migrations/0008_imports.sql and 0009_library_filters.sql (docs/data-model.md "Phase 3 notes").
export const IMPORT_KINDS = ["html", "pdf", "text", "markdown"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const importDocuments = sqliteTable(
  "import_documents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    versionId: integer("version_id").notNull().unique().references(() => pageVersions.id, { onDelete: "cascade" }),
    pageId: integer("page_id").notNull().references(() => pages.id, { onDelete: "cascade" }),
    sourceId: integer("source_id").references(() => sources.id, { onDelete: "set null" }),
    kind: text("kind", { enum: IMPORT_KINDS }).notNull(),
    filename: text("filename").notNull(),
    declaredMime: text("declared_mime"),
    detectedMime: text("detected_mime").notNull(),
    originalBlobId: integer("original_blob_id").notNull().references(() => blobs.id, { onDelete: "restrict" }),
    sizeBytes: integer("size_bytes").notNull(),
    pageCount: integer("page_count"),
    infoJson: text("info_json"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("import_documents_page_idx").on(t.pageId), index("import_documents_source_idx").on(t.sourceId), index("import_documents_kind_idx").on(t.kind, t.pageId)],
);
