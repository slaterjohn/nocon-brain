import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pages } from "./pages.js";
import { users } from "./identity.js";
import { sources } from "./sources.js";

// Mirrors migrations/0010_search.sql (docs/data-model.md sections 3.7, 3.9). The SQL is the DDL source of truth.

export const INDEX_OUTBOX_OPS = ["upsert_page", "delete_page", "update_membership", "update_priority", "update_inlinks"] as const;
export const INDEXING_JOB_KINDS = ["rebuild", "reindex_page", "optimize", "vocab_rebuild", "consistency_check"] as const;
export const INDEXING_JOB_STATES = ["queued", "running", "done", "failed", "cancelled"] as const;
export const SEARCH_SCOPES = ["all", "offline", "online", "images", "documents"] as const;

export const indexOutbox = sqliteTable(
  "index_outbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    op: text("op", { enum: INDEX_OUTBOX_OPS }).notNull(),
    pageId: integer("page_id").notNull(),
    versionId: integer("version_id"),
    queuedAt: integer("queued_at").notNull(),
  },
  (t) => [index("index_outbox_page_idx").on(t.pageId)],
);

export const indexGenerations = sqliteTable("index_generations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schemaVersion: integer("schema_version").notNull(),
  tokenizerConfigJson: text("tokenizer_config_json").notNull(),
  state: text("state", { enum: ["building", "active", "retired", "failed"] }).notNull(),
  docCount: integer("doc_count").notNull().default(0),
  builtAt: integer("built_at"),
  rebuildReason: text("rebuild_reason"),
});

export const indexingJobs = sqliteTable(
  "indexing_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: INDEXING_JOB_KINDS }).notNull(),
    scopeJson: text("scope_json"),
    state: text("state", { enum: INDEXING_JOB_STATES }).notNull(),
    docsTotal: integer("docs_total").notNull().default(0),
    docsDone: integer("docs_done").notNull().default(0),
    generationId: integer("generation_id").references(() => indexGenerations.id, { onDelete: "set null" }),
    error: text("error"),
    detailJson: text("detail_json"),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("indexing_jobs_created_idx").on(t.createdAt)],
);

export const savedSearches = sqliteTable(
  "saved_searches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicId: text("public_id").notNull().unique(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    query: text("query").notNull(),
    filtersJson: text("filters_json").notNull().default("{}"),
    scope: text("scope", { enum: SEARCH_SCOPES }).notNull().default("all"),
    includeOnline: integer("include_online").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastRunAt: integer("last_run_at"),
    lastResultCount: integer("last_result_count"),
    sourceId: integer("source_id").references(() => sources.id, { onDelete: "set null" }),
    collectionId: integer("collection_id"),
  },
  (t) => [index("saved_searches_user_idx").on(t.userId, t.createdAt)],
);

export const searchHistory = sqliteTable(
  "search_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    normalisedQuery: text("normalised_query").notNull(),
    at: integer("at").notNull(),
    localCount: integer("local_count").notNull().default(0),
    onlineProvidersJson: text("online_providers_json"),
    scope: text("scope").notNull().default("all"),
    clickedPageId: integer("clicked_page_id").references(() => pages.id, { onDelete: "set null" }),
  },
  (t) => [index("search_history_user_at_idx").on(t.userId, t.at), index("search_history_norm_idx").on(t.normalisedQuery)],
);
