import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addProvider, finished, results, search, startFake } from "../integration/online/helpers.js";
import { saveAndWait } from "../integration/browser/helpers.js";
import { startDiscoveryTest, until, useFixtures, type DiscoveryTest } from "./helpers.js";

const fixtures = useFixtures();
const origin = () => fixtures().urls.article as string;
const onlinePages = (n = 5) => Array.from({ length: n }, (_, i) => ({ url: `${origin()}/online-only/${i + 1}`, title: `TITLEMARK ${i}`, snippet: `SNIPPETMARK ${i}` }));
const candidates = (t: DiscoveryTest) => t.svc.db.all<{ id: number; url: string; origin_storage: string | null; title_hint: string | null; expires_at: number | null; score_components_json: string | null; state: string }>(
  "SELECT id, url, origin_storage, title_hint, expires_at, score_components_json, state FROM discovery_candidates ORDER BY id");

async function onlineServer(opts: { hold?: boolean } = {}): Promise<DiscoveryTest> {
  const t = await startDiscoveryTest({ ...opts, server: { online: { retryDelayMs: [5, 10] } } });
  await t.svc.search.waitForRebuild();
  const r = await t.api("PATCH", "/api/settings", { privacy: { onlineSearch: { enabled: true, acknowledged: true } } });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return t;
}
async function runSearch(t: DiscoveryTest, query = "turbines") {
  const r = await search(t, { query });
  await finished(t, r.body.searchId);
  return r;
}
function everything(t: DiscoveryTest): string {
  const parts: string[] = [];
  for (const { name } of t.svc.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
    for (const row of t.svc.db.all(`SELECT * FROM "${name}"`)) parts.push(`${name} ${JSON.stringify(row)}`);
  }
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { try { parts.push(fs.readFileSync(p).toString("latin1")); } catch { /* skip */ } } } };
  walk(t.dataDir);
  return parts.join("\n");
}

