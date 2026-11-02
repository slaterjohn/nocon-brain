import { describe, expect, it } from "vitest";
import { addDoc, drained } from "../search/helpers.js";
import { useFixtures } from "../browser/helpers.js";
import { addProvider, finished, readEvents, results, search, startFake, startOnlineServer } from "./helpers.js";

const fixtures = useFixtures();
const errors = (poll: any) => poll.events.filter((e: any) => e.type === "provider_error");

/** A server with one local page so "local results always render" can be checked in every case. */
async function withLocal(opts: Parameters<typeof startOnlineServer>[0] = {}) {
  const t = await startOnlineServer(opts);
  await addDoc(t, "a.html", "Tidal turbines", "Tidal turbines generate electricity from the sea.");
  await drained(t);
  return t;
}

describe("provider failure modes (O-10 server side)", () => {
  it("timeout: reported per provider with its code; local results unaffected; the run ends", async () => {
    const fake = await startFake("searxng", results(3));
    fake.delayMs = 1500;
    const t = await withLocal();
    await addProvider(t, fake, { timeoutMs: 500 });
    const r = await search(t, {});
    expect(r.body.results).toHaveLength(1);
    const poll = await finished(t, r.body.searchId);
    expect(errors(poll)).toHaveLength(1);
    expect(errors(poll)[0]).toMatchObject({ code: "timeout" });
    expect(poll.events.at(-1)).toMatchObject({ type: "done", reason: "all_providers_answered" });
    expect(poll.online.providers[0]).toMatchObject({ state: "error", error: { code: "timeout" } });
    expect(fake.requests.length).toBe(1);               // a timeout is not retried
  });

  it("429: code rate_limited with retryAfterMs, the circuit opens, and no request goes out while it is open", async () => {
    const fake = await startFake("brave", results(3));
    fake.override = { status: 429, headers: { "retry-after": "30" } };
    const t = await withLocal();
    const p = await addProvider(t, fake);
    const first = await search(t, {});
    const poll = await finished(t, first.body.searchId);
    expect(errors(poll)[0]).toMatchObject({ code: "rate_limited", retryAfterMs: 30_000 });
    expect(fake.requests.length).toBe(1);
    const prov = await t.api("GET", `/api/search/providers/${p.id}`);
    expect(prov.body.health).toMatchObject({ state: "degraded", lastErrorCode: "rate_limited" });
    expect(prov.body.health.circuitOpenUntil).toBeTruthy();
    const second = await search(t, {});
    const poll2 = await finished(t, second.body.searchId);
    expect(errors(poll2)[0]).toMatchObject({ code: "rate_limited" });
    expect(errors(poll2)[0].retryAfterMs).toBeGreaterThan(0);
    expect(fake.requests.length).toBe(1);               // still one: the circuit held
    // After Retry-After the circuit closes and the next search is let through.
    fake.override = undefined;
    t.fake.advance(31_000);
    const third = await search(t, {});
    const poll3 = await finished(t, third.body.searchId);
    expect(errors(poll3)).toHaveLength(0);
    expect(fake.requests.length).toBe(2);
  });

  it("auth failure: code auth, no retry, provider marked down", async () => {
    const fake = await startFake("brave", results(3));
    const t = await withLocal();
    const p = await addProvider(t, fake, { apiKey: "the-wrong-key" });
    const r = await search(t, {});
    const poll = await finished(t, r.body.searchId);
    expect(errors(poll)[0]).toMatchObject({ code: "auth" });
    expect(fake.requests.length).toBe(1);
    expect((await t.api("GET", `/api/search/providers/${p.id}`)).body.health).toMatchObject({ state: "down", lastErrorCode: "auth" });
    expect(JSON.stringify(poll)).not.toContain("the-wrong-key");
  });

  it("malformed JSON and an unexpected body: bad_request, no crash, the other provider still answers", async () => {
    const bad = await startFake("searxng", results(3));
    bad.override = { status: 200, body: '{"results": [ {"title": "truncated", "url": ' };
    const good = await startFake("mojeek", results(3, "good.example"));
    const t = await withLocal();
    await addProvider(t, bad, { name: "Bad", priority: 1 });
    await addProvider(t, good, { name: "Good", priority: 2 });
    const r = await search(t, {});
    const poll = await finished(t, r.body.searchId);
    expect(errors(poll)).toHaveLength(1);
    expect(errors(poll)[0]).toMatchObject({ code: "bad_request" });
    const ok = poll.events.find((e: any) => e.type === "provider_results");
    expect(ok.append).toHaveLength(3);
    expect(poll.online.providers.map((x: any) => x.state)).toEqual(["error", "ok"]);
    // A JSON value that is not an object, and an object without results.
    bad.override = { status: 200, body: "[1,2,3]" };
    const r2 = await search(t, {});
    expect(errors(await finished(t, r2.body.searchId))[0]).toMatchObject({ code: "upstream" });
    bad.override = { status: 200, body: "{}" };
    const r3 = await search(t, {});
    expect(errors(await finished(t, r3.body.searchId))[0]).toMatchObject({ code: "upstream" });
  });

  it("a 5xx is retried once and then reported; one retry that works is invisible", async () => {
    const fake = await startFake("searxng", results(2));
    const t = await withLocal();
    await addProvider(t, fake);
    fake.failTimes = 1;
    const r = await search(t, {});
    const poll = await finished(t, r.body.searchId);
    expect(errors(poll)).toHaveLength(0);
    expect(fake.requests.length).toBe(2);
    fake.requests.length = 0;
    fake.override = { status: 503, body: "down", contentType: "text/plain" };
    const r2 = await search(t, {});
    const poll2 = await finished(t, r2.body.searchId);
    expect(errors(poll2)[0]).toMatchObject({ code: "upstream" });
    expect(fake.requests.length).toBe(2);
  });

  it("a dropped connection is a network error", async () => {
    const fake = await startFake("searxng", results(2));
    fake.hangUp = true;
    const t = await withLocal();
    await addProvider(t, fake);
    const r = await search(t, {});
    const poll = await finished(t, r.body.searchId);
    expect(errors(poll)[0]).toMatchObject({ code: "network" });
    expect(r.body.results).toHaveLength(1);
  });

  it("one of two providers failing: the other's results arrive and the failure is shown for the first only", async () => {
    const down = await startFake("searxng", results(2));
    down.override = { status: 500, body: "x", contentType: "text/plain" };
    const up = await startFake("mojeek", results(5, "up.example"));
    const t = await withLocal();
    const a = await addProvider(t, down, { name: "Down", priority: 1 });
    const b = await addProvider(t, up, { name: "Up", priority: 2 });
    const r = await search(t, {});
    const poll = await finished(t, r.body.searchId);
    expect(errors(poll).map((e: any) => [e.providerId, e.code])).toEqual([[a.id, "upstream"]]);
    expect(poll.events.filter((e: any) => e.type === "provider_results").map((e: any) => e.providerId)).toEqual([b.id]);
    const snap = await t.api("GET", `/api/search/${r.body.searchId}`);
    expect(snap.body.results).toHaveLength(6);
  });

  it("the fallback provider is used when the primary errors, and its results are attributed to it", async () => {
    const primary = await startFake("brave", results(3));
    primary.override = { status: 500, body: "x", contentType: "text/plain" };
    const backup = await startFake("searxng", results(4, "backup.example"));
    const t = await withLocal();
    const fb = await addProvider(t, backup, { name: "Backup", priority: 9, enabled: true });
    // The fallback is also listed as a normal provider, so disable it and keep it only as a fallback.
    await t.api("PATCH", `/api/search/providers/${fb.id}`, { enabled: false });
    const main = await addProvider(t, primary, { name: "Primary", priority: 1, fallbackProviderId: fb.id });
    await t.api("PATCH", `/api/search/providers/${fb.id}`, { enabled: true });
    await t.api("PATCH", `/api/search/providers/${fb.id}`, { priority: 1 });
    // Run only the primary: the fallback is still allowed to answer for it.
    const r = await search(t, { providers: [main.id] });
    const poll = await finished(t, r.body.searchId);
    const types = poll.events.map((e: any) => e.type);
    expect(types).toEqual(["provider_started", "provider_error", "coverage", "provider_started", "provider_results", "coverage", "done"]);
    const err = poll.events.find((e: any) => e.type === "provider_error");
    expect(err).toMatchObject({ providerId: main.id, code: "upstream", fallbackProviderId: fb.id });
    const started = poll.events.filter((e: any) => e.type === "provider_started");
    expect(started[1]).toMatchObject({ providerId: fb.id, fallbackFor: main.id });
    expect(poll.events.find((e: any) => e.type === "provider_results").append[0].attribution[0]).toMatchObject({ id: fb.id });
  });

  it("a monthly cap blocks further requests and shows quota_exhausted without calling out", async () => {
    const fake = await startFake("searxng", results(2));
    const t = await withLocal();
    await addProvider(t, fake, { monthlyCap: 1 });
    const a = await search(t, {});
    expect(errors(await finished(t, a.body.searchId))).toHaveLength(0);
    const b = await search(t, {});
    const poll = await finished(t, b.body.searchId);
    expect(errors(poll)[0]).toMatchObject({ code: "quota_exhausted" });
    expect(fake.requests.length).toBe(1);
  });

  it("the server-side deadline ends a run whose providers are still waiting", async () => {
    const slow = await startFake("searxng", results(2));
    slow.delayMs = 3000;
    const t = await withLocal();
    await t.api("PATCH", "/api/settings", { search: { onlineDeadlineMs: 1000 } });
    await addProvider(t, slow, { timeoutMs: 10_000 });
    const r = await search(t, {});
    const poll = await finished(t, r.body.searchId);
    expect(poll.events.at(-1)).toMatchObject({ type: "done", reason: "deadline" });
    expect(errors(poll)).toHaveLength(1);
  });
});

