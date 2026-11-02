import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CHEM_UUID, fixtureZims, folderBytes, startZimServer } from "./helpers.js";

/** Z-03 (import and management) and Z-09 (the knowledge_package source). */
describe("registering knowledge packages", () => {
  it("adds a ZIM in place: validates it, reads the metadata and licence, checksums it, and does not write a copy", async () => {
    const t = await startZimServer();
    const p = await t.place("big");
    const before = folderBytes(t.dataDir, t.rootsDir);
    const res = await t.api("POST", "/api/zim/packages/import", { path: p });
    expect(res.status).toBe(201);
    const z = res.body;
    expect(z).toMatchObject({
      title: "Large package (fixture)", language: "eng", flavour: "maxi", storageMode: "in_place", state: "ready", priority: "P1", neverAutoEvicted: true,
      enabledForSearch: true, hasFulltextIndex: false, newNamespaceScheme: true, path: p,
    });
    expect(z.id).toMatch(/^zim_/);
    expect(z.sizeBytes).toBe(fs.statSync(p).size);
    expect(z.license).toMatchObject({ name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/", known: true });
    expect(z.attribution).toMatch(/Large package \(fixture\).*NoConBrain.*CC BY-SA 4\.0/);
    // the checksum is computed in the background by reading the file, never by writing
    await t.svc.zim.idle();
    const done = (await t.api("GET", `/api/zim/packages/${z.id}`)).body;
    expect(done.checksum).toEqual({ state: "done", sha256: createHash("sha256").update(fs.readFileSync(p)).digest("hex") });
    // Read in place without full extraction: a 24 MiB package adds well under a megabyte of files (the database and logs only).
    const written = folderBytes(t.dataDir, t.rootsDir) - before;
    expect(fs.statSync(p).size).toBeGreaterThan(20 * 1024 * 1024);
    expect(written).toBeLessThan(1024 * 1024);
    // the file is untouched
    expect((await fixtureZims()).big && fs.statSync(p).size).toBe(fs.statSync((await fixtureZims()).big).size);
    // and it reads: the entry list comes from the file directly
    const entries = (await t.api("GET", `/api/zim/packages/${z.id}/entries`)).body;
    expect(entries.items.map((e: { path: string }) => e.path)).toContain("Big_article");
    expect(t.svc.activity && t.svc.db.get("SELECT COUNT(*) AS n FROM activity_log WHERE area = 'zim'")).toMatchObject({ n: expect.any(Number) });
  });

  it("copy mode copies the file into a volume's zim folder with a verified checksum, and the copy is what is read", async () => {
    const t = await startZimServer();
    const v = { id: t.svc.volumes.list()[0]!.publicId };
    expect(v.id).toMatch(/^vol_/);
    const volRoot = t.svc.volumes.list()[0]!.rootPath;
    const src = await t.place("chem");
    const res = await t.api("POST", "/api/zim/packages/import", { path: src, copy: true, volumeId: v.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ storageMode: "copied", state: "ready", volumeId: v.id, checksum: { state: "done" } });
    expect(res.body.path.startsWith(path.join(volRoot, "zim"))).toBe(true);
    expect(fs.existsSync(res.body.path)).toBe(true);
    expect(fs.readdirSync(path.join(volRoot, "zim")).filter((f) => f.endsWith(".partial"))).toEqual([]);
    expect(res.body.checksum.sha256).toBe(createHash("sha256").update(fs.readFileSync(src)).digest("hex"));
    // storage accounting: the copy counts against the volume and shows under its priority
    const usage = (await t.api("GET", "/api/storage/usage?by=priority")).body;
    expect(usage.knowledgePackages).toMatchObject({ count: 1, copiedBytes: res.body.sizeBytes, inPlaceBytes: 0, neverAutoEvicted: true });
    expect(usage.items.find((i: { key: string }) => i.key === "P1").exclusiveBytes).toBe(res.body.sizeBytes);
    const vol = (await t.api("GET", `/api/storage/volumes/${v.id}`)).body;
    expect(vol.usedBytes).toBeGreaterThanOrEqual(res.body.sizeBytes);
    expect(vol.usageByPriority.P1).toBeGreaterThanOrEqual(res.body.sizeBytes);
    // the volume cannot be removed while it holds a package
    expect((await t.api("DELETE", `/api/storage/volumes/${v.id}`)).status).toBe(409);
  });

  it("rejects a second file with the same UUID, a damaged file, a path outside the allowed roots and a duplicate path", async () => {
    const t = await startZimServer();
    const first = await t.add("chem");
    expect(first.status).toBe(201);
    const dup = await t.add("chem", {}, "chem-copy.zim");
    expect(dup.status).toBe(409);
    expect(dup.body.message).toMatch(/already added/);
    expect(dup.body.details).toMatchObject({ existing: first.body.id, uuid: CHEM_UUID });
    expect((await t.api("GET", "/api/zim/packages")).body.total).toBe(1);

    const bad = await t.add("bad");
    expect(bad.status).toBe(400);
    expect(bad.body.details.fields[0].path).toBe("path");
    expect(bad.body.message).toMatch(/not a valid ZIM/);
    // the server survived the damaged file and still answers
    expect((await t.api("GET", "/api/zim/packages")).status).toBe(200);

    const outside = await t.api("POST", "/api/zim/packages/import", { path: "/etc/hosts.zim" });
    expect(outside.status).toBe(400);
    expect(outside.body.details.fields[0].message).toMatch(/allowed locations/);
    const again = await t.api("POST", "/api/zim/packages/import", { path: first.body.path });
    expect(again.status).toBe(409);
    expect((await t.api("POST", "/api/zim/packages/import", { path: "relative.zim" })).status).toBe(400);
    expect((await t.api("POST", "/api/zim/packages/import", { path: path.join(t.rootsDir, "library", "nope.zim") })).status).toBe(400);
    const notZim = path.join(t.rootsDir, "library", "notes.txt");
    fs.writeFileSync(notZim, "hello");
    expect((await t.api("POST", "/api/zim/packages/import", { path: notZim })).body.details.fields[0].message).toMatch(/\.zim/);
    // a path that escapes through a symlink is refused too
    const link = path.join(t.rootsDir, "library", "link.zim");
    fs.symlinkSync("/etc/hosts", link);
    expect((await t.api("POST", "/api/zim/packages/import", { path: link })).status).toBe(400);
  });

  it("lists and filters packages, patches priority, search flag and attribution, and tracks a missing file", async () => {
    const t = await startZimServer();
    const a = (await t.add("chem")).body;
    const b = (await t.add("other")).body;
    expect((await t.api("GET", "/api/zim/packages")).body.total).toBe(2);
    expect((await t.api("GET", "/api/zim/packages?language=fr")).body.items.map((x: { id: string }) => x.id)).toEqual([b.id]);
    expect((await t.api("GET", "/api/zim/packages?language=eng")).body.items.map((x: { id: string }) => x.id)).toEqual([a.id]);
    const patched = await t.api("PATCH", `/api/zim/packages/${a.id}`, { priority: "P2", enabledForSearch: false, attribution: "Custom credit line." });
    expect(patched.body).toMatchObject({ priority: "P2", enabledForSearch: false, attribution: "Custom credit line." });
    expect((await t.api("GET", "/api/zim/packages?enabledForSearch=false")).body.total).toBe(1);
    expect((await t.api("PATCH", `/api/zim/packages/${a.id}`, { priority: "P9" })).status).toBe(400);
    // remove the file behind the registry's back: verify says so, and the package is marked missing rather than vanishing
    fs.rmSync(a.path);
    const v = await t.api("POST", `/api/zim/packages/${a.id}/verify`, {});
    expect(v.body.ok).toBe(false);
    expect(v.body.package.state).toBe("missing");
    // put it back and it recovers
    fs.copyFileSync((await fixtureZims()).chem, a.path);
    const again = await t.api("POST", `/api/zim/packages/${a.id}/verify`, { deep: true });
    expect(again.body.ok).toBe(true);
    expect(again.body.checks).toContain("checksum:ok");
    expect(again.body.package.state).toBe("ready");
  });

  it("a package saved as degraded returns to ready after a successful open (for example after a restart)", async () => {
    const t = await startZimServer();
    const z = (await t.add("chem")).body;
    await t.svc.zimSource.close(z.id); // as after a restart: nothing is open
    t.svc.db.run("UPDATE zim_packages SET state = 'degraded', state_detail = 'old fault' WHERE public_id = ?", [z.id]);
    expect(await t.svc.zim.ensureOpen(t.svc.zim.rowByPublic(z.id))).toBe(true);
    expect((await t.api("GET", `/api/zim/packages/${z.id}`)).body).toMatchObject({ state: "ready", stateDetail: null });
  });

  it("verify reports a damaged file instead of crashing the server", async () => {
    const t = await startZimServer();
    const z = (await t.add("chem")).body;
    const stat = fs.statSync(z.path);
    // flip a byte in the middle of the cluster data: structure is intact, the checksum is not
    const fd = fs.openSync(z.path, "r+");
    const at = Math.floor(stat.size / 2);
    const one = Buffer.alloc(1);
    fs.readSync(fd, one, 0, 1, at);
    one[0] = one[0]! ^ 0xff;
    fs.writeSync(fd, one, 0, 1, at);
    fs.closeSync(fd);
    const v = await t.api("POST", `/api/zim/packages/${z.id}/verify`, { deep: true });
    expect(v.status).toBe(200);
    expect(v.body.ok).toBe(false);
    expect((await t.api("GET", "/api/zim/packages")).status).toBe(200);
  });
});

describe("removing a package", () => {
  async function withReferences() {
    const t = await startZimServer();
    const z = (await t.add("chem")).body;
    const src = z.sourceId as string;
    const user = t.svc.db.get<{ id: number }>("SELECT id FROM users LIMIT 1")!.id;
    const now = t.clock.now();
    t.svc.db.run(
      "INSERT INTO bookmarks (public_id, user_id, original_url, url_key, title, zim_package_id, zim_path, reference_priority, created_at) VALUES ('bm_zimonly', ?, 'zim://x/Benzene', 'zim://x/Benzene', 'Benzene', (SELECT id FROM zim_packages), 'Benzene', 2, ?)", [user, now]);
    // a bookmark that also points at an archived page keeps the page
    const pg = t.svc.db.run("INSERT INTO pages (public_id, url_key, canonical_url, host, registrable_domain, origin, content_type, availability, created_at) VALUES ('pg_x', 'https://p.test/', 'https://p.test/', 'p.test', 'p.test', 'web', 'html', 'archived', ?)", [now]).lastInsertRowid;
    t.svc.db.run(
      "INSERT INTO bookmarks (public_id, user_id, original_url, url_key, title, page_id, zim_package_id, zim_path, reference_priority, created_at) VALUES ('bm_both', ?, 'https://p.test/', 'https://p.test/', 'Both', ?, (SELECT id FROM zim_packages), 'Toluene', 2, ?)", [user, pg, now]);
    const col = t.svc.db.run("INSERT INTO collections (public_id, name, kind, sort_order, created_at, updated_at) VALUES ('col_z', 'Chemistry', 'manual', 0, ?, ?)", [now, now]).lastInsertRowid;
    t.svc.db.run("INSERT INTO collection_memberships (collection_id, zim_package_id, zim_path, added_by, added_at) VALUES (?, (SELECT id FROM zim_packages), 'Benzene', 'user', ?)", [col, now]);
    return { t, z, src, user };
  }

  it("a dry run lists what refers to the package and changes nothing", async () => {
    const { t, z, src } = await withReferences();
    const plan = (await t.api("DELETE", `/api/zim/packages/${z.id}?dryRun=true`)).body;
    expect(plan.removed).toBe(false);
    expect(plan.plan.references.bookmarks).toMatchObject({ count: 2 });
    expect(plan.plan.references.collections).toMatchObject({ count: 1, items: [{ collectionId: "col_z", name: "Chemistry", entries: 1 }] });
    expect(plan.plan.references.sources.items).toEqual([{ id: src, name: "Chemistry (fixture)" }]);
    expect(plan.plan).toMatchObject({ needsConfirmation: true, deletesFile: false });
    expect((await t.api("GET", `/api/zim/packages/${z.id}/references`)).body.package.id).toBe(z.id);
    expect((await t.api("GET", "/api/zim/packages")).body.total).toBe(1);
    expect(fs.existsSync(z.path)).toBe(true);
  });

  it("without confirmation it is refused with the same list; with confirmation it cleans the references and leaves an in-place file alone", async () => {
    const { t, z, src } = await withReferences();
    const refused = await t.api("DELETE", `/api/zim/packages/${z.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.details.references.bookmarks.count).toBe(2);
    expect((await t.api("GET", "/api/zim/packages")).body.total).toBe(1);

    const done = await t.api("DELETE", `/api/zim/packages/${z.id}?confirm=true`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ removed: true, fileDeleted: false });
    expect((await t.api("GET", `/api/zim/packages/${z.id}`)).status).toBe(404);
    expect(fs.existsSync(z.path)).toBe(true); // a file the Human placed is theirs
    const db = t.svc.db;
    expect(db.get("SELECT 1 AS x FROM bookmarks WHERE public_id = 'bm_zimonly'")).toBeUndefined();
    expect(db.get("SELECT zim_package_id AS z FROM bookmarks WHERE public_id = 'bm_both'")).toEqual({ z: null });
    expect(db.get("SELECT COUNT(*) AS n FROM collection_memberships")).toEqual({ n: 0 });
    expect(db.get("SELECT deleted_at IS NOT NULL AS gone FROM sources WHERE public_id = ?", [src])).toEqual({ gone: 1 });
    // once gone, the same file can be added again
    expect((await t.api("POST", "/api/zim/packages/import", { path: z.path })).status).toBe(201);
  });

  it("a package with nothing referring to it (other than its own source) is removed without confirmation, and a copy's file is deleted", async () => {
    const t = await startZimServer();
    const v = { id: t.svc.volumes.list()[0]!.publicId };
    const z = (await t.api("POST", "/api/zim/packages/import", { path: await t.place("chem"), copy: true, volumeId: v.id })).body;
    const r = await t.api("DELETE", `/api/zim/packages/${z.id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ removed: true, fileDeleted: true });
    expect(fs.existsSync(z.path)).toBe(false);
    expect((await t.api("GET", "/api/storage/usage?by=priority")).body.knowledgePackages.count).toBe(0);
  });

  it("an interrupted removal is finished at the next start", async () => {
    const t = await startZimServer();
    const v = { id: t.svc.volumes.list()[0]!.publicId };
    const z = (await t.api("POST", "/api/zim/packages/import", { path: await t.place("chem"), copy: true, volumeId: v.id })).body;
    t.svc.db.run("UPDATE zim_packages SET state = 'removing' WHERE public_id = ?", [z.id]);
    expect((await t.svc.zim.recover()).removed).toBe(1);
    expect(fs.existsSync(z.path)).toBe(false);
    expect(t.svc.db.get("SELECT COUNT(*) AS n FROM zim_packages")).toEqual({ n: 0 });
  });
});

describe("knowledge_package sources", () => {
  it("a package gets a source that lists it, carries its priority and cannot be set to auto-evict", async () => {
    const t = await startZimServer();
    const z = (await t.add("chem")).body;
    expect(z.sourceId).toMatch(/^src_/);
    const s = (await t.api("GET", `/api/sources/${z.sourceId}`)).body;
    expect(s).toMatchObject({
      type: "knowledge_package", adapter: "zim", name: "Chemistry (fixture)", priority: "P1", automaticEviction: false, retention: { mode: "all" }, enabled: true,
      knowledgePackage: { id: z.id, title: "Chemistry (fixture)", state: "ready" },
    });
    expect((await t.api("GET", "/api/sources?type=knowledge_package")).body.total).toBe(1);
    // browse
    const page1 = (await t.api("GET", `/api/sources/${z.sourceId}/pages?limit=3`)).body;
    expect(page1.items).toHaveLength(3);
    expect(page1.items[0]).toMatchObject({ kind: "zim", zimId: z.id });
    expect(page1.total).toBe(z.counts.articles);
    const page2 = (await t.api("GET", `/api/sources/${z.sourceId}/pages?limit=100&cursor=${encodeURIComponent(page1.nextCursor)}`)).body;
    expect(page2.items.map((i: { path: string }) => i.path)).not.toContain(page1.items[0].path);
    // stats and storage accounting
    const stats = (await t.api("GET", `/api/sources/${z.sourceId}/stats`)).body;
    expect(stats).toMatchObject({ pages: z.counts.articles, latestBytes: z.sizeBytes, knowledgePackage: { id: z.id } });
    // priority and retention semantics: priority is shared with the package, eviction can never be switched on
    const up = await t.api("PATCH", `/api/sources/${z.sourceId}`, { priority: "P2" });
    expect(up.body.priority).toBe("P2");
    expect((await t.api("GET", `/api/zim/packages/${z.id}`)).body.priority).toBe("P2");
    const evict = await t.api("PATCH", `/api/sources/${z.sourceId}`, { automaticEviction: true });
    expect(evict.status).toBe(400);
    expect(evict.body.details.fields[0].message).toMatch(/never removed automatically/);
    // switching the source off takes the package out of search, switching it on puts it back
    await t.api("PATCH", `/api/sources/${z.sourceId}`, { enabled: false });
    expect((await t.api("GET", `/api/zim/packages/${z.id}`)).body.enabledForSearch).toBe(false);
    // running it makes no sense
    expect((await t.api("POST", `/api/sources/${z.sourceId}/run`)).status).toBe(409);
    // storage-by-source shows it
    const bySource = (await t.api("GET", "/api/storage/usage?by=source")).body;
    expect(bySource.items.find((i: { key: string }) => i.key === z.sourceId)).toBeUndefined(); // in place: outside the volumes
    expect(bySource.knowledgePackages.inPlaceBytes).toBe(z.sizeBytes);
  });

  it("creating a knowledge_package source needs a package; deleting the source keeps the package", async () => {
    const t = await startZimServer();
    const z = (await t.add("chem", { createSource: false })).body;
    expect(z.sourceId).toBeNull();
    const none = await t.api("POST", "/api/sources", { name: "KP", type: "knowledge_package" });
    expect(none.status).toBe(400);
    expect(none.body.details.fields[0].path).toBe("zimId");
    expect((await t.api("POST", "/api/sources", { name: "KP", type: "knowledge_package", zimId: "zim_nope" })).status).toBe(400);
    const made = await t.api("POST", "/api/sources", { name: "My chemistry", type: "knowledge_package", zimId: z.id, priority: "P3" });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: "My chemistry", priority: "P3", knowledgePackage: { id: z.id } });
    expect((await t.api("POST", "/api/sources", { name: "Again", type: "knowledge_package", zimId: z.id })).status).toBe(409);
    expect((await t.api("DELETE", `/api/sources/${made.body.id}`)).status).toBe(200);
    expect((await t.api("GET", `/api/zim/packages/${z.id}`)).body).toMatchObject({ id: z.id, state: "ready", sourceId: null });
  });
});
