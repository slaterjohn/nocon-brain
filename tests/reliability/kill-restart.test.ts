import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { tempDir } from "../integration/server/helpers.js";
import { addDoc, searchApi, startSearchServer, until } from "../integration/search/helpers.js";
import { fixtureZims, startZimServer } from "../integration/zim/helpers.js";
import { startPipelineServer } from "../integration/pipeline/helpers.js";
import { startCrawlServer } from "../integration/crawl/helpers.js";
import { CHILD, expectKilled, integrity, listFiles, startChild, verifyAll } from "./helpers.js";

// H-01: a real server process is killed with SIGKILL at an awkward moment, and a new one starts on the same data. The pipeline stages, the crawl and
// the eviction run have their own kill tests (tests/integration/pipeline/crash.test.ts, tests/integration/crawl/kill.test.ts,
// tests/storage-safety/interrupted-eviction.test.ts), which this suite runs too. This file covers the rest.

const WORDS = ["lamp", "rock", "tide", "wave", "sail", "mast", "keel", "buoy", "port", "dock"];

describe("kill during an index rebuild", () => {
  it("SIGKILL part-way through a rebuild: the next start resumes it and ends with the same index, nothing corrupt", async () => {
    const dataDir = tempDir("ncb-rel-data-");
    const rootsDir = tempDir("ncb-rel-roots-");
    const one = await startSearchServer({ dataDir, rootsDir });
    await one.svc.search.waitForRebuild();
    for (let i = 0; i < 12; i++) await addDoc(one, `p${i}.html`, `Page about ${WORDS[i % WORDS.length]} number ${i}`, `This page number ${i} talks about the ${WORDS[i % WORDS.length]} at sea, with enough text to be kept. `.repeat(2));
    await one.svc.search.drain();
    await one.server.close();
    fs.rmSync(path.join(dataDir, "index"), { recursive: true, force: true });

    const child = startChild(CHILD, { MODE: "rebuild", CHILD_DATA_DIR: dataDir, CHILD_ROOTS_DIR: rootsDir });
    await child.waitFor(/^REBUILD [3-9]/);
    await child.kill();
    expectKilled(await child.exited);
    expect(fs.existsSync(path.join(dataDir, "index", "index.db"))).toBe(false); // the half-built copy is not the live index

    const back = await startSearchServer({ dataDir, rootsDir, signIn: true });
    await until(async () => (await back.api("GET", "/api/index/status")).body.state === "ok", 60_000);
    expect((await back.api("GET", "/api/index/status")).body).toMatchObject({ docs: 12, drift: 0 });
    expect((await searchApi(back, { query: "tide" })).body.results.length).toBeGreaterThan(0);
    expect(integrity(path.join(dataDir, "index", "index.db"))).toEqual([]);
    expect(integrity(path.join(dataDir, "db", "main.db"))).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, "index", "index.rebuild.db"))).toBe(false);
    expect(await verifyAll(back.svc)).toEqual([]);
  });
});

describe("kill during a ZIM import (copy)", () => {
  it.each([["copy-chunk"], ["after-rename"]])("SIGKILL at %s: no half package, no stray file, and the import can be repeated", async (fault) => {
    const dataDir = tempDir("ncb-rel-data-");
    const rootsDir = tempDir("ncb-rel-roots-");
    const zims = await fixtureZims();
    fs.mkdirSync(path.join(rootsDir, "library"), { recursive: true });
    const src = path.join(rootsDir, "library", "big.zim");
    fs.copyFileSync(zims.big, src);

    const child = startChild(CHILD, { MODE: "zim-copy", CHILD_DATA_DIR: dataDir, CHILD_ROOTS_DIR: rootsDir, ZIM_PATH: src, ZIM_FAULT: fault });
    expectKilled(await child.exited);
    const zimDir = path.join(rootsDir, "vol", "zim");
    // The crash left what a crash leaves: a partial copy, or a whole copy no package owns yet.
    expect(listFiles(zimDir).length).toBeGreaterThan(0);

    const t = await startZimServer({ dataDir, rootsDir });
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM zim_packages")!.n).toBe(0);
    expect(listFiles(zimDir)).toEqual([]);
    expect(fs.existsSync(src)).toBe(true); // the original is never touched
    const log = t.svc.db.all<{ message: string }>("SELECT message FROM activity_log WHERE area = 'zim'");
    expect(log.some((l) => /interrupted and has been discarded/.test(l.message))).toBe(true);
    const again = await t.api("POST", "/api/zim/packages/import", { path: src, copy: true });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ state: "ready", storageMode: "copied" });
    expect(await verifyAll(t.svc)).toEqual([]);
  });
});

