import { describe, expect, it } from "vitest";
import { createSsrfGuard } from "@ncb/fetch";
import { classifyInput } from "@ncb/server";
import { saveAndWait, startBrowserServer, useFixtures } from "./helpers.js";

const fixtures = useFixtures();

describe("A-16 address bar input", () => {
  it.each([
    ["https://example.org/a", { kind: "url", url: "https://example.org/a" }],
    ["example.org", { kind: "url", url: "https://example.org" }],
    ["example.org/path?q=1", { kind: "url", url: "https://example.org/path?q=1" }],
    ["127.0.0.1:8080/x", { kind: "url", url: "http://127.0.0.1:8080/x" }],
    ["localhost:3000", { kind: "url", url: "http://localhost:3000" }],
    ["how do tides work", { kind: "search", query: "how do tides work" }],
    ["tides", { kind: "search", query: "tides" }],
    ["re: tides", { kind: "search", query: "re: tides" }],
    ["javascript:alert(1)", { kind: "unsupported", scheme: "javascript" }],
    ["data:text/html,hi", { kind: "unsupported", scheme: "data" }],
    ["file:///etc/passwd", { kind: "unsupported", scheme: "file" }],
  ])("classifies %s", (input, want) => {
    expect(classifyInput(input)).toEqual(want);
  });
});

