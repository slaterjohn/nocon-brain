import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SimulatedCrash, VolumeUnavailableError, blobPathFor } from "@ncb/server";
import { call, setupAdmin, startServer, tempDir } from "./helpers.js";

async function withVolume(opts: Parameters<typeof startServer>[0] = {}) {
  const t = await startServer(opts);
  const { volume } = await t.svc.volumes.register({ path: t.volDir, name: "Main" });
  return { ...t, volume };
}

describe("F-07 blob store", () => {
  it("stores identical content once", async () => {
    const t = await withVolume();
    const a = await t.svc.blobs.put(Buffer.from("<html>hello</html>"), { kind: "document", mime: "text/html" });
    const b = await t.svc.blobs.put(Readable.from([Buffer.from("<html>hello</html>")]), { kind: "document" });
    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(true);
    expect(b.blob.id).toBe(a.blob.id);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) n FROM blobs")!.n).toBe(1);
    const files: string[] = [];
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
    walk(path.join(t.volDir, "blobs"));
    expect(files).toHaveLength(1);
    expect(fs.readdirSync(path.join(t.volDir, "tmp"))).toEqual([]);
  });

  it("round-trips text through zstd and leaves binary kinds uncompressed", async () => {
    const t = await withVolume();
    const text = "lorem ipsum dolor sit amet ".repeat(2000);
    const r = await t.svc.blobs.put(text, { kind: "text" });
    expect(r.blob.compression).toBe("zstd");
    expect(r.blob.sizeBytes).toBe(Buffer.byteLength(text));
    expect(r.blob.storedBytes).toBeLessThan(r.blob.sizeBytes / 5);
    expect((await t.svc.blobs.read(r.blob.sha256)).data.toString()).toBe(text);

    const bin = Buffer.from([0, 1, 2, 3, 255, 254]);
    const img = await t.svc.blobs.put(bin, { kind: "image" });
    expect(img.blob.compression).toBe("none");
    expect(img.blob.storedBytes).toBe(bin.length);
    expect((await t.svc.blobs.read(img.blob.sha256)).data.equals(bin)).toBe(true);
  });

  it("derives the path from the sha only", async () => {
    const t = await withVolume();
    const r = await t.svc.blobs.put("abc", { kind: "css" });
    const sha = r.blob.sha256;
    expect(blobPathFor(t.volDir, sha, true)).toBe(path.join(t.volDir, "blobs", sha.slice(0, 2), sha.slice(2, 4), `${sha}.zst`));
    expect(fs.existsSync(blobPathFor(t.volDir, sha, true))).toBe(true);
    for (const evil of ["../../etc/passwd", "ab/../../x", `${sha}/..`, sha.toUpperCase(), "", sha.slice(1)]) {
      expect(() => blobPathFor(t.volDir, evil, false), evil).toThrow();
    }
    await expect(t.svc.blobs.open("../../etc/passwd")).rejects.toThrow();
  });

  it("leaves no row after a crash between temp write and rename, and cleans the leftover", async () => {
    let crash = true;
    const t = await withVolume({ server: { blobFault: () => { if (crash) throw new SimulatedCrash("boom"); } } });
    await expect(t.svc.blobs.put("crash me", { kind: "text" })).rejects.toBeInstanceOf(SimulatedCrash);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) n FROM blobs")!.n).toBe(0);
    const tmp = path.join(t.volDir, "tmp");
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith(".part"))).toHaveLength(1);
    expect(fs.existsSync(path.join(t.volDir, "blobs", "ab"))).toBe(false);

    expect(await t.svc.blobs.cleanTmp(t.volume, 3_600_000)).toBe(0); // young files are kept
    expect(await t.svc.blobs.cleanTmp(t.volume, 0)).toBe(1);
    expect(fs.readdirSync(tmp)).toEqual([]);

    crash = false;
    const ok = await t.svc.blobs.put("crash me", { kind: "text" });
    expect(ok.deduplicated).toBe(false);
  });

  it("cleans leftovers at startup", async () => {
    const t = await withVolume();
    fs.writeFileSync(path.join(t.volDir, "tmp", "old.part"), "x");
    await t.server.close();
    const again = await startServer({ dataDir: t.dataDir, rootsDir: t.rootsDir });
    expect(fs.readdirSync(path.join(t.volDir, "tmp"))).toEqual([]);
    expect(again.svc.volumes.list()).toHaveLength(1);
  });

  it("returns a typed error for an offline volume", async () => {
    const t = await withVolume();
    const r = await t.svc.blobs.put("hello", { kind: "text" });
    fs.renameSync(path.join(t.volDir, ".noconbrain-volume"), path.join(t.volDir, "marker.away"));
    await expect(t.svc.blobs.read(r.blob.sha256)).rejects.toBeInstanceOf(VolumeUnavailableError);
    await expect(t.svc.blobs.put("new", { kind: "text" })).rejects.toBeInstanceOf(VolumeUnavailableError);
    const err = await t.svc.blobs.read(r.blob.sha256).catch((e) => e);
    expect(err).toMatchObject({ kind: "volume_unavailable", code: "conflict", details: { volumeId: t.volume.publicId } });
    expect(t.svc.volumes.byId(t.volume.id)!.state).toBe("offline");
    // Bringing it back makes it usable again.
    fs.renameSync(path.join(t.volDir, "marker.away"), path.join(t.volDir, ".noconbrain-volume"));
    expect((await t.svc.blobs.read(r.blob.sha256)).data.toString()).toBe("hello");
  });

  it("counts references and collects garbage after the grace period", async () => {
    const t = await withVolume();
    const { blob } = await t.svc.blobs.put("refcounted", { kind: "text" });
    t.svc.blobs.addRef(blob.id, 2);
    expect(t.svc.blobs.bySha(blob.sha256)).toMatchObject({ refcount: 2, zeroSince: null });
    expect(t.svc.blobs.release(blob.id)).toBe(1);
    expect(t.svc.blobs.release(blob.id)).toBe(0);
    expect(t.svc.blobs.bySha(blob.sha256)!.zeroSince).not.toBeNull();
    await expect(t.svc.blobs.delete(blob.sha256)).resolves.toBe(true);
    const again = await t.svc.blobs.put("refcounted", { kind: "text" });
    t.svc.blobs.addRef(again.blob.id);
    await expect(t.svc.blobs.delete(again.blob.sha256)).rejects.toThrow(/in use/);
    t.svc.blobs.release(again.blob.id);
    expect(await t.svc.blobs.collectGarbage(1000)).toBe(0);
    t.fake.advance(2000);
    expect(await t.svc.blobs.collectGarbage(1000)).toBe(1);
    expect(t.svc.blobs.bySha(again.blob.sha256)).toBeUndefined();
  });

  it("enforces a size cap and cleans up", async () => {
    const t = await withVolume();
    await expect(t.svc.blobs.put(Buffer.alloc(5000, 1), { kind: "other", maxBytes: 100 })).rejects.toMatchObject({ code: "insufficient_storage" });
    expect(fs.readdirSync(path.join(t.volDir, "tmp"))).toEqual([]);
  });
});

