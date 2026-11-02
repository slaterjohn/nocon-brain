import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@ncb/shared";
import { ConnectivityGuardedFetcher, createArchiveServer, type Fetcher } from "@ncb/server";
import { call, setupAdmin, startServer, tempDir } from "./helpers.js";

describe("F-15 connectivity", () => {
  const okFetcher = (): Fetcher & { calls: number } => {
    const f = { calls: 0, async fetch() { f.calls++; return { status: 200, headers: {}, body: new Uint8Array() }; } };
    return f;
  };

  it("forced offline makes the fetcher refuse, and switching it off restores it", async () => {
    const inner = okFetcher();
    const t = await startServer({ server: { fetcher: inner } });
    const cookie = await setupAdmin(t);
    expect((await t.svc.fetcher.fetch({ url: "https://example.org/" })).status).toBe(200);
    expect(inner.calls).toBe(1);

    const on = await call(t, { url: "/api/system/connectivity", body: { forceOffline: true }, cookie });
    expect(on.json()).toMatchObject({ state: "offline", source: "forced" });
    await expect(t.svc.fetcher.fetch({ url: "https://example.org/" })).rejects.toMatchObject({ code: "offline", details: { canQueue: true, reason: "forced_offline" } });
    await expect(t.svc.fetcher.fetch({ url: "https://example.org/", background: true })).rejects.toBeInstanceOf(AppError);
    expect(inner.calls).toBe(1);
    expect((await call(t, { url: "/api/system/connectivity", cookie })).json()).toMatchObject({ state: "offline", source: "forced" });
    expect((await call(t, { url: "/api/settings", cookie })).json().offline.forced).toBe(true);

    // The switch is persisted: it survives a restart.
    await t.server.close();
    const again = await startServer({ dataDir: t.dataDir, rootsDir: t.rootsDir });
    expect(again.svc.connectivity.snapshot()).toMatchObject({ state: "offline", source: "forced" });

    const cookie2 = (await call(again, { url: "/api/auth/login", body: { username: "admin", password: "correct horse battery" } })).cookies[0]!;
    const off = await call(again, { url: "/api/system/connectivity", body: { forceOffline: false }, cookie: `ncb_session=${cookie2.value}` });
    expect(off.json().source).not.toBe("forced");
  });

  it("derives state passively: unknown, online after a success, offline after repeated network failures", async () => {
    const inner: Fetcher = { fetch: vi.fn().mockRejectedValue(Object.assign(new Error("dns"), { code: "ENOTFOUND" })) };
    const t = await startServer({ server: { fetcher: inner } });
    expect(t.svc.connectivity.snapshot().state).toBe("unknown");
    t.svc.connectivity.recordOutcome({ ok: true });
    expect(t.svc.connectivity.snapshot()).toMatchObject({ state: "online", source: "passive" });
    for (let i = 0; i < 3; i++) await t.svc.fetcher.fetch({ url: "https://x.test/" }).catch(() => undefined);
    expect(t.svc.connectivity.snapshot().state).toBe("offline");
    // Background work now refuses; a user-initiated fetch may still try.
    await expect(t.svc.fetcher.fetch({ url: "https://x.test/", background: true })).rejects.toMatchObject({ code: "offline", details: { reason: "offline" } });
    await expect(t.svc.fetcher.fetch({ url: "https://x.test/" })).rejects.toMatchObject({ code: "ENOTFOUND" });
  });

  it("makes no outbound call when the probe URL is empty", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const t = await startServer({ server: { probe } });
    t.svc.connectivity.start();
    expect(await t.svc.connectivity.probeNow()).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(t.svc.connectivity.probeCount).toBe(0);
    globalFetch.mockRestore();
  });

  it("uses the probe when a URL is configured, and never while forced offline", async () => {
    const probe = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const t = await startServer({ server: { probe }, env: { NCB_CONNECTIVITY_PROBE_URL: "http://probe.test/ping" } });
    expect(await t.svc.connectivity.probeNow()).toBe(true);
    expect(t.svc.connectivity.snapshot()).toMatchObject({ state: "online", source: "probe" });
    expect(await t.svc.connectivity.probeNow()).toBe(false);
    expect(t.svc.connectivity.snapshot()).toMatchObject({ state: "offline", source: "probe" });
    t.svc.connectivity.setForced(true);
    expect(await t.svc.connectivity.probeNow()).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("guards any inner fetcher via the wrapper", async () => {
    const t = await startServer();
    const inner = okFetcher();
    const guarded = new ConnectivityGuardedFetcher(inner, t.svc.connectivity);
    t.svc.connectivity.setForced(true);
    await expect(guarded.fetch({ url: "http://a.test/" })).rejects.toMatchObject({ code: "offline" });
    expect(inner.calls).toBe(0);
  });

  it("streams state over SSE with a heartbeat and Last-Event-ID replay", async () => {
    const t = await startServer({ server: { sseHeartbeatMs: 40 } });
    const cookie = await setupAdmin(t);
    const { apiPort } = await t.server.listen();

    const chunks: string[] = [];
    const open = (headers: Record<string, string> = {}) =>
      new Promise<http.IncomingMessage>((resolve) => {
        const req = http.get({ host: "127.0.0.1", port: apiPort, path: "/api/system/events", headers: { cookie, ...headers } }, (res) => {
          res.setEncoding("utf8");
          res.on("data", (c: string) => chunks.push(c));
          resolve(res);
        });
        req.on("error", () => undefined);
      });
    const res = await open();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["x-accel-buffering"]).toBe("no");
    await vi.waitFor(() => expect(chunks.join("")).toContain("event: connectivity"));
    expect(chunks.join("")).toMatch(/event: connectivity\ndata: \{"state":"unknown"/);
    await vi.waitFor(() => expect(chunks.join("")).toContain(": heartbeat"));

    t.svc.connectivity.setForced(true);
    await vi.waitFor(() => expect(chunks.join("")).toMatch(/id: \d+\nevent: connectivity\ndata: \{"state":"offline","since":"[^"]+","source":"forced"\}/));
    res.destroy();

    // A reconnect with Last-Event-ID receives what it missed.
    t.svc.events.publish("job", { jobId: 1 });
    chunks.length = 0;
    const res2 = await open({ "last-event-id": "0" });
    await vi.waitFor(() => expect(chunks.join("")).toContain("event: job"));
    res2.destroy();

    // Unauthenticated clients are refused, not streamed.
    const anon = await call(t, { url: "/api/system/events" });
    expect(anon.statusCode).toBe(401);
  });
});

describe("F-16 settings", () => {
  it("returns every group with documented defaults and a JSON Schema", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    const all = (await call(t, { url: "/api/settings", cookie })).json();
    expect(Object.keys(all)).toEqual(["general", "resources", "privacy", "offline", "browser", "search", "discovery", "storage", "logging", "appearance"]);
    expect(all.general).toEqual({ appName: "NoConBrain", locale: "en-GB" });
    expect(all.browser.bookmarkPriority).toBe(2);
    expect(all.privacy.onlineSearch).toEqual({ enabled: false, acknowledgedAt: null });
    expect(all.offline).toMatchObject({ forced: false, probeUrl: "", hasProbeToken: false });
    expect(all.search).toMatchObject({ rrfK: 60, rrfLocalWeight: 1.5 });

    const schema = (await call(t, { url: "/api/settings/schema", cookie })).json();
    expect(schema.properties.general.properties.appName.default).toBe("NoConBrain");
    expect(Object.keys(schema.properties)).toHaveLength(10);
  });

  it("rejects invalid values with field errors and writes nothing", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    const res = await call(t, {
      method: "PATCH", url: "/api/settings", cookie,
      body: { general: { appName: "" }, offline: { probeUrl: "not a url" }, search: { rrfK: 0 }, browser: { bookmarkPriority: 9, showLinkStates: false } },
    });
    expect(res.statusCode).toBe(400);
    const paths = res.json().details.fields.map((f: { path: string }) => f.path).sort();
    expect(paths).toEqual(["browser.bookmarkPriority", "general.appName", "offline.probeUrl", "search.rrfK"]);
    expect((await call(t, { url: "/api/settings", cookie })).json().browser.showLinkStates).toBe(true);
    expect((await call(t, { method: "PATCH", url: "/api/settings", body: { nonsense: { a: 1 } }, cookie })).statusCode).toBe(400);
  });

  it("applies partial updates, strips unknown fields and persists", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    const res = await call(t, { method: "PATCH", url: "/api/settings", cookie, body: { general: { appName: "My Brain", bogus: 1 }, search: { rrfK: 30 } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().general).toEqual({ appName: "My Brain", locale: "en-GB" });
    expect(res.json().search.rrfK).toBe(30);
    expect(res.json().search.rrfLocalWeight).toBe(1.5);
    expect(t.svc.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key='general'")!.value_json).not.toContain("bogus");
  });

  it("never returns secrets and stores them encrypted", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    const res = await call(t, { method: "PATCH", url: "/api/settings", cookie, body: { offline: { probeToken: "s3cr3t-token-value", probeUrl: "https://probe.example/ping" } } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("s3cr3t-token-value");
    expect(res.json().offline).toMatchObject({ hasProbeToken: true, probeUrl: "https://probe.example/ping" });
    expect(res.json().offline.probeToken).toBeUndefined();
    const get = await call(t, { url: "/api/settings", cookie });
    expect(get.body).not.toContain("s3cr3t-token-value");
    const stored = t.svc.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key='offline'")!.value_json;
    expect(stored).not.toContain("s3cr3t-token-value");
    expect(t.svc.settings.secret("offline", "probeToken")).toBe("s3cr3t-token-value");
    // An unrelated patch keeps the secret; null clears it.
    await call(t, { method: "PATCH", url: "/api/settings", cookie, body: { offline: { probeIntervalSeconds: 120 } } });
    expect(t.svc.settings.secret("offline", "probeToken")).toBe("s3cr3t-token-value");
    const cleared = await call(t, { method: "PATCH", url: "/api/settings", cookie, body: { offline: { probeToken: null } } });
    expect(cleared.json().offline.hasProbeToken).toBe(false);
    expect(JSON.stringify((await call(t, { url: "/api/settings/schema", cookie })).json())).not.toContain("s3cr3t");
  });

  it("requires acknowledgement before online search is enabled and records it", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    const refused = await call(t, { method: "PATCH", url: "/api/settings", cookie, body: { privacy: { onlineSearch: { enabled: true } } } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().details.fields[0].path).toBe("privacy.onlineSearch.acknowledged");
    const ok = await call(t, { method: "PATCH", url: "/api/settings", cookie, body: { privacy: { onlineSearch: { enabled: true, acknowledged: true } } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().disclosure).toMatch(/Online search sends/);
    expect(ok.json().privacy.onlineSearch.enabled).toBe(true);
    expect(ok.json().privacy.onlineSearch.acknowledgedAt).toMatch(/^\d{4}-/);
  });

  it("keeps per-user settings", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    expect((await call(t, { url: "/api/settings/user", cookie })).json()).toMatchObject({ theme: "system", density: "comfortable", tabRestore: true });
    const res = await call(t, { method: "PATCH", url: "/api/settings/user", cookie, body: { theme: "dark", shortcuts: { search: "/" } } });
    expect(res.json()).toMatchObject({ theme: "dark", shortcuts: { search: "/" } });
    expect((await call(t, { method: "PATCH", url: "/api/settings/user", cookie, body: { theme: "neon" } })).statusCode).toBe(400);
  });
});

describe("F-11 setup wizard and F-12 dashboard", () => {
  it("walks the wizard: validate, storage, profile, providers, complete", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);

    const outside = await call(t, { url: "/api/setup/storage/validate", body: { path: tempDir() }, cookie });
    expect(outside.json()).toMatchObject({ ok: false, errors: [{ path: "path" }] });
    const valid = await call(t, { url: "/api/setup/storage/validate", body: { path: t.volDir }, cookie });
    expect(valid.json()).toMatchObject({ ok: true, errors: [], warnings: expect.any(Array), freeBytes: expect.any(Number) });
    expect(t.svc.volumes.list()).toHaveLength(0); // validation registers nothing

    const bad = await call(t, { url: "/api/setup/storage", body: { path: tempDir(), name: "x" }, cookie });
    expect(bad.statusCode).toBe(400);

    expect((await call(t, { url: "/api/setup/complete", body: {}, cookie })).statusCode).toBe(409); // no storage yet
    const storage = await call(t, { url: "/api/setup/storage", body: { path: t.volDir, name: "Main" }, cookie });
    expect(storage.statusCode).toBe(200);
    expect(storage.json()).toMatchObject({ volume: { name: "Main", isDefault: true }, warnings: expect.any(Array) });
    expect((await call(t, { url: "/api/setup/storage", body: { path: t.volDir, name: "Again" }, cookie })).statusCode).toBe(409);

    const profile = await call(t, { url: "/api/setup/profile", body: { profile: "pi-lite" }, cookie });
    expect(profile.json().profile).toBe("pi-lite");
    expect((await call(t, { url: "/api/setup/profile", body: { profile: "huge" }, cookie })).statusCode).toBe(400);
    expect((await call(t, { url: "/api/setup/providers", body: { skip: true }, cookie })).json()).toEqual({ skipped: true });
    expect((await call(t, { url: "/api/setup/providers", body: { providers: [{ name: "x" }] }, cookie })).statusCode).toBe(501);
    // The first source is created through the sources service (full coverage in tests/integration/phase3/gaps.test.ts).
    expect((await call(t, { url: "/api/setup/first-source", body: {}, cookie })).statusCode).toBe(400);
    const first = await call(t, { url: "/api/setup/first-source", body: { url: "https://example.org/guide", kind: "page" }, cookie });
    expect(first.statusCode).toBe(201);
    expect(first.json().source).toMatchObject({ type: "single_page", name: "example.org", startUrl: "https://example.org/guide" });

    expect((await call(t, { url: "/api/setup/status" })).json()).toEqual({ adminExists: true, storageConfigured: true, profile: "pi-lite", firstSourceCreated: true, complete: false });
    expect((await call(t, { url: "/api/setup/complete", body: {}, cookie })).json()).toEqual({ complete: true });
    expect((await call(t, { url: "/api/setup/status" })).json().complete).toBe(true);
    // Validation stays available to the admin afterwards; the wizard steps do not.
    expect((await call(t, { url: "/api/setup/storage/validate", body: { path: t.volDir }, cookie })).statusCode).toBe(200);
    expect((await call(t, { url: "/api/setup/profile", body: { profile: "standard" }, cookie })).statusCode).toBe(409);
  });

  it("requires a session for the wizard steps", async () => {
    const t = await startServer();
    await setupAdmin(t);
    for (const url of ["/api/setup/storage", "/api/setup/storage/validate", "/api/setup/profile", "/api/setup/providers", "/api/setup/complete"]) {
      expect((await call(t, { url, body: {} })).statusCode, url).toBe(401);
    }
  });

  it("serves the dashboard and status", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    await t.svc.volumes.register({ path: t.volDir, name: "Main" });
    await t.svc.blobs.put("some text", { kind: "text" });
    t.svc.queue.enqueue({ type: "verify", queue: "maintenance", payload: {} });
    const dash = (await call(t, { url: "/api/system/dashboard", cookie })).json();
    expect(dash.storage.usedBytes).toBeGreaterThan(0);
    expect(dash.storage.availableBytes).toBeGreaterThan(0);
    expect(dash.jobs).toMatchObject({ active: 0, queued: 1, failedLast24h: 0 });
    expect(dash.pages.total).toBe(0);
    expect(dash.connectivity).toBe("unknown");
    expect(dash.workers.find((w: { name: string }) => w.name === "extract").state).toBe("disabled");
    const status = (await call(t, { url: "/api/system/status", cookie })).json();
    expect(status).toMatchObject({ version: expect.any(String), architecture: process.arch, queues: { maintenance: { queued: 1 } }, connectivity: { state: "unknown" } });
    expect((await call(t, { url: "/api/system/dashboard" })).statusCode).toBe(401);
  });

  it("filters the activity log by level, area, text and time, with cursors", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    const w = (level: "info" | "warn" | "error", area: "storage" | "auth" | "crawl", message: string) => {
      t.fake.advance(1000);
      t.svc.activity.write({ level, area, message });
    };
    w("info", "storage", "volume mounted https://user:pw@host.test/x?token=abc");
    w("warn", "storage", "disk getting full");
    w("error", "crawl", "fetch failed");
    w("error", "auth", "bad thing");
    const get = async (q: string) => (await call(t, { url: `/api/system/logs?${q}`, cookie })).json();
    expect((await get("level=error")).items.map((i: { message: string }) => i.message)).toEqual(["bad thing", "fetch failed"]);
    expect((await get("area=storage")).items).toHaveLength(2);
    expect((await get("level=warn,error&area=crawl")).items).toHaveLength(1);
    expect((await get("q=FULL")).items[0].message).toBe("disk getting full");
    const first = await get("level=error&limit=1");
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    const second = await get(`level=error&limit=1&cursor=${first.nextCursor}`);
    expect(second.items[0].message).toBe("fetch failed");
    expect(second.nextCursor).toBeUndefined();
    expect((await call(t, { url: "/api/system/logs?level=loud", cookie })).statusCode).toBe(400);
    const row = (await get("area=storage&q=mounted")).items[0];
    expect(row).toMatchObject({ id: expect.any(Number), at: expect.stringMatching(/^\d{4}-/), level: "info", area: "storage" });
    expect(JSON.stringify(row)).not.toContain("pw@");
    expect(JSON.stringify(row)).not.toContain("abc");
    expect((await get(`from=${new Date(t.fake.now() - 1500).toISOString()}`)).items).toHaveLength(2);
  });
});

describe("archive listener", () => {
  it("serves only a health placeholder, ignores cookies and exposes no API", async () => {
    const server = createArchiveServer({ appUrl: "http://localhost:3000" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
        fetch(`http://127.0.0.1:${port}${path}`, { method, headers });
      const health = await get("/__health", { cookie: "ncb_session=abc" });
      expect(health.status).toBe(200);
      expect(health.headers.get("set-cookie")).toBeNull();
      expect(health.headers.get("content-security-policy")).toMatch(/^sandbox; default-src 'none'/);
      expect(health.headers.get("content-security-policy")).toContain("frame-ancestors http://localhost:3000");
      expect(health.headers.get("x-content-type-options")).toBe("nosniff");
      expect(health.headers.get("referrer-policy")).toBe("no-referrer");
      expect((await get("/healthz")).status).toBe(200);
      for (const p of ["/api/system/health", "/api/auth/me", "/api/setup/status", "/a/token/p/pg_1", "/"]) {
        const r = await get(p, { cookie: "ncb_session=abc", "x-nocon-csrf": "1" });
        expect(r.status, p).toBe(p.startsWith("/a/") ? 401 : 404);
        expect(r.headers.get("set-cookie")).toBeNull();
        expect(r.headers.get("content-security-policy")).toContain("sandbox");
        expect(await r.text()).not.toMatch(/"status"|unauthorized|user/i);
      }
      const post = await get("/__health", {}, "POST");
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, HEAD");
      expect(post.headers.get("content-security-policy")).toContain("sandbox");
    } finally {
      server.close();
    }
  });

  it("starts alongside the API when listening", async () => {
    const t = await startServer({ server: { archive: true } });
    const { archivePort } = await t.server.listen();
    const res = await fetch(`http://127.0.0.1:${archivePort}/__health`);
    expect(res.status).toBe(200);
    const api = await fetch(`http://127.0.0.1:${archivePort}/api/system/health`);
    expect(api.status).toBe(404);
  });
});
