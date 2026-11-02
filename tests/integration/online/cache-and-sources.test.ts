import { describe, expect, it } from "vitest";
import { addDoc, drained } from "../search/helpers.js";
import { useFixtures } from "../browser/helpers.js";
import { addProvider, finished, results, search, startFake, startOnlineServer, until } from "./helpers.js";

const fixtures = useFixtures();

describe("Mojeek caches for its plan's time only (O-04)", () => {
  it("serves a repeat from the cache within the TTL, fetches again after it, and never stores longer than the policy", async () => {
    const fake = await startFake("mojeek", results(5));
    const t = await startOnlineServer();
    const p = await addProvider(t, fake);
    expect(p.storage).toMatchObject({ policy: "ttl", ttlSeconds: 3600, maxTtlSeconds: 3600 });
    const go = async (q = "turbines") => {
      const r = await search(t, { query: q });
      const poll = await finished(t, r.body.searchId);
      return poll.events.find((e: any) => e.type === "provider_results");
    };
    const first = await go();
    expect(first).toMatchObject({ cached: false });
    expect(fake.requests.length).toBe(1);
    const second = await go();
    expect(second).toMatchObject({ cached: true });
    expect(second.append.map((x: any) => x.url)).toEqual(first.append.map((x: any) => x.url));
    expect(fake.requests.length).toBe(1);                              // no request, and no count against the plan
    expect((await t.api("GET", `/api/search/providers/${p.id}`)).body.usage.month.requests).toBe(1);
    // Another query is a miss; the cache is per query.
    expect((await go("other words")).cached).toBe(false);
    const row = t.svc.db.get<{ fetched_at: number; expires_at: number }>("SELECT fetched_at, expires_at FROM provider_result_cache ORDER BY id LIMIT 1")!;
    expect(row.expires_at - row.fetched_at).toBe(3600_000);
    t.fake.advance(3599_000);
    expect((await go()).cached).toBe(true);
    t.fake.advance(2_000);
    const expired = await go();
    expect(expired.cached).toBe(false);
    expect(fake.requests.length).toBe(3);
    // A shorter policy applies to new rows, and tightening to "none" empties the cache.
    await t.api("PATCH", `/api/search/providers/${p.id}`, { storage: { policy: "ttl", ttlSeconds: 60 } });
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM provider_result_cache")!.n).toBe(0);
    await go("short");
    const short = t.svc.db.get<{ fetched_at: number; expires_at: number }>("SELECT fetched_at, expires_at FROM provider_result_cache")!;
    expect(short.expires_at - short.fetched_at).toBe(60_000);
    await t.api("PATCH", `/api/search/providers/${p.id}`, { storage: { policy: "none" } });
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM provider_result_cache")!.n).toBe(0);
    const n = fake.requests.length;
    await go("short");
    expect(fake.requests.length).toBe(n + 1);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM provider_result_cache")!.n).toBe(0);
  });

  it("SearXNG is not cached unless a cache time is set", async () => {
    const fake = await startFake("searxng", results(3));
    const t = await startOnlineServer();
    const p = await addProvider(t, fake);
    for (let i = 0; i < 2; i++) await finished(t, (await search(t, {})).body.searchId);
    expect(fake.requests.length).toBe(2);
    await t.api("PATCH", `/api/search/providers/${p.id}`, { storage: { policy: "unrestricted", ttlSeconds: 120 } });
    for (let i = 0; i < 2; i++) await finished(t, (await search(t, {})).body.searchId);
    expect(fake.requests.length).toBe(3);
  });
});

async function savedSource(t: any, body: Record<string, unknown> = {}, query = "turbines energy") {
  const ss = await t.api("POST", "/api/search/saved", { name: "Turbines", query, includeOnline: true });
  expect(ss.status).toBe(201);
  const src = await t.api("POST", `/api/search/saved/${ss.body.id}/source`, body);
  return { ss: ss.body, src };
}

