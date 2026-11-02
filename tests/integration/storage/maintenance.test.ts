import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startSearchServer, drained } from "../search/helpers.js";
import { archiveSignature, expectConsistent, startStorageTest, type StorageTest } from "../../storage-safety/helpers.js";

const STORAGE_CHECKS = ["I-1", "I-2", "I-3", "I-4", "I-5", "I-6", "I-7", "I-8", "I-9", "I-11", "I-12"];

/** A healthy archive: a Protected page and two Standard pages, one sharing a stylesheet. */
async function healthy(t: StorageTest) {
  const keep = t.seed.source({ name: "Keep", priority: 1, retention: { mode: "all" } });
  const std = t.seed.source({ name: "Std", priority: 3 });
  const css = { tag: "shared.css", bytes: 300 };
  const a = await t.seed.page({ url: "https://m.test/a", sources: [keep], versions: [{ blobs: [{ tag: "a-doc", bytes: 800 }, css] }] });
  const b = await t.seed.page({ url: "https://m.test/b", sources: [std], versions: [{ blobs: [{ tag: "b-doc", bytes: 900 }, css] }] });
  const c = await t.seed.page({ url: "https://m.test/c", sources: [std], versions: [{ blobs: [{ tag: "c-doc", bytes: 700 }] }] });
  return { a, b, c, keep, std };
}

describe("T-10 verify-and-repair: a healthy archive is clean", () => {
  it("reports nothing and says what it covered", async () => {
    const t = await startStorageTest();
    await healthy(t);
    const r = await t.svc.storage.maintenance.verify({ checks: [...STORAGE_CHECKS, "I-13"] });
    expect(r.findings).toEqual([]);
    expect(r).toMatchObject({ kind: "verify", dryRun: true, state: "done" });
    expect(r.checked.blobs).toBe(4);
    expect(r.checked.scrubbed).toBe(4);
  });
});

