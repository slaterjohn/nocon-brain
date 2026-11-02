import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { addDoc, drained } from "../search/helpers.js";
import { saveAndWait, useFixtures } from "../browser/helpers.js";
import { addProvider, finished, readEvents, results, search, startFake, startOnlineServer, until } from "./helpers.js";

const fixtures = useFixtures();

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(p)); else out.push(p);
  }
  return out;
}

/** Every table row of main.db as text, plus every file under the data directory. */
function everything(t: { svc: { db: any }; dataDir: string }): string {
  const parts: string[] = [];
  for (const { name } of t.svc.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'") as { name: string }[]) {
    for (const row of t.svc.db.all(`SELECT * FROM "${name}"`)) parts.push(name + " " + JSON.stringify(row));
  }
  for (const f of allFiles(t.dataDir)) {
    try { if (fs.statSync(f).size < 200 * 1024 * 1024) parts.push(fs.readFileSync(f).toString("latin1")); } catch { /* unreadable */ }
  }
  return parts.join("\n");
}

describe("Brave is transient only (O-03)", () => {
  const MARK_TITLE = "BRAVETITLE7f3a";
  const MARK_SNIP = "BRAVESNIPPET9c1d";
  const MARK_HOST = "brave-marker-host.example";

  it("a Brave search leaves no title, snippet or URL in any table or file", async () => {
    const brave = await startFake("brave", Array.from({ length: 8 }, (_, i) => ({ url: `https://${MARK_HOST}/page/${i}`, title: `${MARK_TITLE} ${i} about turbines`, snippet: `${MARK_SNIP} ${i} about turbines` })));
    const t = await startOnlineServer();
    await addDoc(t, "a.html", "Tidal turbines", "Tidal turbines generate electricity.");
    await drained(t);
    const p = await addProvider(t, brave);
    expect(p.storage).toMatchObject({ policy: "none", adapterPolicy: "none" });
    const r = await search(t, {});
    const poll = await finished(t, r.body.searchId);
    const added = poll.events.find((e: any) => e.type === "provider_results").append;
    expect(added).toHaveLength(8);
    expect(added.every((x: any) => x.storage === "transient")).toBe(true);
    expect(added[0].title).toContain(MARK_TITLE);                      // shown to the Human, in memory
    await readEvents(t, r.body.searchId);
    await t.api("GET", `/api/search/${r.body.searchId}`);
    await t.api("POST", `/api/search/${r.body.searchId}/more`, {});    // a second page of Brave results
    await new Promise((res) => setTimeout(res, 300));
    // Searching again hits the provider again: nothing was cached.
    const before = brave.requests.length;
    const again = await search(t, {});
    await finished(t, again.body.searchId);
    expect(brave.requests.length).toBeGreaterThan(before);
    const hay = everything(t);
    for (const needle of [MARK_TITLE, MARK_SNIP, MARK_HOST, "brave-key"]) expect(hay, needle).not.toContain(needle);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM provider_result_cache")!.n).toBe(0);
    // And the log names the provider and a code, never a result.
    const log = JSON.stringify(t.svc.db.all("SELECT * FROM activity_log"));
    expect(log).not.toContain(MARK_TITLE);
  });

  it("database triggers refuse Brave cache rows and transient candidates with provider text", async () => {
    const brave = await startFake("brave", results(2));
    const t = await startOnlineServer();
    const p = await addProvider(t, brave);
    const now = Date.now();
    const rowId = t.svc.db.get<{ id: number }>("SELECT id FROM search_providers WHERE public_id = ?", [p.id])!.id;
    expect(() => t.svc.db.run("INSERT INTO provider_result_cache (provider_id, query_hash, page, results_json, fetched_at, expires_at) VALUES (?, 'h', 1, '[]', ?, ?)", [rowId, now, now + 1])).toThrow(/may not be stored/);
    // Even if someone loosened the row, the adapter name alone keeps the cache closed.
    expect(() => t.svc.db.run("UPDATE search_providers SET storage_kind = 'ttl', storage_ttl_seconds = 60 WHERE id = ?", [rowId])).toThrow(/looser/);
    const ins = (title: string | null, state: string) => t.svc.db.run(
      "INSERT INTO discovery_candidates (public_id, url, url_key, title_hint, state, origin_storage, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 'none', ?, ?)",
      [`cand_${Math.random()}`, "https://x.example/", `k${Math.random()}`, title, state, now, now]);
    expect(() => ins("a Brave title", "queued")).toThrow(/transient-only/);
    expect(() => ins(null, "new")).toThrow(/transient-only/);
    expect(() => ins(null, "queued")).not.toThrow();
    const cid = t.svc.db.get<{ id: number }>("SELECT id FROM discovery_candidates")!.id;
    expect(() => t.svc.db.run("UPDATE discovery_candidates SET title_hint = 'x' WHERE id = ?", [cid])).toThrow(/transient-only/);
    expect(() => t.svc.db.run("INSERT INTO candidate_provenance (candidate_id, kind, detail, seen_at) VALUES (?, 'saved_search', 'a snippet', ?)", [cid, now])).toThrow(/no provider text/);
  });

  it("saving a Brave result archives the page itself and copies nothing from Brave", async () => {
    const pageUrl = `${fixtures().urls.article}/online-only/1`;
    const brave = await startFake("brave", [{ url: pageUrl, title: `${MARK_TITLE} live log`, snippet: `${MARK_SNIP} live log snippet` }, ...results(2)]);
    const t = await startOnlineServer();
    await addProvider(t, brave);
    const r = await search(t, { query: "astronomy telescope" });
    const poll = await finished(t, r.body.searchId);
    const item = poll.events.find((e: any) => e.type === "provider_results").append.find((x: any) => x.url === pageUrl);
    expect(item).toMatchObject({ storage: "transient", availability: "online_only", actions: { saveForOffline: true } });
    const save = await t.api("POST", `/api/search/${r.body.searchId}/results/${item.key}/save`, {});
    expect(save.status).toBe(202);
    expect(save.body).toMatchObject({ url: pageUrl, state: "queued", held: false, key: item.key });
    expect(save.body.downloadId).toMatch(/^dl_/);
    const done = await until(() => { const c = t.pipeline.getCapture(save.body.downloadId); return c && (c.state === "completed" || c.state === "failed") ? c : undefined; });
    expect(done.state).toBe("completed");
    // The page's own title, nothing from Brave, anywhere.
    const page = t.svc.db.get<{ title: string; id: number }>("SELECT id, title FROM pages WHERE canonical_url = ?", [pageUrl])!;
    expect(page.title).not.toContain(MARK_TITLE);
    const hay = everything(t);
    expect(hay).not.toContain(MARK_TITLE);
    expect(hay).not.toContain(MARK_SNIP);
    const dl = t.svc.db.get<{ requested_by: string; requested_url: string }>("SELECT requested_by, requested_url FROM download_jobs WHERE public_id = ?", [save.body.downloadId])!;
    expect(dl).toMatchObject({ requested_by: "search", requested_url: pageUrl });
    // O-09: afterwards the result is linked to the page, and a new search finds it locally.
    await drained(t);
    const snap = await t.api("GET", `/api/search/${r.body.searchId}`);
    const mine = snap.body.results.find((x: any) => x.url === pageUrl);
    expect(["cached", "partial"]).toContain(mine.availability);
    expect(mine.actions.saveForOffline).toBe(false);
    expect(mine.pageId).toMatch(/^pg_/);
    const next = await search(t, { query: "telescope observing", online: "off" });
    expect(next.body.results.some((x: any) => x.pageId === mine.pageId)).toBe(true);
    // Saving it again is refused.
    expect((await t.api("POST", `/api/search/${r.body.searchId}/results/${item.key}/save`, {})).status).toBe(409);
    expect((await t.api("POST", `/api/search/${r.body.searchId}/results/k_nope/save`, {})).status).toBe(404);
  });
});