describe("kill during a backup", () => {
  it.each([["after-main"], ["before-rename"]])("SIGKILL at %s: no backup that looks finished, the leftovers go at startup, the next backup works", async (fault) => {
    const dataDir = tempDir("ncb-rel-data-");
    const rootsDir = tempDir("ncb-rel-roots-");
    const one = await startSearchServer({ dataDir, rootsDir });
    await addDoc(one, "a.html", "Alpha page", "Alpha text for the archive that the backup should hold. ".repeat(3));
    await one.svc.search.drain();
    await one.server.close();

    const child = startChild(CHILD, { MODE: "backup", CHILD_DATA_DIR: dataDir, CHILD_ROOTS_DIR: rootsDir, BACKUP_FAULT: fault });
    expectKilled(await child.exited);
    const left = fs.readdirSync(path.join(dataDir, "backups")).filter((n) => n.startsWith(".tmp-backup-") || n.startsWith("backup-"));
    expect(left.some((n) => n.startsWith(".tmp-backup-"))).toBe(true);
    expect(left.some((n) => n.startsWith("backup-"))).toBe(false);

    const t = await startSearchServer({ dataDir, rootsDir, signIn: true });
    expect(fs.readdirSync(path.join(dataDir, "backups")).filter((n) => n.startsWith(".tmp-backup-"))).toEqual([]);
    expect(t.svc.storage.backups.list()).toEqual([]);
    const res = await t.api("POST", "/api/system/maintenance/backup", {});
    expect(res.status).toBe(200);
    expect(t.svc.storage.backups.list()).toHaveLength(1);
    expect(integrity(path.join(dataDir, "db", "main.db"))).toEqual([]);
  });
});

describe("kill while a file is being stored (atomic finalisation)", () => {
  it("SIGKILL after the temp file is durable and before the rename: no blob row, no blob file, the temp file is removed at startup", async () => {
    const dataDir = tempDir("ncb-rel-data-");
    const rootsDir = tempDir("ncb-rel-roots-");
    const child = startChild(CHILD, { MODE: "blob", CHILD_DATA_DIR: dataDir, CHILD_ROOTS_DIR: rootsDir });
    expectKilled(await child.exited);
    const vol = path.join(rootsDir, "vol");
    const before = listFiles(vol);
    expect(before.filter((f) => f.startsWith("tmp/") && f.endsWith(".part"))).toHaveLength(1);
    expect(before.filter((f) => f.startsWith("blobs/"))).toEqual([]); // nothing half-written is visible under its final name

    const t = await startPipelineServer({ dataDir, rootsDir });
    expect(listFiles(vol).filter((f) => f.endsWith(".part"))).toEqual([]);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM blobs")!.n).toBe(0);
    expect(t.svc.db.all<{ message: string }>("SELECT message FROM activity_log").some((l) => /unfinished temporary file/.test(l.message))).toBe(true);
    expect(await verifyAll(t.svc)).toEqual([]);
  });
});

describe("kill while a page is being downloaded", () => {
  it("SIGKILL with the response half-sent: the next start puts the job back and finishes the download", async () => {
    const body = `<!doctype html><html><head><title>Slow page</title></head><body><article><h1>Slow page</h1><p>${"A paragraph that arrives slowly. ".repeat(40)}</p></article></body></html>`;
    let stall = true;
    let hit!: () => void;
    const requested = new Promise<void>((r) => (hit = r));
    const sockets = new Set<import("node:net").Socket>();
    const srv = http.createServer((req, res) => {
      if (req.url === "/robots.txt") { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
      if (stall) { res.write(body.slice(0, 100)); hit(); return; }
      res.end(body);
    });
    srv.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/slow`;
    try {
      const dataDir = tempDir("ncb-rel-data-");
      const rootsDir = tempDir("ncb-rel-roots-");
      const child = startChild(CHILD, { MODE: "capture", CHILD_DATA_DIR: dataDir, CHILD_ROOTS_DIR: rootsDir, CAPTURE_URL: url });
      await requested;
      await child.kill();
      expectKilled(await child.exited);
      for (const s of sockets) s.destroy();
      stall = false;

      const t = await startCrawlServer({ dataDir, rootsDir }); // the real clock: the child wrote real times and a retry back-off must be able to pass
      const dump = () => JSON.stringify({ jobs: t.svc.db.all("SELECT id, type, state, attempts, run_at, lease_until, last_error FROM jobs"), dl: t.svc.db.all("SELECT state, failure_code, failure_message FROM download_jobs"), log: t.svc.db.all("SELECT level, message FROM activity_log") });
      const dl = await until(() => {
        const r = t.svc.db.get<{ state: string; failure_code: string | null }>("SELECT state, failure_code FROM download_jobs ORDER BY id DESC LIMIT 1");
        return r && (r.state === "completed" || r.state === "failed") ? r : undefined;
      }, 40_000).catch((e) => { throw new Error(`${e.message}: ${dump()}`); });
      expect(dl).toEqual({ state: "completed", failure_code: null });
      expect(t.svc.db.get<{ s: string }>("SELECT status AS s FROM page_versions")!.s).toBe("ready");
      expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions")!.n).toBe(1);
      expect(await verifyAll(t.svc)).toEqual([]);
    } finally {
      for (const s of sockets) s.destroy();
      srv.close();
    }
  });
});
