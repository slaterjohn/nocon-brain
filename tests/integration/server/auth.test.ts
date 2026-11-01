import { describe, expect, it } from "vitest";
import { scryptStats } from "../../../apps/server/src/lib/password.js";
import { ADMIN, PROXY_SECRET, call, cookieFrom, setupAdmin, startServer } from "./helpers.js";

const DAY = 86_400_000;

describe("F-06 setup and login", () => {
  it("allows setup only while no admin exists, and checks before hashing", async () => {
    const t = await startServer();
    const status0 = await call(t, { url: "/api/setup/status" });
    expect(status0.json()).toEqual({ adminExists: false, storageConfigured: false, profile: null, firstSourceCreated: false, complete: false });

    const first = await call(t, { url: "/api/setup/admin", body: ADMIN });
    expect(first.statusCode).toBe(200);
    expect(first.json().user.username).toBe("admin");
    const cookie = cookieFrom(first);
    const setCookie = String(first.headers["set-cookie"]);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toMatch(/Secure/i);

    const before = scryptStats().started;
    const second = await call(t, { url: "/api/setup/admin", body: { username: "other", password: "another long password" } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("conflict");
    expect(scryptStats().started).toBe(before); // refused without hashing
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) n FROM users")!.n).toBe(1);

    expect((await call(t, { url: "/api/setup/status" })).json().adminExists).toBe(true);
    expect((await call(t, { url: "/api/auth/me", cookie })).json()).toMatchObject({ mode: "admin", csrfRequired: true, user: { username: "admin" } });
  });

  it("gates the API with setup_required until an admin exists, then 401 without a session", async () => {
    const t = await startServer();
    const pre = await call(t, { url: "/api/settings" });
    expect(pre.statusCode).toBe(409);
    expect(pre.json().error).toBe("setup_required");
    await setupAdmin(t);
    const post = await call(t, { url: "/api/settings" });
    expect(post.statusCode).toBe(401);
    expect(post.json().error).toBe("unauthorized");
  });

  it("logs in, rejects bad credentials with one message, and logs out", async () => {
    const t = await startServer();
    await setupAdmin(t);
    const bad = await call(t, { url: "/api/auth/login", body: { username: "admin", password: "wrong wrong wrong" } });
    expect(bad.statusCode).toBe(401);
    const unknown = await call(t, { url: "/api/auth/login", body: { username: "nobody", password: "wrong wrong wrong" } });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().message).toBe(bad.json().message);

    const ok = await call(t, { url: "/api/auth/login", body: { username: "ADMIN", password: ADMIN.password } });
    expect(ok.statusCode).toBe(200);
    const cookie = cookieFrom(ok);
    expect((await call(t, { url: "/api/auth/me", cookie })).statusCode).toBe(200);

    const out = await call(t, { url: "/api/auth/logout", body: {}, cookie });
    expect(out.statusCode).toBe(200);
    expect((await call(t, { url: "/api/auth/me", cookie })).statusCode).toBe(401);
    // Signing out twice is harmless.
    expect((await call(t, { url: "/api/auth/logout", body: {}, cookie })).statusCode).toBe(200);
    // Failed sign-ins are in the activity log, without the password.
    const logs = t.svc.db.all<{ message: string; details_json: string | null }>("SELECT message, details_json FROM activity_log WHERE area = 'auth'");
    expect(logs.some((l) => l.message === "Failed sign-in attempt")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("wrong wrong");
  });

  it("throttles logins per IP (5/min) before hashing and sends Retry-After", async () => {
    const t = await startServer();
    await setupAdmin(t);
    const codes: number[] = [];
    let last;
    for (let i = 0; i < 7; i++) {
      last = await call(t, { url: "/api/auth/login", body: { username: "admin", password: "wrong wrong wrong" } });
      codes.push(last.statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 401, 401, 429, 429]);
    expect(Number(last!.headers["retry-after"])).toBeGreaterThan(0);
    expect(last!.json().error).toBe("rate_limited");
    // Even the right password is refused while throttled (the check is recorded before hashing).
    expect((await call(t, { url: "/api/auth/login", body: ADMIN })).statusCode).toBe(429);
    // The window slides with the clock.
    t.fake.advance(61_000);
    expect((await call(t, { url: "/api/auth/login", body: ADMIN })).statusCode).toBe(200);
  });

  it("throttles per username (20/hour) across different IPs", async () => {
    const t = await startServer();
    await setupAdmin(t);
    let status = 0;
    for (let i = 0; i < 21; i++) {
      const res = await call(t, {
        url: "/api/auth/login", body: { username: "admin", password: "wrong wrong wrong" },
        headers: { "x-nocon-proxy-secret": PROXY_SECRET, "x-nocon-client-ip": `203.0.113.${i + 1}` },
      });
      status = res.statusCode;
    }
    expect(status).toBe(429);
  });

  it("changes the password, revoking other sessions", async () => {
    const t = await startServer();
    const a = await setupAdmin(t);
    const b = cookieFrom(await call(t, { url: "/api/auth/login", body: ADMIN }));
    const wrong = await call(t, { url: "/api/auth/password", body: { current: "nope nope nope", next: "a brand new password" }, cookie: a });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().details.fields[0].path).toBe("current");
    const ok = await call(t, { url: "/api/auth/password", body: { current: ADMIN.password, next: "a brand new password" }, cookie: a });
    expect(ok.statusCode).toBe(200);
    expect((await call(t, { url: "/api/auth/me", cookie: a })).statusCode).toBe(200);
    expect((await call(t, { url: "/api/auth/me", cookie: b })).statusCode).toBe(401);
    expect((await call(t, { url: "/api/auth/login", body: ADMIN })).statusCode).toBe(401);
    expect((await call(t, { url: "/api/auth/login", body: { username: "admin", password: "a brand new password" } })).statusCode).toBe(200);
  });
});

