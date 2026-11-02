import { describe, expect, it } from "vitest";
import { articleUrls, automatic, discoveryDownloads, flood, seedSourcePage, startDiscoveryTest, until, useFixtures, type DiscoveryTest } from "./helpers.js";

const fixtures = useFixtures();
const origin = () => fixtures().urls.article as string;

/** Server with a source, a saved page in it and a flood of candidates linked from that page. */
async function floodedServer(o: { hold?: boolean; quotaBytes?: number; depth?: number; n?: number; state?: "new" | "approved" } = {}) {
  const t = await startDiscoveryTest({ hold: o.hold ?? true, ...(o.quotaBytes !== undefined ? { quotaBytes: o.quotaBytes } : {}) });
  const src = await seedSourcePage(t);
  const ids = flood(t, { urls: articleUrls(origin(), o.n), refPageId: src.pageId, depth: o.depth ?? 1, state: o.state });
  return { t, src, ids };
}
const pass = (t: DiscoveryTest) => t.svc.discovery.runner.runPass("manual");
const ledgerRows = (t: DiscoveryTest) => t.svc.db.all<{ requests: number; reserved_bytes: number; host: string }>("SELECT requests, reserved_bytes, host FROM discovery_ledger");
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("the active runner stays inside every limit (D-04, D-06)", () => {
  it("does nothing by default: discovery is off, even with a flood of candidates", async () => {
    const { t } = await floodedServer();
    const r = pass(t);
    expect(r.active.started).toBe(0);
    expect(r.active.blockedBy).toContain("disabled");
    expect(discoveryDownloads(t)).toHaveLength(0);
    expect(t.fetcher.calls).toHaveLength(0);
    const settings = (await t.api("GET", "/api/discovery/settings")).body;
    expect(settings.settings.enabled).toBe(false);
    expect(settings.settings.active.mode).toBe("off");
    expect(settings.settings.searchDriven).toMatchObject({ searchesInfluenceDiscovery: false, autoCacheOpenedOnlinePages: false, prioritiseFrequentTopics: false, requireApproval: true });
    expect(Object.values(settings.settings.passive)).toEqual([false, false, false, false, false]);
  });

  it("mode off downloads nothing even when everything else is on", async () => {
    const { t, src } = await floodedServer();
    await t.settings(automatic(src.sourcePublicId, { mode: "off" }));
    const r = pass(t);
    expect(r.active.blockedBy).toContain("mode_off");
    expect(discoveryDownloads(t)).toHaveLength(0);
    expect(t.fetcher.calls).toHaveLength(0);
  });

  it("max candidates per run: a pass starts no more than that", async () => {
    const { t, src } = await floodedServer();
    expect((await t.settings(automatic(src.sourcePublicId, { maxCandidatesPerRun: 3 }))).status).toBe(200);
    const r = pass(t);
    expect(r.active.started).toBe(3);
    expect(discoveryDownloads(t)).toHaveLength(3);
    expect(r.active.skipped.run_cap).toBeGreaterThan(0);
  });

  it("queue length: queued plus running never exceeds the maximum, pass after pass", async () => {
    const { t, src } = await floodedServer();
    await t.settings(automatic(src.sourcePublicId, { maxQueued: 4, maxCandidatesPerRun: 3 }));
    expect(pass(t).active.started).toBe(3);
    expect(pass(t).active.started).toBe(1);
    const third = pass(t);
    expect(third.active.started).toBe(0);
    expect(third.active.skipped.queue_full).toBeGreaterThan(0);
    expect(discoveryDownloads(t)).toHaveLength(4);
    expect(t.svc.discovery.ledger.inFlight()).toBe(4);
  });

  it("requests a day: exactly the budget is used and no more", async () => {
    const { t, src } = await floodedServer();
    await t.settings(automatic(src.sourcePublicId, { maxRequestsPerDay: 5 }));
    expect(pass(t).active.started).toBe(5);
    const again = pass(t);
    expect(again.active.started).toBe(0);
    expect(again.active.skipped.requests).toBeGreaterThan(0);
    expect(sum(ledgerRows(t).map((r) => r.requests))).toBe(5);
    const budget = (await t.api("GET", "/api/discovery/budget")).body;
    expect(budget.active.requests).toMatchObject({ used: 5, limit: 5, remaining: 0 });
    // The next day the budget is back.
    t.fake.advance(24 * 3600_000);
    t.svc.db.run("UPDATE jobs SET state = 'cancelled' WHERE type = 'fetch'");
    t.svc.db.run("UPDATE download_jobs SET state = 'cancelled', started_at = NULL");
    expect(pass(t).active.started).toBeGreaterThan(0);
  });

  it("bytes a day: the allotments never add up to more than the budget, and are the capture's size caps", async () => {
    const { t, src } = await floodedServer();
    const budget = 3 * 1024 * 1024;
    await t.settings(automatic(src.sourcePublicId, { maxBytesPerDay: budget }));
    const r = pass(t);
    expect(r.active.started).toBeGreaterThan(0);
    const rows = ledgerRows(t);
    expect(sum(rows.map((x) => x.reserved_bytes))).toBeLessThanOrEqual(budget);
    expect(r.active.skipped.bytes).toBeGreaterThan(0);
    const again = pass(t);
    expect(again.active.started).toBe(0);
    // The cap the capture runs under is the allotment.
    const payload = t.svc.db.get<{ payload_json: string }>("SELECT payload_json FROM jobs WHERE type = 'fetch' ORDER BY id LIMIT 1")!;
    const caps = JSON.parse(payload.payload_json).options.caps;
    expect(caps.maxDocumentBytes + caps.maxTotalAssetBytes).toBeLessThanOrEqual(budget);
    const b = (await t.api("GET", "/api/discovery/budget")).body;
    expect(b.active.bytes.used).toBeLessThanOrEqual(budget);
  });

  it("per-site daily cap", async () => {
    const { t, src } = await floodedServer();
    await t.settings(automatic(src.sourcePublicId, { perSiteDailyCap: 4 }));
    expect(pass(t).active.started).toBe(4);
    const again = pass(t);
    expect(again.active.started).toBe(0);
    expect(again.active.skipped.site_cap).toBeGreaterThan(0);
    expect(sum(ledgerRows(t).map((r) => r.requests))).toBe(4);
  });

  it("depth: candidates deeper than the maximum are never downloaded", async () => {
    const t = await startDiscoveryTest({ hold: true });
    const src = await seedSourcePage(t);
    const urls = articleUrls(origin(), 24);
    flood(t, { urls: urls.slice(0, 8), refPageId: src.pageId, depth: 1 });
    flood(t, { urls: urls.slice(8, 16), refPageId: src.pageId, depth: 2 });
    flood(t, { urls: urls.slice(16), refPageId: src.pageId, depth: 3 });
    await t.settings(automatic(src.sourcePublicId, { maxDepth: 2 }));
    expect(pass(t).active.started).toBe(16);
    const started = new Set(discoveryDownloads(t).map((d) => d.requested_url));
    for (const u of urls.slice(16)) expect(started.has(u), u).toBe(false);
  });

  it("scope: automatic mode downloads only candidates linked from an allowed source", async () => {
    const t = await startDiscoveryTest({ hold: true });
    const allowed = await seedSourcePage(t, "https://seed.example/allowed");
    const other = await seedSourcePage(t, "https://seed.example/other", 3);
    const urls = articleUrls(origin(), 20);
    flood(t, { urls: urls.slice(0, 10), refPageId: allowed.pageId });
    flood(t, { urls: urls.slice(10), refPageId: other.pageId });
    await t.settings(automatic(allowed.sourcePublicId));
    expect(pass(t).active.started).toBe(10);
    expect(new Set(discoveryDownloads(t).map((d) => d.requested_url))).toEqual(new Set(urls.slice(0, 10)));
    // Every download is filed under the allowed source and runs at P4.
    const jobs = t.svc.db.all<{ source_id: number; priority: number; requested_by: string }>("SELECT source_id, priority, requested_by FROM download_jobs WHERE requested_by = 'discovery'");
    expect(new Set(jobs.map((j) => j.source_id))).toEqual(new Set([allowed.sourceId]));
    expect(new Set(jobs.map((j) => j.priority))).toEqual(new Set([4]));
  });

  it("minimum score: automatic mode skips low-scoring candidates, and a weight decides which those are", async () => {
    const t = await startDiscoveryTest({ hold: true });
    const src = await seedSourcePage(t);
    const urls = articleUrls(origin(), 10);
    flood(t, { urls, refPageId: src.pageId });
    const user = t.svc.db.get<{ id: number }>("SELECT id FROM users LIMIT 1")!.id;
    for (const u of urls.slice(0, 5)) {
      t.svc.db.run("INSERT INTO bookmarks (public_id, user_id, original_url, url_key, title, page_id, reference_priority, created_at) VALUES (?, ?, ?, ?, '', NULL, 2, ?)", [`bm_${u}`, user, u, t.svc.pipeline.urlKey(u), t.fake.now()]);
    }
    const zero = { inboundArchivedLinks: 0, collectionRelevance: 0, searchFrequency: 0, bookmarks: 100, recentActivity: 0, sourcePriority: 0, estimatedCost: 0, storageHeadroom: 0 };
    await t.settings(automatic(src.sourcePublicId, { minScore: 20 }, { weights: zero }));
    expect(pass(t).active.started).toBe(5);
    expect(new Set(discoveryDownloads(t).map((d) => d.requested_url))).toEqual(new Set(urls.slice(0, 5)));
  });

  it("storage: nothing starts when the volume has no room, or the source has used its budget", async () => {
    const full = await floodedServer({ quotaBytes: 100 * 1024 });
    await full.t.settings(automatic(full.src.sourcePublicId));
    const a = pass(full.t);
    expect(a.active.started).toBe(0);
    expect(a.active.skipped.storage).toBeGreaterThan(0);
    expect(full.t.fetcher.calls).toHaveLength(0);

    const budgeted = await floodedServer();
    budgeted.t.svc.db.run("UPDATE sources SET storage_budget_bytes = ? WHERE id = ?", [64 * 1024, budgeted.src.sourceId]);
    await budgeted.t.settings(automatic(budgeted.src.sourcePublicId));
    const b = pass(budgeted.t);
    expect(b.active.started).toBe(0);
    expect(b.active.skipped.source_budget).toBeGreaterThan(0);
  });

  it("schedule: nothing starts while the download window is shut, everything may when it opens", async () => {
    const { t, src } = await floodedServer();
    // The fake clock reads 22:13 UTC; the only window is 03:00 to 04:00.
    const w = await t.api("PUT", "/api/downloads/windows", { windows: [{ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "03:00", end: "04:00", timezone: "UTC", enabled: true }] });
    expect(w.status).toBe(200);
    await t.settings(automatic(src.sourcePublicId, { respectSchedule: true }));
    const shut = pass(t);
    expect(shut.active.blockedBy).toContain("window_closed");
    expect(shut.active.started).toBe(0);
    await t.settings({ active: { respectSchedule: false } });
    expect(pass(t).active.started).toBeGreaterThan(0);
  });

  it("resources: nothing starts while the disk guard has paused background downloads", async () => {
    const { t, src } = await floodedServer();
    await t.settings(automatic(src.sourcePublicId));
    (t.svc.limits as { diskStatus: () => unknown }).diskStatus = () => ({ paused: true, volumes: [], pausedDownloads: 0 });
    const r = pass(t);
    expect(r.active.blockedBy).toContain("resources");
    expect(r.active.started).toBe(0);
  });

  it("an archived, excluded or already queued address is never downloaded", async () => {
    const t = await startDiscoveryTest({ hold: true });
    const src = await seedSourcePage(t);
    const urls = articleUrls(origin(), 6);
    flood(t, { urls, refPageId: src.pageId });
    await t.seed.page({ url: t.svc.pipeline.urlKey(urls[0]!), sources: [src.sourceId] });          // archived under its key
    t.svc.db.run("INSERT INTO url_exclusions (source_id, url_key, reason, created_at) VALUES (NULL, ?, 'deleted_by_user', ?)", [t.svc.pipeline.urlKey(urls[1]!), t.fake.now()]);
    t.svc.pipeline.captureUrl(urls[2]!, { priority: 3 });                                             // already in the queue
    await t.settings(automatic(src.sourcePublicId));
    expect(pass(t).active.started).toBe(3);
    const started = discoveryDownloads(t).map((d) => d.requested_url);
    expect(started).not.toContain(urls[0]);
    expect(started).not.toContain(urls[1]);
    expect(started).not.toContain(urls[2]);
  });
});

