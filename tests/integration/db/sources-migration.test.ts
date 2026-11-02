import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultMigrationsDir, migrate, openDb, parseFkDirectives, rebuildWithForeignKeys, MigrationError, type Db } from "@ncb/db";
import { tempDir } from "../helpers.js";

/** The migrations before 0006 in a directory of their own, so a database can be built "as it was" and then upgraded. */
function before0006(upTo: "0006" | "0007" = "0006"): string {
  const dir = path.join(tempDir(), "migrations");
  fs.mkdirSync(dir);
  for (const f of fs.readdirSync(defaultMigrationsDir)) {
    if (/^\d{4}_/.test(f) && f < upTo) fs.copyFileSync(path.join(defaultMigrationsDir, f), path.join(dir, f));
  }
  return dir;
}

const fkList = (db: Db, table: string) =>
  db.all<{ table: string; from: string; on_delete: string }>(`PRAGMA foreign_key_list(${table})`).map((r) => `${r.from}->${r.table}:${r.on_delete}`).sort();

function seed(db: Db) {
  db.run(`INSERT INTO users (public_id, username, password_hash, created_at) VALUES ('usr_1','admin','h',1)`);
  db.run(`INSERT INTO volumes (public_id,name,root_path,marker_uuid,state,reserve_free_bytes,is_default,created_at) VALUES ('vol_1','a','/v/a','u','online',0,1,1)`);
  // Three download jobs, the last two deleted so the AUTOINCREMENT counter is ahead of the largest id.
  for (let i = 1; i <= 5; i++) {
    db.run(`INSERT INTO download_jobs (public_id, kind, state, priority, requested_by, created_at, source_id, config_id) VALUES (?, 'capture', 'completed', 3, 'user', ?, ?, ?)`, [`dl_${i}`, i, i === 1 ? 77 : null, i === 1 ? 5 : null]);
  }
  db.run(`DELETE FROM download_jobs WHERE id IN (4, 5)`);
  db.run(`INSERT INTO crawl_jobs (download_job_id, source_id, mode, seed_urls_json) VALUES (2, 9, 'explore', '["http://x.test/"]')`);
  db.run(`INSERT INTO jobs (type, queue, state, download_job_id, crawl_job_id, url, url_key, created_at) VALUES ('fetch','crawl','queued', 2, 1, 'http://x.test/', 'k1', 1)`);
  db.run(`INSERT INTO activity_log (at, level, area, message, download_job_id) VALUES (1, 'info', 'system', 'hello', 2)`);
  db.run(`INSERT INTO pages (public_id, url_key, canonical_url, host, registrable_domain, created_at) VALUES ('pg_1','k','http://x.test/','x.test','x.test',1)`);
  db.run(`INSERT INTO page_versions (public_id, page_id, version_no, source_id, download_job_id, requested_url, final_url, fetched_at, created_at) VALUES ('ver_1', 1, 1, 3, 2, 'http://x.test/', 'http://x.test/', 1, 1)`);
  db.run(`INSERT INTO page_versions (public_id, page_id, version_no, duplicate_of_version_id, requested_url, final_url, fetched_at, created_at) VALUES ('ver_2', 1, 2, 1, 'http://x.test/', 'http://x.test/', 2, 2)`);
  db.run(`INSERT INTO bookmarks (public_id, user_id, original_url, url_key, page_id, version_id, collection_id, created_at) VALUES ('bm_1', 1, 'http://x.test/', 'k', 1, 1, 4, 1)`);
}

