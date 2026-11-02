import { describe, expect, it } from "vitest";
import { systemClock } from "@ncb/shared";
import { capture } from "../pipeline/helpers.js";
import { startSourcesServer, until, useFixtures } from "../sources/helpers.js";
import { doc, minimalPdf, upload } from "../imports/helpers.js";
import { call, setupAdmin, startServer } from "../server/helpers.js";

const fixtures = useFixtures();
const art = () => fixtures().urls.article;

type T = Awaited<ReturnType<typeof startSourcesServer>>;
const statusOf = async (t: T, id: string) => ((await t.api("GET", `/api/sources/${id}`)).body as { lastStatus: string }).lastStatus;
async function untilAsync<R>(fn: () => Promise<R | undefined | false>, ms = 30_000): Promise<R> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const reaches = (t: T, id: string, want: string, ms = 30_000) => untilAsync(async () => (await statusOf(t, id)) === want || undefined, ms);

describe("item 1: source status follows its downloads", () => {
  it("a single page run ends at ok and a sitemap run only after its last download", async () => {
    const t = await startSourcesServer();
    const one = (await t.api("POST", "/api/sources", { name: "One", type: "single_page", startUrl: `${art()}/moon` })).body;
    await t.api("POST", `/api/sources/${one.id}/run`);
    expect(await statusOf(t, one.id)).toBe("running");
    await reaches(t, one.id, "ok");

    const sm = (await t.api("POST", "/api/sources", { name: "Gazette", type: "sitemap", startUrl: `${fixtures().urls.sitemapFeed}/sitemap-index.xml` })).body;
    const run = await t.api("POST", `/api/sources/${sm.id}/run`);
    expect(run.body.downloadIds.length).toBeGreaterThan(3);
    // While any download is open the source stays running; the moment the last one ends it is ok.
    await untilAsync(async () => {
      const open = t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM download_jobs d JOIN sources s ON s.id = d.source_id WHERE s.public_id = ? AND d.state IN ('queued','running','paused')", [sm.id])!.n;
      if (open > 0) expect(await statusOf(t, sm.id)).toBe("running");
      return open === 0 || undefined;
    }, 90_000);
    await reaches(t, sm.id, "ok");
  }, 150_000);

  it("a website crawl ends at ok", async () => {
    const t = await startSourcesServer({ server: { clock: systemClock, runnerPollMs: 15 } });
    const s = (await t.api("POST", "/api/sources", {
      name: "Graph", type: "website", startUrl: `${fixtures().urls.linkGraph}/n/3`, config: { depth: 0, maxPages: 1, perDomainDelayMs: 1500 }, profile: "custom",
    })).body;
    await t.api("POST", `/api/sources/${s.id}/run`);
    await reaches(t, s.id, "ok", 60_000);
  }, 90_000);

  it("failed and cancelled downloads move a running source off running, whatever ended them", async () => {
    const t = await startSourcesServer();
    const s = (await t.api("POST", "/api/sources", { name: "Two", type: "single_page", startUrl: `${art()}/mars` })).body;
    const rowId = t.svc.sources.resolvePublicId(s.id);
    for (const [state, want] of [["failed", "failed"], ["cancelled", "cancelled"]] as const) {
      t.svc.db.run("UPDATE sources SET last_status = 'running' WHERE id = ?", [rowId]);
      const ins = t.svc.db.run(
        "INSERT INTO download_jobs (public_id, source_id, kind, state, priority, queue_order, requested_by, created_at, finished_at) VALUES (?, ?, 'capture', 'running', 3, 0, 'user', 1, NULL)",
        [`dl_test_${state}`, rowId]);
      t.svc.db.run("UPDATE download_jobs SET state = ?, finished_at = 2 WHERE id = ?", [state, Number(ins.lastInsertRowid)]);
      t.svc.downloads.touch(Number(ins.lastInsertRowid)); // what the pipeline's download event does
      await reaches(t, s.id, want, 10_000);
    }
  });

  it("an event-less ending is caught by the sweep, and an import ends at ok", async () => {
    const t = await startSourcesServer();
    const s = (await t.api("POST", "/api/sources", { name: "Docs", type: "imported_documents" })).body;
    expect(s.lastStatus).toBe("never");
    const up = await upload(t as never, "notes.md", doc("sample.md"), "text/markdown", `?sourceId=${s.id}`);
    expect(up.status).toBe(202);
    await reaches(t, s.id, "ok");
  });
});

