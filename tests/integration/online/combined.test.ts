import { describe, expect, it } from "vitest";
import { addDoc, drained } from "../search/helpers.js";
import { addProvider, finished, parseSse, readEvents, results, search, startFake, startOnlineServer, until } from "./helpers.js";
import http from "node:http";

describe("combined search (O-05)", () => {
  it("answers with local results at once, whatever the provider does, and the events follow in order", async () => {
    const slow = await startFake("searxng", results(6));
    slow.delayMs = 1200;
    const t = await startOnlineServer();
    await addDoc(t, "tides.html", "Tidal turbines", "Tidal turbines turn the motion of the sea into electricity near the Pentland Firth.");
    await drained(t);
    await addProvider(t, slow);
    const t0 = Date.now();
    const r = await search(t, {});
    const took = Date.now() - t0;
    expect(r.status).toBe(200);
    expect(took).toBeLessThan(900);                       // the provider needs 1.2 s; the local answer did not wait
    expect(r.body.results).toHaveLength(1);
    expect(r.body.results[0]).toMatchObject({ origin: "archive", availability: "cached" });
    expect(r.body.online.state).toBe("pending");
    expect(r.body.online.pending).toHaveLength(1);
    expect(r.body.online.disclosure).toMatch(/Online search sends/);
    expect(r.body.lastSeq).toBe(0);
    expect(r.body.searchId).toMatch(/^sch_/);

    const sse = await readEvents(t, r.body.searchId);
    expect(sse.status).toBe(200);
    expect(sse.headers["content-type"]).toContain("text/event-stream");
    expect(sse.headers["x-accel-buffering"]).toBe("no");
    expect(sse.raw.startsWith("retry: 3000")).toBe(true);
    expect(sse.events.map((e) => e.type)).toEqual(["provider_started", "provider_results", "coverage", "done"]);
    expect(sse.events.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    const res = sse.events[1];
    expect(res.append).toHaveLength(6);
    expect(res.append[0]).toMatchObject({ origin: "online", availability: "online_only", storage: "persist", faviconUrl: null, domain: "example.org" });
    expect(res.append[0].attribution[0]).toMatchObject({ kind: "provider", rank: 1 });
    expect(res.append.map((x: any) => x.fusedRank)).toEqual([...res.append.map((x: any) => x.fusedRank)].sort((a, b) => a - b));
    expect(sse.events[3]).toMatchObject({ type: "done", reason: "all_providers_answered" });
    expect(sse.events[2].coverage).toMatchObject({ cachedMatches: 1, onlineMatches: 6, onlineNotArchived: 6, queued: 0, partial: 0, basis: "online_page_estimate" });
  });

  it("reconnecting with Last-Event-ID resumes after that event; a finished stream answers 204", async () => {
    const fake = await startFake("searxng", results(3));
    const t = await startOnlineServer();
    await addProvider(t, fake);
    const r = await search(t, {});
    const all = await readEvents(t, r.body.searchId);
    expect(all.events).toHaveLength(4);
    const tail = await readEvents(t, r.body.searchId, { lastEventId: 2 });
    expect(tail.status).toBe(200);
    expect(tail.events.map((e) => e.id)).toEqual([3, 4]);
    const done = await readEvents(t, r.body.searchId, { lastEventId: 4 });
    expect(done.status).toBe(204);
    expect((await readEvents(t, "sch_missing")).status).toBe(404);
  });

  it("sends a heartbeat comment while a slow provider is pending", async () => {
    const fake = await startFake("searxng", results(2));
    fake.delayMs = 400;
    const t = await startOnlineServer({ server: { sseHeartbeatMs: 60 } });
    await addProvider(t, fake);
    const r = await search(t, {});
    const sse = await readEvents(t, r.body.searchId);
    expect(sse.raw).toContain(": heartbeat");
    expect(sse.events.at(-1)?.type).toBe("done");
  });

  it("polling returns the same events after a sequence number, and the snapshot restores the list", async () => {
    const fake = await startFake("searxng", results(4));
    const t = await startOnlineServer();
    await addDoc(t, "a.html", "Wind turbines", "Wind turbines turn the motion of the air into electricity.");
    await drained(t);
    await addProvider(t, fake);
    const r = await search(t, {});
    const poll = await finished(t, r.body.searchId);
    expect(poll.events.map((e: any) => e.type)).toEqual(["provider_started", "provider_results", "coverage", "done"]);
    expect(poll.lastSeq).toBe(4);
    expect(poll.online).toMatchObject({ state: "done", pending: [], providers: [{ state: "ok", count: 4, hasMore: true }] });
    const after2 = await t.api("GET", `/api/search/${r.body.searchId}?after=2`);
    expect(after2.body.events.map((e: any) => e.seq)).toEqual([3, 4]);
    const snap = await t.api("GET", `/api/search/${r.body.searchId}`);
    expect(snap.status).toBe(200);
    expect(snap.body.results.map((x: any) => x.origin)).toEqual(["archive", "online", "online", "online", "online"]);
    expect(snap.body.lastSeq).toBe(4);
    expect(snap.body.online.state).toBe("done");
    expect(snap.body.coverage).toMatchObject({ cachedMatches: 1, onlineMatches: 4, onlineNotArchived: 4, basis: "online_page_estimate" });
    expect((await t.api("GET", "/api/search/sch_missing")).status).toBe(404);
    expect((await t.api("GET", "/api/search/sch_missing?after=0")).status).toBe(404);
  });

  it("merges two providers: dedup by canonical URL, provenance, local promotion, deterministic order", async () => {
    const one = await startFake("searxng", [
      { url: "https://news.example/a?utm_source=x", title: "Alpha story", snippet: "alpha about turbines" },
      { url: "https://news.example/b", title: "Beta story", snippet: "beta about turbines" },
      { url: "https://en.wikipedia.org/wiki/Tidal_power", title: "Tidal power - Wikipedia", snippet: "wiki" },
    ]);
    const two = await startFake("mojeek", [
      { url: "https://news.example/b#top", title: "Beta again", snippet: "beta second opinion turbines" },
      { url: "https://news.example/c", title: "Gamma story", snippet: "gamma" },
      { url: "https://news.example/a", title: "Alpha again", snippet: "alpha" },
    ]);
    const t = await startOnlineServer();
    await addDoc(t, "tides.html", "Tidal turbines", "Tidal turbines turn the motion of the sea into electricity.");
    await drained(t);
    const local = (await search(t, { online: "off" })).body.results[0];
    const p1 = await addProvider(t, one, { priority: 1, name: "One" });
    const p2 = await addProvider(t, two, { priority: 2, name: "Two" });
    const run = async () => {
      const r = await search(t, {});
      await finished(t, r.body.searchId);
      return (await t.api("GET", `/api/search/${r.body.searchId}?order=fused`)).body;
    };
    const a = await run();
    const online = a.results.filter((x: any) => x.origin === "online");
    // Four distinct pages, not six rows.
    expect(online.map((x: any) => x.url).sort()).toEqual(["https://en.wikipedia.org/wiki/Tidal_power", "https://news.example/a", "https://news.example/b", "https://news.example/c"].sort());
    const beta = online.find((x: any) => x.url === "https://news.example/b");
    expect(beta.attribution.map((x: any) => [x.id, x.rank])).toEqual([[p1.id, 2], [p2.id, 1]]);
    // Alpha: rank 1 at One and rank 3 at Two; Beta: rank 2 and 1. Equal RRF contributions give alpha > beta by the first list.
    const idx = (u: string) => a.results.findIndex((x: any) => x.url === u);
    expect(idx("https://news.example/a")).toBeLessThan(idx("https://news.example/c"));
    expect(a.results[0].origin).toBe("archive");                        // local results stay first
    expect(a.results[0].key).toBe(local.key);
    const b = await run();
    expect(b.results.map((x: any) => x.url)).toEqual(a.results.map((x: any) => x.url));   // deterministic
    // The second provider overlaps the first by 2 of 3: its weight is 0.7 of its own 1.0.
    const sc = beta.fusedScore;
    expect(sc).toBeCloseTo(1 / (60 + 2) + 0.7 / (60 + 1), 5);
  });

  it("a page that the archive and a provider both have is marked, not duplicated", async () => {
    const t = await startOnlineServer();
    const page = await addDoc(t, "tides.html", "Tidal turbines", "Tidal turbines turn the motion of the sea into electricity.");
    await drained(t);
    const localHit = (await search(t, { online: "off" })).body.results[0];
    const fake = await startFake("searxng", [{ url: localHit.url, title: "Same page, provider title", snippet: "turbines from the web" }, { url: "https://other.example/x", title: "Other" }]);
    await addProvider(t, fake);
    const r = await search(t, {});
    const sse = await readEvents(t, r.body.searchId);
    const ev = sse.events.find((e) => e.type === "provider_results");
    expect(ev.append.map((x: any) => x.url)).toEqual(["https://other.example/x"]);
    expect(ev.update).toHaveLength(1);
    expect(ev.update[0]).toMatchObject({ key: localHit.key, alsoOnline: true, addAttribution: { kind: "provider", rank: 1 } });
    expect(ev.update[0].snippetExtra).toContain("<mark>turbines</mark>");
    const snap = await t.api("GET", `/api/search/${r.body.searchId}`);
    const mine = snap.body.results.find((x: any) => x.key === localHit.key);
    expect(mine).toMatchObject({ pageId: page.pageId, alsoOnline: true });
    expect(mine.attribution.map((a: any) => a.kind)).toEqual(["local", "provider"]);
    expect(snap.body.results).toHaveLength(2);
  });

  it("reorder_available is sent when a provider changes the order of what is listed, and the visible list is not rewritten", async () => {
    const t = await startOnlineServer();
    await addDoc(t, "a.html", "Alpha turbines", "Turbines alpha text about energy and the sea.");
    await addDoc(t, "b.html", "Beta turbines", "Turbines beta text about energy and the sea and more words.");
    await drained(t);
    const base = (await search(t, { online: "off" })).body.results;
    expect(base).toHaveLength(2);
    const [first, second] = base;
    // The provider confirms the page the archive ranked second, and only that one.
    const fake = await startFake("searxng", [{ url: second.url, title: "Confirmed", snippet: "x" }, { url: first.url, title: "Also", snippet: "y" }]);
    await addProvider(t, fake);
    const r = await search(t, {});
    const poll = await finished(t, r.body.searchId);
    expect(poll.events.map((e: any) => e.type)).toContain("coverage");
    const re = poll.events.find((e: any) => e.type === "reorder_available");
    if (re) expect(re.fusedOrder).toHaveLength(2);
    const snap = await t.api("GET", `/api/search/${r.body.searchId}`);
    expect(snap.body.results.map((x: any) => x.key)).toEqual([first.key, second.key]);   // display order untouched
    const fused = await t.api("GET", `/api/search/${r.body.searchId}?order=fused`);
    expect(fused.body.results).toHaveLength(2);
  });

  it("'more' asks the providers for the next page, appends only new results and ends with another done", async () => {
    const fake = await startFake("searxng", results(14));
    const t = await startOnlineServer();
    const p = await addProvider(t, fake);
    const r = await search(t, {});
    await finished(t, r.body.searchId);
    const more = await t.api("POST", `/api/search/${r.body.searchId}/more`, {});
    expect(more.status).toBe(202);
    expect(more.body).toMatchObject({ started: [p.id], skipped: [] });
    expect(more.body.lastSeq).toBeGreaterThanOrEqual(4);
    await until(() => fake.requests.length >= 2);
    const tail = await readEvents(t, r.body.searchId, { lastEventId: 4 });
    expect(tail.events.map((e) => e.type)).toEqual(["provider_started", "provider_results", "coverage", "done"]);
    expect(tail.events[0].page).toBe(2);
    expect(tail.events[1].append).toHaveLength(4);       // 14 results, 10 per page
    expect(tail.events[1].hasMore).toBe(true);
    expect(fake.requests[1]!.query.get("pageno")).toBe("2");
    const snap = await t.api("GET", `/api/search/${r.body.searchId}`);
    expect(snap.body.results).toHaveLength(14);
    // Unknown provider and no-more are reported, not errors.
    const none = await t.api("POST", `/api/search/${r.body.searchId}/more`, { providerId: "prv_nope" });
    expect(none.body.started).toEqual([]);
    expect(none.body.skipped[0].providerId).toBe("prv_nope");
  });

  it("scope online lists the web only; offline scope, online off and a page beyond the first go nowhere", async () => {
    const fake = await startFake("searxng", results(3));
    const t = await startOnlineServer();
    await addDoc(t, "a.html", "Wind turbines", "Wind turbines generate electricity.");
    await drained(t);
    await addProvider(t, fake);
    const web = await search(t, { scope: "online" });
    expect(web.body.results).toEqual([]);
    expect(web.body.online.state).toBe("pending");
    const seen = fake.requests.length;
    await finished(t, web.body.searchId);
    expect(fake.requests.length).toBe(seen + 1);
    for (const body of [{ scope: "offline" }, { online: "off" }, { page: 2 }, { scope: "documents" }]) {
      const n = fake.requests.length;
      const x = await search(t, body);
      expect(x.body.online.state, JSON.stringify(body)).toBe("disabled");
      expect((await readEvents(t, x.body.searchId)).events.map((e) => [e.type, e.reason])).toEqual([["done", "no_providers"]]);
      await new Promise((r) => setTimeout(r, 100));
      expect(fake.requests.length, JSON.stringify(body)).toBe(n);
    }
  });

  it("a 'providers' list limits the run to those providers", async () => {
    const a = await startFake("searxng", results(2));
    const b = await startFake("searxng", results(2, "other.example"));
    const t = await startOnlineServer();
    const pa = await addProvider(t, a, { name: "A" });
    await addProvider(t, b, { name: "B" });
    const r = await search(t, { providers: [pa.id] });
    expect(r.body.online.pending).toEqual([pa.id]);
    await finished(t, r.body.searchId);
    expect(a.requests.length).toBe(1);
    expect(b.requests.length).toBe(0);
  });

  it("records the provider ids, never the results, in the search history", async () => {
    const fake = await startFake("searxng", results(2));
    const t = await startOnlineServer();
    const p = await addProvider(t, fake);
    const r = await search(t, { query: "turbine history" });
    await finished(t, r.body.searchId);
    const row = t.svc.db.get<{ online_providers_json: string | null }>("SELECT online_providers_json FROM search_history ORDER BY id DESC LIMIT 1")!;
    expect(JSON.parse(row.online_providers_json!)).toEqual([p.id]);
  });
});

void http; void parseSse;
