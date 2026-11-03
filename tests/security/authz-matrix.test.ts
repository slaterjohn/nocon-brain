import { beforeAll, describe, expect, it } from "vitest";
import { call, PROXY_SECRET, setupAdmin, startServer } from "../integration/server/helpers.js";

/**
 * H-03 API authorisation matrix.
 *
 * The route table comes from Fastify itself (`app.routeTable`, filled by an `onRoute` hook), so a route added without an entry in
 * EXPECTED fails the first test below, and so does a route whose declared level differs. Every route is then called as:
 *
 *   anonymous       no cookie, from outside the LAN, through the web container (proxy secret present)
 *   guest           trusted-LAN client address, no cookie, through the web container
 *   admin           valid session cookie
 *   no proxy secret another container on the network (a missing or wrong secret), even with a valid admin cookie
 *   CSRF missing    no CSRF header, wrong Origin (the archive origin), or cross-site fetch metadata
 *   setup open      before an administrator exists
 *
 * "Allowed" means the request reached the route handler: whatever the handler then answers (200, 400, 404 ...), it is not an access error.
 */

type Level = "public" | "guest" | "guest+post" | "session";

/** The reviewed access level of every route. Change this table only together with a security review of the route. */
const EXPECTED: Record<string, Level> = {
  // public
  "GET /api/system/health": "public",
  "GET /api/setup/status": "public",
  "POST /api/setup/admin": "public",
  "POST /api/auth/login": "public",
  "POST /api/auth/logout": "public",
  // guest
  "GET /api/system/connectivity": "guest",
  "GET /api/auth/me": "guest",
  "GET /api/settings": "guest",
  "GET /api/storage": "guest",
  "GET /api/storage/usage": "guest",
  "GET /api/storage/forecast": "guest",
  "GET /api/browser/frame-state": "guest",
  "GET /api/archive/pages": "guest",
  "GET /api/archive/pages/:id": "guest",
  "GET /api/archive/versions": "guest",
  "GET /api/archive/versions/:id": "guest",
  "GET /api/archive/versions/:id/find": "guest",
  "GET /api/bookmarks": "guest",
  "GET /api/sources": "guest",
  "GET /api/sources/:id": "guest",
  "GET /api/sources/:id/pages": "guest",
  "GET /api/sources/:id/stats": "guest",
  "GET /api/collections": "guest",
  "GET /api/collections/icons": "guest",
  "GET /api/collections/:id": "guest",
  "GET /api/collections/:id/items": "guest",
  "GET /api/search/suggestions": "guest",
  "GET /api/search/favicon/:id": "guest",
  "GET /api/search/saved": "guest",
  "GET /api/search/saved/:id": "guest",
  "GET /api/search/history": "guest",
  "GET /api/search/:id/events": "guest",
  "GET /api/search/:id": "guest",
  "GET /api/index/status": "guest",
  "GET /api/downloads": "guest",
  "GET /api/downloads/queue": "guest",
  "GET /api/downloads/:id": "guest",
  "GET /api/zim/packages": "guest",
  "GET /api/zim/status": "guest",
  "GET /api/zim/packages/:id": "guest",
  "GET /api/zim/packages/:id/entries": "guest",
  "GET /api/zim/packages/:id/suggest": "guest",
  "GET /api/zim/packages/:id/search": "guest",
  "GET /api/zim/packages/:id/entry": "guest",
  "GET /api/zim/packages/:id/illustration": "guest",
  "GET /api/archive/import/limits": "guest",
  "GET /api/archive/versions/:id/import": "guest",
  "GET /api/archive/versions/:id/original": "guest",
  // guest+post
  "POST /api/search": "guest+post",
  // session
  "GET /api/system/status": "session",
  "GET /api/system/dashboard": "session",
  "POST /api/system/maintenance/verify": "session",
  "GET /api/system/maintenance/runs": "session",
  "GET /api/system/maintenance/runs/:id": "session",
  "POST /api/system/maintenance/backup": "session",
  "GET /api/system/maintenance/backups": "session",
  "GET /api/system/logs": "session",
  "POST /api/system/connectivity": "session",
  "GET /api/system/events": "session",
  "POST /api/setup/storage/validate": "session",
  "POST /api/setup/storage": "session",
  "POST /api/setup/profile": "session",
  "POST /api/setup/providers": "session",
  "POST /api/setup/first-source": "session",
  "POST /api/setup/complete": "session",
  "GET /api/auth/sessions": "session",
  "DELETE /api/auth/sessions": "session",
  "DELETE /api/auth/sessions/:id": "session",
  "POST /api/auth/password": "session",
  "PATCH /api/settings": "session",
  "GET /api/settings/schema": "session",
  "GET /api/settings/user": "session",
  "PATCH /api/settings/user": "session",
  "GET /api/storage/volumes": "session",
  "POST /api/storage/volumes": "session",
  "GET /api/storage/volumes/:id": "session",
  "PATCH /api/storage/volumes/:id": "session",
  "DELETE /api/storage/volumes/:id": "session",
  "POST /api/storage/volumes/:id/verify": "session",
  "POST /api/storage/volumes/:id/migrate": "session",
  "GET /api/storage/policy": "session",
  "PUT /api/storage/policy": "session",
  "POST /api/storage/eviction/plan": "session",
  "POST /api/storage/eviction/run": "session",
  "GET /api/storage/eviction/runs": "session",
  "GET /api/storage/pages/:id": "session",
  "PUT /api/storage/pages/:id/pin": "session",
  "DELETE /api/storage/pages/:id/pin": "session",
  "GET /api/storage/audit": "session",
  "POST /api/storage/maintenance/verify": "session",
  "POST /api/browser/resolve": "session",
  "POST /api/browser/link-states": "session",
  "POST /api/browser/live-check": "session",
  "POST /api/browser/save": "session",
  "GET /api/browser/offline-page": "session",
  "DELETE /api/archive/pages/:id": "session",
  "POST /api/archive/capture": "session",
  "GET /api/archive/captures/:id": "session",
  "GET /api/archive/captures": "session",
  "POST /api/archive/frame-grants": "session",
  "POST /api/bookmarks": "session",
  "PATCH /api/bookmarks/:id": "session",
  "DELETE /api/bookmarks/:id": "session",
  "GET /api/history": "session",
  "DELETE /api/history": "session",
  "DELETE /api/history/:id": "session",
  "POST /api/sources": "session",
  "POST /api/sources/preview": "session",
  "PATCH /api/sources/:id": "session",
  "DELETE /api/sources/:id": "session",
  "POST /api/sources/:id/run": "session",
  "POST /api/sources/:id/refresh": "session",
  "POST /api/sources/:id/pause": "session",
  "POST /api/sources/:id/resume": "session",
  "POST /api/collections": "session",
  "PATCH /api/collections/:id": "session",
  "DELETE /api/collections/:id": "session",
  "POST /api/collections/:id/items": "session",
  "POST /api/collections/:id/rebuild": "session",
  "POST /api/search/saved": "session",
  "PATCH /api/search/saved/:id": "session",
  "DELETE /api/search/saved/:id": "session",
  "POST /api/search/saved/:id/run": "session",
  "DELETE /api/search/history": "session",
  "DELETE /api/search/history/:id": "session",
  "GET /api/search/providers": "session",
  "POST /api/search/providers": "session",
  "GET /api/search/providers/:id": "session",
  "PATCH /api/search/providers/:id": "session",
  "DELETE /api/search/providers/:id": "session",
  "POST /api/search/providers/:id/test": "session",
  "GET /api/search/providers/:id/usage": "session",
  "POST /api/search/coverage/plan": "session",
  "POST /api/search/coverage/queue": "session",
  "POST /api/search/saved/:id/source": "session",
  "GET /api/search/saved/:id/candidates": "session",
  "POST /api/search/saved/:id/candidates/approve": "session",
  "POST /api/search/saved/:id/candidates/dismiss": "session",
  "POST /api/search/:id/more": "session",
  "POST /api/search/:id/results/:key/save": "session",
  "POST /api/index/rebuild": "session",
  "POST /api/index/optimize": "session",
  "POST /api/index/check": "session",
  "GET /api/index/jobs": "session",
  "GET /api/index/synonyms": "session",
  "PUT /api/index/synonyms": "session",
  "GET /api/index/ranking": "session",
  "PUT /api/index/ranking": "session",
  "POST /api/downloads": "session",
  "GET /api/downloads/:id/log": "session",
  "POST /api/downloads/:id/pause": "session",
  "POST /api/downloads/:id/resume": "session",
  "POST /api/downloads/:id/cancel": "session",
  "POST /api/downloads/:id/retry": "session",
  "PATCH /api/downloads/:id": "session",
  "GET /api/schedules": "session",
  "POST /api/schedules": "session",
  "GET /api/schedules/:id": "session",
  "PATCH /api/schedules/:id": "session",
  "DELETE /api/schedules/:id": "session",
  "GET /api/downloads/windows": "session",
  "PUT /api/downloads/windows": "session",
  "GET /api/discovery": "session",
  "GET /api/discovery/candidates": "session",
  "POST /api/discovery/candidates/bulk": "session",
  "GET /api/discovery/candidates/:id": "session",
  "GET /api/discovery/candidates/:id/explain": "session",
  "POST /api/discovery/candidates/:id/approve": "session",
  "POST /api/discovery/candidates/:id/dismiss": "session",
  "POST /api/discovery/candidates/:id/queue": "session",
  "GET /api/discovery/settings": "session",
  "PUT /api/discovery/settings": "session",
  "POST /api/discovery/pause": "session",
  "POST /api/discovery/resume": "session",
  "GET /api/discovery/budget": "session",
  "GET /api/discovery/ledger": "session",
  "GET /api/discovery/runner": "session",
  "POST /api/discovery/run": "session",
  "POST /api/zim/packages/import": "session",
  "PATCH /api/zim/packages/:id": "session",
  "GET /api/zim/packages/:id/references": "session",
  "DELETE /api/zim/packages/:id": "session",
  "POST /api/zim/packages/:id/verify": "session",
  "POST /api/wikipedia/preview": "session",
  "POST /api/wikipedia/crawl": "session",
  "GET /api/wikipedia/status": "session",
  "POST /api/wikipedia/reset": "session",
  "POST /api/archive/import": "session",
};