describe("items 2, 3, 4, 8: page list filters, detail references, page types", () => {
  it("filters server-side and pages by cursor; detail lists sources and collections; types come from the stored version", async () => {
    const t = await startSourcesServer();
    const a = (await t.api("POST", "/api/sources", { name: "Alpha", type: "single_page", startUrl: `${art()}/astronomy`, priority: "P2" })).body;
    const b = (await t.api("POST", "/api/sources", { name: "Beta", type: "single_page", startUrl: `${art()}/moon`, priority: "P4" })).body;
    const col = (await t.api("POST", "/api/collections", { name: "Space", icon: "folder" })).body;
    const child = (await t.api("POST", "/api/collections", { name: "Moons", icon: "folder", parentId: col.id })).body;
    await t.api("POST", `/api/sources/${a.id}/run`);
    await t.api("POST", `/api/sources/${b.id}/run`);
    await t.settled();

    // A second version of the astronomy page (a forced capture), a day later.
    t.fake.advance(2 * 86_400_000);
    await capture(t, `${art()}/astronomy`, { force: true, versioning: { mode: "all" }, sourceId: t.svc.sources.resolvePublicId(a.id) });
    const imp = await upload(t as never, "log.md", doc("sample.md"), "text/markdown");
    const pdf = await upload(t as never, "paper.pdf", minimalPdf({ title: "Paper", pages: [["Hello PDF"]] }), "application/pdf");
    await until(() => t.pipeline.getCapture(imp.body.downloadId)?.state === "completed" && t.pipeline.getCapture(pdf.body.downloadId)?.state === "completed");

    const list = async (q: string) => (await t.api("GET", `/api/archive/pages?${q}`)) as { status: number; body: { items: any[]; total: number; nextCursor?: string } };
    const ids = (r: { body: { items: any[] } }) => r.body.items.map((p) => p.title).sort();
    const astro = (await list("domain=127.0.0.1&sourceId=" + a.id)).body.items[0];
    expect(astro.versionCount).toBe(2);

    expect((await list(`sourceId=${a.id}`)).body.total).toBe(1);
    expect((await list(`sourceId=${b.id}`)).body.total).toBe(1);
    expect((await list("sourceId=src_00000000000000000000000000")).status).toBe(404);
    expect((await list("minVersions=2")).body.items.map((p) => p.id)).toEqual([astro.id]);
    expect((await list("priority=P2")).body.items.map((p) => p.id)).toEqual([astro.id]);
    expect((await list("priority=P1,P4")).body.total).toBe(1);
    expect((await list("priority=P9")).status).toBe(400);
    expect((await list("type=pdf")).body.items.map((p) => p.type)).toEqual(["pdf"]);
    expect((await list("type=markdown")).body.items.map((p) => p.type)).toEqual(["markdown"]);
    expect((await list("type=html")).body.total).toBe(2);
    expect((await list("type=html,pdf,markdown")).body.total).toBe(4);
    expect((await list("type=docx")).status).toBe(400);

    // Collections: direct and through a sub-collection.
    const moon = (await list(`sourceId=${b.id}`)).body.items[0];
    await t.api("POST", `/api/collections/${child.id}/items`, { add: [{ pageId: moon.id }] });
    expect((await list(`collectionId=${child.id}`)).body.items.map((p) => p.id)).toEqual([moon.id]);
    expect((await list(`collectionId=${col.id}`)).body.items.map((p) => p.id)).toEqual([moon.id]);

    // Dates: from is inclusive, a bare `to` date includes its whole day.
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const last = Date.parse(astro.lastCapturedAt);
    expect((await list(`from=${day(last)}&to=${day(last)}`)).body.items.map((p) => p.id)).toContain(astro.id);
    expect((await list(`to=${day(last - 86_400_000)}`)).body.items.map((p) => p.id)).not.toContain(astro.id);
    expect((await list(`from=${day(last + 5 * 86_400_000)}`)).body.total).toBe(0);
    expect((await list("from=yesterday")).status).toBe(400);

    // Cursor paging over a filtered result.
    const p1 = await list("type=html,pdf,markdown&limit=3&sort=title");
    expect(p1.body.items).toHaveLength(3);
    expect(p1.body.total).toBe(4);
    const p2 = await list(`type=html,pdf,markdown&limit=3&sort=title&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeUndefined();
    expect(ids(p1).concat(ids(p2))).toHaveLength(4);

    // Detail: references and collections. The inline PATCH is not part of the API.
    const d = (await t.api("GET", `/api/archive/pages/${moon.id}`)).body;
    expect(d.sources).toEqual([expect.objectContaining({ id: b.id, name: "Beta", priority: "P4", discoveredVia: "seed", type: "single_page", system: false })]);
    expect(d.collections).toEqual([expect.objectContaining({ id: child.id, name: "Moons" })]);
    expect(d.page.type).toBe("html");
    const dd = (await t.api("GET", `/api/archive/pages/${imp.body.pageId}`)).body;
    expect(dd.page).toMatchObject({ type: "markdown", imported: { filename: "log.md" } });
    expect(dd.sources.map((s: any) => s.systemKind)).toEqual(["imports"]);
    const dp = (await t.api("GET", `/api/archive/pages/${pdf.body.pageId}`)).body;
    expect(dp.page).toMatchObject({ type: "pdf", imported: { filename: "paper.pdf", pageCount: 1 } });
    expect((await t.api("PATCH", `/api/archive/pages/${moon.id}`, { pin: null })).status).toBe(404);
  }, 150_000);

  it("a signed-in user and a trusted-LAN guest can read the page detail", async () => {
    const first = await startServer();
    const cookie = await setupAdmin(first);
    await first.server.close();
    const t = await startServer({ dataDir: first.dataDir, rootsDir: first.rootsDir, env: { NCB_AUTH_MODE: "trusted-lan", NCB_TRUSTED_LAN_CIDRS: "192.168.1.0/24" } });
    const guest = { remoteAddress: "192.168.1.20" };
    // No pages yet: a 404 still proves the route is open to the guest (a closed route would answer 401).
    expect((await call(t, { url: "/api/archive/pages/pg_00000000000000000000000000", ...guest })).statusCode).toBe(404);
    expect((await call(t, { url: "/api/archive/pages", ...guest })).statusCode).toBe(200);
    expect((await call(t, { url: "/api/archive/pages/pg_00000000000000000000000000", cookie, remoteAddress: "203.0.113.9" })).statusCode).toBe(404);
    expect((await call(t, { url: "/api/archive/pages/pg_00000000000000000000000000", remoteAddress: "203.0.113.9" })).statusCode).toBe(401);
  });
});

describe("items 5 and 6: inline schedule window and the first source in setup", () => {
  it("POST /api/sources keeps the window of an inline schedule", async () => {
    const t = await startSourcesServer();
    const s = await t.api("POST", "/api/sources", {
      name: "Nightly", type: "single_page", startUrl: `${art()}/moon`,
      schedule: { kind: "daily", time: "03:00", timezone: "Europe/London", window: { days: ["mon", "tue"], start: "01:00", end: "06:00", timezone: "Europe/London" } },
    });
    expect(s.status).toBe(201);
    expect(s.body.schedule).toMatchObject({ kind: "daily", window: { days: ["mon", "tue"], start: "01:00", end: "06:00", timezone: "Europe/London", enabled: true } });
    expect(s.body.schedule.windowId).toMatch(/^win_/);
    const bad = await t.api("POST", "/api/sources", { name: "Bad", type: "single_page", startUrl: `${art()}/moon`, schedule: { kind: "daily", time: "03:00", window: { start: "01:00", end: "01:00" } } });
    expect(bad.status).toBe(400);
    expect(bad.body.details.fields.map((f: any) => f.path)).toContain("schedule.window.end");
  });

  it("POST /api/setup/first-source creates a page or website source with the default profile and can run it", async () => {
    const t = await startServer();
    const cookie = await setupAdmin(t);
    await t.svc.volumes.register({ path: t.volDir, name: "Main" });
    expect((await call(t, { url: "/api/setup/status" })).json().firstSourceCreated).toBe(false);
    const bad = await call(t, { url: "/api/setup/first-source", body: { url: "ftp://x" }, cookie });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details.fields.map((f: any) => f.path)).toEqual(["url"]);
    const ok = await call(t, { url: "/api/setup/first-source", body: { url: `${art()}/astronomy`, kind: "website" }, cookie });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ source: { type: "website", profile: "balanced", priority: "P3", name: new URL(art()).host, startUrl: `${art()}/astronomy` } });
    expect(ok.json().downloadIds).toBeUndefined();
    expect((await call(t, { url: "/api/setup/status" })).json().firstSourceCreated).toBe(true);
    const page = await call(t, { url: "/api/setup/first-source", body: { url: `${art()}/moon`, name: "Moon", run: true }, cookie });
    expect(page.statusCode).toBe(201);
    expect(page.json()).toMatchObject({ source: { type: "single_page", name: "Moon" }, downloadIds: [expect.stringMatching(/^dl_/)] });
    expect((await call(t, { url: "/api/setup/first-source", body: { url: `${art()}/moon` } })).statusCode).toBe(401);
    await call(t, { url: "/api/setup/complete", body: {}, cookie });
    expect((await call(t, { url: "/api/setup/first-source", body: { url: `${art()}/moon` }, cookie })).statusCode).toBe(409);
  });
});
