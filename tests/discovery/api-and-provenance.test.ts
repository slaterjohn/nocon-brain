import { describe, expect, it } from "vitest";
import { addProvider, startFake } from "../integration/online/helpers.js";
import { saveAndWait } from "../integration/browser/helpers.js";
import { automatic, discoveryDownloads, flood, seedSourcePage, startDiscoveryTest, until, useFixtures, type DiscoveryTest } from "./helpers.js";

const fixtures = useFixtures();
const origin = () => fixtures().urls.article as string;

describe("explain, scoring and ranking through the API (D-03)", () => {
  it("the components add up to the score, are stored with it, and a weight changes the ranking", async () => {
    const t = await startDiscoveryTest();
    await t.settings({ enabled: true, passive: { fromLinks: true, fromBookmarks: true } });
    const src = await seedSourcePage(t, "https://one.example/a");
    const s = t.svc.discovery.store;
    const o = origin();
    s.add({ url: `${o}/moon`, kind: "link", depth: 1, refPageId: src.pageId });
    s.add({ url: `${o}/mars`, kind: "bookmark", depth: 0 });
    const user = t.svc.db.get<{ id: number }>("SELECT id FROM users LIMIT 1")!.id;
    t.svc.db.run("INSERT INTO bookmarks (public_id, user_id, original_url, url_key, title, page_id, reference_priority, created_at) VALUES ('bm_x', ?, ?, ?, '', NULL, 2, ?)", [user, `${o}/mars`, t.svc.pipeline.urlKey(`${o}/mars`), t.fake.now()]);
    const ids = (await t.api("GET", "/api/discovery/candidates?includeHidden=true")).body.items as { id: string; url: string }[];
    const idOf = (slug: string) => ids.find((i) => i.url.endsWith(`/${slug}`))!.id;
    await t.settings({ weights: { bookmarks: 40, estimatedCost: 0 } });
    const rank = async () => (await t.api("GET", "/api/discovery/candidates?sort=score")).body.items.map((i: { url: string }) => i.url.split("/").pop());
    expect(await rank()).toEqual(["mars", "moon"]);                               // the bookmark outweighs the rest
    await t.settings({ weights: { bookmarks: -40 } });
    expect(await rank()).toEqual(["moon", "mars"]);                               // flip the weight, the ranking follows
    for (const slug of ["moon", "mars"]) {
      const e = (await t.api("GET", `/api/discovery/candidates/${idOf(slug)}/explain`)).body;
      expect(e.components).toHaveLength(8);
      expect(e.components.map((c: { name: string }) => c.name)).toEqual(["inboundArchivedLinks", "collectionRelevance", "searchFrequency", "bookmarks", "recentActivity", "sourcePriority", "estimatedCost", "storageHeadroom"]);
      expect(e.components.reduce((n: number, c: { contribution: number }) => n + c.contribution, 0)).toBeCloseTo(e.score, 9);
      for (const c of e.components) expect(c.contribution).toBeCloseTo(c.raw * c.weight, 6);
      expect(e.scoreStored).toBe(true);
      // Stored on the row, and identical to what the explain API works out.
      const row = t.svc.db.get<{ score: number; score_components_json: string }>("SELECT score, score_components_json FROM discovery_candidates WHERE url = ?", [`${o}/${slug}`])!;
      expect(row.score).toBeCloseTo(e.score, 9);
      expect(JSON.parse(row.score_components_json).reduce((n: number, c: { contribution: number }) => n + c.contribution, 0)).toBeCloseTo(row.score, 9);
      expect(e.summary.length).toBeGreaterThan(0);
    }
    const mars = (await t.api("GET", `/api/discovery/candidates/${idOf("mars")}`)).body;
    expect(mars.why.some((w: string) => /bookmark/i.test(w))).toBe(true);
    expect(mars.scoreComponents).toHaveLength(8);
    expect((await t.api("GET", "/api/discovery/candidates/cand_NOPE")).status).toBe(404);
  });

  it("source priority, links, collections and storage pressure feed the score from the database", async () => {
    const t = await startDiscoveryTest();
    await t.settings({ enabled: true, passive: { fromLinks: true } });
    const p1 = await seedSourcePage(t, "https://one.example/a", 1);
    const p4 = await seedSourcePage(t, "https://two.example/b", 4);
    const o = origin();
    for (const [slug, page] of [["moon", p1], ["mars", p4]] as const) {
      t.svc.discovery.store.add({ url: `${o}/${slug}`, kind: "link", depth: 1, refPageId: page.pageId });
      // A real `links` row from the saved page, as stage 7 writes it.
      const v = t.svc.db.get<{ id: number }>("SELECT latest_version_id AS id FROM pages WHERE id = ?", [page.pageId])!.id;
      t.svc.db.run("INSERT INTO links (from_version_id, from_page_id, to_url, to_url_key, region, score, is_internal, rel_nofollow, position) VALUES (?, ?, ?, ?, 'content', 0.9, 0, 0, 0)", [v, page.pageId, `${o}/${slug}`, t.svc.pipeline.urlKey(`${o}/${slug}`)]);
    }
    t.svc.db.run("INSERT INTO collections (public_id, name, created_at, updated_at) VALUES ('col_x', 'C', ?, ?)", [t.fake.now(), t.fake.now()]);
    t.svc.db.run("INSERT INTO collection_memberships (collection_id, page_id, added_by, added_at) VALUES (1, ?, 'user', ?)", [p1.pageId, t.fake.now()]);
    t.svc.discovery.scorer.rescore();
    const get = async (slug: string) => {
      const list = (await t.api("GET", "/api/discovery/candidates")).body.items as { id: string; url: string }[];
      return (await t.api("GET", `/api/discovery/candidates/${list.find((i) => i.url.endsWith(`/${slug}`))!.id}/explain`)).body.components as { name: string; raw: number }[];
    };
    const moon = await get("moon");
    const mars = await get("mars");
    const raw = (cs: { name: string; raw: number }[], n: string) => cs.find((c) => c.name === n)!.raw;
    expect(raw(moon, "inboundArchivedLinks")).toBeCloseTo(0.25, 6);               // 1 / (1 + 3)
    expect(raw(moon, "collectionRelevance")).toBe(1);                              // its only linking page is in a collection
    expect(raw(mars, "collectionRelevance")).toBe(0);
    expect(raw(moon, "sourcePriority")).toBe(1);                                   // P1
    expect(raw(mars, "sourcePriority")).toBe(0.25);                                // P4
    expect(raw(moon, "storageHeadroom")).toBeGreaterThanOrEqual(0);
  });
});

