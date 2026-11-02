import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addProvider, results, startFake, startOnlineServer } from "./helpers.js";

function dbText(dataDir: string): string {
  // Main database plus its WAL: every byte that could hold a plain-text key.
  const dir = path.join(dataDir, "db");
  return fs.readdirSync(dir).filter((f) => f.startsWith("main.db")).map((f) => fs.readFileSync(path.join(dir, f)).toString("latin1")).join("\n");
}

describe("provider settings API (O-07)", () => {
  it("creates, lists, patches and deletes providers; the credential is encrypted at rest and never returned", async () => {
    const fake = await startFake("brave", results(3));
    const t = await startOnlineServer();
    const secret = "brave-key";
    const created = await t.api("POST", "/api/search/providers", { adapter: "brave", name: "My Brave", baseUrl: fake.url, apiKey: secret, enabled: true, monthlyCap: 900, language: "en-GB", region: "gb" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      adapter: "brave", name: "My Brave", enabled: true, hasCredentials: true, monthlyCap: 900, region: "GB", language: "en-GB", timeoutMs: 4000, safeSearch: "moderate",
      storage: { policy: "none", adapterPolicy: "none", maxTtlSeconds: 0 }, health: { state: "unknown" }, usage: { month: { requests: 0, cap: 900 } },
    });
    expect(created.body.id).toMatch(/^prv_/);
    expect(JSON.stringify(created.body)).not.toContain(secret);
    expect(created.body).not.toHaveProperty("apiKey");
    expect(created.body).not.toHaveProperty("credentials");

    // Encrypted at rest: the row holds the v1 envelope, and the key appears nowhere in the database files.
    const row = t.svc.db.get<{ credentials_enc: string }>("SELECT credentials_enc FROM search_providers")!;
    expect(row.credentials_enc).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(row.credentials_enc).not.toContain(secret);
    expect(dbText(t.dataDir)).not.toContain(secret);

    const list = await t.api("GET", "/api/search/providers");
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.online).toMatchObject({ enabled: true, state: "ready" });
    expect(list.body.online.acknowledgedAt).toBeTruthy();
    expect(JSON.stringify(list.body)).not.toContain(secret);

    const patched = await t.api("PATCH", `/api/search/providers/${created.body.id}`, { name: "Renamed", timeoutMs: 2500, apiKey: "another-secret-value" });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ name: "Renamed", timeoutMs: 2500, hasCredentials: true });
    expect(JSON.stringify(patched.body)).not.toContain("another-secret-value");
    expect(dbText(t.dataDir)).not.toContain("another-secret-value");
    const cleared = await t.api("PATCH", `/api/search/providers/${created.body.id}`, { apiKey: null, enabled: false });
    expect(cleared.body).toMatchObject({ hasCredentials: false, enabled: false });
    // Brave needs a key before it can be switched on again.
    const bad = await t.api("PATCH", `/api/search/providers/${created.body.id}`, { enabled: true });
    expect(bad.status).toBe(400);
    expect(bad.body.details.fields[0].path).toBe("apiKey");

    expect((await t.api("GET", `/api/search/providers/${created.body.id}`)).status).toBe(200);
    expect((await t.api("DELETE", `/api/search/providers/${created.body.id}`)).status).toBe(204);
    expect((await t.api("GET", `/api/search/providers/${created.body.id}`)).status).toBe(404);
    expect((await t.api("GET", "/api/search/providers")).body.items).toHaveLength(0);
  });

  it("needs a session for every provider route and never shows providers to a guest", async () => {
    const t = await startOnlineServer();
    const noCookie = await t.server.app.inject({ method: "GET", url: "/api/search/providers" });
    expect(noCookie.statusCode).toBe(401);
    const post = await t.server.app.inject({ method: "POST", url: "/api/search/providers", payload: { adapter: "searxng" }, headers: { "x-nocon-csrf": "1", origin: "http://localhost:3000" } });
    expect(post.statusCode).toBe(401);
  });

  it("requires the disclosure before the first provider is switched on", async () => {
    const fake = await startFake("searxng", results(2));
    const t = await startOnlineServer({ online: false });
    const refused = await t.api("POST", "/api/search/providers", { adapter: "searxng", name: "S", baseUrl: fake.url, enabled: true });
    expect(refused.status).toBe(400);
    expect(refused.body.details.fields[0].path).toBe("acknowledged");
    expect(refused.body.details.disclosure).toMatch(/Online search sends the words you type/);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM search_providers")!.n).toBe(0);
    // A disabled provider needs no acknowledgement.
    const off = await t.api("POST", "/api/search/providers", { adapter: "searxng", name: "S", baseUrl: fake.url });
    expect(off.status).toBe(201);
    expect(off.body.enabled).toBe(false);
    const enable = await t.api("PATCH", `/api/search/providers/${off.body.id}`, { enabled: true });
    expect(enable.status).toBe(400);
    const ok = await t.api("PATCH", `/api/search/providers/${off.body.id}`, { enabled: true, acknowledged: true });
    expect(ok.status).toBe(200);
    expect(ok.body.enabled).toBe(true);
    const info = await t.api("GET", "/api/search/providers");
    expect(info.body.online.acknowledgedAt).toBeTruthy();
    // The master switch is separate and still off, so nothing goes out.
    expect(info.body.online).toMatchObject({ enabled: false, state: "off" });
    // The settings route enforces the same rule for the master switch when never acknowledged.
    const t2 = await startOnlineServer({ online: false });
    const m = await t2.api("PATCH", "/api/settings", { privacy: { onlineSearch: { enabled: true } } });
    expect(m.status).toBe(400);
    expect(m.body.details.fields[0].path).toBe("privacy.onlineSearch.acknowledged");
  });

  it("validates adapters, storage limits and fallbacks with field paths", async () => {
    const t = await startOnlineServer();
    const noUrl = await t.api("POST", "/api/search/providers", { adapter: "searxng", name: "S" });
    expect(noUrl.body.details.fields.map((f: any) => f.path)).toContain("baseUrl");
    const ftp = await t.api("POST", "/api/search/providers", { adapter: "searxng", name: "S", baseUrl: "ftp://x" });
    expect(ftp.status).toBe(400);
    const creds = await t.api("POST", "/api/search/providers", { adapter: "searxng", name: "S", baseUrl: "http://user:pw@searxng:8080" });
    expect(creds.status).toBe(400);
    const meta = await t.api("POST", "/api/search/providers", { adapter: "searxng", name: "S", baseUrl: "http://169.254.169.254" });
    expect(meta.status).toBe(400);
    expect(meta.body.details.fields[0].path).toBe("baseUrl");
    const brave = await t.api("POST", "/api/search/providers", { adapter: "brave", name: "B", apiKey: "k", storage: { policy: "ttl", ttlSeconds: 60 } });
    expect(brave.status).toBe(400);
    expect(brave.body.details.fields[0].path).toBe("storage.policy");
    const mojeek = await t.api("POST", "/api/search/providers", { adapter: "mojeek", name: "M", apiKey: "k", storage: { policy: "ttl", ttlSeconds: 7200 } });
    expect(mojeek.status).toBe(400);
    expect(mojeek.body.details.fields[0].path).toBe("storage.ttlSeconds");
    const okM = await t.api("POST", "/api/search/providers", { adapter: "mojeek", name: "M", apiKey: "k" });
    expect(okM.status).toBe(201);
    expect(okM.body.storage).toMatchObject({ policy: "ttl", ttlSeconds: 3600, maxTtlSeconds: 3600 });
    const self = await t.api("PATCH", `/api/search/providers/${okM.body.id}`, { fallbackProviderId: okM.body.id });
    expect(self.body.details.fields[0].path).toBe("fallbackProviderId");
    const range = await t.api("PATCH", `/api/search/providers/${okM.body.id}`, { timeoutMs: 10 });
    expect(range.status).toBe(400);
    const unknown = await t.api("PATCH", `/api/search/providers/${okM.body.id}`, { nonsense: 1 });
    expect(unknown.status).toBe(400);
    expect((await t.api("PATCH", "/api/search/providers/prv_missing", { name: "x" })).status).toBe(404);
  });

  it("the test button reports latency, auth failures and the SearXNG JSON setup error, and counts as a request", async () => {
    const searx = await startFake("searxng", results(4));
    const t = await startOnlineServer();
    const p = await addProvider(t, searx);
    const ok = await t.api("POST", `/api/search/providers/${p.id}/test`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, resultCount: expect.any(Number) });
    expect(ok.body.latencyMs).toBeGreaterThanOrEqual(0);
    searx.override = { status: 403, body: "<html>no</html>", contentType: "text/html" };
    const setup = await t.api("POST", `/api/search/providers/${p.id}/test`);
    expect(setup.body).toMatchObject({ ok: false, errorCode: "bad_request" });
    expect(setup.body.message).toMatch(/search\.formats/);
    searx.override = undefined;
    const bravo = await startFake("brave", results(2));
    const b = await addProvider(t, bravo);
    await t.api("PATCH", `/api/search/providers/${b.id}`, { apiKey: "wrong" });
    const auth = await t.api("POST", `/api/search/providers/${b.id}/test`);
    expect(auth.body).toMatchObject({ ok: false, errorCode: "auth" });
    const usage = await t.api("GET", `/api/search/providers/${p.id}/usage`);
    expect(usage.body.month.requests).toBe(2);
    expect(usage.body.history[0]).toMatchObject({ requests: 2 });
    const after = await t.api("GET", `/api/search/providers/${b.id}`);
    expect(after.body.health).toMatchObject({ state: "down", lastErrorCode: "auth" });
    // Forced offline: the test is refused and makes no request.
    await t.api("POST", "/api/system/connectivity", { forceOffline: true });
    const n = searx.requests.length;
    const off = await t.api("POST", `/api/search/providers/${p.id}/test`);
    expect(off.status).toBe(409);
    expect(searx.requests.length).toBe(n);
  });

  it("orders providers by priority and the provider's own host is the only private address it may reach", async () => {
    const a = await startFake("searxng", results(1));
    const t = await startOnlineServer();
    const p1 = await addProvider(t, a, { name: "Second", priority: 5 });
    const p2 = await addProvider(t, a, { name: "First", priority: 1 });
    const list = await t.api("GET", "/api/search/providers");
    expect(list.body.items.map((x: any) => x.name)).toEqual(["First", "Second"]);
    expect(p1.id).not.toBe(p2.id);
    // A redirect from the provider to another private host is refused by the guard.
    const other = await startFake("searxng", results(1));
    a.override = { status: 302, headers: { location: `${other.url}/search?format=json&q=x` }, body: "" };
    const test = await t.api("POST", `/api/search/providers/${p1.id}/test`);
    expect(test.body.ok).toBe(false);
    expect(other.requests.length).toBe(0);
  });
});
