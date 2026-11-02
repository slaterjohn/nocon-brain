import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex, unique, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { blobs } from "./storage.js";
import { downloadJobs } from "./jobs.js";

// Mirrors migrations/0003_pages_versions.sql (docs/data-model.md section 3.4). The SQL is the DDL source of
// truth; these definitions type queries and are checked against the migrated database by schema-sync.test.ts.

export const PIPELINE_STAGES = [
  "validate", "store_original", "assets", "metadata", "readable", "sections", "links", "normalise", "dedup",
  "reader", "render_prep", "index", "link_graph", "candidates", "status",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export const STAGE_STATES = ["pending", "running", "done", "failed", "skipped"] as const;
export const VERSION_STATUSES = ["capturing", "ready", "partial", "failed", "evicting", "evicted"] as const;
export const PARTIAL_REASONS = ["assets_missing", "truncated", "reader_only", "size_cap"] as const;
export const AVAILABILITIES = ["archived", "partial", "evicted", "failed"] as const;

export const pages = sqliteTable(
  "pages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicId: text("public_id").notNull().unique(),
    urlKey: text("url_key").notNull().unique(),
    canonicalUrl: text("canonical_url").notNull(),
    host: text("host").notNull(),
    registrableDomain: text("registrable_domain").notNull(),
    origin: text("origin", { enum: ["web", "wikipedia", "import"] }).notNull().default("web"),
    contentType: text("content_type", { enum: ["html", "pdf", "image", "text", "other"] }),
    title: text("title"),
    language: text("language"),
    latestVersionId: integer("latest_version_id").references((): AnySQLiteColumn => pageVersions.id, { onDelete: "set null" }),
    versionCount: integer("version_count").notNull().default(0),
    availability: text("availability", { enum: AVAILABILITIES }).notNull().default("failed"),
    effectivePriority: integer("effective_priority"),
    inboundCount: integer("inbound_count").notNull().default(0),
    firstCapturedAt: integer("first_captured_at"),
    lastCapturedAt: integer("last_captured_at"),
    lastCheckedAt: integer("last_checked_at"),
    /** Set by a refresh that got 404 or 410. The page and its versions stay (0007). */
    goneAt: integer("gone_at"),
    goneStatus: integer("gone_status"),
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    index("pages_host_idx").on(t.host),
    index("pages_registrable_domain_idx").on(t.registrableDomain),
    index("pages_availability_idx").on(t.availability),
    index("pages_last_captured_idx").on(t.lastCapturedAt),
    index("pages_priority_idx").on(t.effectivePriority, t.lastCapturedAt),
    index("pages_multi_version_idx").on(t.lastCapturedAt).where(sql`${t.versionCount} > 1`),
  ],
);

export const pageAliases = sqliteTable(
  "page_aliases",
  {
    urlKey: text("url_key").primaryKey(),
    pageId: integer("page_id").notNull().references(() => pages.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["redirect", "canonical", "alias", "trailing_slash"] }).notNull(),
    firstSeenAt: integer("first_seen_at").notNull(),
  },
  (t) => [index("page_aliases_page_idx").on(t.pageId)],
);