const LAN_GUEST = "192.168.1.50";
const PUBLIC_CLIENT = "203.0.113.7";
const OTHER_CONTAINER = "172.18.0.9";
const ARCHIVE_ORIGIN = "http://localhost:3002";
/** Streaming responses never end; their access check is the same hook and is covered by the denied legs. */
const STREAMING = new Set(["GET /api/system/events"]);
/** Would end the session the rest of the admin leg depends on; exercised last or skipped. */
const SESSION_ENDING = new Set(["POST /api/auth/logout", "DELETE /api/auth/sessions"]);

interface Row { method: string; url: string; key: string; level: Level; path: string }

function fill(url: string): string {
  return url.replace(/:key/g, "k1").replace(/:[a-zA-Z]+/g, "x1");
}

type Verdict = "allowed" | "unauthorized" | "guest_forbidden" | "proxy_forbidden" | "csrf" | "setup_required";

function verdict(res: { statusCode: number; json(): any }): Verdict {
  let body: { error?: string; message?: string } = {};
  try { body = res.json(); } catch { /* not JSON: the handler answered */ }
  if (res.statusCode === 401 && body.error === "unauthorized") return "unauthorized";
  if (res.statusCode === 403 && body.error === "csrf") return "csrf";
  if (res.statusCode === 403 && body.error === "forbidden") return /web app/.test(body.message ?? "") ? "proxy_forbidden" : "guest_forbidden";
  if (res.statusCode === 409 && body.error === "setup_required") return "setup_required";
  return "allowed";
}

