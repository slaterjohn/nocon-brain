import { describe, expect, it } from "vitest";
import { call, setupAdmin, startServer, APP_URL, PROXY_SECRET } from "./helpers.js";

describe("F-05 Fastify skeleton", () => {
  it("reports starting before migrations finish and ok after", async () => {
    const t = await startServer({ deferInit: true });
    const before = await call(t, { url: "/api/system/health" });
    expect(before.statusCode).toBe(503);
    expect(before.json()).toEqual({ status: "starting" });
    // Anything else is refused with a retry hint while starting.
    const other = await call(t, { url: "/api/setup/status" });
    expect(other.statusCode).toBe(503);
    expect(other.headers["retry-after"]).toBeDefined();

    await t.server.initialize();
    const after = await call(t, { url: "/api/system/health" });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({ status: "ok" });
  });

  it("strips unknown fields and returns the documented 400 shape", async () => {
    const t = await startServer();
    const res = await call(t, {
      url: "/api/setup/admin",
      body: { username: "ab", password: "short", isAdmin: true, __proto__x: 1 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("bad_request");
    expect(typeof body.message).toBe("string");
    expect(body.requestId).toMatch(/^req_[0-9A-Z]{26}$/);
    expect(res.headers["x-request-id"]).toBe(body.requestId);
    const paths = body.details.fields.map((f: { path: string }) => f.path).sort();
    expect(paths).toEqual(["password", "username"]);
    expect(body.details.fields[0]).toMatchObject({ in: "body", message: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain("isAdmin");

    // The unknown field never reaches the handler: a valid body with extras still works and stores only known columns.
    const ok = await call(t, { url: "/api/setup/admin", body: { username: "admin", password: "correct horse battery", role: "root" } });
    expect(ok.statusCode).toBe(200);
    expect(t.svc.db.get<{ role: string }>("SELECT role FROM users")!.role).toBe("admin");
  });

  it("treats an empty JSON body as no body and rejects malformed JSON without a stack", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    const empty = await t.server.app.inject({
      method: "POST", url: "/api/auth/logout",
      headers: { "content-type": "application/json", "x-nocon-csrf": "1", origin: APP_URL, cookie },
    });
    expect(empty.statusCode).toBe(200);

    const bad = await t.server.app.inject({
      method: "POST", url: "/api/auth/login", payload: "{nope",
      headers: { "content-type": "application/json", "x-nocon-csrf": "1", origin: APP_URL },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("bad_request");
    expect(bad.body).not.toMatch(/\bat\s+\S+\s+\(/); // no stack frames
  });

  it("answers unknown routes with the error shape and never leaks a stack on a 500", async () => {
    const t = await startServer();
    const nf = await call(t, { url: "/api/nope" });
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toMatchObject({ error: "not_found", requestId: expect.any(String) });

    const cookie = await setupAdmin(t);
    t.svc.settings.getAll = () => {
      throw new Error("secret internal detail /Users/x/file.ts");
    };
    const boom = await call(t, { url: "/api/settings", cookie });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toMatchObject({ error: "internal", requestId: expect.any(String) });
    expect(boom.body).not.toContain("secret internal detail");
    expect(boom.body).not.toContain("/Users/x");
    expect(boom.json().stack).toBeUndefined();
  });

  it("returns 429 with Retry-After from the global rate limit", async () => {
    const t = await startServer({ server: { rateLimitMax: 3 } });
    const codes: number[] = [];
    let last;
    for (let i = 0; i < 5; i++) {
      last = await call(t, { url: "/api/setup/status" });
      codes.push(last.statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect(Number(last!.headers["retry-after"])).toBeGreaterThan(0);
    expect(last!.json()).toMatchObject({ error: "rate_limited", requestId: expect.any(String) });
    // Health is exempt so Docker checks never trip the limit.
    expect((await call(t, { url: "/api/system/health" })).statusCode).toBe(200);
  });

  it("sets security headers on API responses", async () => {
    const t = await startServer();
    const res = await call(t, { url: "/api/setup/status" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("redacts secrets and URL credentials in logs", async () => {
    const t = await startServer({ env: { NCB_LOG_LEVEL: "info" } });
    await call(t, {
      url: "/api/setup/status?token=abc123supersecret",
      headers: { cookie: "ncb_session=SESSIONSECRET", "x-nocon-proxy-secret": PROXY_SECRET },
    });
    const all = t.logs.join("");
    expect(all).toContain("incoming request");
    expect(all).not.toContain("abc123supersecret");
    expect(all).not.toContain("SESSIONSECRET");
    expect(all).not.toContain(PROXY_SECRET);
  });
});

describe("F-06 cross-site protection", () => {
  it("rejects mutations without the CSRF header or with a wrong Origin", async () => {
    const t = await startServer();
    const noHeader = await call(t, { url: "/api/setup/admin", body: { username: "admin", password: "correct horse battery" }, raw: true, headers: { origin: APP_URL } });
    expect(noHeader.statusCode).toBe(403);
    expect(noHeader.json().error).toBe("csrf");

    const wrongOrigin = await call(t, {
      url: "/api/setup/admin", body: { username: "admin", password: "correct horse battery" }, raw: true,
      headers: { "x-nocon-csrf": "1", origin: "http://evil.example" },
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(wrongOrigin.json().error).toBe("csrf");

    const wrongReferer = await call(t, {
      url: "/api/setup/admin", body: { username: "admin", password: "correct horse battery" }, raw: true,
      headers: { "x-nocon-csrf": "1", referer: "http://evil.example/page" },
    });
    expect(wrongReferer.statusCode).toBe(403);
    expect(t.svc.auth.hasAdmin()).toBe(false);
  });

  it("rejects same-site and cross-site requests without CSRF header and matching Origin, including GET", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    for (const site of ["same-site", "cross-site"]) {
      const get = await call(t, { url: "/api/auth/me", cookie, headers: { "sec-fetch-site": site } });
      expect(get.statusCode, site).toBe(403);
      expect(get.json().error).toBe("csrf");
      // The CSRF header alone is not enough: the Origin must match too.
      const half = await call(t, { url: "/api/auth/me", cookie, headers: { "sec-fetch-site": site, "x-nocon-csrf": "1" } });
      expect(half.statusCode, site).toBe(403);
      const mutate = await call(t, { url: "/api/auth/logout", body: {}, cookie, raw: true, headers: { "sec-fetch-site": site, "x-nocon-csrf": "1", origin: "http://evil.example" } });
      expect(mutate.statusCode, site).toBe(403);
    }
    // With both the header and a matching Origin it passes, as documented.
    const ok = await call(t, { url: "/api/auth/me", cookie, headers: { "sec-fetch-site": "same-site", "x-nocon-csrf": "1", origin: APP_URL } });
    expect(ok.statusCode).toBe(200);
    // same-origin and none always pass.
    for (const site of ["same-origin", "none"]) {
      expect((await call(t, { url: "/api/auth/me", cookie, headers: { "sec-fetch-site": site } })).statusCode).toBe(200);
    }
  });
});