describe("F-06 sessions", () => {
  it("slides the expiry on use", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    for (let i = 0; i < 3; i++) {
      t.fake.advance(29 * DAY);
      expect((await call(t, { url: "/api/auth/me", cookie })).statusCode).toBe(200);
    }
  });

  it("enforces the sliding window when idle", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    t.fake.advance(30 * DAY + 1000);
    const res = await call(t, { url: "/api/auth/me", cookie });
    expect(res.statusCode).toBe(401);
  });

  it("enforces the 90-day absolute cap however often it is used", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    for (let day = 10; day < 90; day += 10) {
      t.fake.advance(10 * DAY);
      expect((await call(t, { url: "/api/auth/me", cookie })).statusCode, `day ${day}`).toBe(200);
    }
    t.fake.advance(10 * DAY + 1000); // day 90
    expect((await call(t, { url: "/api/auth/me", cookie })).statusCode).toBe(401);
    const row = t.svc.db.get<{ created_at: number; absolute_expires_at: number; expires_at: number }>("SELECT * FROM sessions")!;
    expect(row.absolute_expires_at - row.created_at).toBe(90 * DAY);
    expect(row.expires_at).toBeLessThanOrEqual(row.absolute_expires_at);
  });

  it("does not expire every session at once when the wall clock jumps forward", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    t.fake.jumpWall(60 * DAY); // NTP arrives on a Pi that booted with a wrong date
    expect((await call(t, { url: "/api/auth/me", cookie })).statusCode).toBe(200); // grace period after the jump
  });

  it("revokes one session or all others, and lists sessions with the current one marked", async () => {
    const t = await startServer();
    const a = await setupAdmin(t);
    const b = cookieFrom(await call(t, { url: "/api/auth/login", body: ADMIN }));
    const c = cookieFrom(await call(t, { url: "/api/auth/login", body: ADMIN }));

    const list = (await call(t, { url: "/api/auth/sessions", cookie: a })).json();
    expect(list.items).toHaveLength(3);
    expect(list.items.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(a.split("=")[1]); // tokens and their hashes are never listed in full

    const target = list.items.find((s: { current: boolean }) => !s.current).id as string;
    const del = await call(t, { method: "DELETE", url: `/api/auth/sessions/${target}`, cookie: a });
    expect(del.statusCode).toBe(200);
    expect((await call(t, { method: "DELETE", url: `/api/auth/sessions/${target}`, cookie: a })).statusCode).toBe(404);
    const statuses = await Promise.all([b, c].map(async (x) => (await call(t, { url: "/api/auth/me", cookie: x })).statusCode));
    expect(statuses.sort()).toEqual([200, 401]);

    const all = await call(t, { method: "DELETE", url: "/api/auth/sessions/any?all=true", cookie: a });
    expect(all.json().ok).toBe(true);
    expect((await call(t, { url: "/api/auth/me", cookie: b })).statusCode).toBe(401);
    expect((await call(t, { url: "/api/auth/me", cookie: c })).statusCode).toBe(401);
    expect((await call(t, { url: "/api/auth/me", cookie: a })).statusCode).toBe(200);
  });

  it("stores only a hash of the session token", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    const token = cookie.split("=")[1]!;
    const row = t.svc.db.get<{ token_hash: string }>("SELECT token_hash FROM sessions")!;
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toContain(token);
  });
});