describe("migration 0006: foreign keys added to plain-integer columns", () => {
  it("keeps every row, child links, indexes and the AUTOINCREMENT counters", () => {
    const db = openDb(":memory:");
    migrate(db, { migrationsDir: before0006() });
    seed(db);
    const snap = (t: string) => db.all(`SELECT * FROM ${t} ORDER BY 1`);
    const tables = ["download_jobs", "crawl_jobs", "jobs", "activity_log", "pages", "page_versions", "bookmarks", "users", "volumes"];
    const beforeRows = Object.fromEntries(tables.map((t) => [t, snap(t)]));
    const beforeSeq = db.all(`SELECT name, seq FROM sqlite_sequence ORDER BY name`);
    const indexesBefore = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND tbl_name IN ('download_jobs','crawl_jobs','page_versions','bookmarks') ORDER BY name`);

    migrate(db, { migrationsDir: before0006("0007") }); // 0006 only; later migrations add their own columns

    // Every row survives. The only changes are the stale source, config and collection values the migration clears.
    const cleared: Record<string, string[]> = { download_jobs: ["source_id", "config_id"], crawl_jobs: ["source_id"], page_versions: ["source_id"], bookmarks: ["collection_id"] };
    for (const t of tables) {
      const after = (snap(t) as Record<string, unknown>[]).map((r) => {
        const { paused_by_window, ...rest } = r; // the one column 0006 adds to download_jobs
        if (t === "download_jobs") expect(paused_by_window).toBe(0);
        return t === "download_jobs" ? rest : r;
      });
      const want = (beforeRows[t] as Record<string, unknown>[]).map((r) => {
        const copy = { ...r };
        for (const c of cleared[t] ?? []) if (c in copy) copy[c] = null;
        return copy;
      });
      expect(after, t).toEqual(want);
    }
    expect(snap("download_jobs")).toHaveLength(3);
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM crawl_jobs`)!.n).toBe(1); // not cascaded away by the drop
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE download_job_id = 2 AND crawl_job_id = 1`)!.n).toBe(1);
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM activity_log WHERE download_job_id = 2`)!.n).toBe(1);

    expect(db.all(`SELECT name, seq FROM sqlite_sequence WHERE name IN ('download_jobs','page_versions','crawl_jobs','bookmarks') ORDER BY name`)).toEqual(
      (beforeSeq as { name: string; seq: number }[]).filter((r) => ["download_jobs", "page_versions", "crawl_jobs", "bookmarks"].includes(r.name)));
    // The next job id continues after the deleted ones (5), as before.
    db.run(`INSERT INTO download_jobs (public_id, kind, priority, requested_by, created_at) VALUES ('dl_new','capture',3,'user',9)`);
    expect(db.get<{ id: number }>(`SELECT id FROM download_jobs WHERE public_id = 'dl_new'`)!.id).toBe(6);

    expect(db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND tbl_name IN ('download_jobs','crawl_jobs','page_versions','bookmarks') ORDER BY name`)).toEqual(indexesBefore);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    expect(db.get<{ strict: number }>(`SELECT strict FROM pragma_table_list WHERE name = 'download_jobs'`)!.strict).toBe(1);

    // The new keys exist and are enforced.
    expect(fkList(db, "download_jobs")).toEqual(expect.arrayContaining(["config_id->source_configs:SET NULL", "source_id->sources:SET NULL"]));
    expect(fkList(db, "crawl_jobs")).toEqual(expect.arrayContaining(["config_id->source_configs:SET NULL", "source_id->sources:SET NULL", "download_job_id->download_jobs:CASCADE"]));
    expect(fkList(db, "page_versions")).toEqual(expect.arrayContaining(["source_id->sources:SET NULL", "page_id->pages:CASCADE", "duplicate_of_version_id->page_versions:SET NULL"]));
    expect(fkList(db, "bookmarks")).toContain("collection_id->collections:SET NULL");
    expect(() => db.run(`UPDATE download_jobs SET source_id = 999 WHERE id = 2`)).toThrow(/FOREIGN KEY/);
    expect(() => db.run(`UPDATE page_versions SET source_id = 999 WHERE id = 1`)).toThrow(/FOREIGN KEY/);
    expect(() => db.run(`UPDATE bookmarks SET collection_id = 999 WHERE id = 1`)).toThrow(/FOREIGN KEY/);

    // Real parents work, and a hard delete of a source clears the references instead of failing.
    db.run(`INSERT INTO sources (public_id, name, type, strategy, profile, priority, retention_mode, automatic_eviction, created_at, updated_at) VALUES ('src_1','s','website','explore','balanced',3,'latest',1,1,1)`);
    db.run(`UPDATE download_jobs SET source_id = 1 WHERE id = 2`);
    db.run(`UPDATE page_versions SET source_id = 1 WHERE id = 1`);
    db.run(`DELETE FROM sources WHERE id = 1`);
    expect(db.get<{ s: number | null }>(`SELECT source_id AS s FROM download_jobs WHERE id = 2`)!.s).toBeNull();
    expect(db.get<{ s: number | null }>(`SELECT source_id AS s FROM page_versions WHERE id = 1`)!.s).toBeNull();
    // Children of the rebuilt tables still cascade.
    db.run(`DELETE FROM download_jobs WHERE id = 2`);
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM crawl_jobs`)!.n).toBe(0);
    db.close();
  });

  it("a second start applies nothing, and the pre-migration backup holds the old data", () => {
    const dir = tempDir();
    const mig = before0006();
    const file = path.join(dir, "main.db");
    const db = openDb(file);
    migrate(db, { migrationsDir: mig });
    seed(db);
    const through0006 = before0006("0007");
    const r = migrate(db, { backupDir: path.join(dir, "backups"), migrationsDir: through0006 });
    expect(r.applied).toContain("0006_sources_collections");
    expect(r.backups).toHaveLength(1);
    expect(migrate(db, { migrationsDir: through0006 }).applied).toEqual([]);
    const backup = openDb(r.backups[0]!);
    expect(backup.get<{ n: number }>(`SELECT COUNT(*) AS n FROM download_jobs`)!.n).toBe(3);
    expect(backup.all(`PRAGMA foreign_key_list(download_jobs)`)).toEqual([]);
    expect(backup.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sources'`)!.n).toBe(0);
    backup.close();
    db.close();
  });

  it("a failing rebuild rolls everything back and turns foreign keys back on", () => {
    const dir = path.join(tempDir(), "m");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "0001_a.sql"), `CREATE TABLE p (id INTEGER PRIMARY KEY) STRICT; CREATE TABLE c (id INTEGER PRIMARY KEY AUTOINCREMENT, p_id INTEGER) STRICT; INSERT INTO c (p_id) VALUES (5);`);
    fs.writeFileSync(path.join(dir, "0002_b.sql"), `-- ncb:fk c.p_id REFERENCES p(id) ON DELETE CASCADE\n`);
    const db = openDb(":memory:");
    expect(() => migrate(db, { migrationsDir: dir })).toThrow(MigrationError);
    expect(db.pragma("foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM c`)!.n).toBe(1);
    expect(db.all(`PRAGMA foreign_key_list(c)`)).toEqual([]);
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM _migrations`)!.n).toBe(1);
    db.close();
  });

  it("the directive parser and rebuild helper cope with real-world column text", () => {
    expect(parseFkDirectives("x\n-- ncb:fk a.b REFERENCES c(id) ON DELETE SET NULL\n--ncb:fk d.e REFERENCES f(id)\n-- other")).toEqual([
      { table: "a", column: "b", clause: "REFERENCES c(id) ON DELETE SET NULL" }, { table: "d", column: "e", clause: "REFERENCES f(id)" },
    ]);
    const db = openDb(":memory:");
    db.exec(`CREATE TABLE p (id INTEGER PRIMARY KEY) STRICT;
      CREATE TABLE "c" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL DEFAULT 'a,b',
        p_id INTEGER NOT NULL DEFAULT 0 CHECK (p_id >= 0),
        q_id INTEGER
      ) STRICT;
      CREATE INDEX c_p ON c (p_id);
      INSERT INTO p (id) VALUES (0), (1);
      INSERT INTO c (label, p_id, q_id) VALUES ('x', 1, 1);`);
    db.pragma("foreign_keys = OFF");
    rebuildWithForeignKeys(db, "c", [{ column: "p_id", clause: "REFERENCES p(id) ON DELETE CASCADE" }, { column: "q_id", clause: "REFERENCES p(id)" }]);
    db.pragma("foreign_keys = ON");
    expect(fkList(db, "c")).toEqual(["p_id->p:CASCADE", "q_id->p:NO ACTION"]);
    expect(db.get(`SELECT label, p_id, q_id FROM c`)).toEqual({ label: "x", p_id: 1, q_id: 1 });
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'c_p'`)!.n).toBe(1);
    expect(() => rebuildWithForeignKeys(db, "c", [{ column: "p_id", clause: "REFERENCES p(id)" }])).toThrow(/already has a foreign key/);
    expect(() => rebuildWithForeignKeys(db, "c", [{ column: "nope", clause: "REFERENCES p(id)" }])).toThrow(/Cannot find column/);
    expect(() => rebuildWithForeignKeys(db, "missing", [{ column: "x", clause: "REFERENCES p(id)" }])).toThrow(/does not exist/);
    db.close();
  });

  it("creates the new tables STRICT with the documented constraints", () => {
    const db = openDb(":memory:");
    migrate(db);
    const strict = db.all<{ name: string; strict: number }>(`PRAGMA table_list`).filter((t) => ["sources", "source_configs", "collections", "collection_memberships", "page_sources", "source_collections", "source_discovered_urls", "url_exclusions", "schedules", "download_windows"].includes(t.name));
    expect(strict).toHaveLength(10);
    expect(strict.every((t) => t.strict === 1)).toBe(true);
    db.run(`INSERT INTO sources (public_id, name, type, strategy, profile, priority, retention_mode, automatic_eviction, system_kind, created_at, updated_at) VALUES ('src_a','a','single_page','capture','focused',3,'latest',1,'quick_saves',1,1)`);
    expect(() => db.run(`INSERT INTO sources (public_id, name, type, strategy, profile, priority, retention_mode, automatic_eviction, system_kind, created_at, updated_at) VALUES ('src_b','b','single_page','capture','focused',3,'latest',1,'quick_saves',1,1)`)).toThrow(/UNIQUE/);
    expect(() => db.run(`INSERT INTO sources (public_id, name, type, strategy, profile, priority, retention_mode, automatic_eviction, created_at, updated_at) VALUES ('src_c','c','bogus','capture','focused',3,'latest',1,1,1)`)).toThrow(/CHECK/);
    db.run(`INSERT INTO collections (public_id, name, kind, created_at, updated_at) VALUES ('col_f1','f','favourites',1,1)`);
    expect(() => db.run(`INSERT INTO collections (public_id, name, kind, created_at, updated_at) VALUES ('col_f2','f','favourites',1,1)`)).toThrow(/UNIQUE/);
    db.run(`INSERT INTO collections (public_id, name, created_at, updated_at) VALUES ('col_m','m',1,1)`);
    db.run(`INSERT INTO pages (public_id, url_key, canonical_url, host, registrable_domain, created_at) VALUES ('pg_1','k','http://x.test/','x.test','x.test',1)`);
    db.run(`INSERT INTO collection_memberships (collection_id, page_id, added_by, added_at) VALUES (2, 1, 'user', 1)`);
    expect(() => db.run(`INSERT INTO collection_memberships (collection_id, page_id, added_by, added_at) VALUES (2, 1, 'user', 1)`)).toThrow(/UNIQUE/);
    expect(() => db.run(`INSERT INTO collection_memberships (collection_id, added_by, added_at) VALUES (2, 'user', 1)`)).toThrow(/CHECK/);
    expect(() => db.run(`INSERT INTO page_sources (page_id, source_id, first_seen_at, last_seen_at, priority_override) VALUES (1, 1, 1, 1, 7)`)).toThrow(/CHECK/);
    db.run(`INSERT INTO url_exclusions (source_id, url_key, reason, created_at) VALUES (NULL, 'k', 'trap', 1)`);
    expect(() => db.run(`INSERT INTO url_exclusions (source_id, url_key, reason, created_at) VALUES (NULL, 'k', 'trap', 1)`)).toThrow(/UNIQUE/);
    expect(() => db.run(`INSERT INTO download_windows (public_id, days_mask, start_minute, end_minute, created_at) VALUES ('win_1', 127, 60, 60, 1)`)).toThrow(/CHECK/);
    db.close();
  });
});