const viaWeb = (ip: string) => ({ "x-nocon-proxy-secret": PROXY_SECRET, "x-nocon-client-ip": ip });
const RATE = { NCB_RATE_LIMIT_PER_MINUTE: "1000000" };

/** The test helpers close every server after each test, so each test builds its own: admin created, then restarted in trusted-LAN mode. */
async function boot() {
  const first = await startServer({ env: RATE });
  const cookie = await setupAdmin(first);
  await first.server.close();
  const lan = await startServer({
    dataDir: first.dataDir, rootsDir: first.rootsDir,
    env: { ...RATE, NCB_AUTH_MODE: "trusted-lan", NCB_TRUSTED_LAN_CIDRS: "192.168.1.0/24" },
  });
  const rows: Row[] = lan.server.app.routeTable.map((r) => ({
    method: r.method, url: r.url, key: `${r.method} ${r.url}`, level: (r.auth === "guest" && r.guestPost ? "guest+post" : r.auth) as Level, path: fill(r.url),
  }));
  return { lan, cookie, rows };
}

describe("route table", () => {
  it("has an entry for every route, and none for a route that is gone", async () => {
    const { rows } = await boot();
    const actual = rows.map((r) => r.key).sort();
    expect(actual).toEqual(Object.keys(EXPECTED).sort());
  });

  it("declares exactly the reviewed access level on every route", async () => {
    const { rows } = await boot();
    const wrong = rows.filter((r) => EXPECTED[r.key] !== r.level).map((r) => `${r.key}: declared ${r.level}, reviewed ${EXPECTED[r.key]}`);
    expect(wrong).toEqual([]);
  });

  it("keeps the public set to the five routes that must work signed out", async () => {
    const { rows } = await boot();
    expect(rows.filter((r) => r.level === "public").map((r) => r.key).sort()).toEqual([
      "GET /api/setup/status", "GET /api/system/health", "POST /api/auth/login", "POST /api/auth/logout", "POST /api/setup/admin",
    ]);
  });

  it("lets a guest do nothing but read and search: no guest-level route changes data except search", async () => {
    const { rows } = await boot();
    const mutating = rows.filter((r) => r.level === "guest" && r.method !== "GET");
    expect(mutating.map((r) => r.key)).toEqual([]);
  });
});

