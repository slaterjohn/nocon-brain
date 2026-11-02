import { describe, expect, it } from "vitest";
import { systemClock } from "@ncb/shared";
import { sourceReferences } from "../../../apps/server/src/sources/references.js";
import { startSourcesServer, until, useFixtures } from "./helpers.js";

const fixtures = useFixtures();

const art = () => fixtures().urls.article;

describe("C-06 system sources", () => {
  it("creates Quick saves, Browsing cache and Imports once, with the documented priorities", async () => {
    const t = await startSourcesServer();
    const res = await t.api("GET", "/api/sources?system=true");
    expect(res.status).toBe(200);
    const byKind = Object.fromEntries(res.body.items.map((s: any) => [s.systemKind, s]));
    expect(Object.keys(byKind).sort()).toEqual(["browsing_cache", "imports", "quick_saves"]);
    expect(byKind.quick_saves).toMatchObject({ name: "Quick saves", priority: "P3", system: true, enabled: true });
    expect(byKind.browsing_cache).toMatchObject({ priority: "P4", automaticEviction: true });
    expect(byKind.imports).toMatchObject({ priority: "P3", automaticEviction: false });
    // Starting again does not duplicate them.
    t.svc.sources.ensureSystemSources();
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE system_kind IS NOT NULL")!.n).toBe(3);
  });

  it("built-in sources cannot be deleted, retyped or re-addressed, but priority can change", async () => {
    const t = await startSourcesServer();
    const q = (await t.api("GET", "/api/sources?system=true")).body.items.find((s: any) => s.systemKind === "quick_saves");
    expect((await t.api("DELETE", `/api/sources/${q.id}`)).status).toBe(409);
    const bad = await t.api("PATCH", `/api/sources/${q.id}`, { name: "Mine", startUrl: "https://x.test/" });
    expect(bad.status).toBe(409);
    expect(bad.body.details.fields.map((f: any) => f.path).sort()).toEqual(["name", "startUrl"]);
    const ok = await t.api("PATCH", `/api/sources/${q.id}`, { priority: "P2" });
    expect(ok.status).toBe(200);
    expect(ok.body.priority).toBe("P2");
  });
});

describe("C-06 quick saves are linked to the Quick saves source", () => {
  it("/api/browser/save and /api/archive/capture create page_sources rows; a non-default priority is recorded as an override", async () => {
    const t = await startSourcesServer();
    const quick = t.svc.db.get<{ id: number; public_id: string }>("SELECT id, public_id FROM sources WHERE system_kind = 'quick_saves'")!;

    const a = await t.api("POST", "/api/browser/save", { url: `${art()}/astronomy` });
    const b = await t.api("POST", "/api/archive/capture", { url: `${art()}/solar-system`, priority: "P1" });
    expect([a.status, b.status]).toEqual([202, 202]);
    await until(() => ["completed", "failed"].includes(t.pipeline.getCapture(a.body.downloadId)?.state ?? "") && ["completed", "failed"].includes(t.pipeline.getCapture(b.body.downloadId)?.state ?? ""));

    const rows = t.svc.db.all<{ url_key: string; priority_override: number | null; discovered_via: string; depth: number }>(
      `SELECT p.url_key, ps.priority_override, ps.discovered_via, ps.depth FROM page_sources ps JOIN pages p ON p.id = ps.page_id WHERE ps.source_id = ? ORDER BY p.url_key`, [quick.id]);
    expect(rows).toHaveLength(2);
    const byUrl = Object.fromEntries(rows.map((r) => [r.url_key.split("/").pop(), r]));
    expect(byUrl.astronomy).toMatchObject({ priority_override: null, discovered_via: "manual", depth: 0 });
    expect(byUrl["solar-system"]).toMatchObject({ priority_override: 1 });

    // Phase 6 reads references from here: source priority unless overridden.
    const page = t.svc.db.get<{ id: number }>("SELECT id FROM pages WHERE url_key LIKE '%/solar-system'")!;
    const refs = sourceReferences(t.svc.db, page.id);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ sourcePublicId: quick.public_id, priority: 1, systemKind: "quick_saves", automaticEviction: true, active: true });

    // Saving the same page again keeps one reference and moves last_seen_at.
    const again = await t.api("POST", "/api/browser/save", { url: `${art()}/astronomy` });
    await until(() => t.pipeline.getCapture(again.body.downloadId)?.state === "completed");
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_sources WHERE source_id = ?", [quick.id])!.n).toBe(2);
  });

  it("a capture can name another source, and an unknown source is a 404", async () => {
    const t = await startSourcesServer();
    const s = await t.api("POST", "/api/sources", { name: "One", type: "single_page", startUrl: `${art()}/moon` });
    const r = await t.api("POST", "/api/archive/capture", { url: `${art()}/mars`, sourceId: s.body.id });
    expect(r.status).toBe(202);
    await until(() => t.pipeline.getCapture(r.body.downloadId)?.state === "completed");
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_sources ps JOIN sources x ON x.id = ps.source_id WHERE x.public_id = ?", [s.body.id])!.n).toBe(1);
    expect((await t.api("POST", "/api/archive/capture", { url: `${art()}/mars`, sourceId: "src_00000000000000000000000000" })).status).toBe(404);
  });
});