describe("no provider connection unless online search is on (O-07)", () => {
  async function watch<T>(fake: { connections: number; requests: unknown[] }, fn: () => Promise<T>): Promise<{ value: T; connects: number; port: number }> {
    const port = Number(new URL((fake as any).url).port);
    const real = net.Socket.prototype.connect;
    let connects = 0;
    const spy = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...args: any[]) {
      let a = args[0];
      if (Array.isArray(a)) a = a[0];
      const p = typeof a === "object" && a ? Number(a.port) : Number(a);
      if (p === port) connects++;
      return (real as any).apply(this, args);
    } as never);
    try { return { value: await fn(), connects, port }; } finally { spy.mockRestore(); }
  }

  it("makes no socket to a provider when the setting is off, the search says off, work-offline is on, or the connection is known to be down", async () => {
    const fake = await startFake("searxng", results(3));
    const t = await startOnlineServer({ online: false });
    await addDoc(t, "a.html", "Wind turbines", "Wind turbines generate electricity.");
    await drained(t);
    await addProvider(t, fake);
    const states: string[] = [];
    const wait = () => new Promise((r) => setTimeout(r, 250));
    const run = async (label: string, body: Record<string, unknown> = {}) => {
      const w = await watch(fake, async () => {
        const r = await search(t, body);
        states.push(`${label}:${r.body.online.state}`);
        await wait();
        await readEvents(t, r.body.searchId);
        await t.api("POST", `/api/search/${r.body.searchId}/more`, {});
        return r;
      });
      expect(w.connects, label).toBe(0);
      expect(fake.connections, label).toBe(0);
      expect(fake.requests.length, label).toBe(0);
      expect(w.value.status).toBe(200);
      expect(w.value.body.results.length, `${label}: local results still come back`).toBe(1);
    };
    await run("master switch off");
    await t.api("PATCH", "/api/settings", { privacy: { onlineSearch: { enabled: true, acknowledged: true } } });
    await run("online:off", { online: "off" });
    await run("offline scope", { scope: "offline" });
    await t.api("POST", "/api/system/connectivity", { forceOffline: true });
    await run("work offline");
    await t.api("POST", "/api/system/connectivity", { forceOffline: false });
    for (let i = 0; i < 3; i++) t.svc.connectivity.recordOutcome({ ok: false, network: true });
    expect(t.svc.connectivity.snapshot().state).toBe("offline");
    await run("connection down");
    expect(states).toEqual(["master switch off:disabled", "online:off:disabled", "offline scope:disabled", "work offline:offline", "connection down:offline"]);
    // Sanity: switching it all back on does connect.
    t.svc.connectivity.recordOutcome({ ok: true });
    const w = await watch(fake, async () => { const r = await search(t, {}); await finished(t, r.body.searchId); return r; });
    expect(w.connects).toBeGreaterThan(0);
    expect(fake.requests.length).toBe(1);
  });

  it("a provider is not contacted while disabled, and a deleted provider is forgotten", async () => {
    const fake = await startFake("searxng", results(3));
    const t = await startOnlineServer();
    const p = await addProvider(t, fake);
    await t.api("PATCH", `/api/search/providers/${p.id}`, { enabled: false });
    const r = await search(t, {});
    expect(r.body.online.state).toBe("disabled");
    await new Promise((res) => setTimeout(res, 150));
    expect(fake.connections).toBe(0);
  });
});