describe("search-driven discovery (D-05)", () => {
  it("all of it is off by default: searching creates nothing", async () => {
    const fake = await startFake("searxng", onlinePages());
    const t = await onlineServer();
    await addProvider(t, fake);
    await runSearch(t);
    expect(candidates(t)).toHaveLength(0);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM discovery_ledger")!.n).toBe(0);
  });

  it("searchesInfluenceDiscovery on: unsaved results become candidates, with an address and nothing else", async () => {
    const fake = await startFake("searxng", onlinePages());
    const t = await onlineServer();
    await addProvider(t, fake);
    await t.settings({ enabled: true, searchDriven: { searchesInfluenceDiscovery: true } });
    await runSearch(t, "querymarker4471 turbines");
    const rows = candidates(t);
    expect(rows.map((r) => r.url).sort()).toEqual(onlinePages().map((p) => p.url).sort());
    expect(rows.every((r) => r.title_hint === null)).toBe(true);
    expect(t.svc.db.all<{ kind: string; detail: string | null; ref_search_id: number | null }>("SELECT kind, detail, ref_search_id FROM candidate_provenance").every((p) => p.kind === "search_result" && p.detail === null && p.ref_search_id === null)).toBe(true);
    const discoveryTables = JSON.stringify(["discovery_candidates", "candidate_provenance", "discovery_ledger"].map((n) => t.svc.db.all(`SELECT * FROM ${n}`)));
    expect(discoveryTables).not.toContain("querymarker4471");
    expect(discoveryTables).not.toContain("TITLEMARK");
    expect(discoveryTables).not.toContain("SNIPPETMARK");
    // They are listed as background (search-driven) candidates.
    const list = (await t.api("GET", "/api/discovery/candidates")).body;
    expect(list.items.every((c: { lane: string }) => c.lane === "background")).toBe(true);
    // Saved addresses are not suggested.
    await saveAndWait(t, `${origin()}/online-only/1`);
    await runSearch(t, "second turbines");
    expect(candidates(t).filter((r) => r.url.endsWith("/online-only/1")).every((r) => r.state === "archived" || r.state === "new")).toBe(true);
  });

  it("with search history switched off no search text is stored anywhere, whatever discovery does", async () => {
    const fake = await startFake("searxng", onlinePages(3));
    const t = await onlineServer();
    await addProvider(t, fake);
    await t.api("PATCH", "/api/settings", { privacy: { searchHistory: { enabled: false } } });
    await t.settings({ enabled: true, searchDriven: { searchesInfluenceDiscovery: true, prioritiseFrequentTopics: true, autoCacheOpenedOnlinePages: true } });
    await runSearch(t, "privatequery7781 secretwords");
    expect(candidates(t).length).toBeGreaterThan(0);                              // discovery did its work…
    expect(t.svc.db.all("SELECT 1 FROM search_history")).toHaveLength(0);
    expect(everything(t)).not.toContain("privatequery7781");                       // …and no query text exists in any table or file
    expect(everything(t)).not.toContain("secretwords");
  });

  it("prioritiseFrequentTopics decides whether repeated searches count towards the score", async () => {
    const fake = await startFake("searxng", onlinePages(2));
    const t = await onlineServer();
    await addProvider(t, fake);
    await t.settings({ enabled: true, searchDriven: { searchesInfluenceDiscovery: true, prioritiseFrequentTopics: false } });
    await runSearch(t, "alpha");
    t.fake.advance(86_400_000);
    await runSearch(t, "beta");
    t.fake.advance(86_400_000);
    await runSearch(t, "gamma");
    const id = (await t.api("GET", "/api/discovery/candidates")).body.items[0].id;
    const comp = async () => (await t.api("GET", `/api/discovery/candidates/${id}/explain`)).body.components.find((c: { name: string }) => c.name === "searchFrequency");
    expect(await comp()).toMatchObject({ raw: 0, contribution: 0 });
    await t.settings({ searchDriven: { prioritiseFrequentTopics: true } });
    const on = await comp();
    expect(on.raw).toBeCloseTo(0.5, 6);                                           // 3 days: 3 / (3 + 3)
    expect(on.contribution).toBeCloseTo(on.raw * on.weight, 6);
    // Provenance rows are one per day, not one per search.
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM candidate_provenance WHERE candidate_id = (SELECT id FROM discovery_candidates ORDER BY id LIMIT 1)")!.n).toBe(3);
  });

  it("Brave results never become candidates; Mojeek's carry no text and expire with the provider's cache time", async () => {
    const brave = await startFake("brave", onlinePages(3));
    const t = await onlineServer();
    await addProvider(t, brave);
    await t.settings({ enabled: true, searchDriven: { searchesInfluenceDiscovery: true } });
    await runSearch(t);
    expect(candidates(t)).toHaveLength(0);
    const hay = everything(t);
    for (const m of ["TITLEMARK", "SNIPPETMARK", "online-only"]) expect(hay, m).not.toContain(m);

    const mojeek = await startFake("mojeek", onlinePages(2));
    const t2 = await onlineServer();
    await addProvider(t2, mojeek);
    await t2.settings({ enabled: true, searchDriven: { searchesInfluenceDiscovery: true } });
    await runSearch(t2);
    const rows = candidates(t2);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.origin_storage === "ttl" && r.title_hint === null && r.score_components_json === null && r.expires_at === t2.fake.now() + 3600_000)).toBe(true);
    const ex = (await t2.api("GET", `/api/discovery/candidates/${(await t2.api("GET", "/api/discovery/candidates")).body.items[0].id}/explain`)).body;
    expect(ex.scoreStored).toBe(false);
    expect(ex.components.reduce((n: number, c: { contribution: number }) => n + c.contribution, 0)).toBeCloseTo(ex.score, 5);
    t2.fake.advance(3601_000);
    t2.svc.discovery.store.sweepExpired();
    expect(candidates(t2)).toHaveLength(0);
  });

  it("requireApproval: search-driven candidates are downloaded only after approval, filed in the Browsing cache at P4, inside the background budget", async () => {
    const fake = await startFake("searxng", onlinePages(5));
    const t = await onlineServer({ hold: true });
    await addProvider(t, fake);
    await t.settings({ enabled: true, searchDriven: { searchesInfluenceDiscovery: true, requireApproval: true, backgroundBudget: { maxRequestsPerDay: 2, maxBytesPerDay: 50 * 1024 * 1024 } }, active: { respectSchedule: false, minScore: -1000 } });
    await runSearch(t);
    const none = t.svc.discovery.runner.runPass("manual");
    expect(none.background.started).toBe(0);
    expect(none.active.started).toBe(0);
    expect(t.fetcher.calls).toHaveLength(0);

    const items = (await t.api("GET", "/api/discovery/candidates")).body.items;
    const bulk = await t.api("POST", "/api/discovery/candidates/bulk", { ids: items.map((i: { id: string }) => i.id), action: "approve" });
    expect(bulk.body.done).toBe(5);
    const r = t.svc.discovery.runner.runPass("manual");
    expect(r.background.started).toBe(2);                                         // the budget, not the five approved
    expect(r.background.skipped.requests).toBeGreaterThan(0);
    const jobs = t.svc.db.all<{ source_id: number; priority: number; requested_by: string }>("SELECT source_id, priority, requested_by FROM download_jobs");
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.priority === 4 && j.requested_by === "discovery" && j.source_id === t.svc.sources.systemId("browsing_cache"))).toBe(true);
    expect(t.svc.db.get<{ priority: number }>("SELECT priority FROM sources WHERE system_kind = 'browsing_cache'")!.priority).toBe(4);   // the Browsing cache is P4
    expect(t.svc.db.all<{ lane: string }>("SELECT lane FROM discovery_ledger").every((l) => l.lane === "background")).toBe(true);
    expect((await t.api("GET", "/api/discovery/budget")).body.background.requests).toMatchObject({ used: 2, limit: 2, remaining: 0 });
    // The active lane's budget is a separate thing and was not touched.
    expect((await t.api("GET", "/api/discovery/budget")).body.active.requests.used).toBe(0);
  });

  it("without requireApproval a good-scoring search-driven candidate downloads by itself, still within the budget", async () => {
    const fake = await startFake("searxng", onlinePages(4));
    const t = await onlineServer({ hold: true });
    await addProvider(t, fake);
    await t.settings({ enabled: true, searchDriven: { searchesInfluenceDiscovery: true, requireApproval: false, backgroundBudget: { maxRequestsPerDay: 3, maxBytesPerDay: 50 * 1024 * 1024 } }, active: { respectSchedule: false, minScore: -1000 } });
    await runSearch(t);
    expect(t.svc.discovery.runner.runPass("manual").background.started).toBe(3);
    expect(t.svc.discovery.runner.runPass("manual").background.started).toBe(0);
  });
});