describe("unsafe provider content (O-10, XSS payloads)", () => {
  it("scripts, event handlers, javascript:/data: URLs and entity-encoded markup never reach a client as markup", async () => {
    const fake = await startFake("searxng", [
      { url: "https://ok.example/1", title: `<script>alert("t1")</script>Totally <b>normal</b> result`, snippet: `<img src=x onerror=alert("s1")> click <b onmouseover=alert(1)>here</b> turbines` },
      { url: "javascript:alert('u')", title: "JS URL", snippet: "x" },
      { url: "data:text/html,<script>alert(1)</script>", title: "Data URL", snippet: "x" },
      { url: "vbscript:msgbox(1)", title: "VB URL", snippet: "x" },
      { url: "//protocol-relative.example/x", title: "Relative", snippet: "x" },
      { url: "https://user:secret@creds.example/", title: "Creds", snippet: "x" },
      { url: "https://ok.example/2", title: "&lt;svg onload=alert(2)&gt;Entity title", snippet: "&lt;iframe src=//evil.invalid&gt;&lt;/iframe&gt; turbines &amp;lt;b&amp;gt;" },
      { url: "https://ok.example/3", title: "<<script>script>alert(3)<</script>/script>Nested", snippet: "plain turbines" },
    ]);
    const t = await withLocal();
    await addProvider(t, fake);
    const r = await search(t, {});
    const sse = await readEvents(t, r.body.searchId);
    const ev = sse.events.find((e) => e.type === "provider_results");
    expect(ev.dropped).toBe(5);
    expect(ev.append.map((x: any) => x.url)).toEqual(["https://ok.example/1", "https://ok.example/2", "https://ok.example/3"]);
    const check = (x: any) => {
      for (const f of ["title", "titleHtml", "snippet"] as const) {
        const html = String(x[f] ?? "");
        // The only markup allowed is <mark>.
        expect(html.replace(/<\/?mark>/g, ""), f).not.toMatch(/<|>/);
        expect(html, f).not.toMatch(/onerror|onload|onmouseover=<|<script|<img|<svg|<iframe/i);
      }
      expect(x.title).not.toMatch(/[<>]/);
    };
    for (const x of ev.append) check(x);
    const snap = await t.api("GET", `/api/search/${r.body.searchId}`);
    for (const x of snap.body.results) check(x);
    expect(ev.append[0].title).toBe("Totally normal result");
    expect(ev.append[0].titleHtml).toBe("Totally normal result");
    expect(ev.append[0].snippet).toContain("<mark>turbines</mark>");
    const raw = JSON.stringify(sse.events);
    expect(raw).not.toContain("javascript:");
    expect(raw).not.toContain("secret@");
    expect(raw).not.toMatch(/<script|<img|<svg|<iframe/i);
  });

  it("the fixture providers' XSS mode is neutralised in the same way", async () => {
    const base = fixtures().urls.searxng;
    await fetch(`${base}/__control?mode=xss`);
    const t = await withLocal();
    const p = await addProvider(t, { kind: "searxng", url: base, host: "", requests: [], connections: 0 } as never);
    const r = await search(t, { query: "astronomy" });
    const poll = await finished(t, r.body.searchId);
    await fetch(`${base}/__control?reset=1`);
    const ev = poll.events.find((e: any) => e.type === "provider_results");
    expect(ev.dropped).toBeGreaterThanOrEqual(2);       // javascript: and data: URLs
    for (const x of ev.append) {
      expect(x.title).not.toMatch(/[<>]/);
      expect(String(x.snippet).replace(/<\/?mark>/g, "")).not.toMatch(/[<>]/);
      expect(x.url).toMatch(/^https?:\/\//);
    }
    expect(p.id).toBeTruthy();
  });
});

describe("offline behaviour (O-10)", () => {
  it("a provider that was fine becomes unreachable: local results still render and the error is a network code", async () => {
    const fake = await startFake("searxng", results(2));
    const t = await withLocal();
    await addProvider(t, fake);
    await fake.close();
    const r = await search(t, {});
    expect(r.body.results).toHaveLength(1);
    const poll = await finished(t, r.body.searchId);
    expect(errors(poll)[0]).toMatchObject({ code: "network" });
  });

  it("forced offline answers with state offline and a single done event", async () => {
    const fake = await startFake("searxng", results(2));
    const t = await withLocal();
    await addProvider(t, fake);
    await t.api("POST", "/api/system/connectivity", { forceOffline: true });
    const r = await search(t, {});
    expect(r.body).toMatchObject({ online: { state: "offline", pending: [] } });
    expect(r.body.results).toHaveLength(1);
    const sse = await readEvents(t, r.body.searchId);
    expect(sse.events.map((e) => [e.type, e.reason])).toEqual([["done", "no_providers"]]);
    expect((await t.api("POST", `/api/search/${r.body.searchId}/more`, {})).status).toBe(409);
    expect(fake.connections).toBe(0);
  });
});