describe("F-07 volumes API", () => {
  it("rejects paths outside the allowed roots, relative paths and symlink escapes", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    const outside = tempDir("ncb-outside-");
    const link = path.join(t.rootsDir, "link");
    fs.symlinkSync(outside, link);
    for (const p of [outside, "relative/path", "/", path.join(t.rootsDir, "..", "x"), link]) {
      const res = await call(t, { url: "/api/storage/volumes", body: { path: p, name: "X" }, cookie });
      expect(res.statusCode, p).toBe(400);
      expect(res.json().details.fields[0].path).toBe("path");
    }
    expect(t.svc.volumes.list()).toHaveLength(0);
    const missing = await call(t, { url: "/api/storage/volumes", body: { path: path.join(t.rootsDir, "nope"), name: "X" }, cookie });
    expect(missing.statusCode).toBe(400);
  });

  it("registers, lists, updates, verifies and removes a volume", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    const created = await call(t, { url: "/api/storage/volumes", body: { path: t.volDir, name: "Main", reserveFreeBytes: 1000 }, cookie });
    expect(created.statusCode).toBe(201);
    const { volume, warnings } = created.json();
    expect(warnings).toEqual(expect.any(Array));
    expect(volume).toMatchObject({
      name: "Main", state: "online", isDefault: true, usedBytes: 0, reservedBytes: 0, reserveFreeBytes: 1000,
      thresholds: { softPct: 85, evictStartPct: 90, evictTargetPct: 80 }, usageByPriority: { P1: 0, P2: 0, P3: 0, P4: 0 },
    });
    expect(volume.id).toMatch(/^vol_/);
    expect(volume.capacityBytes).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(t.volDir, ".noconbrain-volume"))).toBe(true);

    const dup = await call(t, { url: "/api/storage/volumes", body: { path: t.volDir, name: "Again" }, cookie });
    expect(dup.statusCode).toBe(409);

    const list = (await call(t, { url: "/api/storage/volumes", cookie })).json();
    expect(list.items).toHaveLength(1);
    await t.svc.blobs.put("data", { kind: "text" });
    const detail = (await call(t, { url: `/api/storage/volumes/${volume.id}`, cookie })).json();
    expect(detail.usedBytes).toBeGreaterThan(0);
    expect(detail.blobCount).toBe(1);

    const patched = await call(t, { method: "PATCH", url: `/api/storage/volumes/${volume.id}`, body: { name: "Renamed", quotaBytes: 5000, thresholds: { evictTargetPct: 70 } }, cookie });
    expect(patched.json()).toMatchObject({ name: "Renamed", quotaBytes: 5000, thresholds: { evictTargetPct: 70 } });
    const badThreshold = await call(t, { method: "PATCH", url: `/api/storage/volumes/${volume.id}`, body: { thresholds: { evictTargetPct: 95 } }, cookie });
    expect(badThreshold.statusCode).toBe(400);

    const verify = await call(t, { url: `/api/storage/volumes/${volume.id}/verify`, body: {}, cookie });
    expect(verify.json()).toMatchObject({ markerOk: true, writable: true, checkedBlobs: 1, missingBlobs: 0 });

    expect((await call(t, { url: `/api/storage/volumes/${volume.id}/migrate`, body: {}, cookie })).statusCode).toBe(501);
    expect((await call(t, { url: "/api/storage/volumes/vol_nope", cookie })).statusCode).toBe(400);
    expect((await call(t, { url: "/api/storage/volumes/vol_01J00000000000000000000000", cookie })).statusCode).toBe(404);

    const refused = await call(t, { method: "DELETE", url: `/api/storage/volumes/${volume.id}`, cookie });
    expect(refused.statusCode).toBe(409);
    await t.svc.blobs.delete((t.svc.db.get<{ sha256: string }>("SELECT sha256 FROM blobs")!).sha256);
    expect((await call(t, { method: "DELETE", url: `/api/storage/volumes/${volume.id}`, cookie })).statusCode).toBe(200);
  });

  it("reports an offline volume and warns about the container filesystem, SD cards and low space", async () => {
    const t = await startServer({
      server: {
        volumeProbes: {
          onRootFilesystem: () => true,
          mountinfo: () => `36 25 179:2 / ${t_root()} rw - ext4 /dev/mmcblk0p2 rw\n`,
          statfs: async () => ({ total: 10_000, free: 100 }),
        },
      },
    });
    function t_root() { return fs.realpathSync(t.rootsDir); }
    const cookie = await setupAdmin(t);
    const created = await call(t, { url: "/api/storage/volumes", body: { path: t.volDir, name: "Main", reserveFreeBytes: 1000 }, cookie });
    expect(created.json().warnings.sort()).toEqual(["low_free_space", "on_container_filesystem", "sd_card_suspected"]);
    const id = created.json().volume.id;
    fs.rmSync(path.join(t.volDir, ".noconbrain-volume"));
    const detail = await call(t, { url: `/api/storage/volumes/${id}`, cookie });
    expect(detail.json().state).toBe("offline");
    expect((await call(t, { url: `/api/storage/volumes/${id}/verify`, body: {}, cookie })).json().markerOk).toBe(false);
  });

  it("requires a session", async () => {
    const t = await startServer();
    await setupAdmin(t);
    expect((await call(t, { url: "/api/storage/volumes" })).statusCode).toBe(401);
  });
});
