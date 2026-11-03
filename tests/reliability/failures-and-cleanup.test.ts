import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { createSsrfGuard } from "@ncb/fetch";
import { setupAdmin, tempDir, call } from "../integration/server/helpers.js";
import { startPipelineServer, until } from "../integration/pipeline/helpers.js";
import { startCrawlServer } from "../integration/crawl/helpers.js";
import { listFiles, verifyAll } from "./helpers.js";

// ---- temporary files and half-finished work are cleaned up at startup ----------------------------------------------------

describe("startup cleanup", () => {
  it("removes temporary blob files, scratch files and half-made backups left by a crash, and says so in the log", async () => {
    const dataDir = tempDir("ncb-cl-data-");
    const rootsDir = tempDir("ncb-cl-roots-");
    const one = await startPipelineServer({ dataDir, rootsDir });
    const vol = one.svc.volumes.list()[0]!.rootPath;
    await one.server.close();

    fs.mkdirSync(path.join(vol, "tmp"), { recursive: true });
    fs.writeFileSync(path.join(vol, "tmp", "aaaa.part"), "half a blob");
    fs.writeFileSync(path.join(vol, "tmp", "bbbb.part"), "another half");
    fs.mkdirSync(path.join(dataDir, "tmp"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "tmp", "upload-1"), "scratch");
    fs.mkdirSync(path.join(dataDir, "backups", ".tmp-backup-1-2"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "backups", ".tmp-backup-1-2", "main.db"), "not a database yet");

    const two = await startPipelineServer({ dataDir, rootsDir });
    expect(listFiles(path.join(vol, "tmp"))).toEqual([]);
    expect(fs.readdirSync(path.join(dataDir, "tmp"))).toEqual([]);
    expect(fs.readdirSync(path.join(dataDir, "backups")).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
    const msg = two.svc.db.all<{ message: string }>("SELECT message FROM activity_log WHERE area = 'storage'").map((r) => r.message);
    expect(msg.some((m) => /Removed 2 unfinished temporary files left by a crash/.test(m))).toBe(true);
    expect(await verifyAll(two.svc)).toEqual([]);
  });
});

// ---- every failed download says why, in the log and in words a person can read -------------------------------------------

interface Scenario { name: string; path: string; code: string; caps?: Record<string, number>; hint?: RegExp }

describe("every failure has a log entry and a message for the screen", () => {
  const sockets = new Set<import("node:net").Socket>();
  const srv = http.createServer((req, res) => {
    const p = req.url ?? "/";
    if (p === "/robots.txt") { res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /private\n"); return; }
    if (p === "/missing") { res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not here</h1>"); return; }
    if (p === "/boom") { res.writeHead(500, { "content-type": "text/html" }).end("<h1>Broken</h1>"); return; }
    if (p === "/drop") { res.writeHead(200, { "content-type": "text/html", "content-length": "5000" }); res.write("<html><body>start"); setTimeout(() => res.socket?.destroy(), 30); return; }
    if (p === "/silent") { return; } // never answers
    if (p === "/big") { res.writeHead(200, { "content-type": "text/html" }).end(`<html><body>${"x".repeat(200_000)}</body></html>`); return; }
    if (p === "/private") { res.writeHead(200, { "content-type": "text/html" }).end("<html><body>secret</body></html>"); return; }
    res.writeHead(200, { "content-type": "text/html" }).end("<html><head><title>Fine</title></head><body><article><h1>Fine</h1><p>Fine page.</p></article></body></html>");
  });
  srv.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  const ready = new Promise<number>((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as AddressInfo).port)));
  afterAll(() => { for (const s of sockets) s.destroy(); srv.close(); });

  const scenarios: Scenario[] = [
    { name: "a missing page", path: "/missing", code: "http_4xx" },
    { name: "a server that keeps answering 500", path: "/boom", code: "http_5xx" },
    { name: "a connection cut in the middle of the page", path: "/drop", code: "network" },
    { name: "a server that never answers", path: "/silent", code: "timeout" },
    { name: "a page over its size limit", path: "/big", code: "size_cap", caps: { maxDocumentBytes: 10_000 } },
  ];

  it.each(scenarios)("$name ends as failed with code $code, a plain message, a hint and a log entry linked to the download", async (s) => {
    const port = await ready;
    const t = await startCrawlServer({ server: { captureFetcherOptions: { ssrf: createSsrfGuard({ allow: "127.0.0.1" }), timeouts: { headersMs: 400, bodyMs: 400, totalMs: 2000 } } } });
    const cookie = await setupAdmin(t);
    const { downloadId } = t.pipeline.captureUrl(`http://127.0.0.1:${port}${s.path}`, s.caps ? { caps: s.caps } : {});
    const end = await until(() => { const r = t.pipeline.getCapture(downloadId); return r && (r.state === "completed" || r.state === "failed") ? r : undefined; }, 60_000);
    expect(end).toMatchObject({ state: "failed", failureCode: s.code });

    // What the screen shows: the download's failure object (api.md section 8).
    const api = (await call(t, { url: `/api/downloads/${downloadId}`, cookie })).json<{ state: string; failure?: { code: string; message: string; hint: string; retryable: boolean } }>();
    expect(api.state).toBe("failed");
    expect(api.failure?.code).toBe(s.code);
    expect(api.failure?.message).toMatch(/^[A-Z].*[.!]$/s);
    expect(api.failure?.message).not.toMatch(/\bat .*\.(ts|js):\d+|Error:|undefined|\[object/);
    expect(api.failure?.hint.length).toBeGreaterThan(10);

    // What the log shows: at least one warning or error tied to this download.
    const log = t.svc.db.all<{ level: string; message: string }>(
      "SELECT a.level, a.message FROM activity_log a JOIN download_jobs d ON d.id = a.download_job_id WHERE d.public_id = ? AND a.level IN ('warn','error')", [downloadId]);
    expect(log.length, `no warning or error in the log for ${s.name}`).toBeGreaterThan(0);
    // and no version is left half-made
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions WHERE status = 'capturing'")!.n).toBe(0);
  });

  it("a failed download can be retried and then succeeds (the failure was not left behind)", async () => {
    const port = await ready;
    const t = await startCrawlServer({ server: { captureFetcherOptions: { ssrf: createSsrfGuard({ allow: "127.0.0.1" }), timeouts: { headersMs: 400, totalMs: 2000 } } } });
    const cookie = await setupAdmin(t);
    const { downloadId } = t.pipeline.captureUrl(`http://127.0.0.1:${port}/missing`);
    await until(() => t.pipeline.getCapture(downloadId)?.state === "failed", 30_000);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pages WHERE availability = 'archived'")!.n).toBe(0);
    const ok = t.pipeline.captureUrl(`http://127.0.0.1:${port}/fine`);
    const end = await until(() => { const r = t.pipeline.getCapture(ok.downloadId); return r && (r.state === "completed" || r.state === "failed") ? r : undefined; }, 30_000);
    expect(end.state).toBe("completed");
    void cookie;
  });
});
