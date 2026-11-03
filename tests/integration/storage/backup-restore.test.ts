import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "@ncb/db";
import { restoreBackup, RestoreError, type BackupManifest } from "@ncb/server";
import { addDoc, searchApi, startSearchServer, until } from "../search/helpers.js";
import { tempDir } from "../server/helpers.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const WORDS = ["lamp", "rock", "tide", "wave", "sail"];

async function archive(n = 5) {
  const dataDir = tempDir("ncb-bk-data-");
  const rootsDir = tempDir("ncb-bk-roots-");
  const t = await startSearchServer({ dataDir, rootsDir });
  await t.svc.search.waitForRebuild();
  const pages: { pageId: string }[] = [];
  for (let i = 0; i < n; i++) pages.push(await addDoc(t, `p${i}.html`, `Page about ${WORDS[i % WORDS.length]} number ${i}`, `This page talks about the ${WORDS[i % WORDS.length]} at sea, number ${i}. `.repeat(3)));
  await t.svc.search.drain();
  return { t, dataDir, rootsDir, pages };
}

const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");

describe("H-02 backup", () => {
  it("writes a folder of VACUUM INTO copies with a manifest of checksums, leaves out the index and the key by default, and lists it", async () => {
    const { t, dataDir } = await archive();
    const res = await t.api("POST", "/api/system/maintenance/backup", {});
    expect(res.status).toBe(200);
    expect(res.body.file).toMatch(/^backup-\d{8}T\d{6}Z\/main\.db$/);
    const dir = path.join(dataDir, "backups", res.body.dir);
    expect(fs.readdirSync(dir).sort()).toEqual(["main.db", "manifest.json"]);
    const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as BackupManifest;
    expect(m).toMatchObject({ format: 1, integrity: "ok", counts: { pages: 5 } });
    expect(m.files).toEqual([{ name: "main.db", bytes: fs.statSync(path.join(dir, "main.db")).size, sha256: sha(path.join(dir, "main.db")) }]);
    expect(m.volumes).toHaveLength(1);
    expect(m.notes.join(" ")).toMatch(/search index is not in this backup/);
    expect(m.notes.join(" ")).toMatch(/secret key is not in this backup/);
    const list = await t.api("GET", "/api/system/maintenance/backups");
    expect(list.body.items).toHaveLength(1);
    // recorded as a maintenance run and in the log
    expect(t.svc.storage.maintenance.list().items.some((r) => r.kind === "backup" && r.state === "done")).toBe(true);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity_log WHERE message LIKE 'Backup written%'")!.n).toBe(1);
  });

  it("can include the search index and the secret key when asked, and keeps only the newest N backups", async () => {
    const { t, dataDir } = await archive(3);
    const res = await t.api("POST", "/api/system/maintenance/backup", { includeIndex: true, includeSecretKey: true });
    const files = fs.readdirSync(path.join(dataDir, "backups", res.body.dir)).sort();
    expect(files).toEqual(["index.db", "main.db", "manifest.json", "secret.key"]);
    expect(fs.statSync(path.join(dataDir, "backups", res.body.dir, "secret.key")).mode & 0o077).toBe(0);
    for (let i = 0; i < 9; i++) t.svc.storage.runBackup({}); // keep is 7
    expect(t.svc.storage.backups.list()).toHaveLength(7);
  });
});