describe("anonymous (outside the LAN, through the web container)", () => {
  it("is refused on every non-public route with 401 and allowed on public routes", async () => {
    const { lan, cookie, rows } = await boot();
    const bad: string[] = [];
    for (const r of rows) {
      const res = await call(lan, { method: r.method, url: r.path, headers: viaWeb(PUBLIC_CLIENT), remoteAddress: OTHER_CONTAINER });
      const v = verdict(res);
      const want: Verdict = r.level === "public" ? "allowed" : "unauthorized";
      if (v !== want) bad.push(`${r.key}: ${v} (${res.statusCode}), want ${want}`);
    }
    expect(bad).toEqual([]);
  });

  it("a forged or garbage session cookie is no better than none", async () => {
    const { lan, cookie, rows } = await boot();
    const bad: string[] = [];
    for (const r of rows.filter((x) => x.level !== "public")) {
      for (const c of ["ncb_session=" + "a".repeat(43), "ncb_session=", "ncb_session=../../etc/passwd", "ncb_session=%00"]) {
        const res = await call(lan, { method: r.method, url: r.path, cookie: c, headers: viaWeb(PUBLIC_CLIENT), remoteAddress: OTHER_CONTAINER });
        if (verdict(res) !== "unauthorized") bad.push(`${r.key} with ${c}: ${res.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("guest (trusted LAN, read-only)", () => {
  it("reads guest routes, searches, is refused (401 read, 403 write) on everything else", async () => {
    const { lan, cookie, rows } = await boot();
    const bad: string[] = [];
    for (const r of rows) {
      if (STREAMING.has(r.key)) continue;
      const res = await call(lan, { method: r.method, url: r.path, headers: viaWeb(LAN_GUEST), remoteAddress: OTHER_CONTAINER });
      const v = verdict(res);
      let want: Verdict;
      if (r.level === "public") want = "allowed";
      else if (r.level === "guest") want = r.method === "GET" ? "allowed" : "guest_forbidden";
      else if (r.level === "guest+post") want = "allowed";
      else want = r.method === "GET" ? "unauthorized" : "guest_forbidden";
      if (v !== want) bad.push(`${r.key}: ${v} (${res.statusCode} ${res.body.slice(0, 80)}), want ${want}`);
    }
    expect(bad).toEqual([]);
  });

  it("a guest address only counts when it arrives with the proxy secret (a forged client address is ignored)", async () => {
    const { lan, cookie, rows } = await boot();
    for (const headers of [{ "x-nocon-client-ip": LAN_GUEST }, { "x-nocon-client-ip": LAN_GUEST, "x-nocon-proxy-secret": "x".repeat(32) }] as Record<string, string>[]) {
      const res = await call(lan, { url: "/api/settings", headers, remoteAddress: PUBLIC_CLIENT });
      expect(verdict(res)).toBe("proxy_forbidden");
    }
    // With the secret but a client address outside the LAN, the same request is anonymous.
    const out = await call(lan, { url: "/api/settings", headers: viaWeb("10.9.9.9"), remoteAddress: OTHER_CONTAINER });
    expect(verdict(out)).toBe("unauthorized");
  });

  it("a guest never sees a stored secret", async () => {
    const { lan, cookie, rows } = await boot();
    const SECRET = "probe-token-SECRET-1234567890";
    const set = await call(lan, { method: "PATCH", url: "/api/settings", cookie, headers: viaWeb(PUBLIC_CLIENT), remoteAddress: OTHER_CONTAINER, body: { offline: { probeToken: SECRET } } });
    expect(set.statusCode, set.body).toBe(200);
    const seen: string[] = [];
    for (const r of rows.filter((x) => x.level.startsWith("guest") && x.method === "GET" && !STREAMING.has(x.key))) {
      const res = await call(lan, { url: r.path, headers: viaWeb(LAN_GUEST), remoteAddress: OTHER_CONTAINER });
      if (res.body.includes(SECRET) || res.body.includes(PROXY_SECRET)) seen.push(r.key);
      if (res.headers["set-cookie"] && r.key !== "GET /api/auth/me") seen.push(`${r.key} set a cookie`);
    }
    expect(seen).toEqual([]);
    // the administrator does not get it back either
    const admin = await call(lan, { url: "/api/settings", cookie, headers: viaWeb(PUBLIC_CLIENT), remoteAddress: OTHER_CONTAINER });
    expect(admin.body).not.toContain(SECRET);
  });
});

describe("no proxy secret (another container on the network)", () => {
  it("refuses every route but health, with a valid admin cookie and with a wrong secret", async () => {
    const { lan, cookie, rows } = await boot();
    const bad: string[] = [];
    for (const r of rows) {
      for (const headers of [{}, { "x-nocon-proxy-secret": "wrong".repeat(8) }, { "x-nocon-proxy-secret": "" }] as Record<string, string>[]) {
        const res = await call(lan, { method: r.method, url: r.path, cookie, headers, remoteAddress: OTHER_CONTAINER });
        const want: Verdict = r.key === "GET /api/system/health" ? "allowed" : "proxy_forbidden";
        if (verdict(res) !== want) bad.push(`${r.key}: ${verdict(res)} (${res.statusCode})`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the secret must match exactly: a prefix, a suffix, a longer value and another case all fail", async () => {
    const { lan, cookie, rows } = await boot();
    for (const s of [PROXY_SECRET.slice(0, -1), PROXY_SECRET + "x", " " + PROXY_SECRET, PROXY_SECRET.toUpperCase()]) {
      const res = await call(lan, { url: "/api/settings", cookie, headers: { "x-nocon-proxy-secret": s }, remoteAddress: OTHER_CONTAINER });
      expect(verdict(res), s).toBe("proxy_forbidden");
    }
  });
});

describe("alternative spellings of an API path (regression: /%61pi/... skipped every API check)", () => {
  const SPELLINGS = [(p: string) => p.replace("/api", "/%61pi"), (p: string) => p.replace("/api", "/ap%69"), (p: string) => p.replace("/api", "/%61%70%69"), (p: string) => p.replace("/api/", "/api/%2e%2e/api/")];

  it("every route keeps every check under an encoded spelling: no secret, anonymous, CSRF", async () => {
    const { lan, cookie, rows } = await boot();
    const bad: string[] = [];
    for (const r of rows) {
      if (STREAMING.has(r.key)) continue;
      for (const spell of SPELLINGS) {
        const url = spell(r.path);
        const noSecret = await call(lan, { method: r.method, url, cookie, remoteAddress: OTHER_CONTAINER });
        if (r.key !== "GET /api/system/health" && verdict(noSecret) !== "proxy_forbidden") bad.push(`${r.method} ${url} without secret: ${noSecret.statusCode}`);
        const anon = await call(lan, { method: r.method, url, headers: viaWeb(PUBLIC_CLIENT), remoteAddress: OTHER_CONTAINER });
        if (r.level !== "public" && verdict(anon) !== "unauthorized" && anon.statusCode !== 404) bad.push(`${r.method} ${url} anonymous: ${anon.statusCode}`);
        if (r.method !== "GET") {
          const csrf = await call(lan, { method: r.method, url, cookie, headers: viaWeb(PUBLIC_CLIENT), raw: true, remoteAddress: OTHER_CONTAINER });
          if (verdict(csrf) !== "csrf" && csrf.statusCode !== 404) bad.push(`${r.method} ${url} without CSRF header: ${csrf.statusCode}`);
        }
        if (anon.statusCode !== 404 && anon.headers["x-frame-options"] !== "DENY") bad.push(`${r.method} ${url} lacks the API response headers`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("before setup an encoded spelling does not answer either", async () => {
    const t = await startServer({ env: RATE });
    for (const url of ["/%61pi/settings", "/%61pi/storage/volumes", "/%61pi/system/status"]) {
      const res = await call(t, { url, headers: viaWeb(PUBLIC_CLIENT), remoteAddress: OTHER_CONTAINER });
      expect(verdict(res), url).toBe("setup_required");
    }
  });

  it("unmatched paths are 404 with the API error body and never reach a handler", async () => {
    const { lan, cookie } = await boot();
    for (const url of ["//api/settings", "/api//settings", "/api/settings/", "/API/settings", "/api/settings;x", "/%2561pi/settings", "/api%2Fsettings", "/\\api/settings", "/api/settings%00", "/api/settings%2f..%2f", "/%61pi", "/"]) {
      const res = await call(lan, { url, cookie, headers: viaWeb(PUBLIC_CLIENT), remoteAddress: OTHER_CONTAINER });
      expect([404, 400], `${url} -> ${res.statusCode}`).toContain(res.statusCode);
      expect(res.body).not.toMatch(/"general"|"appName"/);
    }
  });
});

describe("CSRF and cross-origin protection", () => {
  it("every mutating route refuses a request without the CSRF header, and one from the archive origin", async () => {
    const { lan, cookie, rows } = await boot();
    const bad: string[] = [];
    for (const r of rows.filter((x) => x.method !== "GET")) {
      const noHeader = await call(lan, { method: r.method, url: r.path, cookie, headers: { ...viaWeb(PUBLIC_CLIENT), origin: "http://localhost:3000" }, raw: true, remoteAddress: OTHER_CONTAINER });
      if (verdict(noHeader) !== "csrf") bad.push(`${r.key} without header: ${noHeader.statusCode}`);
      const archive = await call(lan, { method: r.method, url: r.path, cookie, headers: { ...viaWeb(PUBLIC_CLIENT), "x-nocon-csrf": "1", origin: ARCHIVE_ORIGIN }, raw: true, remoteAddress: OTHER_CONTAINER });
      if (verdict(archive) !== "csrf") bad.push(`${r.key} from archive origin: ${archive.statusCode}`);
      const referer = await call(lan, { method: r.method, url: r.path, cookie, headers: { ...viaWeb(PUBLIC_CLIENT), "x-nocon-csrf": "1", referer: ARCHIVE_ORIGIN + "/a/x/p/y" }, raw: true, remoteAddress: OTHER_CONTAINER });
      if (verdict(referer) !== "csrf") bad.push(`${r.key} from archive referer: ${referer.statusCode}`);
    }
    expect(bad).toEqual([]);
  });

  it("a cross-site or same-site fetch is refused on every route, GET included, unless it carries the header and the app origin", async () => {
    const { lan, cookie, rows } = await boot();
    const bad: string[] = [];
    for (const r of rows.filter((x) => !STREAMING.has(x.key))) {
      for (const site of ["cross-site", "same-site"]) {
        const res = await call(lan, { method: r.method, url: r.path, cookie, headers: { ...viaWeb(PUBLIC_CLIENT), "sec-fetch-site": site, origin: ARCHIVE_ORIGIN, "x-nocon-csrf": "1" }, raw: true, remoteAddress: OTHER_CONTAINER });
        if (verdict(res) !== "csrf") bad.push(`${r.key} ${site}: ${res.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("responses carry no CORS headers, so a page on another origin cannot read them", async () => {
    const { lan, cookie, rows } = await boot();
    for (const url of ["/api/settings", "/api/auth/me", "/api/system/health", "/api/nope"]) {
      const res = await call(lan, { url, cookie, headers: { ...viaWeb(PUBLIC_CLIENT), origin: ARCHIVE_ORIGIN }, remoteAddress: OTHER_CONTAINER });
      expect(res.headers["access-control-allow-origin"], url).toBeUndefined();
      expect(res.headers["access-control-allow-credentials"], url).toBeUndefined();
    }
    const pre = await call(lan, { method: "OPTIONS", url: "/api/settings", headers: { ...viaWeb(PUBLIC_CLIENT), origin: ARCHIVE_ORIGIN, "access-control-request-method": "PATCH" }, raw: true, remoteAddress: OTHER_CONTAINER });
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("admin", () => {
  it("reaches every route: no access error on any of them", async () => {
    const { lan, cookie, rows } = await boot();
    const bad: string[] = [];
    const order = [...rows.filter((r) => !SESSION_ENDING.has(r.key)), ...rows.filter((r) => r.key === "DELETE /api/auth/sessions")];
    for (const r of order) {
      if (STREAMING.has(r.key) || r.key === "POST /api/auth/logout") continue;
      const res = await call(lan, { method: r.method, url: r.path, cookie, headers: viaWeb(PUBLIC_CLIENT), remoteAddress: OTHER_CONTAINER });
      const v = verdict(res);
      if (v !== "allowed") bad.push(`${r.key}: ${v} (${res.statusCode} ${res.body.slice(0, 100)})`);
      expect(res.statusCode, `${r.key} ${res.body.slice(0, 200)}`).toBeLessThan(500);
    }
    expect(bad).toEqual([]);
  });
});

describe("setup not finished (no administrator yet)", () => {
  it("only the public routes answer; everything else says to finish setup", async () => {
    const { rows } = await boot();
    const setupT = await startServer({ env: RATE }); // no administrator yet
    const bad: string[] = [];
    for (const r of rows) {
      if (STREAMING.has(r.key)) continue;
      const res = await call(setupT, { method: r.method, url: r.path, headers: viaWeb(PUBLIC_CLIENT), remoteAddress: OTHER_CONTAINER });
      const v = verdict(res);
      const want: Verdict = r.level === "public" ? "allowed" : "setup_required";
      if (v !== want) bad.push(`${r.key}: ${v} (${res.statusCode})`);
    }
    expect(bad).toEqual([]);
  });

  it("once an administrator exists, the setup route cannot make a second one", async () => {
    const { lan, cookie, rows } = await boot();
    const res = await call(lan, { url: "/api/setup/admin", body: { username: "second", password: "another good password" }, headers: viaWeb(PUBLIC_CLIENT), remoteAddress: OTHER_CONTAINER });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(lan.svc.db.get<{ n: number }>("SELECT count(*) AS n FROM users")!.n).toBe(1);
  });
});