describe("deciding: approve, dismiss, queue, bulk (D-07 contract)", () => {
  async function withCandidates(n = 4): Promise<{ t: DiscoveryTest; ids: string[] }> {
    const t = await startDiscoveryTest();
    await t.settings({ enabled: true, passive: { fromBookmarks: true } });
    for (const slug of ["moon", "mars", "stars", "comets", "jupiter"].slice(0, n)) t.svc.discovery.store.add({ url: `${origin()}/${slug}`, kind: "bookmark", depth: 0 });
    return { t, ids: ((await t.api("GET", "/api/discovery/candidates?sort=oldest")).body.items as { id: string }[]).map((i) => i.id) };
  }

  it("approve records the decision and suggestions; dismiss hides it; both are idempotent where they should be", async () => {
    const { t, ids } = await withCandidates();
    const src = await seedSourcePage(t, "https://seed.example/a");
    t.svc.db.run("INSERT INTO collections (public_id, name, created_at, updated_at) VALUES ('col_a', 'Reading', ?, ?)", [t.fake.now(), t.fake.now()]);
    const ap = await t.api("POST", `/api/discovery/candidates/${ids[0]}/approve`, { sourceId: src.sourcePublicId, collectionId: "col_a" });
    expect(ap.status).toBe(200);
    expect(ap.body).toMatchObject({ state: "approved", decidedBy: "user", suggestedSource: { id: src.sourcePublicId }, suggestedCollectionId: "col_a" });
    expect((await t.api("POST", `/api/discovery/candidates/${ids[0]}/approve`, {})).body.state).toBe("approved");
    expect((await t.api("POST", `/api/discovery/candidates/${ids[0]}/approve`, { sourceId: "src_NOPE" })).status).toBe(404);
    const dis = await t.api("POST", `/api/discovery/candidates/${ids[1]}/dismiss`);
    expect(dis.body.state).toBe("dismissed");
    expect((await t.api("GET", "/api/discovery/candidates?state=dismissed")).body.total).toBe(1);
    // A dismissed address stays dismissed when it is seen again.
    expect(t.svc.discovery.store.add({ url: `${origin()}/mars`, kind: "bookmark", depth: 0 })).toEqual({ outcome: "skipped", reason: "dismissed" });
    // …but the Human may change their mind.
    expect((await t.api("POST", `/api/discovery/candidates/${ids[1]}/approve`, {})).body.state).toBe("approved");
  });

  it("queue downloads now through the normal path, files it where asked, and the candidate follows the download", async () => {
    const { t, ids } = await withCandidates(2);
    const src = await seedSourcePage(t, "https://seed.example/a");
    const q = await t.api("POST", `/api/discovery/candidates/${ids[0]}/queue`, { priority: "P2", sourceId: src.sourcePublicId });
    expect(q.status).toBe(202);
    expect(q.body).toMatchObject({ state: "queued", decidedBy: "user" });
    expect(q.body.downloadId).toMatch(/^dl_/);
    const dl = t.svc.db.get<{ priority: number; requested_by: string; source_id: number; candidate_id: number }>("SELECT priority, requested_by, source_id, candidate_id FROM download_jobs WHERE public_id = ?", [q.body.downloadId])!;
    expect(dl).toMatchObject({ priority: 2, requested_by: "user", source_id: src.sourceId });
    expect(dl.candidate_id).toBeGreaterThan(0);
    await until(() => ["completed", "failed"].includes(t.svc.pipeline.getCapture(q.body.downloadId)?.state ?? ""));
    t.svc.discovery.runner.reconcile();
    expect((await t.api("GET", `/api/discovery/candidates/${ids[0]}`)).body.state).toBe("archived");
    // Queue-now is the Human's own action: it is not counted in the daily budgets.
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM discovery_ledger")!.n).toBe(0);
    // Queued or archived candidates cannot be dismissed.
    expect((await t.api("POST", `/api/discovery/candidates/${ids[0]}/dismiss`)).status).toBe(409);
    // While the Human is offline the download waits, held.
    await t.api("PATCH", "/api/settings", { offline: { forced: true } });
    const held = await t.api("POST", `/api/discovery/candidates/${ids[1]}/queue`, {});
    expect(held.status).toBe(202);
    expect(held.body.held).toBe(true);
  });

  it("bulk reports each item and never stops at the first failure", async () => {
    const { t, ids } = await withCandidates(3);
    const r = await t.api("POST", "/api/discovery/candidates/bulk", { ids: [ids[0], "cand_NOPE", ids[1]], action: "approve" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ done: 2, failed: 1 });
    expect(r.body.results[1]).toMatchObject({ id: "cand_NOPE", ok: false, error: { code: "not_found" } });
    expect((await t.api("POST", "/api/discovery/candidates/bulk", { ids: [ids[2]], action: "dismiss" })).body.done).toBe(1);
    expect((await t.api("POST", "/api/discovery/candidates/bulk", { ids: [], action: "dismiss" })).status).toBe(400);
    expect((await t.api("POST", "/api/discovery/candidates/bulk", { ids: [ids[0]], action: "explode" })).status).toBe(400);
  });

  it("every write needs the CSRF header and a session", async () => {
    const { t, ids } = await withCandidates(1);
    const { call } = await import("../integration/server/helpers.js");
    const noCsrf = await call(t, { method: "POST", url: `/api/discovery/candidates/${ids[0]}/approve`, body: {}, cookie: t.cookie, raw: true });
    expect(noCsrf.statusCode).toBe(403);
    const noSession = await call(t, { method: "GET", url: "/api/discovery" });
    expect(noSession.statusCode).toBe(401);
    expect((await call(t, { method: "POST", url: "/api/discovery/pause", body: {} })).statusCode).toBe(401);
  });
});