describe("T-10 each corrupt fixture is detected; dry run changes nothing; repair fixes it", () => {
  async function broken() {
    const t = await startStorageTest();
    const { a, b, c } = await healthy(t);
    const db = t.svc.db;
    const vol = t.svc.volumes.list()[0]!;
    // I-1: delete a blob file
    fs.rmSync(t.seed.blobFile(c.blobShas[0]!));
    // I-2: a stray file with no row
    const stray = path.join(vol.rootPath, "blobs", "ab", "cd");
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, "f".repeat(64)), "stray");
    // I-3: skew a refcount, and a missing zero_since
    db.run("UPDATE blobs SET refcount = 7 WHERE sha256 = ?", [a.blobShas[0]!]);
    // I-4: a reference whose version does not exist (foreign keys off for the insert)
    db.pragma("foreign_keys = OFF");
    db.run("INSERT INTO asset_references (version_id, asset_id, role, referenced_url) VALUES (999999, (SELECT MIN(id) FROM assets), 'other', 'https://x.test/dangling')");
    db.pragma("foreign_keys = ON");
    // I-5: a version left in capturing, with no job
    await t.seed.page({ url: "https://m.test/stuck", sources: [], versions: [{ status: "capturing", ageDays: 2, blobs: [{ tag: "stuck", bytes: 100 }] }] });
    // I-6: a latest pointer to a version of another page
    db.run("UPDATE pages SET latest_version_id = ? WHERE id = ?", [a.versionIds[0], b.pageId]);
    // I-7: a host that thinks a request is in flight
    db.run("INSERT INTO host_state (host, in_flight) VALUES ('ghost.test', 3)");
    // I-8: a reservation for a download that is over
    const dl = Number(db.run("INSERT INTO download_jobs (public_id, kind, state, priority, requested_by, created_at) VALUES ('dl_STALE', 'capture', 'completed', 3, 'user', ?)", [t.svc.clock.now()]).lastInsertRowid);
    db.run("INSERT INTO volume_reservations (volume_id, download_job_id, reserved_bytes, created_at, expires_at) VALUES (?, ?, 500, ?, ?)", [vol.id, dl, t.svc.clock.now(), t.svc.clock.now() + 1_000_000]);
    // I-9: an old temp file
    const tmp = path.join(vol.rootPath, "tmp", "old.part");
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, "x");
    const old = new Date(Date.now() - 3 * 86_400_000);
    fs.utimesSync(tmp, old, old);
    // I-11: same size, different bytes
    const file = t.seed.blobFile(b.blobShas[0]!);
    fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size, 0x41));
    return { t, a, b, c };
  }

  it("dry run (the default) finds every one of them and changes nothing", async () => {
    const { t } = await broken();
    const before = archiveSignature(t);
    const res = await t.api("POST", "/api/system/maintenance/verify", {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: "verify", dryRun: true, state: "done" });
    const found = new Map<string, { count: number; examples: string[] }>(res.body.findings.map((f: { invariant: string; count: number; examples: string[] }) => [f.invariant, f]));
    for (const inv of ["I-1", "I-2", "I-3", "I-4", "I-5", "I-6", "I-7", "I-8", "I-9", "I-11"]) expect(found.get(inv)?.count, inv).toBeGreaterThanOrEqual(1);
    expect(res.body.findings.every((f: { repaired?: number }) => f.repaired === undefined)).toBe(true);
    expect(archiveSignature(t)).toEqual(before);
    // also nothing else in the database changed: counts of the tables repair would touch
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM host_state WHERE in_flight = 3")!.n).toBe(1);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM volume_reservations")!.n).toBe(1);
    // the report is kept
    const runs = (await t.api("GET", "/api/system/maintenance/runs")).body;
    expect(runs.items[0]).toMatchObject({ id: res.body.id, dryRun: true });
    expect((await t.api("GET", `/api/system/maintenance/runs/${res.body.id}`)).body.findings).toEqual(res.body.findings);
  });

  it("repair fixes each one, and a second check is clean", async () => {
    const { t, a, b, c } = await broken();
    const res = await t.api("POST", "/api/system/maintenance/verify", { repair: true });
    expect(res.body).toMatchObject({ kind: "repair", dryRun: false, state: "done" });
    for (const f of res.body.findings) expect(f.repaired, f.invariant).toBe(f.count);

    // I-1: the file is gone, so the blob is marked missing and the page that used it is partial, not silently broken
    expect(t.svc.blobs.bySha(c.blobShas[0]!)!.state).toBe("missing");
    expect(t.seed.versionStatus(c.versionIds[0]!)).toBe("partial");
    // I-2: the stray file is quarantined, not deleted
    const vol = t.svc.volumes.list()[0]!;
    expect(fs.existsSync(path.join(vol.rootPath, "blobs", "ab", "cd", "f".repeat(64)))).toBe(false);
    expect(fs.readdirSync(path.join(vol.rootPath, "quarantine")).some((f) => f.endsWith("f".repeat(64)))).toBe(true);
    // I-3
    expect(t.svc.blobs.bySha(a.blobShas[0]!)!.refcount).toBe(1);
    // I-5: the stuck copy is failed and its blob released
    expect(t.svc.db.get<{ s: string }>("SELECT status AS s FROM page_versions WHERE requested_url = 'https://m.test/stuck'")!.s).toBe("failed");
    // I-6: the pointer is back on the page's own version
    expect(t.svc.db.get<{ l: number }>("SELECT latest_version_id AS l FROM pages WHERE id = ?", [b.pageId])!.l).toBe(b.versionIds[0]);
    // I-7, I-8, I-9
    expect(t.svc.db.get<{ n: number }>("SELECT in_flight AS n FROM host_state WHERE host = 'ghost.test'")!.n).toBe(0);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM volume_reservations")!.n).toBe(0);
    expect(fs.existsSync(path.join(vol.rootPath, "tmp", "old.part"))).toBe(false);
    // I-11: the corrupted file is moved aside and the blob marked missing; its page is partial
    expect(t.svc.blobs.bySha(b.blobShas[0]!)!.state).toBe("missing");
    expect(t.seed.versionStatus(b.versionIds[0]!)).toBe("partial");

    const again = await t.svc.storage.maintenance.verify({ checks: STORAGE_CHECKS });
    expect(again.findings, JSON.stringify(again.findings)).toEqual([]);
    expect(t.svc.db.pragma("foreign_key_check")).toEqual([]);
  });

  it("only the checks asked for are run, and an unknown check is a 400", async () => {
    const { t } = await broken();
    const r = await t.api("POST", "/api/system/maintenance/verify", { checks: ["I-8"] });
    expect(r.body.findings.map((f: { invariant: string }) => f.invariant)).toEqual(["I-8"]);
    expect((await t.api("POST", "/api/system/maintenance/verify", { checks: ["I-99"] })).status).toBe(400);
  });
});