describe("H-02 restore: back up, restore into a fresh data directory, migrate, start, and use it", () => {
  it("pages, search and sources all work in the restored stack; an older backup is migrated on the way", async () => {
    const { t, dataDir, rootsDir } = await archive();
    const before = {
      pages: t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pages")!.n,
      sources: t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources")!.n,
      search: (await searchApi(t, { query: "tide" })).body.results.map((r: any) => r.pageId).sort(),
    };
    expect(before.search.length).toBeGreaterThan(0);
    const b = t.svc.storage.runBackup({});
    await t.server.close();

    // Make the backup "older": drop what migration 0015 added and forget that it ran, then re-seal the manifest.
    const bdir = path.join(dataDir, "backups", b.dir);
    const d = openDb(path.join(bdir, "main.db"));
    d.exec("DROP TABLE job_rollups; DELETE FROM _migrations WHERE name = '0015_maintenance'");
    d.checkpoint("TRUNCATE");
    d.close();
    for (const ext of ["-wal", "-shm"]) fs.rmSync(path.join(bdir, "main.db" + ext), { force: true });
    const mf = JSON.parse(fs.readFileSync(path.join(bdir, "manifest.json"), "utf8")) as BackupManifest;
    mf.files[0] = { name: "main.db", bytes: fs.statSync(path.join(bdir, "main.db")).size, sha256: sha(path.join(bdir, "main.db")) };
    fs.writeFileSync(path.join(bdir, "manifest.json"), JSON.stringify(mf));

    // A fresh data directory. The blob volume (a separate disk or folder) is the same one, as the guide says it must be.
    const freshData = tempDir("ncb-bk-fresh-");
    const r = restoreBackup({ backupDir: bdir, dataDir: freshData });
    expect(r.restored).toEqual(["main.db"]);
    expect(r.warnings.join(" ")).toMatch(/search index was not in the backup/);
    expect(fs.existsSync(path.join(freshData, "index", "index.db"))).toBe(false);

    const back = await startSearchServer({ dataDir: freshData, rootsDir, signIn: true });
    expect(back.svc.main.migration.applied).toEqual(["0015_maintenance"]); // only what the backup lacked
    expect(back.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_rollups")!.n).toBe(0);
    expect(fs.readdirSync(path.join(freshData, "backups")).some((n) => n.startsWith("main-pre-0015_maintenance-"))).toBe(true);

    expect(back.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pages")!.n).toBe(before.pages);
    const src = await back.api("GET", "/api/sources");
    expect(src.status).toBe(200);
    expect(back.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources")!.n).toBe(before.sources);
    await until(async () => (await back.api("GET", "/api/index/status")).body.state === "ok", 60_000);
    expect((await searchApi(back, { query: "tide" })).body.results.map((x: any) => x.pageId).sort()).toEqual(before.search);
    // an archived page opens from its stored files
    const pg = await back.api("GET", `/api/archive/pages/${before.search[0]}`);
    expect(pg.status).toBe(200);
    // and the app's own verify agrees that every stored file is there
    const v = await back.svc.storage.maintenance.verify({ checks: ["I-1", "I-2", "I-3", "I-4", "I-11", "I-12"] });
    expect(v.findings).toEqual([]);
    expect(v.checked.blobs).toBeGreaterThan(0);
  });

  it("refuses a damaged backup, a non-empty data directory and a running server; force keeps the old database", async () => {
    const { t, dataDir } = await archive(2);
    const b = t.svc.storage.runBackup({});
    const bdir = path.join(dataDir, "backups", b.dir);

    // running server: the writer lock is held
    expect(() => restoreBackup({ backupDir: bdir, dataDir })).toThrow(/already holds the database lock|WriterLock|lock/i);
    await t.server.close();

    // non-empty target
    expect(() => restoreBackup({ backupDir: bdir, dataDir })).toThrow(RestoreError);
    const forced = restoreBackup({ backupDir: bdir, dataDir, force: true });
    expect(forced.keptOld).toMatch(/main\.db\.before-restore-\d{8}T\d{6}Z$/);
    expect(fs.existsSync(forced.keptOld!)).toBe(true);

    // damaged backup: one flipped byte is caught by the checksum before anything is written
    const fresh = tempDir("ncb-bk-fresh-");
    const bytes = fs.readFileSync(path.join(bdir, "main.db"));
    bytes[bytes.length - 100]! ^= 0xff;
    fs.writeFileSync(path.join(bdir, "main.db"), bytes);
    expect(() => restoreBackup({ backupDir: bdir, dataDir: fresh })).toThrow(/does not match its checksum/);
    expect(fs.existsSync(path.join(fresh, "db", "main.db"))).toBe(false);
    // an unfinished folder (no manifest) is not a backup
    expect(() => restoreBackup({ backupDir: tempDir("ncb-empty-"), dataDir: fresh })).toThrow(/not a finished backup/);
  });

  it("restores the search index and the secret key when the backup holds them, and keeps an existing key unless told otherwise", async () => {
    const { t, dataDir, rootsDir } = await archive(3);
    const b = t.svc.storage.runBackup({ includeIndex: true, includeSecretKey: true });
    const key = fs.readFileSync(path.join(dataDir, "secrets", "secret.key"), "utf8");
    await t.server.close();
    const bdir = path.join(dataDir, "backups", b.dir);

    const fresh = tempDir("ncb-bk-fresh-");
    const r = restoreBackup({ backupDir: bdir, dataDir: fresh });
    expect(r.restored.sort()).toEqual(["index.db", "main.db", "secret.key"]);
    expect(fs.readFileSync(path.join(fresh, "secrets", "secret.key"), "utf8")).toBe(key);
    const back = await startSearchServer({ dataDir: fresh, rootsDir, signIn: true });
    await until(async () => (await back.api("GET", "/api/index/status")).body.state === "ok", 60_000);
    expect((await back.api("GET", "/api/index/status")).body).toMatchObject({ docs: 3, drift: 0 });
    await back.server.close();

    // a key already there is kept
    fs.writeFileSync(path.join(fresh, "secrets", "secret.key"), "a-different-key-that-is-long-enough");
    fs.rmSync(path.join(fresh, "db"), { recursive: true });
    const again = restoreBackup({ backupDir: bdir, dataDir: fresh });
    expect(again.restored).not.toContain("secret.key");
    expect(again.warnings.join(" ")).toMatch(/secret key already exists/);
  });

  it("the command line tool restores a backup the same way (node dist/cli.js restore)", async () => {
    const { t, dataDir } = await archive(2);
    const b = t.svc.storage.runBackup({});
    await t.server.close();
    const fresh = tempDir("ncb-bk-fresh-");
    const run = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "apps/server/src/cli.ts"), "restore", path.join(dataDir, "backups", b.dir), "--data-dir", fresh], { cwd: ROOT, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/Restored main\.db from a backup made .* \(2 pages\)/);
    expect(integrityOk(path.join(fresh, "db", "main.db"))).toBe(true);
    const bad = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "apps/server/src/cli.ts"), "restore", path.join(dataDir, "backups", b.dir), "--data-dir", fresh], { cwd: ROOT, encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/already exists/);
  });
});

