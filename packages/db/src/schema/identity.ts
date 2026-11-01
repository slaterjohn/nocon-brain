import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Mirrors migrations/0001_foundation.sql (docs/data-model.md section 3.1). The SQL is the source of
// truth for DDL (STRICT, collations, partial indexes); this file gives the query builder its types.
// test/schema-sync.test.ts fails if the two drift apart.

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    publicId: text("public_id").notNull().unique(),
    username: text("username").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["admin"] }).notNull().default("admin"),
    createdAt: integer("created_at").notNull(),
    lastLoginAt: integer("last_login_at"),
    disabledAt: integer("disabled_at"),
  },
  (t) => [check("users_role_check", sql`${t.role} IN ('admin')`)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    absoluteExpiresAt: integer("absolute_expires_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
});

export const userSettings = sqliteTable(
  "user_settings",
  {
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value"),
});