describe("F-06 client IP and trusted-LAN mode", () => {
  async function lan(extra: Record<string, string> = {}) {
    const first = await startServer();
    await setupAdmin(first);
    await first.server.close();
    // Restart over the same data dir in trusted-LAN mode (it refuses to start without an admin).
    return startServer({
      dataDir: first.dataDir, rootsDir: first.rootsDir,
      env: { NCB_AUTH_MODE: "trusted-lan", NCB_TRUSTED_LAN_CIDRS: "192.168.1.0/24", ...extra },
    });
  }

  it("ignores a forged x-nocon-client-ip unless the proxy secret matches", async () => {
    const t = await lan();
    const forged = { "x-nocon-client-ip": "192.168.1.50" };
    const noSecret = await call(t, { url: "/api/settings", headers: forged, remoteAddress: "203.0.113.9" });
    expect(noSecret.statusCode).toBe(401);
    const wrongSecret = await call(t, { url: "/api/settings", headers: { ...forged, "x-nocon-proxy-secret": "x".repeat(32) }, remoteAddress: "203.0.113.9" });
    expect(wrongSecret.statusCode).toBe(401);
    const withSecret = await call(t, { url: "/api/settings", headers: { ...forged, "x-nocon-proxy-secret": PROXY_SECRET }, remoteAddress: "203.0.113.9" });
    expect(withSecret.statusCode).toBe(200);
  });

  it("does not trust a forged IP for the login throttle either", async () => {
    const t = await startServer();
    await setupAdmin(t);
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      codes.push((await call(t, { url: "/api/auth/login", body: { username: `u${i}`, password: "wrong wrong wrong" }, headers: { "x-nocon-client-ip": `198.51.100.${i + 1}` } })).statusCode);
    }
    expect(codes.slice(5)).toEqual([429, 429]); // all attempts counted against the real socket address
  });

  it("gives a trusted-LAN guest read-only access and never any mutation", async () => {
    const t = await lan();
    const guest = { remoteAddress: "192.168.1.20" };
    const me = await call(t, { url: "/api/auth/me", ...guest });
    expect(me.json()).toMatchObject({ mode: "guest", csrfRequired: true });
    expect((await call(t, { url: "/api/settings", ...guest })).statusCode).toBe(200);
    expect((await call(t, { url: "/api/system/connectivity", ...guest })).statusCode).toBe(200);

    // Mutations are refused, with valid CSRF headers.
    const patch = await call(t, { method: "PATCH", url: "/api/settings", body: { general: { appName: "Hacked" } }, ...guest });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().error).toBe("forbidden");
    const connect = await call(t, { url: "/api/system/connectivity", body: { forceOffline: true }, ...guest });
    expect(connect.statusCode).toBe(403);
    expect(t.svc.connectivity.forced).toBe(false);
    // Admin-only reads stay closed to guests.
    expect((await call(t, { url: "/api/auth/sessions", ...guest })).statusCode).toBe(401);
    expect((await call(t, { url: "/api/storage/volumes", ...guest })).statusCode).toBe(401);
    expect((await call(t, { url: "/api/system/logs", ...guest })).statusCode).toBe(401);
    expect((await call(t, { url: "/api/settings/schema", ...guest })).statusCode).toBe(401);
    // An address outside the range gets nothing.
    expect((await call(t, { url: "/api/settings", remoteAddress: "10.0.0.5" })).statusCode).toBe(401);
  });

  it("is off by default and refuses unsafe configurations", async () => {
    const t = await startServer();
    await setupAdmin(t);
    expect((await call(t, { url: "/api/settings", remoteAddress: "192.168.1.20" })).statusCode).toBe(401);

    const first = await startServer();
    await setupAdmin(first);
    await first.server.close();
    await expect(
      startServer({ dataDir: first.dataDir, rootsDir: first.rootsDir, env: { NCB_AUTH_MODE: "trusted-lan", NCB_TRUSTED_LAN_CIDRS: "8.8.8.0/24" } }),
    ).rejects.toThrow(/private/);
    await expect(
      startServer({ dataDir: first.dataDir, rootsDir: first.rootsDir, env: { NCB_AUTH_MODE: "trusted-lan", NCB_TRUSTED_LAN_CIDRS: "0.0.0.0/0" } }),
    ).rejects.toThrow(/private/);
    // No admin yet: refuses to start.
    await expect(startServer({ env: { NCB_AUTH_MODE: "trusted-lan", NCB_TRUSTED_LAN_CIDRS: "192.168.1.0/24" } })).rejects.toThrow(/administrator/i);
  });
});