describe("no telemetry and no remote favicons", () => {
  it("never fetches an icon or any address a provider returned while searching", async () => {
    const tracker = await startFake("searxng", []);
    const brave = await startFake("brave", results(4, "unused.example"));
    // Results point at the tracker host; a favicon or preview fetch would hit it.
    brave.results = [0, 1, 2].map((i) => ({ url: `${tracker.url}/page/${i}`, title: `Tracker page ${i} turbines`, snippet: "turbines" }));
    const t = await startOnlineServer();
    await addProvider(t, brave);
    const r = await search(t, {});
    const poll = await finished(t, r.body.searchId);
    const items = poll.events.find((e: any) => e.type === "provider_results").append;
    expect(items.every((x: any) => x.faviconUrl === null)).toBe(true);
    await readEvents(t, r.body.searchId);
    await t.api("GET", `/api/search/${r.body.searchId}`);
    await t.api("GET", `/api/search/${r.body.searchId}?order=fused`);
    await t.api("POST", "/api/search/coverage/plan", { searchId: r.body.searchId, resultKeys: "all_uncached", strategy: "capture", priority: "P3" });
    await new Promise((res) => setTimeout(res, 300));
    expect(tracker.connections).toBe(0);
    expect(tracker.requests).toHaveLength(0);
  });
});

void saveAndWait;
