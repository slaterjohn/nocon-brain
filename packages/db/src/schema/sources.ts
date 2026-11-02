import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { pages } from "./pages.js";

// Mirrors migrations/0006_sources_collections.sql (docs/data-model.md section 3.3). The SQL is the DDL source of truth;
// test/schema-sync.test.ts fails if the two drift apart.

export const SOURCE_TYPES = ["single_page", "website", "section", "linked_collection", "sitemap", "feed", "saved_search", "knowledge_package", "imported_documents"] as const;
export const SYSTEM_SOURCE_KINDS = ["quick_saves", "browsing_cache", "imports"] as const;
export const COLLECTION_KINDS = ["manual", "auto", "saved_search", "favourites"] as const;
export const SCHEDULE_KINDS = ["manual", "hourly", "daily", "weekly", "cron"] as const;
export const DISCOVERED_VIA = ["seed", "link", "sitemap", "feed", "search", "manual"] as const;

export const sources = sqliteTable(
  "sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicId: text("public_id").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type", { enum: SOURCE_TYPES }).notNull(),
    adapter: text("adapter", { enum: ["http", "wikipedia", "zim", "import"] }).notNull().default("http"),
    startUrl: text("start_url"),
    strategy: text("strategy", { enum: ["capture", "explore", "mirror"] }).notNull(),
    profile: text("profile", { enum: ["focused", "balanced", "comprehensive", "custom"] }).notNull(),
    currentConfigId: integer("current_config_id"),
    priority: integer("priority").notNull(),
    retentionMode: text("retention_mode", { enum: ["all", "latest", "time", "budget", "custom"] }).notNull(),
    retentionJson: text("retention_json").notNull().default("{}"),
    automaticEviction: integer("automatic_eviction").notNull(),
    storageBudgetBytes: integer("storage_budget_bytes"),
    preferredVolumeId: integer("preferred_volume_id"),
    discoveryEnabled: integer("discovery_enabled").notNull().default(0),
    enabled: integer("enabled").notNull().default(1),
    systemKind: text("system_kind", { enum: SYSTEM_SOURCE_KINDS }),
    savedSearchId: integer("saved_search_id"),
    pausedAt: integer("paused_at"),
    lastRunAt: integer("last_run_at"),
    nextRunAt: integer("next_run_at"),
    lastStatus: text("last_status"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    uniqueIndex("sources_system_kind_uq").on(t.systemKind).where(sql`${t.systemKind} IS NOT NULL`),
    index("sources_live_idx").on(t.deletedAt, t.enabled),
  ],
);

export const sourceConfigs = sqliteTable(
  "source_configs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    configJson: text("config_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("source_configs_source_id_version_unique").on(t.sourceId, t.version)],
);

export const collections = sqliteTable(
  "collections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicId: text("public_id").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon").notNull().default("folder"),
    kind: text("kind", { enum: COLLECTION_KINDS }).notNull().default("manual"),
    parentId: integer("parent_id"),
    ruleJson: text("rule_json"),
    priorityFloor: integer("priority_floor"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("collections_parent_idx").on(t.parentId)],
);

export const sourceCollections = sqliteTable(
  "source_collections",
  {
    sourceId: integer("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
    collectionId: integer("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.collectionId] })],
);

export const collectionMemberships = sqliteTable(
  "collection_memberships",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    collectionId: integer("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
    pageId: integer("page_id").references(() => pages.id, { onDelete: "cascade" }),
    zimPackageId: integer("zim_package_id"),
    zimPath: text("zim_path"),
    addedBy: text("added_by", { enum: ["user", "rule", "source"] }).notNull(),
    addedAt: integer("added_at").notNull(),
  },
  (t) => [index("collection_memberships_page_idx").on(t.pageId)],
);

export const pageSources = sqliteTable(
  "page_sources",
  {
    pageId: integer("page_id").notNull().references(() => pages.id, { onDelete: "cascade" }),
    sourceId: integer("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    discoveredVia: text("discovered_via", { enum: DISCOVERED_VIA }).notNull().default("manual"),
    depth: integer("depth").notNull().default(0),
    priorityOverride: integer("priority_override"),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.sourceId] }), index("page_sources_source_idx").on(t.sourceId)],
);

export const sourceDiscoveredUrls = sqliteTable(
  "source_discovered_urls",
  {
    sourceId: integer("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
    urlKey: text("url_key").notNull(),
    url: text("url").notNull(),
    via: text("via", { enum: ["sitemap", "feed"] }).notNull(),
    itemDate: integer("item_date"),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.urlKey] })],
);

export const urlExclusions = sqliteTable(
  "url_exclusions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id").references(() => sources.id, { onDelete: "cascade" }),
    urlKey: text("url_key").notNull(),
    reason: text("reason", { enum: ["deleted_by_user", "blocked", "trap"] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("url_exclusions_source_id_url_key_unique").on(t.sourceId, t.urlKey)],
);

export const downloadWindows = sqliteTable(
  "download_windows",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicId: text("public_id").notNull().unique(),
    sourceId: integer("source_id").references(() => sources.id, { onDelete: "cascade" }),
    name: text("name").notNull().default(""),
    daysMask: integer("days_mask").notNull(),
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    limitsJson: text("limits_json"),
    enabled: integer("enabled").notNull().default(1),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("download_windows_source_idx").on(t.sourceId)],
);

export const schedules = sqliteTable(
  "schedules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicId: text("public_id").notNull().unique(),
    sourceId: integer("source_id").references(() => sources.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: SCHEDULE_KINDS }).notNull(),
    cronExpr: text("cron_expr"),
    specJson: text("spec_json").notNull().default("{}"),
    timezone: text("timezone").notNull().default("UTC"),
    windowId: integer("window_id").references(() => downloadWindows.id, { onDelete: "set null" }),
    missedRunPolicy: text("missed_run_policy", { enum: ["skip", "run_once"] }).notNull().default("run_once"),
    nextRunAt: integer("next_run_at"),
    lastRunAt: integer("last_run_at"),
    lastSlotAt: integer("last_slot_at"),
    enabled: integer("enabled").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("schedules_due_idx").on(t.enabled, t.nextRunAt), index("schedules_source_idx").on(t.sourceId)],
);
