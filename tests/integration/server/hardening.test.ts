import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { createSsrfGuard } from "@ncb/fetch";
import { call, PROXY_SECRET, startServer } from "./helpers.js";
import { startCrawlServer } from "../crawl/helpers.js";
import { until } from "../pipeline/helpers.js";

describe("HB-01 the API answers only the web app and the container itself", () => {
  const FROM_EGRESS = "172.18.0.9"; // a neighbour on a shared Docker network, such as SearXNG

  it("refuses a request from another container that has no proxy secret, with a 403 that says why", async () => {
    const t = await startServer();
    const res = await call(t, { url: "/api/settings", remoteAddress: FROM_EGRESS });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "forbidden", message: "This address only accepts requests from the NoConBrain web app." });
    // a wrong secret is no better, and neither is a forged client address
    const wrong = await call(t, { url: "/api/settings", remoteAddress: FROM_EGRESS, headers: { "x-nocon-proxy-secret": "x".repeat(32), "x-nocon-client-ip": "127.0.0.1" } });
    expect(wrong.statusCode).toBe(403);
    // mutating routes too, and the setup route
    expect((await call(t, { url: "/api/setup/admin", body: { username: "evil", password: "correct horse battery" }, remoteAddress: FROM_EGRESS })).statusCode).toBe(403);
    expect(t.svc.auth.hasAdmin()).toBe(false);
  });

  it("lets the web app through with the secret (the normal path), and the health check from anywhere", async () => {
    const t = await startServer();
    const ok = await call(t, { url: "/api/settings", remoteAddress: FROM_EGRESS, headers: { "x-nocon-proxy-secret": PROXY_SECRET, "x-nocon-client-ip": "203.0.113.7" } });
    expect(ok.statusCode).not.toBe(403); // 409 setup_required here: the request reached the application
    expect((await call(t, { url: "/api/system/health", remoteAddress: FROM_EGRESS })).statusCode).toBe(200);
  });

  it("lets requests from inside the container through without the secret (health check, local tools)", async () => {
    const t = await startServer();
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const res = await call(t, { url: "/api/settings", remoteAddress: addr });
      expect(res.statusCode, addr).not.toBe(403);
    }
  });

  it("can be switched off for a trusted network, and does not apply when no proxy secret is set", async () => {
    const off = await startServer({ env: { NCB_API_PROXY_ONLY: "false" } });
    expect((await call(off, { url: "/api/settings", remoteAddress: FROM_EGRESS })).statusCode).not.toBe(403);
    const noSecret = await startServer({ env: { NCB_PROXY_SECRET: undefined } as never });
    expect(noSecret.config.NCB_PROXY_SECRET).toBeUndefined();
    expect((await call(noSecret, { url: "/api/settings", remoteAddress: FROM_EGRESS })).statusCode).not.toBe(403);
  });
});

describe("HB-07 the renderer's forward proxy binds to one network", () => {
  it("binds to this container's address inside the configured range", async () => {
    const t = await startCrawlServer({ env: { NCB_RENDERER_URL: "http://127.0.0.1:9", NCB_RENDER_PROXY_PORT: "0", NCB_RENDER_PROXY_HOST: "127.0.0.0/8" } });
    const addr = (t.server.renderProxy as unknown as { server: http.Server }).server.address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
  });

  it("does not start (and does not fall back to every interface) when the container is not on that network", async () => {
    await expect(startServer({ env: { NCB_RENDERER_URL: "http://127.0.0.1:9", NCB_RENDER_PROXY_PORT: "0", NCB_RENDER_PROXY_HOST: "10.254.254.0/24" } })).rejects.toThrow(/no address in 10\.254\.254\.0\/24/);
  });

  it("the shared secret is still required", async () => {
    const t = await startCrawlServer({ env: { NCB_RENDERER_URL: "http://127.0.0.1:9", NCB_RENDER_PROXY_PORT: "0", NCB_RENDER_PROXY_HOST: "127.0.0.1" } });
    expect(t.server.renderProxy).toBeDefined();
    const proxy = t.server.renderProxy as unknown as { server: http.Server };
    const port = (proxy.server.address() as AddressInfo).port;
    const res = await new Promise<number>((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, method: "GET", path: "http://example.test/" }, (x) => { x.resume(); resolve(x.statusCode ?? 0); });
      r.on("error", reject);
      r.end();
    });
    expect(res).toBe(407);
  });
});

