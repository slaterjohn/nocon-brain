import { describe, expect, it } from "vitest";
import { seedSourcePage, startDiscoveryTest, useFixtures, type DiscoveryTest } from "./helpers.js";

const fixtures = useFixtures();
const origin = () => fixtures().urls.article as string;
const count = (t: DiscoveryTest, sql: string, args: (string | number)[] = []) => t.svc.db.get<{ n: number }>(sql, args)!.n;

describe("the candidate store (D-01)", () => {
  it("the same address from three sources is one candidate with three provenance rows", async () => {
    const t = await startDiscoveryTest();
    await t.settings({ enabled: true, passive: { fromLinks: true, fromBookmarks: true, fromMissingLinks: true } });
    const a = await seedSourcePage(t, "https://one.example/a");
    const b = await seedSourcePage(t, "https://two.example/b", 3);
    const url = `${origin()}/astronomy`;
    const store = t.svc.discovery.store;
    expect(store.add({ url, kind: "link", depth: 1, refPageId: a.pageId, detail: "content" })).toMatchObject({ outcome: "created" });
    expect(store.add({ url, kind: "link", depth: 1, refPageId: b.pageId, detail: "related" })).toMatchObject({ outcome: "updated" });
    expect(store.add({ url, kind: "bookmark", depth: 0 })).toMatchObject({ outcome: "updated" });
    expect(count(t, "SELECT COUNT(*) AS n FROM discovery_candidates")).toBe(1);
    expect(count(t, "SELECT COUNT(*) AS n FROM candidate_provenance")).toBe(3);
    const list = (await t.api("GET", "/api/discovery/candidates")).body;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ provenanceCount: 3, provenanceKinds: ["bookmark", "link"], depth: 0 });
    const detail = (await t.api("GET", `/api/discovery/candidates/${list.items[0].id}`)).body;
    expect(detail.provenance.map((p: { kind: string }) => p.kind).sort()).toEqual(["bookmark", "link", "link"]);
    expect(detail.provenance.find((p: { pageId?: string }) => p.pageId === a.pagePublicId)).toMatchObject({ kind: "link", detail: "content", pageUrl: "https://one.example/a" });
  });

  it("tracking parameters and fragments do not make a second candidate", async () => {
    const t = await startDiscoveryTest();
    await t.settings({ enabled: true });
    const s = t.svc.discovery.store;
    const base = `${origin()}/moon`;
    s.add({ url: base, kind: "manual", depth: 0 });
    s.add({ url: `${base}?utm_source=x&fbclid=y#top`, kind: "manual", depth: 0 });
    s.add({ url: `${base}/`.replace("/moon/", "/moon"), kind: "manual", depth: 0 });
    expect(count(t, "SELECT COUNT(*) AS n FROM discovery_candidates")).toBe(1);
  });

  it("the same reason on the same day is recorded once, and again the next day", async () => {
    const t = await startDiscoveryTest();
    await t.settings({ enabled: true, passive: { fromLinks: true } });
    const a = await seedSourcePage(t, "https://one.example/a");
    const s = t.svc.discovery.store;
    const url = `${origin()}/mars`;
    for (let i = 0; i < 4; i++) s.add({ url, kind: "link", depth: 1, refPageId: a.pageId });
    expect(count(t, "SELECT COUNT(*) AS n FROM candidate_provenance")).toBe(1);
    t.fake.advance(86_400_000);
    s.add({ url, kind: "link", depth: 1, refPageId: a.pageId });
    expect(count(t, "SELECT COUNT(*) AS n FROM candidate_provenance")).toBe(2);
    // But a page counts once towards "pages that link to it", however many days it was seen.
    const e = (await t.api("GET", `/api/discovery/candidates/${(await t.api("GET", "/api/discovery/candidates")).body.items[0].id}/explain`)).body;
    expect(e.components.find((c: { name: string }) => c.name === "inboundArchivedLinks").raw).toBe(0);   // no `links` rows: nothing archived links here
  });

  it("archived, queued, excluded, dismissed and secret-looking addresses create no candidate", async () => {
    const t = await startDiscoveryTest({ hold: true });
    await t.settings({ enabled: true });
    const s = t.svc.discovery.store;
    const o = origin();
    // archived (under its key, and under an alias)
    const pg = await t.seed.page({ url: t.svc.pipeline.urlKey(`${o}/stars`) });
    expect(s.add({ url: `${o}/stars`, kind: "manual", depth: 0 })).toEqual({ outcome: "skipped", reason: "archived" });
    t.svc.db.run("INSERT INTO page_aliases (url_key, page_id, kind, first_seen_at) VALUES (?, ?, 'redirect', ?)", [t.svc.pipeline.urlKey(`${o}/stars-old`), pg.pageId, t.fake.now()]);
    expect(s.add({ url: `${o}/stars-old`, kind: "manual", depth: 0 })).toEqual({ outcome: "skipped", reason: "archived" });
    // a download already waiting or running
    t.svc.pipeline.captureUrl(`${o}/comets`, { priority: 3 });
    expect(s.add({ url: `${o}/comets`, kind: "manual", depth: 0 })).toEqual({ outcome: "skipped", reason: "in_progress" });
    // excluded by the Human (deleted)
    t.svc.db.run("INSERT INTO url_exclusions (source_id, url_key, reason, created_at) VALUES (NULL, ?, 'deleted_by_user', ?)", [t.svc.pipeline.urlKey(`${o}/galaxies`), t.fake.now()]);
    expect(s.add({ url: `${o}/galaxies`, kind: "manual", depth: 0 })).toEqual({ outcome: "skipped", reason: "excluded" });
    // dismissed stays dismissed
    const made = s.add({ url: `${o}/jupiter`, kind: "manual", depth: 0 });
    expect(made.outcome).toBe("created");
    const id = (await t.api("GET", "/api/discovery/candidates")).body.items[0].id;
    await t.api("POST", `/api/discovery/candidates/${id}/dismiss`, {});
    expect(s.add({ url: `${o}/jupiter`, kind: "bookmark", depth: 0 })).toEqual({ outcome: "skipped", reason: "dismissed" });
    // addresses that look like secrets or actions, and things that are not web pages
    for (const bad of [`${o}/page?token=abc`, `${o}/page?session_id=1`, `${o}/account/reset`, `${o}/login`, `${o}/x?apikey=1`]) {
      expect(s.add({ url: bad, kind: "manual", depth: 0 }), bad).toEqual({ outcome: "skipped", reason: "sensitive" });
    }
    expect(s.add({ url: "ftp://x.example/file", kind: "manual", depth: 0 })).toEqual({ outcome: "skipped", reason: "invalid_url" });
    expect(s.add({ url: "https://user:pw@x.example/", kind: "manual", depth: 0 })).toEqual({ outcome: "skipped", reason: "invalid_url" });
    expect(count(t, "SELECT COUNT(*) AS n FROM discovery_candidates")).toBe(1);   // only the dismissed one
  });

  it("the pool is bounded, and candidates expire and come back when seen again", async () => {
    const t = await startDiscoveryTest();
    await t.settings({ enabled: true, pool: { maxCandidates: 3, expireAfterDays: 2 } });
    const s = t.svc.discovery.store;
    const o = origin();
    const r = ["astronomy", "moon", "mars", "stars", "comets"].map((slug) => s.add({ url: `${o}/${slug}`, kind: "manual", depth: 0 }));
    expect(r.map((x) => x.outcome)).toEqual(["created", "created", "created", "skipped", "skipped"]);
    expect(r[3]).toEqual({ outcome: "skipped", reason: "pool_full" });
    t.fake.advance(3 * 86_400_000);
    expect(s.sweepExpired()).toBe(3);
    expect(s.counts().expired).toBe(3);
    expect(s.add({ url: `${o}/moon`, kind: "bookmark", depth: 0 })).toMatchObject({ outcome: "updated" });
    expect(s.counts()).toMatchObject({ new: 1, expired: 2 });
  });

  it("a candidate that is saved some other way is closed, not suggested", async () => {
    const t = await startDiscoveryTest();
    await t.settings({ enabled: true });
    const o = origin();
    t.svc.discovery.store.add({ url: `${o}/biomass`, kind: "manual", depth: 0 });
    await t.seed.page({ url: t.svc.pipeline.urlKey(`${o}/biomass`) });
    t.svc.discovery.store.sweepExpired();
    expect(t.svc.discovery.store.counts()).toMatchObject({ archived: 1, new: 0 });
  });

  it("a collector that is switched off hides what it brought, without deleting it", async () => {
    const t = await startDiscoveryTest();
    await t.settings({ enabled: true, passive: { fromBookmarks: true } });
    t.svc.discovery.store.add({ url: `${origin()}/moon`, kind: "bookmark", depth: 0 });
    expect((await t.api("GET", "/api/discovery/candidates")).body.total).toBe(1);
    await t.settings({ passive: { fromBookmarks: false } });
    expect((await t.api("GET", "/api/discovery/candidates")).body.total).toBe(0);
    expect((await t.api("GET", "/api/discovery/candidates?includeHidden=true")).body.total).toBe(1);
    await t.settings({ passive: { fromBookmarks: true }, enabled: false });
    expect((await t.api("GET", "/api/discovery/candidates")).body.total).toBe(0);
    await t.settings({ enabled: true });
    expect((await t.api("GET", "/api/discovery/candidates")).body.total).toBe(1);
  });
});

