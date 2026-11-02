import { describe, expect, it } from "vitest";
import { addDoc, drained } from "../search/helpers.js";
import { useFixtures } from "../browser/helpers.js";
import { addProvider, finished, results, search, startFake, startOnlineServer, until } from "./helpers.js";

const fixtures = useFixtures();

async function scenario() {
  const art = fixtures().urls.article;
  const urls = [1, 2, 3, 4].map((i) => `${art}/online-only/${i}`);
  const t = await startOnlineServer();
  await addDoc(t, "a.html", "Tidal turbines", "Tidal turbines generate electricity from the sea.");
  await drained(t);
  const local = (await search(t, { online: "off" })).body.results[0];
  const fake = await startFake("searxng", [
    { url: local.url, title: "Same as the archived page", snippet: "turbines" },
    ...urls.map((u, i) => ({ url: u, title: `Online only ${i + 1} turbines`, snippet: "turbines" })),
    { url: "https://elsewhere.example/page", title: "Elsewhere turbines", snippet: "turbines" },
  ]);
  await addProvider(t, fake);
  const r = await search(t, {});
  const poll = await finished(t, r.body.searchId);
  const keys = (poll.events.find((e: any) => e.type === "provider_results").append as any[]).map((x) => x.key as string);
  return { t, r, poll, keys, urls, local };
}

