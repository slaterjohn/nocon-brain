import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { downloadJobs } from "./jobs.js";

// Mirrors migrations/0001_foundation.sql (docs/data-model.md section 3.2).

export const volumes = sqliteTable(
  "volumes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicId: text("public_id").notNull().unique(),
    name: text("name").notNull().unique(),
    rootPath: text("root_path").notNull(),
    markerUuid: text("marker_uuid").notNull(),
    state: text("state", { enum: ["online", "offline", "readonly", "draining", "disabled"] }).notNull(),
    quotaBytes: integer("quota_bytes"),
    reserveFreeBytes: integer("reserve_free_bytes").notNull(),
    softThresholdPct: integer("soft_threshold_pct").notNull().default(85),
    evictStartPct: integer("evict_start_pct").notNull().default(90),
    evictTargetPct: integer("evict_target_pct").notNull().default(80),
    isDefault: integer("is_default").notNull().default(0),
    statTotal: integer("stat_total"),
    statFree: integer("stat_free"),
    statAt: integer("stat_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("volumes_one_default").on(t.isDefault).where(sql`${t.isDefault} = 1`)],
);

export const storagePolicies = sqliteTable(
  "storage_policies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scope: text("scope", { enum: ["global", "volume"] }).notNull(),
    volumeId: integer("volume_id").references(() => volumes.id, { onDelete: "cascade" }),
    permitImportantEviction: integer("permit_important_eviction").notNull().default(0),
    throttleOpportunistic: integer("throttle_opportunistic").notNull().default(1),
    pruneSurplusVersions: integer("prune_surplus_versions").notNull().default(1),
    orphanGraceSeconds: integer("orphan_grace_seconds").notNull().default(86400),
    maxEvictionBatchBytes: integer("max_eviction_batch_bytes"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("storage_policies_one_global").on(t.scope).where(sql`${t.scope} = 'global'`),
    uniqueIndex("storage_policies_one_per_volume").on(t.volumeId).where(sql`${t.scope} = 'volume'`),
  ],
);

export const volumeReservations = sqliteTable(
  "volume_reservations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    volumeId: integer("volume_id").notNull().references(() => volumes.id, { onDelete: "cascade" }),
    downloadJobId: integer("download_job_id").notNull().references(() => downloadJobs.id, { onDelete: "cascade" }),
    reservedBytes: integer("reserved_bytes").notNull(),
    writtenBytes: integer("written_bytes").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    priority: integer("priority"),
    sourceId: integer("source_id"),
  },
  (t) => [index("volume_reservations_volume_idx").on(t.volumeId), uniqueIndex("volume_reservations_job_uq").on(t.volumeId, t.downloadJobId)],
);

export const blobs = sqliteTable(
  "blobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sha256: text("sha256").notNull().unique(),
    sizeBytes: integer("size_bytes").notNull(),
    storedBytes: integer("stored_bytes").notNull(),
    compression: text("compression", { enum: ["none", "zstd"] }).notNull().default("none"),
    mime: text("mime"),
    kind: text("kind", {
      enum: ["document", "css", "image", "font", "media", "pdf", "text", "reader", "json", "other"],
    }).notNull().default("other"),
    volumeId: integer("volume_id").notNull().references(() => volumes.id),
    refcount: integer("refcount").notNull().default(0),
    zeroSince: integer("zero_since"),
    state: text("state", { enum: ["writing", "ready", "missing", "quarantined"] }).notNull().default("ready"),
    verifiedAt: integer("verified_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("blobs_zero_since_idx").on(t.volumeId, t.zeroSince).where(sql`${t.zeroSince} IS NOT NULL`),
    index("blobs_volume_kind_idx").on(t.volumeId, t.kind),
  ],
);

export const storageUsageCache = sqliteTable(
  "storage_usage_cache",
  {
    volumeId: integer("volume_id").notNull().references(() => volumes.id, { onDelete: "cascade" }),
    dimension: text("dimension", { enum: ["priority", "source", "kind"] }).notNull(),
    key: text("key").notNull(),
    bytes: integer("bytes").notNull().default(0),
    blobCount: integer("blob_count").notNull().default(0),
    sharedBytes: integer("shared_bytes").notNull().default(0),
    computedAt: integer("computed_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.volumeId, t.dimension, t.key] })],
);