describe("HB-05 robots.txt and files go through the per-host politeness gate", () => {
  const seen: { path: string; at: number }[] = [];
  const srv = http.createServer((req, res) => {
    seen.push({ path: req.url ?? "", at: Date.now() });
    if (req.url === "/robots.txt") { res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n"); return; }
    if (req.url === "/page") {
      const imgs = Array.from({ length: 6 }, (_, i) => `<img src="/img${i}.png" alt="">`).join("");
      res.writeHead(200, { "content-type": "text/html" }).end(`<html><head><title>Gate</title></head><body><article><h1>Gate</h1><p>${"Words in a paragraph. ".repeat(30)}</p>${imgs}</article></body></html>`);
      return;
    }
    res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from("89504e470d0a1a0a", "hex"));
  });
  const ready = new Promise<number>((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as AddressInfo).port)));
  afterAll(() => srv.close());

  it("a host with a politeness delay sees robots.txt, the page and each file spaced out, not in one burst", async () => {
    const port = await ready;
    seen.length = 0;
    const t = await startCrawlServer({ server: { captureFetcherOptions: { ssrf: createSsrfGuard({ allow: "127.0.0.1" }) }, pacer: { assetGapMs: 120 } } });
    t.svc.db.run("INSERT INTO host_state (host, crawl_delay_ms) VALUES ('127.0.0.1', 300)");
    // robots.txt is cached for a day, so this capture is the first request to the host.
    const { downloadId } = t.pipeline.captureUrl(`http://127.0.0.1:${port}/page`, { requestedBy: "schedule" }); // a background capture; one saved by hand is not paced
    await until(() => { const r = t.pipeline.getCapture(downloadId); return r && (r.state === "completed" || r.state === "failed") ? r : undefined; }, 60_000);

    const robots = seen.find((s) => s.path === "/robots.txt")!;
    const page = seen.find((s) => s.path === "/page")!;
    expect(robots && page).toBeTruthy();
    expect(page.at - robots.at).toBeGreaterThanOrEqual(280); // the host delay, minus timer slack
    const files = seen.filter((s) => s.path.startsWith("/img")).map((s) => s.at).sort((a, b) => a - b);
    expect(files.length).toBeGreaterThanOrEqual(5);
    // The pacer spaces dispatch by 120 ms; arrival at this server jitters by a few ms either way, so one gap can read short
    // (CI arm64 saw 95 ms) while the next reads long. A burst would show gaps near 0, so check each gap loosely and the total tightly.
    for (let i = 1; i < files.length; i++) expect(files[i]! - files[i - 1]!, `gap before file ${i}`).toBeGreaterThanOrEqual(60);
    expect(files.at(-1)! - files[0]!, "span of the file requests").toBeGreaterThanOrEqual((files.length - 1) * 120 - 40);
    expect(files[0]! - page.at).toBeGreaterThanOrEqual(100);
  });

  it("a page saved by hand is not slowed even when a crawl left a delay on the host", async () => {
    const port = await ready;
    seen.length = 0;
    const t = await startCrawlServer({ server: { captureFetcherOptions: { ssrf: createSsrfGuard({ allow: "127.0.0.1" }) } } });
    t.svc.db.run("INSERT INTO host_state (host, crawl_delay_ms) VALUES ('127.0.0.1', 1500)");
    const t0 = Date.now();
    const { downloadId } = t.pipeline.captureUrl(`http://127.0.0.1:${port}/page`);
    await until(() => { const r = t.pipeline.getCapture(downloadId); return r && (r.state === "completed" || r.state === "failed") ? r : undefined; }, 30_000);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("a host with no delay is not slowed at all", async () => {
    const port = await ready;
    seen.length = 0;
    const t = await startCrawlServer({ server: { captureFetcherOptions: { ssrf: createSsrfGuard({ allow: "127.0.0.1" }) } } });
    const t0 = Date.now();
    const { downloadId } = t.pipeline.captureUrl(`http://127.0.0.1:${port}/page`);
    await until(() => { const r = t.pipeline.getCapture(downloadId); return r && (r.state === "completed" || r.state === "failed") ? r : undefined; }, 30_000);
    expect(Date.now() - t0).toBeLessThan(3000);
    const files = seen.filter((s) => s.path.startsWith("/img"));
    expect(files.length).toBeGreaterThanOrEqual(5);
  });
});