describe("saved search as a source (O-11)", () => {
  const art = () => fixtures().urls.article;
  const pages = () => [1, 2, 3].map((i) => ({ url: `${art()}/online-only/${i}`, title: `Online only ${i} turbines`, snippet: "turbines snippet" }));

  it("downloads mode queues each new address once; a second run adds nothing", async () => {
    const fake = await startFake("searxng", pages());
    const t = await startOnlineServer();
    await addProvider(t, fake);
    const { ss, src } = await savedSource(t, { onResult: "downloads", maxResults: 10, priority: "P3" });
    expect(src.status).toBe(201);
    expect(src.body).toMatchObject({ type: "saved_search", name: "Turbines", priority: "P3", enabled: true });
    expect(ss.sourceId).toBeNull();
    const after = await t.api("GET", `/api/search/saved/${ss.id}`);
    expect(after.body.id).toBe(ss.id);
    expect(after.body.sourceId).toBe(src.body.id);
    expect((await t.api("GET", "/api/search/saved")).body.items.find((x: any) => x.id === ss.id).sourceId).toBe(src.body.id);
    expect((await t.api("POST", `/api/search/saved/${ss.id}/source`, {})).status).toBe(409);
    const run = await t.api("POST", `/api/sources/${src.body.id}/run`);
    expect(run.status).toBe(202);
    expect(run.body.downloadIds).toHaveLength(3);
    const dl = t.svc.db.all<{ requested_by: string; requested_url: string }>("SELECT requested_by, requested_url FROM download_jobs ORDER BY id");
    expect(dl.every((d) => d.requested_by === "search")).toBe(true);
    expect(dl.map((d) => d.requested_url).sort()).toEqual(pages().map((p) => p.url).sort());
    await until(() => run.body.downloadIds.every((id: string) => { const c = t.pipeline.getCapture(id); return c && (c.state === "completed" || c.state === "failed"); }), 30_000);
    const again = await t.api("POST", `/api/sources/${src.body.id}/run`);
    expect(again.body.downloadIds).toEqual([]);                      // archived already
    // Nothing the provider said is stored: the pages have their own titles.
    expect(JSON.stringify(t.svc.db.all("SELECT * FROM download_jobs"))).not.toContain("snippet");
    const status = await t.api("GET", `/api/sources/${src.body.id}`);
    expect(status.body.lastRunAt).toBeTruthy();
  });

  it("candidates mode: results become candidates with provenance; SearXNG may keep the title", async () => {
    const fake = await startFake("searxng", pages());
    const t = await startOnlineServer();
    await addProvider(t, fake);
    const { ss, src } = await savedSource(t, { onResult: "candidates", maxResults: 2 });
    const run = await t.api("POST", `/api/sources/${src.body.id}/run`);
    expect(run.status).toBe(202);
    expect(run.body.downloadIds).toEqual([]);
    const c = await t.api("GET", `/api/search/saved/${ss.id}/candidates`);
    expect(c.body.items).toHaveLength(2);
    expect(c.body.items[0]).toMatchObject({ state: "new", transient: false });
    expect(c.body.items[0].id).toMatch(/^cand_/);
    expect(c.body.items.map((i: any) => i.title).every((x: string) => /Online only/.test(x))).toBe(true);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM candidate_provenance WHERE kind = 'saved_search' AND detail IS NULL")!.n).toBe(2);
    // Approve one: it is queued as a capture; dismiss the other.
    const ap = await t.api("POST", `/api/search/saved/${ss.id}/candidates/approve`, { ids: [c.body.items[0].id] });
    expect(ap.status).toBe(202);
    expect(ap.body.queued).toBe(1);
    const dis = await t.api("POST", `/api/search/saved/${ss.id}/candidates/dismiss`, { ids: [c.body.items[1].id] });
    expect(dis.body.dismissed).toBe(1);
    const after = await t.api("GET", `/api/search/saved/${ss.id}/candidates`);
    expect(after.body.items.map((i: any) => i.state).sort()).toEqual(["dismissed", "queued"]);
    // Re-running keeps the same two rows.
    await t.api("POST", `/api/sources/${src.body.id}/run`);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM discovery_candidates")!.n).toBe(2);
  });

  it("a time-limited provider's candidates carry no title and expire with the cache time", async () => {
    const fake = await startFake("mojeek", pages());
    const t = await startOnlineServer();
    await addProvider(t, fake);
    const { ss, src } = await savedSource(t, { onResult: "candidates" });
    await t.api("POST", `/api/sources/${src.body.id}/run`);
    const rows = t.svc.db.all<{ title_hint: string | null; origin_storage: string; expires_at: number; first_seen_at: number }>("SELECT * FROM discovery_candidates");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.title_hint === null && r.origin_storage === "ttl" && r.expires_at - r.first_seen_at === 3600_000)).toBe(true);
    expect((await t.api("GET", `/api/search/saved/${ss.id}/candidates`)).body.items).toHaveLength(3);
    t.fake.advance(3601_000);
    expect((await t.api("GET", `/api/search/saved/${ss.id}/candidates`)).body.items).toHaveLength(0);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM discovery_candidates")!.n).toBe(0);
  });

  it("Brave-sourced candidates exist in memory only; the Human's approval stores the address, never a title or snippet", async () => {
    const MARK = "BRAVETEXT5521";
    const brave = await startFake("brave", [
      { url: `${art()}/online-only/1`, title: `${MARK} one`, snippet: `${MARK} snippet one` },
      { url: `${art()}/online-only/2`, title: `${MARK} two`, snippet: `${MARK} snippet two` },
    ]);
    const t = await startOnlineServer();
    await addProvider(t, brave);
    // Even "downloads" mode must wait for approval for a transient provider.
    const { ss, src } = await savedSource(t, { onResult: "downloads" });
    const run = await t.api("POST", `/api/sources/${src.body.id}/run`);
    expect(run.status).toBe(202);
    expect(run.body.downloadIds).toEqual([]);
    expect(run.body.warnings.join(" ")).toMatch(/held for approval/);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM discovery_candidates")!.n).toBe(0);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM download_jobs")!.n).toBe(0);
    const list = await t.api("GET", `/api/search/saved/${ss.id}/candidates`);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items.every((i: any) => i.transient && i.title === null && /^tmp_/.test(i.id))).toBe(true);
    const ap = await t.api("POST", `/api/search/saved/${ss.id}/candidates/approve`, { ids: [list.body.items[0].id] });
    expect(ap.body.queued).toBe(1);
    const row = t.svc.db.get<{ title_hint: string | null; origin_storage: string; state: string; url: string }>("SELECT * FROM discovery_candidates")!;
    expect(row).toMatchObject({ title_hint: null, origin_storage: "none", state: "queued" });
    expect(row.url).toBe(list.body.items[0].url);
    const left = await t.api("GET", `/api/search/saved/${ss.id}/candidates`);
    expect(left.body.items.filter((i: any) => i.transient)).toHaveLength(1);
    const hay = JSON.stringify([t.svc.db.all("SELECT * FROM discovery_candidates"), t.svc.db.all("SELECT * FROM candidate_provenance"), t.svc.db.all("SELECT * FROM download_jobs"), t.svc.db.all("SELECT * FROM sources")]);
    expect(hay).not.toContain(MARK);
    // The other one stays unsaved when dismissed.
    const dis = await t.api("POST", `/api/search/saved/${ss.id}/candidates/dismiss`, { ids: [left.body.items.find((i: any) => i.transient).id] });
    expect(dis.body.dismissed).toBe(1);
    expect((await t.api("GET", `/api/search/saved/${ss.id}/candidates`)).body.items.filter((i: any) => i.transient)).toHaveLength(0);
  });

  it("does not run while online search is off or the server is offline, and says why", async () => {
    const fake = await startFake("searxng", pages());
    const t = await startOnlineServer();
    await addProvider(t, fake);
    const { src } = await savedSource(t, { onResult: "candidates" });
    await t.api("POST", "/api/system/connectivity", { forceOffline: true });
    const off = await t.api("POST", `/api/sources/${src.body.id}/run`);
    expect(off.status).toBe(409);
    expect(off.body.error).toBe("offline");
    await t.api("POST", "/api/system/connectivity", { forceOffline: false });
    await t.api("PATCH", "/api/settings", { privacy: { onlineSearch: { enabled: false } } });
    const sw = await t.api("POST", `/api/sources/${src.body.id}/run`);
    expect(sw.status).toBe(409);
    expect(sw.body.error).toBe("conflict");
    expect(fake.requests.length).toBe(0);
    expect((await t.api("GET", `/api/sources/${src.body.id}`)).body.lastRunAt).toBeTruthy();
    void addDoc; void drained;
  });
});