describe("auto-cache of opened online pages (D-05)", () => {
  const open = (t: DiscoveryTest, url: string) => t.api("POST", "/api/browser/resolve", { input: url });
  const cached = (t: DiscoveryTest) => t.svc.db.all<{ requested_url: string; source_id: number; priority: number }>("SELECT requested_url, source_id, priority FROM download_jobs WHERE requested_by = 'discovery' ORDER BY id");

  it("off by default; on, it saves only the page the Human opened, into the Browsing cache at P4", async () => {
    const t = await startDiscoveryTest();
    const a = `${origin()}/online-only/1`;
    expect((await open(t, a)).body.resolution.kind).toBe("live");
    expect(cached(t)).toHaveLength(0);

    await t.settings({ enabled: true, searchDriven: { autoCacheOpenedOnlinePages: false } });
    await open(t, `${origin()}/online-only/2`);
    expect(cached(t)).toHaveLength(0);

    await t.settings({ searchDriven: { autoCacheOpenedOnlinePages: true } });
    const b = `${origin()}/online-only/3`;
    await open(t, b);
    expect(cached(t)).toMatchObject([{ requested_url: b, priority: 4, source_id: t.svc.sources.systemId("browsing_cache") }]);
    await until(() => ["archived", "partial"].includes(t.svc.pipeline.findPageByUrl(b)?.availability ?? ""));
    // Nothing the page links to was fetched, saved or made a candidate.
    expect(t.fetcher.calls.filter((u) => /\/(online-only|astronomy|articles)/.test(u) && u !== b && !u.includes("/assets") && !u.includes("/img") && !u.includes("favicon"))).toEqual([]);
    expect(t.svc.db.all<{ url: string }>("SELECT p.canonical_url AS url FROM pages p JOIN page_sources ps ON ps.page_id = p.id WHERE ps.source_id = ?", [t.svc.sources.systemId("browsing_cache")])).toHaveLength(1);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM discovery_candidates")!.n).toBe(0);
    // Opening it again does not save it twice.
    await open(t, b);
    expect(cached(t)).toHaveLength(1);
    expect(t.svc.db.all<{ lane: string }>("SELECT lane FROM discovery_ledger").map((l) => l.lane)).toEqual(["auto_cache"]);
  });

  it("obeys the background budget, the per-site cap, the kill switch, offline mode and the secret filter", async () => {
    const t = await startDiscoveryTest({ hold: true });
    await t.settings({ enabled: true, searchDriven: { autoCacheOpenedOnlinePages: true, backgroundBudget: { maxRequestsPerDay: 2, maxBytesPerDay: 50 * 1024 * 1024 } }, active: { perSiteDailyCap: 5, respectSchedule: false } });
    const o = origin();
    for (let i = 1; i <= 4; i++) await open(t, `${o}/online-only/${i}`);
    expect(cached(t)).toHaveLength(2);                                            // the budget, not the four pages
    expect((await t.api("GET", "/api/discovery/budget")).body.background.requests.remaining).toBe(0);

    // Secret-looking addresses are never kept.
    const t2 = await startDiscoveryTest({ hold: true });
    await t2.settings({ enabled: true, searchDriven: { autoCacheOpenedOnlinePages: true } });
    expect(t2.svc.discovery.onOpened(`${o}/login`)).toEqual({ ok: false, reason: "sensitive" });
    expect(t2.svc.discovery.onOpened(`${o}/x?token=abc`)).toEqual({ ok: false, reason: "sensitive" });
    // Kill switch, then offline mode.
    t2.svc.discovery.runner.pause();
    expect(t2.svc.discovery.onOpened(`${o}/online-only/1`)).toEqual({ ok: false, reason: "kill_switch" });
    t2.svc.discovery.runner.resume();
    await t2.api("PATCH", "/api/settings", { offline: { forced: true } });
    expect(t2.svc.discovery.onOpened(`${o}/online-only/1`)).toEqual({ ok: false, reason: "offline" });
    expect(cached(t2)).toHaveLength(0);
    expect(t2.fetcher.calls).toHaveLength(0);
  });
});