describe("budgets, ledger and runner status (D-06, D-07 contract)", () => {
  it("a finished download settles its ledger entry with the bytes it really took, and its candidate becomes archived", async () => {
    const t = await startDiscoveryTest();
    const src = await seedSourcePage(t);
    const o = origin();
    const ids = flood(t, { urls: [`${o}/moon`, `${o}/mars`, `${o}/stars`], refPageId: src.pageId });
    await t.settings(automatic(src.sourcePublicId, { maxCandidatesPerRun: 3 }));
    expect(t.svc.discovery.runner.runPass("manual").active.started).toBe(3);
    await until(() => discoveryDownloads(t).every((d) => ["completed", "failed"].includes(t.svc.db.get<{ s: string }>("SELECT state AS s FROM download_jobs WHERE id = ?", [d.id])!.s)));
    t.svc.discovery.runner.reconcile();
    const rows = (await t.api("GET", "/api/discovery/ledger")).body.items;
    expect(rows).toHaveLength(3);
    expect(rows.every((r: { state: string; outcome: string; bytes: number; reservedBytes: number; lane: string }) => r.state === "settled" && r.outcome === "archived" && r.bytes > 0 && r.lane === "active")).toBe(true);
    const budget = (await t.api("GET", "/api/discovery/budget")).body;
    expect(budget.active.bytes.used).toBe(rows.reduce((n: number, r: { bytes: number }) => n + r.bytes, 0));
    expect(budget.active.requests.used).toBe(3);
    expect(budget.month.requests).toBe(3);
    expect(budget.perSite.top[0]).toMatchObject({ host: "127.0.0.1", requests: 3 });
    expect(budget.queue.inFlight).toBe(0);
    for (const id of ids) expect(t.svc.db.get<{ state: string }>("SELECT state FROM discovery_candidates WHERE id = ?", [id])!.state).toBe("archived");
    expect((await t.api("GET", "/api/discovery/ledger?lane=background")).body.items).toHaveLength(0);
    expect((await t.api("GET", "/api/discovery/ledger?limit=2")).body.nextCursor).toBeTruthy();
    expect((await t.api("GET", "/api/discovery/ledger?day=nope")).status).toBe(400);
    // The pages were saved as Opportunistic content under the allowed source.
    const page = t.svc.pipeline.findPageByUrl(`${o}/moon`)!;
    expect(page.effectivePriority).toBeGreaterThanOrEqual(2);
  });

  it("a failed download counts its request, is retried once, then the candidate expires", async () => {
    const t = await startDiscoveryTest();
    const src = await seedSourcePage(t);
    const [id] = flood(t, { urls: [`${origin()}/no-such-page-at-all`], refPageId: src.pageId });
    await t.settings(automatic(src.sourcePublicId));
    t.svc.discovery.runner.runPass("manual");
    await until(() => discoveryDownloads(t).every((d) => ["completed", "failed"].includes(t.svc.db.get<{ s: string }>("SELECT state AS s FROM download_jobs WHERE id = ?", [d.id])!.s)));
    t.svc.discovery.runner.reconcile();
    expect(t.svc.db.get<{ state: string; attempts: number }>("SELECT state, attempts FROM discovery_candidates WHERE id = ?", [id])).toEqual({ state: "new", attempts: 1 });
    t.svc.discovery.runner.runPass("manual");
    await until(() => discoveryDownloads(t).length === 2 && discoveryDownloads(t).every((d) => ["completed", "failed"].includes(t.svc.db.get<{ s: string }>("SELECT state AS s FROM download_jobs WHERE id = ?", [d.id])!.s)));
    t.svc.discovery.runner.reconcile();
    expect(t.svc.db.get<{ state: string }>("SELECT state FROM discovery_candidates WHERE id = ?", [id])!.state).toBe("expired");
    expect((await t.api("GET", "/api/discovery/ledger")).body.items.map((r: { outcome: string }) => r.outcome)).toEqual(["failed", "failed"]);
  });

  it("the runner status says what blocks it, and the overview summarises everything", async () => {
    const t = await startDiscoveryTest();
    let r = (await t.api("GET", "/api/discovery/runner")).body;
    expect(r).toMatchObject({ state: "off", mode: "off", blockedBy: ["disabled"], killSwitch: { paused: false }, inFlight: 0 });
    await t.settings({ enabled: true, active: { mode: "approval" } });
    r = (await t.api("GET", "/api/discovery/runner")).body;
    expect(r.state).toBe("idle");
    await t.api("POST", "/api/discovery/pause", {});
    r = (await t.api("GET", "/api/discovery/runner")).body;
    expect(r).toMatchObject({ state: "paused", killSwitch: { paused: true } });
    const run = await t.api("POST", "/api/discovery/run", {});
    expect(run.body.active.blockedBy).toContain("kill_switch");
    expect((await t.api("GET", "/api/discovery/runner")).body.lastPass.trigger).toBe("manual");
    const o = (await t.api("GET", "/api/discovery")).body;
    expect(o).toMatchObject({ enabled: true, mode: "approval", killSwitch: { paused: true }, counts: { new: 0 }, runner: { state: "paused" } });
    expect(o.budget.active.requests).toMatchObject({ used: 0 });
    // The kill switch survives a restart: it is stored.
    expect(t.svc.db.get<{ paused_at: number | null }>("SELECT paused_at FROM discovery_state WHERE id = 1")!.paused_at).not.toBeNull();
    await t.api("POST", "/api/discovery/resume", {});
    expect((await t.api("GET", "/api/discovery/runner")).body.state).toBe("idle");
  });

  it("progressive expansion: each hop is one level deeper and stops at the depth limit", async () => {
    const t = await startDiscoveryTest();
    const src = await seedSourcePage(t);
    await t.settings(automatic(src.sourcePublicId, { maxDepth: 2, maxRequestsPerDay: 8, maxCandidatesPerRun: 4, minScore: -1000 }, { ceilings: { maxDepth: 2, maxQueued: 100, maxRequestsPerDay: 200, maxBytesPerDay: 512 * 1024 * 1024 } }));
    // The Human saves a page, and says it belongs to the allowed source.
    const saved = await saveAndWait(t, `${origin()}/astronomy`);
    expect(saved.state).toBe("completed");
    const page = t.svc.pipeline.findPageByUrl(`${origin()}/astronomy`)!;
    t.svc.db.run("INSERT INTO page_sources (page_id, source_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", [page.id, src.sourceId, t.fake.now(), t.fake.now()]);
    const depthOf = () => t.svc.db.all<{ depth: number }>("SELECT depth FROM discovery_candidates").map((r) => r.depth);
    expect(Math.max(...depthOf())).toBe(1);
    const settle = async () => { await until(() => discoveryDownloads(t).every((d) => ["completed", "failed"].includes(t.svc.db.get<{ s: string }>("SELECT state AS s FROM download_jobs WHERE id = ?", [d.id])!.s))); t.svc.discovery.runner.reconcile(); };
    t.svc.discovery.runner.runPass("manual");
    await settle();
    expect(Math.max(...depthOf())).toBe(2);                                        // links of depth-1 pages became depth-2 candidates
    for (let i = 0; i < 4; i++) { t.svc.discovery.runner.runPass("manual"); await settle(); }
    expect(Math.max(...depthOf())).toBe(2);                                        // never a depth-3 candidate
    const done = t.svc.db.all<{ depth: number }>("SELECT depth FROM discovery_candidates WHERE state = 'archived'");
    expect(done.length).toBeGreaterThan(0);
    expect(t.svc.db.get<{ n: number }>("SELECT COALESCE(SUM(requests), 0) AS n FROM discovery_ledger")!.n).toBeLessThanOrEqual(8);
  });
});