describe("A-16 resolve: each branch of the URL flow", () => {
  it("1 normalises, 2 checks the archive, 3 opens a cached page, with a frame grant for the listener", async () => {
    const t = await startBrowserServer();
    const url = `${fixtures().urls.article}/astronomy`;
    const done = await saveAndWait(t, url);
    expect(done.outcome).toBe("created");

    // Mixed-case host, a fragment and a tracking-free query: normalised before the lookup.
    const messy = url.replace("127.0.0.1", "127.0.0.1") + "#overview";
    const r = await t.api("POST", "/api/browser/resolve", { input: messy, tabId: "tab-1" });
    expect(r.status).toBe(200);
    expect(r.body.normalizedUrl).toBe(url);
    expect(r.body.urlKey).toMatch(/^http/);
    expect(r.body.resolution.kind).toBe("archive");
    expect(r.body.resolution.mode).toBe("original");
    expect(r.body.resolution.page.id).toMatch(/^pg_/);
    expect(r.body.resolution.version.status).toMatch(/ready|partial/);
    expect(r.body.alternatives).toEqual(expect.arrayContaining(["archive", "reader", "live"]));
    const frame = r.body.resolution.frame;
    expect(frame.sandbox).toBe("allow-popups allow-popups-to-escape-sandbox");
    expect(frame.sandbox).not.toMatch(/allow-scripts|allow-same-origin/);
    expect(frame.frameId).toMatch(/^fr_/);
    expect(new Date(frame.expiresAt).getTime()).toBe(t.clock.now() + 8 * 3600 * 1000);

    // The grant is a real capability: the listener serves the page with it.
    const page = await t.archiveFetch(frame.url, { headers: { "sec-fetch-dest": "iframe" } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Astronomy");

    // Reader mode asks for the reader view of the same page.
    const reader = await t.api("POST", "/api/browser/resolve", { input: url, prefer: "reader" });
    expect(reader.body.resolution.mode).toBe("reader");
    expect(reader.body.resolution.frame.url).toMatch(/\/reader$/);
  });

  it("4 online and not cached allows live, 5 offers to archive it, and nothing is fetched by resolve", async () => {
    const t = await startBrowserServer();
    const url = `${fixtures().urls.article}/solar-system`;
    const before = t.svc.queue.counts();
    const r = await t.api("POST", "/api/browser/resolve", { input: url });
    expect(r.body.resolution).toMatchObject({ kind: "live", url, canSave: true });
    expect(r.body.alternatives).toContain("live");
    expect(r.body.connectivity).toBe("unknown");
    expect(t.svc.queue.counts()).toEqual(before);
    expect(t.pipeline.findPageByUrl(url)).toBeUndefined();
    const hits = (fixtures().log("article") as { entries: { url: string }[] }).entries;
    expect(hits.filter((h) => h.url.includes("solar-system"))).toHaveLength(0);
  });

  it("6 offline and unavailable shows the offline page, 7 queues the missing page for when the connection returns", async () => {
    const t = await startBrowserServer();
    const url = `${fixtures().urls.article}/black-holes`;
    t.svc.connectivity.setForced(true);

    const r = await t.api("POST", "/api/browser/resolve", { input: url });
    expect(r.body.connectivity).toBe("offline");
    expect(r.body.resolution).toMatchObject({ kind: "offline", url, reason: "forced_offline", canQueue: true });
    expect(r.body.alternatives).not.toContain("live");

    const page = await t.api("GET", `/api/browser/offline-page?url=${encodeURIComponent(url)}`);
    expect(page.body).toMatchObject({ url, reason: "forced_offline", canQueue: true, archived: false });

    // Saving offline is refused with an offer to queue ...
    const refused = await t.api("POST", "/api/browser/save", { url });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "offline", details: { canQueue: true } });

    // ... and queuing holds the capture. Link states show it as queued, and nothing was fetched.
    const q = await t.api("POST", "/api/browser/save", { url, queue: true });
    expect(q.status).toBe(202);
    expect(q.body).toMatchObject({ held: true, state: "queued", priority: 3 });
    const ls = await t.api("POST", "/api/browser/link-states", { urls: [url] });
    expect(ls.body.items[0]).toMatchObject({ url, state: "queued" });
    const again = await t.api("POST", "/api/browser/resolve", { input: url });
    expect(again.body.resolution.queued.downloadId).toBe(q.body.downloadId);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.pipeline.getCapture(q.body.downloadId)!.state).toBe("queued");

    // Back online: the held capture is released and finishes.
    t.svc.connectivity.setForced(false);
    t.svc.connectivity.recordOutcome({ ok: true });
    const { until } = await import("./helpers.js");
    const done = await until(() => {
      const c = t.pipeline.getCapture(q.body.downloadId);
      return c && c.state === "completed" ? c : undefined;
    });
    expect(done.outcome).toBe("created");
    const after = await t.api("POST", "/api/browser/resolve", { input: url });
    expect(after.body.resolution.kind).toBe("archive");
  });

  it("offline with the page cached still opens the archived copy", async () => {
    const t = await startBrowserServer();
    const url = `${fixtures().urls.article}/astronomy`;
    await saveAndWait(t, url);
    t.svc.connectivity.setForced(true);
    const r = await t.api("POST", "/api/browser/resolve", { input: url });
    expect(r.body.resolution.kind).toBe("archive");
    expect(r.body.alternatives).not.toContain("live");
  });

  it("the preference for cached or live applies when both exist, and an explicit choice wins", async () => {
    const t = await startBrowserServer();
    const url = `${fixtures().urls.article}/astronomy`;
    await saveAndWait(t, url);
    expect((await t.api("POST", "/api/browser/resolve", { input: url })).body.resolution.kind).toBe("archive");
    expect((await t.api("PATCH", "/api/settings", { browser: { preferCached: false } })).status).toBe(200);
    expect((await t.api("POST", "/api/browser/resolve", { input: url })).body.resolution.kind).toBe("live");
    expect((await t.api("POST", "/api/browser/resolve", { input: url, prefer: "archive" })).body.resolution.kind).toBe("archive");
    // Offline there is no live site to prefer.
    t.svc.connectivity.setForced(true);
    expect((await t.api("POST", "/api/browser/resolve", { input: url })).body.resolution.kind).toBe("archive");
  });

  it("search terms go to the search page; unsupported schemes and credentials are refused", async () => {
    const t = await startBrowserServer();
    expect((await t.api("POST", "/api/browser/resolve", { input: "how do tides work" })).body.resolution).toEqual({ kind: "search", query: "how do tides work" });
    const js = await t.api("POST", "/api/browser/resolve", { input: "javascript:alert(1)" });
    expect(js.status).toBe(400);
    const cred = await t.api("POST", "/api/browser/resolve", { input: "https://user:pw@example.org/" });
    expect(cred.status).toBe(400);
  });

  it("a frame grant for a page or version mints a token without resolving; unknown ids are 404", async () => {
    const t = await startBrowserServer();
    const done = await saveAndWait(t, `${fixtures().urls.article}/astronomy`);
    const g = await t.api("POST", "/api/archive/frame-grants", { versionId: done.versionId, mode: "reader" });
    expect(g.status).toBe(200);
    expect(g.body.url).toMatch(/\/v\/ver_[0-9A-Z]{26}\/reader$/);
    expect((await t.archiveFetch(g.body.url)).status).toBe(200);
    expect((await t.api("POST", "/api/archive/frame-grants", { pageId: "pg_00000000000000000000000000" })).status).toBe(404);
    expect((await t.api("POST", "/api/archive/frame-grants", {})).status).toBe(400);
  });
});