describe("T-10 invariant I-13 and the index (I-10)", () => {
  it("reports a Protected copy that was evicted without a record, loudly, and does not repair it", async () => {
    const t = await startStorageTest();
    const { a } = await healthy(t);
    t.svc.db.run("UPDATE page_versions SET status = 'evicted' WHERE id = ?", [a.versionIds[0]]);
    const r = await t.svc.storage.maintenance.verify({ checks: ["I-13"], repair: true });
    expect(r.findings[0]).toMatchObject({ invariant: "I-13", count: 1, repaired: 0 });
    expect(t.svc.db.get<{ level: string }>("SELECT level FROM activity_log WHERE area = 'storage' AND message LIKE 'Repair finished%' ORDER BY id DESC LIMIT 1")!.level).toBe("error");
  });

  it("detects an index that is missing a document and repair has it rebuilt", async () => {
    const t = await startSearchServer();
    await t.svc.search.waitForRebuild();
    const s = { seed: new (await import("../../storage-safety/helpers.js")).Seeder(t) };
    const src = s.seed.source({ priority: 3 });
    for (const trg of t.svc.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'idxo_%'")) t.svc.db.exec(`DROP TRIGGER ${trg.name}`);
    await s.seed.page({ url: "https://i.test/never-indexed", sources: [src], versions: [{ blobs: [{ tag: "i", bytes: 50 }] }] });
    await drained(t);
    const dry = await t.svc.storage.maintenance.verify({ checks: ["I-10"] });
    expect(dry.findings[0]).toMatchObject({ invariant: "I-10" });
    const fixed = await t.svc.storage.maintenance.verify({ checks: ["I-10"], repair: true });
    expect(fixed.findings[0]).toMatchObject({ invariant: "I-10", repaired: expect.any(Number) });
    await t.svc.search.waitForRebuild();
    expect((await t.svc.storage.maintenance.verify({ checks: ["I-10"] })).findings).toEqual([]);
  });
});

describe("nightly quick_check and the throttled hash scrub", () => {
  it("the storage pass runs a quick_check once a day and scrubs a bounded amount, flagging a corrupted file without changing it", async () => {
    const t = await startStorageTest();
    const { b } = await healthy(t);
    await t.svc.storage.tick();
    const runs = t.svc.storage.maintenance.list().items;
    expect(runs.filter((r) => r.kind === "integrity_check")).toHaveLength(1);
    await t.svc.storage.tick();
    expect(t.svc.storage.maintenance.list().items.filter((r) => r.kind === "integrity_check")).toHaveLength(1); // not again the same day
    t.fake.advance(25 * 3_600_000);
    await t.svc.storage.tick();
    expect(t.svc.storage.maintenance.list().items.filter((r) => r.kind === "integrity_check")).toHaveLength(2);
    // scrub: good blobs get a verified_at; a corrupted one is logged, not touched
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM blobs WHERE verified_at IS NOT NULL")!.n).toBe(4);
    const file = t.seed.blobFile(b.blobShas[0]!);
    fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size, 0x42));
    t.svc.db.run("UPDATE blobs SET verified_at = 1");
    const { notes } = await t.svc.storage.tick();
    expect(notes.join(" ")).toMatch(/checksum/);
    expect(t.svc.blobs.bySha(b.blobShas[0]!)!.state).toBe("ready");
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity_log WHERE level = 'error' AND message LIKE '%checksum%'")!.n).toBe(1);
    expectConsistent(t, expect);
  });

  it("a backup of main.db can be written", async () => {
    const t = await startStorageTest();
    const r = await t.api("POST", "/api/system/maintenance/backup");
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(t.dataDir, "backups", r.body.file))).toBe(true);
  });
});