describe("listing, filtering and sorting (D-07 contract)", () => {
  it("filters by state, provenance, host, text, score and source, sorts and pages", async () => {
    const t = await startDiscoveryTest();
    await t.settings({ enabled: true, passive: { fromLinks: true, fromBookmarks: true }, active: { maxDepth: 2 } });
    const src = await seedSourcePage(t, "https://one.example/a");
    const other = await seedSourcePage(t, "https://two.example/b", 4);
    const s = t.svc.discovery.store;
    const o = origin();
    for (const slug of ["astronomy", "moon", "mars"]) s.add({ url: `${o}/${slug}`, kind: "link", depth: 1, refPageId: src.pageId });
    s.add({ url: `${o}/stars`, kind: "bookmark", depth: 0 });
    s.add({ url: `${o}/comets`, kind: "link", depth: 2, refPageId: other.pageId });
    const get = async (q: string) => (await t.api("GET", `/api/discovery/candidates${q}`)).body;
    expect((await get("")).total).toBe(5);
    expect((await get("?provenance=bookmark")).items.map((i: { url: string }) => i.url)).toEqual([`${o}/stars`]);
    expect((await get(`?sourceId=${src.sourcePublicId}`)).total).toBe(3);
    expect((await get(`?sourceId=${other.sourcePublicId}`)).total).toBe(1);
    expect((await get("?q=MOON")).total).toBe(1);
    expect((await get("?host=127.0.0.1")).total).toBe(5);
    expect((await get("?host=nowhere.example")).total).toBe(0);
    expect((await get("?state=approved")).total).toBe(0);
    expect((await get("?state=new,approved")).counts).toMatchObject({ new: 5 });
    const byScore = (await get("?sort=score")).items.map((i: { score: number }) => i.score);
    expect(byScore).toEqual([...byScore].sort((a, b) => b - a));
    const byScoreAsc = (await get("?sort=-score")).items.map((i: { score: number }) => i.score);
    expect(byScoreAsc).toEqual([...byScore].reverse());
    expect((await get("?sort=depth")).items[0].depth).toBe(0);
    const p1 = await get("?limit=2&sort=oldest");
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBe("2");
    const p3 = await get(`?limit=2&sort=oldest&cursor=4`);
    expect(p3.items).toHaveLength(1);
    expect(p3.nextCursor).toBeUndefined();
    expect((await get(`?minScore=${byScore[0] + 1}`)).total).toBe(0);
    expect((await t.api("GET", "/api/discovery/candidates?sort=nope")).status).toBe(400);
    expect((await t.api("GET", "/api/discovery/candidates?state=nope")).status).toBe(400);
  });
});