export const pageVersions = sqliteTable(
  "page_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicId: text("public_id").notNull().unique(),
    pageId: integer("page_id").notNull().references(() => pages.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    sourceId: integer("source_id"),
    downloadJobId: integer("download_job_id").references(() => downloadJobs.id, { onDelete: "set null" }),
    crawlJobId: integer("crawl_job_id"),
    requestedUrl: text("requested_url").notNull(),
    finalUrl: text("final_url").notNull(),
    status: text("status", { enum: VERSION_STATUSES }).notNull().default("capturing"),
    partialReason: text("partial_reason", { enum: PARTIAL_REASONS }),
    httpStatus: integer("http_status"),
    renderMode: text("render_mode", { enum: ["plain", "browser"] }).notNull().default("plain"),
    documentBlobId: integer("document_blob_id").references(() => blobs.id, { onDelete: "restrict" }),
    rawHash: text("raw_hash"),
    rawBytes: integer("raw_bytes"),
    mime: text("mime"),
    contentHash: text("content_hash"),
    simhash: text("simhash"),
    duplicateOfVersionId: integer("duplicate_of_version_id").references((): AnySQLiteColumn => pageVersions.id, { onDelete: "set null" }),
    etag: text("etag"),
    lastModified: text("last_modified"),
    title: text("title"),
    description: text("description"),
    language: text("language"),
    author: text("author"),
    siteName: text("site_name"),
    publishedAt: integer("published_at"),
    modifiedAt: integer("modified_at"),
    publishedSource: text("published_source", { enum: ["og", "jsonld", "time_element", "meta", "url", "none"] }),
    publishedConfidence: text("published_confidence", { enum: ["high", "medium", "low"] }),
    wordCount: integer("word_count"),
    totalBytes: integer("total_bytes"),
    headersJson: text("headers_json"),
    metadataJson: text("metadata_json"),
    failureStage: text("failure_stage"),
    failureMessage: text("failure_message"),
    extractorVersion: text("extractor_version"),
    rewriterVersion: text("rewriter_version"),
    pipelineVersion: text("pipeline_version"),
    retained: integer("retained").notNull().default(1),
    fetchedAt: integer("fetched_at").notNull(),
    createdAt: integer("created_at").notNull(),
    evictedAt: integer("evicted_at"),
    lastAccessedAt: integer("last_accessed_at"),
  },
  (t) => [
    unique("page_versions_page_no_uq").on(t.pageId, t.versionNo),
    index("page_versions_page_idx").on(t.pageId, sql`${t.versionNo} DESC`),
    index("page_versions_status_idx").on(t.status),
    index("page_versions_content_hash_idx").on(t.contentHash),
    index("page_versions_raw_hash_idx").on(t.rawHash),
    index("page_versions_source_idx").on(t.sourceId),
    index("page_versions_fetched_idx").on(t.fetchedAt),
    index("page_versions_job_idx").on(t.downloadJobId),
    index("page_versions_rendered_idx").on(t.pageId).where(sql`${t.renderMode} = 'browser'`),
  ],
);

export const versionContent = sqliteTable("version_content", {
  versionId: integer("version_id").primaryKey().references(() => pageVersions.id, { onDelete: "cascade" }),
  textBlobId: integer("text_blob_id").references(() => blobs.id, { onDelete: "restrict" }),
  readerBlobId: integer("reader_blob_id").references(() => blobs.id, { onDelete: "restrict" }),
  outlineBlobId: integer("outline_blob_id").references(() => blobs.id, { onDelete: "restrict" }),
  extractionBlobId: integer("extraction_blob_id").references(() => blobs.id, { onDelete: "restrict" }),
  extractionMethod: text("extraction_method", { enum: ["readability", "defuddle", "body_text", "none"] }),
  keywordsJson: text("keywords_json"),
});

export const pageAttributions = sqliteTable("page_attributions", {
  versionId: integer("version_id").primaryKey().references(() => pageVersions.id, { onDelete: "cascade" }),
  licenseName: text("license_name"),
  licenseUrl: text("license_url"),
  sourceUrl: text("source_url"),
  revisionId: text("revision_id"),
  historyUrl: text("history_url"),
  creditText: text("credit_text"),
});

export const assets = sqliteTable(
  "assets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    blobId: integer("blob_id").references(() => blobs.id, { onDelete: "restrict" }),
    url: text("url").notNull(),
    urlKey: text("url_key").notNull(),
    kind: text("kind", { enum: ["document", "css", "image", "font", "media", "pdf", "other"] }).notNull().default("other"),
    mime: text("mime"),
    httpStatus: integer("http_status"),
    sizeBytes: integer("size_bytes"),
    status: text("status", { enum: ["ok", "error", "blocked", "skipped"] }).notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (t) => [
    uniqueIndex("assets_url_blob_uq").on(t.urlKey, t.blobId).where(sql`${t.blobId} IS NOT NULL`),
    uniqueIndex("assets_negative_uq").on(t.urlKey, t.status).where(sql`${t.blobId} IS NULL`),
    index("assets_blob_idx").on(t.blobId),
  ],
);