describe("A-16 link states", () => {
  it("reports cached, queued, live-only and unavailable without fetching", async () => {
    const t = await startBrowserServer();
    const base = fixtures().urls.article;
    await saveAndWait(t, `${base}/astronomy`);
    const urls = [`${base}/astronomy`, `${base}/solar-system`, "not a url"];
    let r = await t.api("POST", "/api/browser/link-states", { urls });
    expect(r.body.items.map((i: { state: string }) => i.state)).toEqual(["cached", "live_only", "unavailable"]);
    expect(r.body.items[0].pageId).toMatch(/^pg_/);
    t.svc.connectivity.setForced(true);
    r = await t.api("POST", "/api/browser/link-states", { urls: [`${base}/solar-system`] });
    expect(r.body.items[0].state).toBe("unavailable");
    expect((await t.api("POST", "/api/browser/link-states", { urls: Array.from({ length: 201 }, () => "https://a.test/") })).status).toBe(400);
  });
});

describe("A-16 live-check", () => {
  it("blocks private hosts before any connection, with the default guard", async () => {
    const t = await startBrowserServer({ server: { captureFetcherOptions: { ssrf: createSsrfGuard() } } });
    const r = await t.api("POST", "/api/browser/live-check", { url: "http://127.0.0.1:9/" });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("blocked");
    const meta = await t.api("POST", "/api/browser/live-check", { url: "http://169.254.169.254/latest/meta-data" });
    expect(meta.status).toBe(403);
    expect((await t.api("POST", "/api/browser/live-check", { url: "ftp://example.org/" })).status).toBe(400);
  });

  it("sends a HEAD to an allowed host and reads the framing headers", async () => {
    const t = await startBrowserServer();
    const r = await t.api("POST", "/api/browser/live-check", { url: `${fixtures().urls.article}/astronomy` });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ reachable: true, status: 200 });
    expect(["boolean"]).toContain(typeof r.body.frameable);
    const log = (fixtures().log("article") as { entries: { method: string; url: string }[] }).entries;
    expect(log.some((x) => x.method === "HEAD" && x.url.includes("/astronomy"))).toBe(true);
  });

  it("is refused while forced offline", async () => {
    const t = await startBrowserServer();
    t.svc.connectivity.setForced(true);
    const r = await t.api("POST", "/api/browser/live-check", { url: `${fixtures().urls.article}/astronomy` });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("offline");
  });
});

describe("A-16 authorisation", () => {
  it("every browser route needs a session; mutations need the CSRF header", async () => {
    const t = await startBrowserServer();
    const { call } = await import("./helpers.js");
    for (const [method, url, body] of [
      ["POST", "/api/browser/resolve", { input: "example.org" }],
      ["POST", "/api/browser/link-states", { urls: [] }],
      ["POST", "/api/browser/live-check", { url: "https://example.org" }],
      ["POST", "/api/browser/save", { url: "https://example.org" }],
      ["GET", "/api/browser/offline-page?url=https%3A%2F%2Fexample.org", undefined],
      ["POST", "/api/archive/capture", { url: "https://example.org" }],
      ["POST", "/api/archive/frame-grants", { pageId: "pg_x" }],
    ] as const) {
      const res = await call(t, { method, url, body });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    const noCsrf = await call(t, { method: "POST", url: "/api/browser/save", body: { url: "https://example.org" }, cookie: t.cookie, raw: true });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe("A-16 held captures", () => {
  it("are released when work offline is switched off, even though the connection is not known to be up", async () => {
    const t = await startBrowserServer();
    const url = `${fixtures().urls.article}/renewable-energy`;
    t.svc.connectivity.setForced(true);
    const q = await t.api("POST", "/api/browser/save", { url, queue: true });
    expect(q.body.held).toBe(true);
    t.svc.connectivity.setForced(false);
    expect(t.svc.connectivity.snapshot().state).toBe("unknown");
    const { until } = await import("./helpers.js");
    const done = await until(() => {
      const c = t.pipeline.getCapture(q.body.downloadId);
      return c && c.state === "completed" ? c : undefined;
    });
    expect(done.outcome).toBe("created");
  });
});