describe("saved-search and Brave candidates keep the O-11 rules (provenance correctness)", () => {
  it("saved-search results show in the discovery list only while that collector is on, with correct provenance", async () => {
    const fake = await startFake("searxng", [1, 2, 3].map((i) => ({ url: `${origin()}/online-only/${i}`, title: `Online ${i}`, snippet: "x" })));
    const t = await startDiscoveryTest({ server: { online: { retryDelayMs: [5, 10] } } });
    await t.svc.search.waitForRebuild();
    await t.api("PATCH", "/api/settings", { privacy: { onlineSearch: { enabled: true, acknowledged: true } } });
    await addProvider(t, fake);
    const ss = await t.api("POST", "/api/search/saved", { name: "T", query: "turbines", includeOnline: true });
    const src = await t.api("POST", `/api/search/saved/${ss.body.id}/source`, { onResult: "candidates", maxResults: 3 });
    await t.api("POST", `/api/sources/${src.body.id}/run`);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM discovery_candidates")!.n).toBe(3);
    expect((await t.api("GET", "/api/discovery/candidates")).body.total).toBe(0);              // everything off
    await t.settings({ enabled: true, passive: { fromSavedSearches: true } });
    const list = (await t.api("GET", "/api/discovery/candidates")).body;
    expect(list.total).toBe(3);
    expect(list.items.every((c: { provenanceKinds: string[]; host: string; score: number }) => c.provenanceKinds.join() === "saved_search" && c.host === "127.0.0.1")).toBe(true);
    const detail = (await t.api("GET", `/api/discovery/candidates/${list.items[0].id}`)).body;
    expect(detail.provenance).toMatchObject([{ kind: "saved_search", sourceId: src.body.id }]);
    // Deciding in one place shows in the other.
    await t.api("POST", `/api/discovery/candidates/${list.items[0].id}/dismiss`);
    expect((await t.api("GET", `/api/search/saved/${ss.body.id}/candidates`)).body.items.map((i: { state: string }) => i.state).sort()).toEqual(["dismissed", "new", "new"]);
  });

  it("an approved Brave address appears with no title or components, and dismissing it forgets it", async () => {
    const MARK = "BRAVETEXT9902";
    const brave = await startFake("brave", [1, 2].map((i) => ({ url: `${origin()}/online-only/${i}`, title: `${MARK} ${i}`, snippet: `${MARK} s` })));
    const t = await startDiscoveryTest({ server: { online: { retryDelayMs: [5, 10] } } });
    await t.svc.search.waitForRebuild();
    await t.api("PATCH", "/api/settings", { privacy: { onlineSearch: { enabled: true, acknowledged: true } } });
    await addProvider(t, brave);
    await t.settings({ enabled: true, passive: { fromSavedSearches: true } });
    const ss = await t.api("POST", "/api/search/saved", { name: "T", query: "turbines", includeOnline: true });
    const src = await t.api("POST", `/api/search/saved/${ss.body.id}/source`, { onResult: "candidates" });
    await t.api("POST", `/api/sources/${src.body.id}/run`);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM discovery_candidates")!.n).toBe(0);     // in memory only
    expect((await t.api("GET", "/api/discovery/candidates")).body.total).toBe(0);
    const mem = (await t.api("GET", `/api/search/saved/${ss.body.id}/candidates`)).body.items;
    await t.api("POST", `/api/search/saved/${ss.body.id}/candidates/approve`, { ids: [mem[0].id] });
    await until(() => ["completed", "failed"].includes(t.svc.db.get<{ s: string }>("SELECT state AS s FROM download_jobs ORDER BY id LIMIT 1")?.s ?? ""));
    const row = t.svc.db.get<{ id: number; title_hint: string | null; score_components_json: string | null; origin_storage: string; score: number }>("SELECT * FROM discovery_candidates")!;
    expect(row).toMatchObject({ title_hint: null, score_components_json: null, origin_storage: "none" });
    const listed = (await t.api("GET", "/api/discovery/candidates")).body.items;
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBeUndefined();
    const ex = (await t.api("GET", `/api/discovery/candidates/${listed[0].id}/explain`)).body;
    expect(ex.scoreStored).toBe(false);
    expect(JSON.stringify(ex)).not.toContain(MARK);
    // Runner bookkeeping must not trip the database rules for transient candidates.
    t.svc.discovery.runner.reconcile();
    t.svc.discovery.scorer.scoreOne(row.id);
    expect(JSON.stringify([t.svc.db.all("SELECT * FROM discovery_candidates"), t.svc.db.all("SELECT * FROM candidate_provenance"), t.svc.db.all("SELECT * FROM discovery_ledger")])).not.toContain(MARK);
  });

  it("a Brave address that cannot be downloaded is forgotten after two failures, and no database rule trips on the way", async () => {
    const brave = await startFake("brave", [{ url: `${origin()}/missing-page-for-brave`, title: "BRAVEGONE title", snippet: "BRAVEGONE" }]);
    const t = await startDiscoveryTest({ server: { online: { retryDelayMs: [5, 10] } } });
    await t.svc.search.waitForRebuild();
    await t.api("PATCH", "/api/settings", { privacy: { onlineSearch: { enabled: true, acknowledged: true } } });
    await addProvider(t, brave);
    const ss = await t.api("POST", "/api/search/saved", { name: "T", query: "turbines", includeOnline: true });
    const src = await t.api("POST", `/api/search/saved/${ss.body.id}/source`, { onResult: "candidates" });
    await t.api("POST", `/api/sources/${src.body.id}/run`);
    const mem = (await t.api("GET", `/api/search/saved/${ss.body.id}/candidates`)).body.items;
    await t.api("POST", `/api/search/saved/${ss.body.id}/candidates/approve`, { ids: [mem[0].id] });
    const finish = async () => { await until(() => t.svc.db.all<{ state: string }>("SELECT state FROM download_jobs").every((d) => ["completed", "failed"].includes(d.state))); t.svc.discovery.runner.reconcile(); };
    await finish();
    expect(t.svc.db.get<{ state: string }>("SELECT state FROM discovery_candidates")!.state).toBe("approved");   // back to waiting for the runner
    await t.settings({ enabled: true, passive: { fromSavedSearches: true }, active: { mode: "approval", respectSchedule: false } });
    expect(t.svc.discovery.runner.runPass("manual").active.started).toBe(1);
    await until(() => t.svc.db.all<{ state: string }>("SELECT state FROM download_jobs").length === 2 && t.svc.db.all<{ state: string }>("SELECT state FROM download_jobs").every((d) => ["completed", "failed"].includes(d.state)));
    t.svc.discovery.runner.reconcile();
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM discovery_candidates")!.n).toBe(0);
    expect(JSON.stringify(t.svc.db.all("SELECT * FROM discovery_ledger"))).not.toContain("BRAVEGONE");
  });
});
