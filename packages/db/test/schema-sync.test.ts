import { getTableColumns, getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { migrate, openDb, schema } from "../src/index.js";

// The SQL migrations are the DDL source of truth; the Drizzle schema only types queries.
// This test fails when a column is added to one and not the other.
describe("drizzle schema matches the migrated database", () => {
  const db = openDb(":memory:");
  migrate(db);
  const tables = (Object.values(schema) as unknown[]).filter((t): t is SQLiteTable => is(t, SQLiteTable));

  it("covers every table", () => {
    const real = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_migrations'`).map((r) => r.name).sort();
    expect(tables.map((t) => getTableName(t)).sort()).toEqual(real);
  });

  it.each(tables.map((t) => [getTableName(t), t] as const))("%s columns", (name, table) => {
    const real = db.all<{ name: string; type: string; notnull: number }>(`PRAGMA table_info(${name})`);
    const declared = Object.values(getTableColumns(table));
    expect(declared.map((c) => c.name).sort()).toEqual(real.map((c) => c.name).sort());
    for (const col of declared) {
      const r = real.find((x) => x.name === col.name)!;
      // PK columns report notnull=0 for INTEGER PRIMARY KEY; compare only non-PK columns.
      if (!col.primary) expect(r.notnull === 1, `${name}.${col.name} notnull`).toBe(col.notNull);
    }
  });

  it("all tables are STRICT", () => {
    const rows = db.all<{ name: string; strict: number }>(`PRAGMA table_list`).filter((r) => !r.name.startsWith("sqlite_"));
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((r) => r.strict !== 1).map((r) => r.name)).toEqual([]);
  });
});