describe("approval mode and offline mode (D-04)", () => {
  it("approval mode downloads nothing without approval, and only what was approved after it", async () => {
    const { t, src } = await floodedServer();
    await t.settings(automatic(src.sourcePublicId, { mode: "approval" }, { acknowledged: undefined }));
    const none = pass(t);
    expect(none.active.started).toBe(0);
    expect(t.fetcher.calls).toHaveLength(0);
    expect(discoveryDownloads(t)).toHaveLength(0);

    const list = (await t.api("GET", "/api/discovery/candidates?includeHidden=true&limit=3")).body.items;
    for (const c of list) expect((await t.api("POST", `/api/discovery/candidates/${c.id}/approve`, {})).status).toBe(200);
    const r = pass(t);
    expect(r.active.started).toBe(3);
    expect(new Set(discoveryDownloads(t).map((d) => d.requested_url))).toEqual(new Set(list.map((c: { url: string }) => c.url)));
    // Dismissed candidates are not downloaded, even when approved before.
    const other = (await t.api("GET", "/api/discovery/candidates?state=new&limit=1")).body.items[0];
    await t.api("POST", `/api/discovery/candidates/${other.id}/approve`, {});
    await t.api("POST", `/api/discovery/candidates/${other.id}/dismiss`, {});
    expect(pass(t).active.started).toBe(0);
  });

  it("offline mode downloads nothing, whatever is approved or flooded", async () => {
    const { t, src } = await floodedServer({ state: "approved" });
    await t.settings(automatic(src.sourcePublicId));
    const off = await t.api("PATCH", "/api/settings", { offline: { forced: true } });
    expect(off.status).toBe(200);
    const r = pass(t);
    expect(r.active.blockedBy).toContain("offline");
    expect(r.active.started).toBe(0);
    expect(discoveryDownloads(t)).toHaveLength(0);
    expect(t.fetcher.calls).toHaveLength(0);
    expect((await t.api("GET", "/api/discovery/runner")).body.state).toBe("blocked");
    // Back online, the same pass works.
    await t.api("PATCH", "/api/settings", { offline: { forced: false } });
    expect(pass(t).active.started).toBeGreaterThan(0);
  });

  it("automatic mode needs an explicit confirmation", async () => {
    const t = await startDiscoveryTest();
    const r = await t.settings({ enabled: true, active: { mode: "automatic" } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("discovery.acknowledged");
    expect((await t.api("GET", "/api/discovery/settings")).body.settings.active.mode).toBe("off");
    // A request cannot supply the confirmation time itself.
    const spoof = await t.settings({ enabled: true, active: { mode: "automatic", automaticAcknowledgedAt: new Date().toISOString() } });
    expect(spoof.status).toBe(400);
    const ok = await t.settings({ active: { mode: "automatic" }, acknowledged: true });
    expect(ok.status).toBe(200);
    expect(ok.body.settings.active.automaticAcknowledgedAt).toBeTruthy();
    // Leaving automatic mode clears it.
    expect((await t.settings({ active: { mode: "approval" } })).body.settings.active.automaticAcknowledgedAt).toBeNull();
  });
});

describe("the kill switch and the global ceiling (D-06)", () => {
  it("stops within one job: nothing starts after it, waiting downloads are cancelled", async () => {
    const { t, src } = await floodedServer();
    await t.settings(automatic(src.sourcePublicId, { maxCandidatesPerRun: 10 }));
    // Stop the runner in the middle of a pass: it reads the switch again before each download.
    const realCapture = t.svc.pipeline.captureUrl.bind(t.svc.pipeline);
    let started = 0;
    (t.svc.pipeline as { captureUrl: typeof realCapture }).captureUrl = (url, o) => {
      const out = realCapture(url, o);
      if (++started === 2) t.svc.discovery.runner.pause("test");
      return out;
    };
    const r = pass(t);
    expect(started).toBe(2);
    expect(r.active.started).toBe(2);
    expect(r.active.blockedBy).toContain("kill_switch");
    (t.svc.pipeline as { captureUrl: typeof realCapture }).captureUrl = realCapture;

    // A later pass starts nothing, by timer or by hand.
    expect(pass(t).active.started).toBe(0);
    t.fetcher.release();
    t.svc.discovery.tickMs = 1;
    t.svc.discovery.tick();
    // Of the two that were started, a waiting one was cancelled when the switch was thrown; a running one was left to finish.
    const left = discoveryDownloads(t);
    expect(left).toHaveLength(2);
    await until(() => t.fetcher.calls.length >= 1 && left.every((d) => ["completed", "failed", "cancelled"].includes(t.svc.db.get<{ s: string }>("SELECT state AS s FROM download_jobs WHERE id = ?", [d.id])!.s)));
    expect(t.fetcher.calls.filter((u) => articleUrls(origin()).includes(u)).length).toBeLessThanOrEqual(2);
    // Resuming lets it go on.
    expect((await t.api("POST", "/api/discovery/resume", {})).body).toEqual({ paused: false });
    expect(pass(t).active.started).toBeGreaterThan(0);
  });

  it("the API pause cancels waiting downloads and reports it", async () => {
    const { t, src } = await floodedServer();
    await t.settings(automatic(src.sourcePublicId, { maxCandidatesPerRun: 20, maxQueued: 20 }));
    pass(t);
    const running = discoveryDownloads(t).length;
    expect(running).toBe(20);
    const p = await t.api("POST", "/api/discovery/pause", {});
    expect(p.status).toBe(200);
    expect(p.body.paused).toBe(true);
    const states = discoveryDownloads(t).map((d) => d.state);
    expect(states.filter((s) => s === "queued")).toHaveLength(0);
    expect(p.body.cancelled).toBe(states.filter((s) => s === "cancelled").length);
    const overview = (await t.api("GET", "/api/discovery")).body;
    expect(overview.killSwitch.paused).toBe(true);
    expect((await t.api("GET", "/api/discovery/runner")).body.state).toBe("paused");
    // Cancelled before they started: the requests are given back.
    t.svc.discovery.runner.reconcile();
    const rows = t.svc.db.all<{ requests: number; state: string }>("SELECT requests, state FROM discovery_ledger WHERE outcome = 'cancelled'");
    expect(rows.every((r) => r.state === "settled")).toBe(true);
  });

  it("the global ceiling cannot be set above the profile maximum, and nothing can be set above the ceiling", async () => {
    const t = await startDiscoveryTest();
    await t.api("PATCH", "/api/settings", { resources: { profile: "pi-lite" } });
    const fields = (r: { body: any }) => (r.body.details?.fields ?? []).map((f: { path: string }) => f.path);
    const depth = await t.settings({ ceilings: { maxDepth: 11 } });
    expect(depth.status).toBe(400);
    expect(fields(depth)).toContain("discovery.ceilings.maxDepth");
    expect(fields(await t.settings({ ceilings: { maxBytesPerDay: 3 * 1024 ** 3 } }))).toContain("discovery.ceilings.maxBytesPerDay");
    expect(fields(await t.settings({ ceilings: { maxRequestsPerDay: 10_001 } }))).toContain("discovery.ceilings.maxRequestsPerDay");
    expect(fields(await t.settings({ ceilings: { maxQueued: 50_001 } }))).toContain("discovery.ceilings.maxQueued");
    expect(fields(await t.settings({ pool: { maxCandidates: 50_001 } }))).toContain("discovery.pool.maxCandidates");
    // Under the ceiling: refused too.
    expect(fields(await t.settings({ active: { maxDepth: 4 } }))).toContain("discovery.active.maxDepth");
    expect(fields(await t.settings({ active: { maxBytesPerDay: 600 * 1024 * 1024 } }))).toContain("discovery.active.maxBytesPerDay");
    // At the maximum is fine.
    expect((await t.settings({ ceilings: { maxDepth: 10, maxQueued: 50_000, maxRequestsPerDay: 10_000, maxBytesPerDay: 2 * 1024 ** 3 } })).status).toBe(200);
    // Nothing was half-saved by the refusals.
    const got = (await t.api("GET", "/api/discovery/settings")).body;
    expect(got.settings.ceilings.maxDepth).toBe(10);
    expect(got.profileMaximums).toMatchObject({ maxDepth: 10, maxRequestsPerDay: 10_000 });
    // A smaller profile lowers what is in force at once.
    await t.settings({ active: { maxDepth: 10 } });
    await t.api("PATCH", "/api/settings", { resources: { profile: "standard" } });
    await t.settings({ ceilings: { maxDepth: 20 }, active: { maxDepth: 20 } });
    await t.api("PATCH", "/api/settings", { resources: { profile: "pi-lite" } });
    expect((await t.api("GET", "/api/discovery/settings")).body.effective.maxDepth).toBe(10);
  });

  it("the depth ceiling is enforced where candidates are created, too", async () => {
    const t = await startDiscoveryTest();
    await t.settings({ enabled: true, passive: { fromBookmarks: true }, active: { maxDepth: 2 } });
    const url = `${origin()}/astronomy`;
    expect(t.svc.discovery.store.add({ url, kind: "link", depth: 2 })).toMatchObject({ outcome: "created" });
    expect(t.svc.discovery.store.add({ url: `${origin()}/moon`, kind: "link", depth: 3 })).toEqual({ outcome: "skipped", reason: "depth" });
    await until(() => true);
  });
});
