import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBrowserServer, until, useFixtures } from "../browser/helpers.js";
import { capture, startPipelineServer } from "../pipeline/helpers.js";

const fixtures = useFixtures();
const MARKER = "lanternfish-migration-7731";

/** Stands in for the renderer container: the contract of POST /render, with the "script result" built in. */
async function fakeRenderer(opts: { delayMs?: number; fail?: { status: number; error: string } } = {}) {
  const calls: { url: string; auth?: string; body: Record<string, unknown> }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") return void res.end(JSON.stringify({ ok: true }));
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { url: string };
    calls.push({ url: body.url, auth: req.headers.authorization, body });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 0));
    inFlight--;
    if (opts.fail) {
      res.writeHead(opts.fail.status, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: opts.fail.error, message: "no" }));
    }
    const dom = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Aurora survey (script-built)</title></head><body>
<div id="root"><main><article><h1>Aurora survey</h1>
<p>The aurora survey recorded forty-one displays over the winter, and the brightest, on the ninth of January, filled the northern sky for almost two hours.</p>
<p>Observers at the Kvaloya station noted that green emission dominated. The scriptbuilt marker phrase is ${MARKER}.</p>
<p>Magnetometer traces showed the substorm onset eleven minutes before the first visible arc brightened, which matches the delay seen in earlier seasons.</p></article></main></div>
<script>window.__state = {a: 1};</script><script src="/js-only/app.js"></script></body></html>`;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ finalUrl: body.url, status: 200, html: dom, title: "Aurora survey", loadedBytes: 1234, durationMs: 42, requests: 3, blockedRequests: 1, memoryMb: 180 }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, get maxInFlight() { return maxInFlight; },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

const textOf = async (t: Awaited<ReturnType<typeof startPipelineServer>>, publicVersionId: string): Promise<string> => {
  const v = t.pipeline.getVersion(publicVersionId)!;
  return v.content.textSha256 ? (await t.svc.blobs.read(v.content.textSha256)).data.toString("utf8") : "";
};

const versions = (t: Awaited<ReturnType<typeof startPipelineServer>>, url: string) => {
  const page = t.pipeline.findPageByUrl(url)!;
  return { page, list: t.pipeline.listVersions(page.id) };
};

describe("C-16 rendering is optional", () => {
  it("with the renderer off, a script-built page is captured as the plain shell and nothing is queued", async () => {
    const t = await startPipelineServer();
    expect(t.server.renderProxy).toBeUndefined();
    expect(t.svc.render.enabled).toBe(false);
    const url = `${fixtures().urls.article}/js-only`;
    expect((await capture(t, url)).state).toBe("completed");
    const { list } = versions(t, url);
    expect(list).toHaveLength(1);
    expect(await textOf(t, list[0]!.publicId)).not.toContain(MARKER);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type = 'render'")!.n).toBe(0);
    expect(t.svc.db.get<{ render_mode: string }>("SELECT render_mode FROM page_versions")!.render_mode).toBe("plain");
  });
});

describe("C-16 rendering through the renderer service", () => {
  let renderer: Awaited<ReturnType<typeof fakeRenderer>>;
  beforeAll(async () => { renderer = await fakeRenderer(); });
  afterAll(async () => { await renderer.close(); });

  const start = (env: Record<string, string> = {}) =>
    startPipelineServer({ env: { NCB_RENDERER_URL: renderer.url, NCB_RENDER_PROXY_PORT: "0", ...env } });

  it("renders an empty-shell page after the normal capture and stores the DOM as a flagged version", async () => {
    const t = await start();
    renderer.calls.length = 0;
    expect(t.svc.render.enabled).toBe(true);
    const url = `${fixtures().urls.article}/js-only`;
    expect((await capture(t, url)).state).toBe("completed");
    const both = await until(() => { const v = versions(t, url).list.filter((x) => x.status === "ready" || x.status === "partial"); return v.length === 2 ? v : undefined; });
    const rendered = both.find((v) => t.svc.db.get<{ render_mode: string }>("SELECT render_mode FROM page_versions WHERE public_id = ?", [v.publicId])!.render_mode === "browser")!;
    const plain = both.find((v) => v !== rendered)!;
    expect(await textOf(t, plain.publicId)).not.toContain(MARKER);
    expect(await textOf(t, rendered.publicId)).toContain(MARKER);
    expect(rendered.versionNo).toBeGreaterThan(plain.versionNo);
    // The rendered version is the one the library and the reader see.
    const page = t.pipeline.findPageByUrl(url)!;
    expect(page.latestVersionPublicId).toBe(rendered.publicId);
    expect(page.title).toBe("Aurora survey (script-built)");
    // One request to the renderer, with the shared secret and the page's own address.
    expect(renderer.calls).toHaveLength(1);
    expect(renderer.calls[0]).toMatchObject({ url, auth: `Bearer ${"p".repeat(32)}` });
    expect(renderer.calls[0]!.body).toMatchObject({ timeoutMs: 45_000 });
    // The API reports the flag.
    const summary = t.pipeline.getVersion(rendered.publicId)!;
    expect(summary.mime).toBe("text/html");
    const job = t.svc.db.get<{ state: string; host: string }>("SELECT state, host FROM jobs WHERE type = 'render'")!;
    expect(job).toMatchObject({ state: "done", host: "renderer.internal" });
  });

  it("the stored DOM keeps its scripts as text, and the listener serves them sanitised (no script ever runs in the archive)", async () => {
    const t = await startBrowserServer({ env: { NCB_RENDERER_URL: renderer.url, NCB_RENDER_PROXY_PORT: "0" } });
    const url = `${fixtures().urls.article}/js-only`;
    const { downloadId } = t.pipeline.captureUrl(url);
    await until(() => t.pipeline.getCapture(downloadId)?.state === "completed");
    const rendered = await until(() => versions(t, url).list.find((v) => t.svc.db.get<{ render_mode: string }>("SELECT render_mode FROM page_versions WHERE public_id = ?", [v.publicId])?.render_mode === "browser" && v.status === "ready"));
    const stored = (await t.svc.blobs.read(t.pipeline.getVersion(rendered.publicId)!.documentSha256!)).data.toString("utf8");
    expect(stored).toContain("<script");
    const g = await t.api("POST", "/api/archive/frame-grants", { versionId: rendered.publicId, mode: "original" });
    const served = await t.archiveFetch(g.body.url);
    expect(served.status).toBe(200);
    const body = await served.text();
    expect(body).toContain(MARKER);
    expect(body).not.toMatch(/<script/i);
    expect(served.headers.get("content-security-policy")).toMatch(/sandbox/);
    const v = await t.api("GET", `/api/archive/versions/${rendered.publicId}`);
    expect(v.status).toBe(200);
  });

  it("the little-text trigger renders a large shell; a server-rendered page is not rendered", async () => {
    const t = await start();
    renderer.calls.length = 0;
    const base = fixtures().urls.article;
    await capture(t, `${base}/js-only/big`);
    await until(() => renderer.calls.length === 1);
    expect(renderer.calls[0]!.url).toBe(`${base}/js-only/big`);
    await capture(t, `${base}/astronomy`);
    await capture(t, `${base}/solar-system`);
    await new Promise((r) => setTimeout(r, 300));
    expect(renderer.calls).toHaveLength(1);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type = 'render'")!.n).toBe(1);
  });

  it("a rendered version is never rendered again", async () => {
    const t = await start();
    renderer.calls.length = 0;
    const url = `${fixtures().urls.article}/js-only`;
    await capture(t, url);
    await until(() => versions(t, url).list.filter((v) => v.status === "ready" || v.status === "partial").length === 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(renderer.calls).toHaveLength(1);
    const rv = versions(t, url).list.find((v) => t.svc.db.get<{ render_mode: string }>("SELECT render_mode FROM page_versions WHERE public_id = ?", [v.publicId])!.render_mode === "browser")!;
    const decision = await t.svc.render.evaluate(t.svc.db.get<{ id: number }>("SELECT id FROM page_versions WHERE public_id = ?", [rv.publicId])!.id, {});
    expect(decision?.skipped).toBe("already_rendered");
  });

  it("the per-source option: always renders a normal page, never skips a shell", async () => {
    const t = await start();
    renderer.calls.length = 0;
    const base = fixtures().urls.article;
    const mk = async (name: string, renderMode: string, startUrl: string) => {
      const r = await t.svc.sources.create({ name, type: "single_page", startUrl, profile: "focused", config: { renderMode }, priority: 3, adapter: "http", discoveryEnabled: false, enabled: true } as never);
      return r;
    };
    const always = await mk("Always", "always", `${base}/astronomy`);
    const never = await mk("Never", "never", `${base}/js-only`);
    await t.svc.sources.run(always.id);
    await until(() => renderer.calls.some((c) => c.url === `${base}/astronomy`));
    await t.svc.sources.run(never.id);
    await until(() => t.pipeline.findPageByUrl(`${base}/js-only`)?.latestVersionId);
    await new Promise((r) => setTimeout(r, 300));
    expect(renderer.calls.map((c) => c.url)).toEqual([`${base}/astronomy`]);
  });

  it("a renderer failure leaves the plain capture in place and says why", async () => {
    const failing = await fakeRenderer({ fail: { status: 504, error: "timeout" } });
    try {
      const t = await startPipelineServer({ env: { NCB_RENDERER_URL: failing.url, NCB_RENDER_PROXY_PORT: "0" } });
      const url = `${fixtures().urls.article}/js-only`;
      expect((await capture(t, url)).state).toBe("completed");
      await until(() => t.svc.db.get<{ state: string }>("SELECT state FROM jobs WHERE type = 'render'")?.state === "failed");
      const { list } = versions(t, url);
      expect(list).toHaveLength(1);
      expect(list[0]!.status === "ready" || list[0]!.status === "partial").toBe(true);
      expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activity_log WHERE message LIKE 'Rendering % failed%'")!.n).toBeGreaterThan(0);
    } finally {
      await failing.close();
    }
  });
});

describe("C-16 render concurrency", () => {
  it("never runs more pages at once than the setting allows", async () => {
    const slow = await fakeRenderer({ delayMs: 250 });
    try {
      const t = await startPipelineServer({ env: { NCB_RENDERER_URL: slow.url, NCB_RENDER_PROXY_PORT: "0", NCB_RENDER_CONCURRENCY: "1" } });
      const base = fixtures().urls.article;
      for (const p of ["js-only", "js-only/big"]) t.pipeline.captureUrl(`${base}/${p}`);
      await until(() => slow.calls.length === 2, 30_000);
      await new Promise((r) => setTimeout(r, 400));
      expect(slow.maxInFlight).toBe(1);
      expect(t.svc.db.get<{ max_concurrent: number }>("SELECT max_concurrent FROM host_state WHERE host = 'renderer.internal'")!.max_concurrent).toBe(1);
    } finally {
      await slow.close();
    }
  });

  it("reads resources.renderConcurrency, live; NCB_RENDER_CONCURRENCY is only its default", async () => {
    const t = await startPipelineServer({ env: { NCB_RENDERER_URL: "http://127.0.0.1:9", NCB_RENDER_PROXY_PORT: "0", NCB_RENDER_CONCURRENCY: "2" } });
    const maxConc = () => t.svc.db.get<{ max_concurrent: number }>("SELECT max_concurrent FROM host_state WHERE host = 'renderer.internal'")?.max_concurrent;
    expect(t.svc.settings.internal("resources").renderConcurrency).toBe(2); // the environment value is the default of the setting
    const url = `${fixtures().urls.article}/js-only`;
    await capture(t, url);
    await until(() => maxConc() === 2);
    // A change to the setting applies at once, to the queue's limit for jobs already waiting, and to the next render.
    t.svc.settings.patch({ resources: { renderConcurrency: 3 } });
    expect(maxConc()).toBe(3);
    t.svc.settings.patch({ resources: { renderConcurrency: 1 } });
    expect(maxConc()).toBe(1);
    // The old, unused group has no effect.
    const s = t.svc.settings as unknown as { internal(g: string): unknown };
    const orig = s.internal.bind(s);
    s.internal = (g: string) => (g === "limits" ? { renderConcurrency: 4 } : orig(g));
    t.svc.settings.patch({ resources: { renderConcurrency: 2 } });
    expect(maxConc()).toBe(2);
  });
});

describe("C-16 the proxy starts with the renderer", () => {
  it("listens, wants the shared secret, and refuses private addresses", async () => {
    const t = await startPipelineServer({ env: { NCB_RENDERER_URL: "http://127.0.0.1:9", NCB_RENDER_PROXY_PORT: "0", NCB_RENDER_PROXY_HOST: "127.0.0.1" } });
    const addr = t.server.renderProxy!.server.address() as AddressInfo;
    expect(addr.port).toBeGreaterThan(0);
    const status = (path: string, auth?: string) => new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: addr.port, path, headers: { host: "x", ...(auth ? { "proxy-authorization": auth } : {}) } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }).on("error", reject);
    });
    expect(await status(`${fixtures().urls.article}/astronomy`)).toBe(407);
    const ok = `Basic ${Buffer.from(`renderer:${"p".repeat(32)}`).toString("base64")}`;
    expect(await status(`${fixtures().urls.article}/astronomy`, ok)).toBe(200);
    expect(await status("http://10.0.0.1/", ok)).toBe(403);
    expect(await status(`${fixtures().urls.ssrfBait}/canary`.replace("127.0.0.1", "localhost"), ok)).toBe(403);
  });
});