export const ASSET_ROLES = ["document", "stylesheet", "image", "font", "media", "icon", "other"] as const;

export const assetReferences = sqliteTable(
  "asset_references",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    versionId: integer("version_id").notNull().references(() => pageVersions.id, { onDelete: "cascade" }),
    assetId: integer("asset_id").notNull().references(() => assets.id, { onDelete: "restrict" }),
    viaAssetId: integer("via_asset_id").references(() => assets.id, { onDelete: "restrict" }),
    role: text("role", { enum: ASSET_ROLES }).notNull().default("other"),
    referencedUrl: text("referenced_url").notNull(),
  },
  (t) => [
    unique("asset_references_uq").on(t.versionId, t.assetId, t.referencedUrl),
    index("asset_references_asset_idx").on(t.assetId),
    index("asset_references_version_url_idx").on(t.versionId, t.referencedUrl),
  ],
);

export const assetAttributions = sqliteTable("asset_attributions", {
  assetId: integer("asset_id").primaryKey().references(() => assets.id, { onDelete: "cascade" }),
  author: text("author"),
  licenseName: text("license_name"),
  licenseUrl: text("license_url"),
  sourcePageUrl: text("source_page_url"),
});

export const versionResources = sqliteTable(
  "version_resources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    versionId: integer("version_id").notNull().references(() => pageVersions.id, { onDelete: "cascade" }),
    resourceKey: text("resource_key").notNull(),
    url: text("url").notNull(),
    assetId: integer("asset_id").references(() => assets.id, { onDelete: "restrict" }),
    viaResourceKey: text("via_resource_key"),
    role: text("role", { enum: ASSET_ROLES }).notNull().default("other"),
    status: text("status", { enum: ["ok", "missing", "blocked", "skipped"] }).notNull(),
  },
  (t) => [
    unique("version_resources_key_uq").on(t.versionId, t.resourceKey),
    unique("version_resources_url_uq").on(t.versionId, t.url),
    index("version_resources_asset_idx").on(t.assetId),
  ],
);

export const links = sqliteTable(
  "links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fromVersionId: integer("from_version_id").notNull().references(() => pageVersions.id, { onDelete: "cascade" }),
    fromPageId: integer("from_page_id").notNull().references(() => pages.id, { onDelete: "cascade" }),
    toUrl: text("to_url").notNull(),
    toUrlKey: text("to_url_key").notNull(),
    toPageId: integer("to_page_id").references(() => pages.id, { onDelete: "set null" }),
    anchorText: text("anchor_text"),
    context: text("context"),
    region: text("region", { enum: ["content", "heading", "related", "nav", "footer", "other"] }).notNull().default("other"),
    score: real("score").notNull().default(0),
    featuresJson: text("features_json"),
    isInternal: integer("is_internal").notNull().default(0),
    relNofollow: integer("rel_nofollow").notNull().default(0),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    index("links_from_version_idx").on(t.fromVersionId),
    index("links_to_url_key_idx").on(t.toUrlKey),
    index("links_to_page_idx").on(t.toPageId),
    index("links_from_to_page_idx").on(t.fromPageId, t.toPageId),
  ],
);

export const pipelineStageRuns = sqliteTable(
  "pipeline_stage_runs",
  {
    versionId: integer("version_id").notNull().references(() => pageVersions.id, { onDelete: "cascade" }),
    stage: text("stage", { enum: PIPELINE_STAGES }).notNull(),
    state: text("state", { enum: STAGE_STATES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    detailJson: text("detail_json"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [primaryKey({ columns: [t.versionId, t.stage] }), index("pipeline_stage_runs_state_idx").on(t.state)],
);