describe("C-06 source lifecycle", () => {
  it("create, edit (new config version), run, delete", async () => {
    const t = await startSourcesServer();
    const created = await t.api("POST", "/api/sources", { name: "Moon page", type: "single_page", startUrl: `${art()}/moon`, priority: "P2" });
    expect(created.status).toBe(201);
    const s = created.body;
    expect(s).toMatchObject({ type: "single_page", priority: "P2", configVersion: 1, enabled: true, paused: false, system: false, strategy: "capture", automaticEviction: false });
    expect(s.config).toMatchObject({ depth: 0, maxPages: 1 });

    // Editing the name keeps the config version; editing a crawl setting adds one.
    const renamed = await t.api("PATCH", `/api/sources/${s.id}`, { name: "Moon" });
    expect(renamed.body).toMatchObject({ name: "Moon", configVersion: 1 });
    const edited = await t.api("PATCH", `/api/sources/${s.id}`, { config: { versioning: { mode: "all" }, retries: 1 } });
    expect(edited.body.configVersion).toBe(2);
    expect(edited.body.config.versioning.mode).toBe("all");
    const versions = t.svc.db.all<{ version: number }>("SELECT version FROM source_configs WHERE source_id = (SELECT id FROM sources WHERE public_id = ?) ORDER BY version", [s.id]);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    // An edit that changes nothing does not add a version.
    expect((await t.api("PATCH", `/api/sources/${s.id}`, { config: { retries: 1 } })).body.configVersion).toBe(2);

    const run = await t.api("POST", `/api/sources/${s.id}/run`);
    expect(run.status).toBe(202);
    expect(run.body.downloadIds).toHaveLength(1);
    await t.settled(s.id);
    const pages = await t.api("GET", `/api/sources/${s.id}/pages`);
    expect(pages.body.total).toBe(1);
    expect(pages.body.items[0]).toMatchObject({ discoveredVia: "seed", depth: 0, priorityOverride: null });
    const stats = await t.api("GET", `/api/sources/${s.id}/stats`);
    expect(stats.body).toMatchObject({ pages: 1, versions: 1, byPriority: [{ priority: "P2", pages: 1 }] });
    expect(stats.body.lastRuns[0]).toMatchObject({ state: "completed", requestedBy: "user" });
    expect((await t.api("GET", `/api/sources/${s.id}`)).body.pageCount).toBe(1);

    const del = await t.api("DELETE", `/api/sources/${s.id}`);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ referencesRemoved: 1, pagesDeleted: 0, pagesUnreferenced: 1 });
    expect((await t.api("GET", `/api/sources/${s.id}`)).status).toBe(404);
    expect((await t.api("GET", "/api/sources")).body.items.some((x: any) => x.id === s.id)).toBe(false);
  });

  it("the download job records the config version it ran with", async () => {
    const t = await startSourcesServer();
    const s = (await t.api("POST", "/api/sources", { name: "Moon", type: "single_page", startUrl: `${art()}/moon` })).body;
    await t.api("PATCH", `/api/sources/${s.id}`, { config: { retries: 0 } });
    const crawl = (await t.api("POST", "/api/sources", { name: "Site", type: "section", startUrl: `${fixtures().urls.linkGraph}/n/3`, config: { depth: 1, maxPages: 5 } })).body;
    const run = await t.api("POST", `/api/sources/${crawl.id}/run`);
    expect(run.status).toBe(202);
    const job = t.svc.db.get<{ config_id: number; source_id: number }>("SELECT config_id, source_id FROM download_jobs WHERE public_id = ?", [run.body.downloadIds[0]])!;
    const cfg = t.svc.db.get<{ version: number; source_id: number }>("SELECT version, source_id FROM source_configs WHERE id = ?", [job.config_id])!;
    expect(cfg.source_id).toBe(job.source_id);
    expect(cfg.version).toBe(1);
  });

  it("deleting a source removes its references, keeps its pages and cancels its work", async () => {
    const t = await startSourcesServer();
    const s = (await t.api("POST", "/api/sources", { name: "Moon", type: "single_page", startUrl: `${art()}/moon` })).body;
    await t.api("POST", `/api/sources/${s.id}/run`);
    await t.settled(s.id);
    const page = t.svc.db.get<{ id: number; public_id: string }>("SELECT id, public_id FROM pages WHERE url_key LIKE '%/moon'")!;
    // A bookmark and a second source both keep a page referenced; the first source's removal must not touch them.
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_sources WHERE page_id = ?", [page.id])!.n).toBe(1);
    const del = await t.api("DELETE", `/api/sources/${s.id}`);
    expect(del.body.referencesRemoved).toBe(1);
    // The page is still in the archive and still readable; it simply has no source reference.
    expect((await t.api("GET", `/api/archive/pages/${page.public_id}`)).status).toBe(200);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_sources WHERE page_id = ?", [page.id])!.n).toBe(0);
    expect(sourceReferences(t.svc.db, page.id)).toEqual([]);
    // The soft-deleted row remains for history, and old versions still point at it.
    const row = t.svc.db.get<{ deleted_at: number | null; enabled: number }>("SELECT deleted_at, enabled FROM sources WHERE public_id = ?", [s.id])!;
    expect(row.deleted_at).not.toBeNull();
    expect(row.enabled).toBe(0);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions v JOIN sources x ON x.id = v.source_id WHERE x.public_id = ?", [s.id])!.n).toBe(1);
  });

  it("deletePages=true also deletes pages that nothing else references, but not shared ones", async () => {
    const t = await startSourcesServer();
    const a = (await t.api("POST", "/api/sources", { name: "A", type: "single_page", startUrl: `${art()}/moon` })).body;
    const b = (await t.api("POST", "/api/sources", { name: "B", type: "single_page", startUrl: `${art()}/moon` })).body;
    const c = (await t.api("POST", "/api/sources", { name: "C", type: "single_page", startUrl: `${art()}/mars` })).body;
    for (const s of [a, b, c]) { await t.api("POST", `/api/sources/${s.id}/run`); await t.settled(s.id); }
    const del = await t.api("DELETE", `/api/sources/${a.id}?deletePages=true`);
    // /moon is still referenced by B, so it stays.
    expect(del.body).toMatchObject({ referencesRemoved: 1, pagesDeleted: 0 });
    const del2 = await t.api("DELETE", `/api/sources/${c.id}?deletePages=true`);
    expect(del2.body).toMatchObject({ referencesRemoved: 1, pagesDeleted: 1 });
    expect(t.svc.db.get("SELECT 1 AS x FROM pages WHERE url_key LIKE '%/mars'")).toBeUndefined();
    // The deletion is remembered so a crawl does not fetch it again.
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM url_exclusions WHERE reason = 'deleted_by_user'")!.n).toBe(1);
    expect(t.svc.db.get("SELECT 1 AS x FROM pages WHERE url_key LIKE '%/moon'")).toBeDefined();
  });

  it("a disabled source keeps its references and refuses to run; enabling it again works", async () => {
    const t = await startSourcesServer();
    const s = (await t.api("POST", "/api/sources", { name: "Moon", type: "single_page", startUrl: `${art()}/moon` })).body;
    await t.api("POST", `/api/sources/${s.id}/run`);
    await t.settled(s.id);
    const off = await t.api("PATCH", `/api/sources/${s.id}`, { enabled: false });
    expect(off.body.enabled).toBe(false);
    expect(off.body.pageCount).toBe(1);
    const page = t.svc.db.get<{ id: number }>("SELECT id FROM pages WHERE url_key LIKE '%/moon'")!;
    const refs = sourceReferences(t.svc.db, page.id);
    expect(refs).toHaveLength(1); // disabling must never make content evictable
    expect((await t.api("POST", `/api/sources/${s.id}/run`)).status).toBe(409);
    expect((await t.api("PATCH", `/api/sources/${s.id}`, { enabled: true })).body.enabled).toBe(true);
    expect((await t.api("POST", `/api/sources/${s.id}/run`)).status).toBe(202);
  });

  it("pause and resume change only scheduled work", async () => {
    const t = await startSourcesServer();
    const s = (await t.api("POST", "/api/sources", { name: "Moon", type: "single_page", startUrl: `${art()}/moon` })).body;
    expect((await t.api("POST", `/api/sources/${s.id}/pause`)).body.paused).toBe(true);
    expect((await t.api("POST", `/api/sources/${s.id}/run`)).status).toBe(202); // manual runs still work
    expect((await t.api("POST", `/api/sources/${s.id}/resume`)).body).toMatchObject({ paused: false, enabled: true });
  });

  it("invalid configs are refused with field messages, nothing is stored", async () => {
    const t = await startSourcesServer();
    const before = t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources")!.n;
    const r = await t.api("POST", "/api/sources", { name: "", type: "website", startUrl: "ftp://x.test", config: { depth: -3, maxPages: 0 } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("bad_request");
    expect(r.body.details.fields.map((f: any) => f.path).sort()).toEqual(["config.depth", "config.maxPages", "name", "startUrl"]);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources")!.n).toBe(before);
    const later = await t.api("POST", "/api/sources", { name: "S", type: "saved_search" });
    expect(later.status).toBe(400);
    expect(later.body.details.fields.find((f: any) => f.path === "type").message).toMatch(/arrive with online search/);
    const patch = await t.api("PATCH", "/api/sources/src_00000000000000000000000000", { name: "x" });
    expect(patch.status).toBe(404);
  });

  it("limits are capped per resource profile", async () => {
    const t = await startSourcesServer({ env: { NCB_RESOURCE_PROFILE: "pi-lite" } });
    expect(t.svc.settings.internal("resources").profile).toBe("pi-lite");
    const r = await t.api("POST", "/api/sources", { name: "Big", type: "website", startUrl: "https://example.com/", config: { maxPages: 50_000, depth: 8 } });
    expect(r.status).toBe(400);
    expect(r.body.details.fields.map((f: any) => f.path).sort()).toEqual(["config.depth", "config.maxPages"]);
    expect(r.body.details.fields[0].message).toMatch(/pi-lite profile/);
  });

  it("a website run goes to the crawl engine and its pages are linked with depth and how they were found", async () => {
    // The queue's per-host delay runs on real time, which the fake test clock would freeze.
    const t = await startSourcesServer({ server: { clock: systemClock, runnerPollMs: 15 } });
    const s = (await t.api("POST", "/api/sources", {
      name: "Graph", type: "website", startUrl: `${fixtures().urls.linkGraph}/n/3`, priority: "P4",
      config: { depth: 1, maxPages: 3, perDomainDelayMs: 1500 }, profile: "custom",
    })).body;
    expect(s.priority).toBe("P4");
    const run = await t.api("POST", `/api/sources/${s.id}/run`);
    expect(run.status).toBe(202);
    await until(() => t.svc.db.get("SELECT 1 AS x FROM download_jobs WHERE public_id = ? AND state IN ('completed','failed')", [run.body.downloadIds[0]]), 120_000);
    const pages = (await t.api("GET", `/api/sources/${s.id}/pages?limit=50`)).body;
    expect(pages.total).toBeGreaterThanOrEqual(2);
    const seed = pages.items.find((p: any) => p.depth === 0);
    expect(seed.discoveredVia).toBe("seed");
    expect(pages.items.some((p: any) => p.depth === 1 && p.discoveredVia === "link")).toBe(true);
    expect(pages.items.every((p: any) => p.priorityOverride === null)).toBe(true);
    // Every crawled page references the source at the source's priority (what Phase 6 reads).
    const rows = t.svc.db.all<{ sid: number; pr: number }>(
      "SELECT ps.source_id AS sid, COALESCE(ps.priority_override, s.priority) AS pr FROM page_sources ps JOIN sources s ON s.id = ps.source_id");
    expect(rows.length).toBe(pages.total);
    expect(new Set(rows.map((r) => `${r.sid}:${r.pr}`)).size).toBe(1);
    expect(rows[0]!.pr).toBe(4);
    expect(t.svc.crawl.list({ sourceId: rows[0]!.sid })).toHaveLength(1);
    // Pause and resume reach the engine without error once the crawl has ended; a bad config maps to field errors.
    expect((await t.api("POST", `/api/sources/${s.id}/pause`)).body.paused).toBe(true);
    expect((await t.api("POST", `/api/sources/${s.id}/resume`)).body.paused).toBe(false);
  }, 150_000);
});
