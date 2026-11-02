import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
    onResult: text("on_result", { enum: ["candidates", "downloads"] }).notNull().default("candidates"),
    maxResults: integer("max_results").notNull().default(20),
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

// Mirrors migrations/0011_online_search.sql (Phase 5, docs/data-model.md section 3.6). The SQL is the DDL source of truth.

export const PROVIDER_ADAPTERS = ["searxng", "brave", "mojeek"] as const;
export const STORAGE_KINDS = ["none", "ttl", "unrestricted"] as const;

export const searchProviders = sqliteTable(
  "search_providers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicId: text("public_id").notNull().unique(),
    adapter: text("adapter", { enum: PROVIDER_ADAPTERS }).notNull(),
    name: text("name").notNull(),
    enabled: integer("enabled").notNull().default(0),
    priority: integer("priority").notNull().default(100),
    baseUrl: text("base_url"),
    credentialsEnc: text("credentials_enc"),
    timeoutMs: integer("timeout_ms").notNull().default(4000),
    rateLimitPerSec: real("rate_limit_per_sec").notNull().default(1),
    monthlyCap: integer("monthly_cap"),
    dailyCap: integer("daily_cap"),
    fallbackProviderId: integer("fallback_provider_id"),
    language: text("language"),
    region: text("region"),
    safeSearch: text("safe_search", { enum: ["off", "moderate", "strict"] }).notNull().default("moderate"),
    storageKind: text("storage_kind", { enum: STORAGE_KINDS }).notNull(),
    storageTtlSeconds: integer("storage_ttl_seconds"),
    weight: real("weight").notNull().default(1),
    healthState: text("health_state", { enum: ["unknown", "ok", "degraded", "down"] }).notNull().default("unknown"),
    lastOkAt: integer("last_ok_at"),
    lastErrorCode: text("last_error_code"),
    circuitOpenUntil: integer("circuit_open_until"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("search_providers_enabled_idx").on(t.enabled, t.priority)],
);

export const providerResultCache = sqliteTable(
  "provider_result_cache",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    providerId: integer("provider_id").notNull().references(() => searchProviders.id, { onDelete: "cascade" }),
    queryHash: text("query_hash").notNull(),
    page: integer("page").notNull(),
    resultsJson: text("results_json").notNull(),
    fetchedAt: integer("fetched_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("provider_result_cache_expires_idx").on(t.expiresAt)],
);

export const usageCounters = sqliteTable(
  "usage_counters",
  {
    kind: text("kind", { enum: ["provider_requests", "discovery_bytes", "discovery_requests", "wikipedia_requests"] }).notNull(),
    subject: text("subject").notNull(),
    period: text("period").notNull(),
    count: integer("count").notNull().default(0),
    bytes: integer("bytes").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.kind, t.subject, t.period] })],
);

export const discoveryCandidates = sqliteTable(
  "discovery_candidates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicId: text("public_id").notNull().unique(),
    url: text("url").notNull(),
    urlKey: text("url_key").notNull().unique(),
    titleHint: text("title_hint"),
    state: text("state", { enum: ["new", "approved", "queued", "archived", "dismissed", "expired"] }).notNull().default("new"),
    score: real("score").notNull().default(0),
    scoreComponentsJson: text("score_components_json"),
    estBytes: integer("est_bytes"),
    suggestedSourceId: integer("suggested_source_id"),
    suggestedCollectionId: integer("suggested_collection_id"),
    originStorage: text("origin_storage", { enum: STORAGE_KINDS }),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    expiresAt: integer("expires_at"),
    decidedBy: text("decided_by"),
    decidedAt: integer("decided_at"),
  },
  (t) => [index("discovery_candidates_state_idx").on(t.state, t.score), index("discovery_candidates_expires_idx").on(t.expiresAt)],
);

export const candidateProvenance = sqliteTable(
  "candidate_provenance",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    candidateId: integer("candidate_id").notNull().references(() => discoveryCandidates.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["link", "search_result", "saved_search", "visit", "bookmark", "missing_link", "manual"] }).notNull(),
    refPageId: integer("ref_page_id"),
    refSearchId: integer("ref_search_id"),
    refSourceId: integer("ref_source_id"),
    detail: text("detail"),
    weight: real("weight"),
    seenAt: integer("seen_at").notNull(),
  },
  (t) => [index("candidate_provenance_candidate_idx").on(t.candidateId)],
);
