import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.js";
import { pages, pageVersions } from "./pages.js";

// Mirrors migrations/0004_bookmarks_history.sql (docs/data-model.md section 3.8). The SQL is the DDL source of truth;
// test/schema-sync.test.ts fails if the two drift apart.

export const SERVED_FROM = ["archive", "cache", "zim", "live", "offline"] as const;
export type ServedFrom = (typeof SERVED_FROM)[number];

export const bookmarks = sqliteTable(
  "bookmarks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicId: text("public_id").notNull().unique(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    originalUrl: text("original_url").notNull(),
    urlKey: text("url_key").notNull(),
    title: text("title").notNull().default(""),
    pageId: integer("page_id").references(() => pages.id, { onDelete: "set null" }),
    versionId: integer("version_id").references(() => pageVersions.id, { onDelete: "set null" }),
    zimPackageId: integer("zim_package_id"),
    zimPath: text("zim_path"),
    collectionId: integer("collection_id"),
    referencePriority: integer("reference_priority").notNull().default(2),
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    index("bookmarks_user_created_idx").on(t.userId, t.createdAt),
    index("bookmarks_url_key_idx").on(t.urlKey),
    index("bookmarks_page_idx").on(t.pageId),
    uniqueIndex("bookmarks_user_url_uq").on(t.userId, t.urlKey).where(sql`${t.deletedAt} IS NULL`),
  ],
);

export const historyEntries = sqliteTable(
  "history_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicId: text("public_id").notNull().unique(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    urlKey: text("url_key").notNull(),
    title: text("title").notNull().default(""),
    visitedAt: integer("visited_at").notNull(),
    pageId: integer("page_id").references(() => pages.id, { onDelete: "set null" }),
    zimPackageId: integer("zim_package_id"),
    servedFrom: text("served_from", { enum: SERVED_FROM }).notNull(),
  },
  (t) => [index("history_user_visited_idx").on(t.userId, t.visitedAt), index("history_url_key_idx").on(t.urlKey)],
);