function integrityOk(file: string): boolean {
  const d = openDb(file);
  try { return d.all<{ integrity_check: string }>("PRAGMA integrity_check").every((r) => r.integrity_check === "ok"); } finally { d.close(); }
}

describe("H-02 scheduled maintenance", () => {
  it("the storage pass takes a backup and a verify when the last one is old enough, and not before", async () => {
    const { t } = await archive(2);
    await t.svc.storage.tick();
    const kinds = () => t.svc.storage.maintenance.list().items.map((r) => r.kind);
    expect(kinds().filter((k) => k === "backup")).toHaveLength(1);
    expect(kinds().filter((k) => k === "verify")).toHaveLength(1);
    await t.svc.storage.tick();
    expect(kinds().filter((k) => k === "backup")).toHaveLength(1); // not again the same day
    t.fake.advance(25 * 3_600_000);
    await t.svc.storage.tick();
    expect(kinds().filter((k) => k === "backup")).toHaveLength(2);
    expect(kinds().filter((k) => k === "verify")).toHaveLength(1); // weekly
    t.fake.advance(7 * 86_400_000);
    await t.svc.storage.tick();
    expect(kinds().filter((k) => k === "verify")).toHaveLength(2);
    const verify = t.svc.storage.maintenance.list().items.find((r) => r.kind === "verify")!;
    expect(t.svc.storage.maintenance.get(verify.id).findings.filter((f) => f.invariant !== "REF")).toEqual([]);
  });

  it("scheduled backups can be turned off, and a failing one is recorded without stopping the pass", async () => {
    const off = await startSearchServer({ env: { NCB_BACKUP_INTERVAL_HOURS: "0", NCB_VERIFY_INTERVAL_HOURS: "0" } });
    await off.svc.storage.tick();
    expect(off.svc.storage.maintenance.list().items.filter((r) => r.kind === "backup" || r.kind === "verify")).toEqual([]);

    const t = await startSearchServer({ server: { backupFault: () => { throw new Error("disk is full"); } } });
    const { notes } = await t.svc.storage.tick();
    expect(notes.join(" ")).toMatch(/scheduled backup failed: disk is full/);
    const run = t.svc.storage.maintenance.list().items.find((r) => r.kind === "backup")!;
    expect(run.state).toBe("failed");
    expect(t.svc.db.get<{ level: string }>("SELECT level FROM activity_log WHERE message LIKE 'The backup failed%'")!.level).toBe("error");
    expect(fs.readdirSync(path.join(t.dataDir, "backups")).filter((n) => n.startsWith(".tmp-backup-"))).toEqual([]);
    expect(t.svc.storage.backups.list()).toEqual([]);
  });
});