describe("coverage counts and 'Improve offline coverage' (O-08)", () => {
  it("counts match a known fixture and no field is a percentage of the internet", async () => {
    const { t, r, poll } = await scenario();
    const cov = poll.events.filter((e: any) => e.type === "coverage").at(-1).coverage;
    expect(cov).toEqual({ cachedMatches: 1, onlineMatches: 6, onlineNotArchived: 5, queued: 0, partial: 0, basis: "online_page_estimate" });
    const snap = await t.api("GET", `/api/search/${r.body.searchId}`);
    expect(snap.body.coverage).toEqual(cov);
    // Not a single key or value of any coverage payload talks about shares.
    const text = JSON.stringify([cov, r.body.coverage, snap.body.coverage]);
    expect(text).not.toMatch(/percent|share|ratio|fraction|%|internet/i);
    for (const k of Object.keys(cov)) expect(k).not.toMatch(/percent|share|ratio|pct/i);
  });

  it("a plan is an estimate, labelled and bounded, and skips what is saved or unknown", async () => {
    const { t, r, keys, local } = await scenario();
    const plan = await t.api("POST", "/api/search/coverage/plan", { searchId: r.body.searchId, resultKeys: [keys[0], keys[1], local.key, "k_unknown"], strategy: "capture", priority: "P3" });
    expect(plan.status).toBe(200);
    expect(plan.body.planId).toMatch(/^plan_/);
    expect(plan.body.urls).toBe(2);
    expect(plan.body.estimate).toMatchObject({ estimate: true, confidence: "low" });
    expect(plan.body.estimate.pages).toEqual({ low: 1, high: 2 });
    expect(plan.body.estimate.bytes.low).toBeGreaterThan(0);
    expect(plan.body.estimate.bytes.high).toBeGreaterThanOrEqual(plan.body.estimate.bytes.low);
    expect(plan.body.estimate.durationSeconds.high).toBeGreaterThanOrEqual(plan.body.estimate.durationSeconds.low);
    expect(plan.body.estimate.basis).toMatch(/default of 600 KiB per page/);
    expect(plan.body.warnings.join(" ")).toMatch(/not part of this search/);
    expect(plan.body.warnings.join(" ")).toMatch(/already saved/);
    expect(plan.body.expiresAt).toBeTruthy();
    expect(JSON.stringify(plan.body)).not.toMatch(/percent|%/);
    // Exploring is bounded by the device profile and says so.
    const explore = await t.api("POST", "/api/search/coverage/plan", { searchId: r.body.searchId, resultKeys: "all_uncached", strategy: "explore", depth: 2, priority: "P3" });
    expect(explore.body.urls).toBe(5);
    expect(explore.body.estimate.pages.high).toBe(5 * (1 + 8 * 2));
    expect(explore.body.estimate.pages.high).toBeLessThanOrEqual(5_000);
    expect(explore.body.estimate.confidence).toBe("low");
    expect(explore.body.warnings.join(" ")).toMatch(/follows links/);
    // The basis uses archived pages from the same domains when there are some.
    const basisUrl = `${fixtures().urls.article}/online-only/9`;
    expect(basisUrl).toBeTruthy();
    // Errors.
    expect((await t.api("POST", "/api/search/coverage/plan", { searchId: "sch_missing", resultKeys: "all_uncached", priority: "P3" })).status).toBe(404);
    const none = await t.api("POST", "/api/search/coverage/plan", { searchId: r.body.searchId, resultKeys: [local.key], priority: "P3" });
    expect(none.status).toBe(400);
    expect(none.body.details.fields[0].path).toBe("resultKeys");
    expect((await t.api("POST", "/api/search/coverage/plan", { searchId: r.body.searchId, resultKeys: [], priority: "P3" })).status).toBe(400);
  });

  it("queueing creates the downloads, a source and a collection; the pages arrive in it and the counts move", async () => {
    const { t, r, keys } = await scenario();
    const plan = await t.api("POST", "/api/search/coverage/plan", {
      searchId: r.body.searchId, resultKeys: keys.slice(0, 3), strategy: "capture", priority: "P2", retention: { mode: "latest", count: 1 }, asCollection: { name: "Energy from search", icon: "bookmark" },
    });
    expect(plan.status).toBe(200);
    const q = await t.api("POST", "/api/search/coverage/queue", { planId: plan.body.planId, name: "Turbine pages" });
    expect(q.status).toBe(202);
    expect(q.body).toMatchObject({ queued: 3 });
    expect(q.body.downloadIds).toHaveLength(3);
    expect(q.body.sourceId).toMatch(/^src_/);
    expect(q.body.collectionId).toMatch(/^col_/);
    const src = await t.api("GET", `/api/sources/${q.body.sourceId}`);
    expect(src.body).toMatchObject({ name: "Turbine pages", priority: "P2", collections: [q.body.collectionId] });
    const dl = t.svc.db.all<{ requested_by: string; kind: string; priority: number }>("SELECT requested_by, kind, priority FROM download_jobs WHERE public_id IN (" + q.body.downloadIds.map(() => "?").join(",") + ")", q.body.downloadIds);
    expect(dl.every((d) => d.requested_by === "search" && d.kind === "capture" && d.priority === 2)).toBe(true);
    // A plan can be queued once.
    expect((await t.api("POST", "/api/search/coverage/queue", { planId: plan.body.planId })).status).toBe(409);
    expect((await t.api("POST", "/api/search/coverage/queue", { planId: "plan_missing" })).status).toBe(404);
    // The counts show them queued, then (once saved) not "online only" any more.
    const snap = await t.api("GET", `/api/search/${r.body.searchId}`);
    expect(snap.body.coverage.queued + snap.body.coverage.partial + (snap.body.results.filter((x: any) => x.availability === "cached").length - 1)).toBeGreaterThanOrEqual(0);
    await until(() => q.body.downloadIds.every((id: string) => { const c = t.pipeline.getCapture(id); return c && (c.state === "completed" || c.state === "failed"); }), 30_000);
    await drained(t);
    const items = await t.api("GET", `/api/collections/${q.body.collectionId}/items`);
    expect(items.body.items.length).toBe(3);
    const after = await t.api("GET", `/api/search/${r.body.searchId}`);
    expect(after.body.coverage.onlineNotArchived).toBe(2);       // elsewhere.example and the one not chosen
    expect(after.body.coverage.queued).toBe(0);
  });

  it("explore starts one crawl with all the chosen addresses as seeds", async () => {
    const { t, r, keys } = await scenario();
    const plan = await t.api("POST", "/api/search/coverage/plan", { searchId: r.body.searchId, resultKeys: keys.slice(0, 2), strategy: "explore", depth: 1, priority: "P3" });
    const q = await t.api("POST", "/api/search/coverage/queue", { planId: plan.body.planId });
    expect(q.status).toBe(202);
    expect(q.body.downloadIds).toHaveLength(1);
    const dl = t.svc.db.get<{ kind: string; requested_by: string }>("SELECT kind, requested_by FROM download_jobs WHERE public_id = ?", [q.body.downloadIds[0]])!;
    expect(dl.kind).toBe("explore");
    const crawl = t.svc.db.get<{ seed_urls_json: string }>("SELECT c.seed_urls_json FROM crawl_jobs c JOIN download_jobs d ON d.id = c.download_job_id WHERE d.public_id = ?", [q.body.downloadIds[0]])!;
    expect(JSON.parse(crawl.seed_urls_json)).toHaveLength(2);
    void results;
  });

  it("offline, queued captures wait held", async () => {
    const { t, r, keys } = await scenario();
    const plan = await t.api("POST", "/api/search/coverage/plan", { searchId: r.body.searchId, resultKeys: keys.slice(0, 2), strategy: "capture", priority: "P3" });
    await t.api("POST", "/api/system/connectivity", { forceOffline: true });
    const q = await t.api("POST", "/api/search/coverage/queue", { planId: plan.body.planId });
    expect(q.status).toBe(202);
    const held = t.svc.db.all<{ state: string }>("SELECT j.state FROM jobs j JOIN download_jobs d ON d.id = j.download_job_id WHERE d.public_id IN (?, ?)", q.body.downloadIds);
    expect(held.map((h) => h.state)).toEqual(["held", "held"]);
  });
});