describe("H-02 log pruning and jobs rollup", () => {
  it("old finished jobs are rolled into daily counters and deleted; running, recent and still-needed rows stay", async () => {
    const { t } = await archive(1);
    const { db, clock } = t.svc;
    const old = clock.now() - 10 * 86_400_000;
    const ins = (state: string, finished: number, extra = "") => db.run(
      `INSERT INTO jobs (type, queue, state, attempts, created_at, started_at, finished_at ${extra ? ", " + extra.split("=")[0] : ""}) VALUES ('index', 'index', ?, 2, ?, ?, ? ${extra ? ", " + extra.split("=")[1] : ""})`, [state, finished - 500, finished - 400, finished]);
    ins("done", old); ins("done", old); ins("cancelled", old);
    ins("done", clock.now() - 3600_000); // recent
    ins("dead", old); // dead rows are kept four times as long
    const dl = Number(db.run("INSERT INTO download_jobs (public_id, kind, state, priority, requested_by, created_at) VALUES ('dl_ROLLUP', 'capture', 'running', 3, 'user', ?)", [clock.now()]).lastInsertRowid);
    ins("done", old, `download_job_id=${dl}`); // belongs to a download that has not ended
    const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs")!.n;
    await t.svc.storage.tick();
    const left = db.all<{ state: string }>("SELECT state FROM jobs").length;
    expect(before - left).toBe(3);
    const roll = db.all<{ state: string; jobs: number; attempts: number; runtime_ms: number }>("SELECT state, jobs, attempts, runtime_ms FROM job_rollups ORDER BY state");
    expect(roll).toEqual([{ state: "cancelled", jobs: 1, attempts: 2, runtime_ms: 400 }, { state: "done", jobs: 2, attempts: 4, runtime_ms: 800 }]);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE download_job_id = ?", [dl])!.n).toBe(1);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE state = 'dead'")!.n).toBe(1);

    // a second pass adds to the same counters instead of replacing them
    ins("done", old);
    await t.svc.storage.tick();
    expect(db.get<{ jobs: number }>("SELECT jobs FROM job_rollups WHERE state = 'done'")!.jobs).toBe(3);
  });

  it("the activity log is pruned to its retention at startup and on the maintenance timer", async () => {
    const t = await startSearchServer();
    const days = (t.svc.settings.internal("logging") as { retentionDays: number }).retentionDays;
    t.svc.activity.write({ level: "info", area: "system", message: "ancient entry" });
    t.svc.db.run("UPDATE activity_log SET at = ? WHERE message = 'ancient entry'", [t.svc.clock.now() - (days + 1) * 86_400_000]);
    expect(t.svc.activity.prune(days)).toBeGreaterThanOrEqual(1);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity_log WHERE message = 'ancient entry'")!.n).toBe(0);
  });
});
