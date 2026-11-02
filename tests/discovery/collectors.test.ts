import { describe, expect, it } from "vitest";
import { saveAndWait } from "../integration/browser/helpers.js";
import { startDiscoveryTest, useFixtures, type DiscoveryTest } from "./helpers.js";

const fixtures = useFixtures();
const origin = () => fixtures().urls.article as string;
const candidates = (t: DiscoveryTest) => t.svc.db.all<{ url: string; depth: number; state: string }>("SELECT url, depth, state FROM discovery_candidates ORDER BY id");
const kinds = (t: DiscoveryTest) => t.svc.db.all<{ kind: string }>("SELECT DISTINCT kind FROM candidate_provenance ORDER BY kind").map((r) => r.kind);
const stageState = (t: DiscoveryTest, versionPublicId: string) =>
  t.svc.db.get<{ state: string; detail_json: string | null }>(
    "SELECT s.state, s.detail_json FROM pipeline_stage_runs s JOIN page_versions v ON v.id = s.version_id WHERE v.public_id = ? AND s.stage = 'candidates'", [versionPublicId])!;

describe("passive collectors fire only when their setting is on (D-02)", () => {
  it("links: stage 14 is skipped while off, and collects links of the page that was saved when on", async () => {
    const t = await startDiscoveryTest();
    const off = await saveAndWait(t, `${origin()}/astronomy`);
    expect(off.state).toBe("completed");
    expect(candidates(t)).toHaveLength(0);
    expect(stageState(t, off.versionId!).state).toBe("skipped");

    // Master on but the links collector off: still nothing.
    await t.settings({ enabled: true });
    await saveAndWait(t, `${origin()}/solar-system`);
    expect(candidates(t)).toHaveLength(0);

    // Collector on but master off: still nothing.
    await t.settings({ enabled: false, passive: { fromLinks: true } });
    await saveAndWait(t, `${origin()}/black-holes`);
    expect(candidates(t)).toHaveLength(0);

    await t.settings({ enabled: true, passive: { fromLinks: true } });
    const callsBefore = t.fetcher.calls.length;
    const on = await saveAndWait(t, `${origin()}/planets`);
    const stage = stageState(t, on.versionId!);
    expect(stage.state).toBe("done");
    expect(JSON.parse(stage.detail_json!).created).toBeGreaterThan(0);
    const rows = candidates(t);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.depth === 1 && r.state === "new")).toBe(true);
    // Provenance names the page and the region; the candidates are not the pages already saved.
    const page = t.svc.pipeline.findPageByUrl(`${origin()}/planets`)!;
    const prov = t.svc.db.all<{ kind: string; ref_page_id: number; detail: string }>("SELECT kind, ref_page_id, detail FROM candidate_provenance");
    expect(prov.every((p) => p.kind === "link" && p.ref_page_id === page.id && ["content", "heading", "related"].includes(p.detail))).toBe(true);
    const saved = new Set(["astronomy", "solar-system", "black-holes", "planets"].map((s) => `${origin()}/${s}`));
    expect(rows.some((r) => saved.has(r.url))).toBe(false);
    // Nothing a candidate points at was fetched: collecting is passive.
    const fetched = new Set(t.fetcher.calls.slice(callsBefore));
    expect(rows.some((r) => fetched.has(r.url))).toBe(false);
    expect(t.svc.db.all("SELECT 1 FROM download_jobs WHERE requested_by = 'discovery'")).toHaveLength(0);
  });

  it("links: a page found by discovery produces candidates one level deeper, up to the depth limit", async () => {
    const t = await startDiscoveryTest();
    await t.settings({ enabled: true, passive: { fromLinks: true }, active: { maxDepth: 1 } });
    await saveAndWait(t, `${origin()}/moon`);
    const first = candidates(t);
    expect(first.length).toBeGreaterThan(0);
    // Pretend the runner downloaded a depth-1 candidate: its links would be depth 2, over the limit of 1.
    const c = first[0]!;
    const row = t.svc.db.get<{ id: number }>("SELECT id FROM discovery_candidates WHERE url = ?", [c.url])!;
    const before = candidates(t).length;
    const dl = t.svc.pipeline.captureUrl(c.url, { priority: 4, requestedBy: "discovery", depth: 1 });
    t.svc.db.run("UPDATE download_jobs SET candidate_id = ? WHERE public_id = ?", [row.id, dl.downloadId]);
    await new Promise<void>((resolve, reject) => {
      const end = Date.now() + 30_000;
      const poll = () => {
        const s = t.svc.pipeline.getCapture(dl.downloadId);
        if (s && (s.state === "completed" || s.state === "failed")) return resolve();
        if (Date.now() > end) return reject(new Error("capture did not finish"));
        setTimeout(poll, 25);
      };
      poll();
    });
    expect(candidates(t).filter((r) => r.depth > 1)).toHaveLength(0);
    expect(candidates(t).length).toBeGreaterThanOrEqual(before - 1);
  });

  it("visits: a live page view becomes a candidate only when the collector and history are on", async () => {
    const t = await startDiscoveryTest();
    const url = `${origin()}/online-only/1`;
    const visit = async (u: string) => (await t.api("POST", "/api/browser/resolve", { input: u })).body.resolution.kind;
    expect(await visit(url)).toBe("live");
    expect(candidates(t)).toHaveLength(0);                                     // everything off

    await t.settings({ enabled: true, passive: { fromVisits: false } });
    await visit(`${origin()}/online-only/2`);
    expect(candidates(t)).toHaveLength(0);                                     // collector off

    await t.settings({ passive: { fromVisits: true } });
    await t.api("PATCH", "/api/settings", { privacy: { history: { enabled: false } } });
    const entries = t.svc.db.all("SELECT 1 FROM history_entries").length;
    await visit(`${origin()}/online-only/3`);
    expect(candidates(t)).toHaveLength(0);                                     // history disabled: no visit candidates, ever
    expect(t.svc.db.all("SELECT 1 FROM history_entries")).toHaveLength(entries);

    await t.api("PATCH", "/api/settings", { privacy: { history: { enabled: true } } });
    await visit(`${origin()}/online-only/4`);
    expect(candidates(t).map((c) => c.url)).toEqual([`${origin()}/online-only/4`]);
    expect(kinds(t)).toEqual(["visit"]);
    // A page that is already saved is a visit to the archive, not a candidate.
    await saveAndWait(t, `${origin()}/mars`);
    await visit(`${origin()}/mars`);
    expect(candidates(t)).toHaveLength(1);
    expect(t.fetcher.calls.some((u) => u.includes("online-only"))).toBe(false);   // no fetch for any of this
  });

  it("bookmarks: a bookmark of an unsaved address becomes a candidate when on", async () => {
    const t = await startDiscoveryTest();
    const mark = (u: string) => t.api("POST", "/api/bookmarks", { url: u });
    await mark(`${origin()}/online-only/1`);
    expect(candidates(t)).toHaveLength(0);
    await t.settings({ enabled: true, passive: { fromBookmarks: true } });
    expect((await mark(`${origin()}/online-only/2`)).status).toBeLessThan(300);
    expect(candidates(t).map((c) => c.url)).toEqual([`${origin()}/online-only/2`]);
    await saveAndWait(t, `${origin()}/stars`);
    await mark(`${origin()}/stars`);                                          // saved already: no candidate
    expect(candidates(t)).toHaveLength(1);
    expect(kinds(t)).toEqual(["bookmark"]);
    expect(t.fetcher.calls.some((u) => u.includes("online-only"))).toBe(false);
  });

  it("missing links: the 'not saved yet' page makes a candidate when on", async () => {
    const t = await startDiscoveryTest();
    const shown = (u: string) => t.api("GET", `/api/browser/offline-page?url=${encodeURIComponent(u)}`);
    await shown(`${origin()}/online-only/1`);
    expect(candidates(t)).toHaveLength(0);
    await t.settings({ enabled: true, passive: { fromMissingLinks: true } });
    expect((await shown(`${origin()}/online-only/2`)).body.archived).toBe(false);
    expect(candidates(t).map((c) => c.url)).toEqual([`${origin()}/online-only/2`]);
    expect(kinds(t)).toEqual(["missing_link"]);
    expect(t.fetcher.calls).toHaveLength(0);
  });

  it("every collector off leaves the discovery tables empty after a busy session", async () => {
    const t = await startDiscoveryTest();
    await saveAndWait(t, `${origin()}/jupiter`);
    await t.api("POST", "/api/bookmarks", { url: `${origin()}/online-only/1` });
    await t.api("POST", "/api/browser/resolve", { input: `${origin()}/online-only/2` });
    await t.api("GET", `/api/browser/offline-page?url=${encodeURIComponent(`${origin()}/online-only/3`)}`);
    for (const table of ["discovery_candidates", "candidate_provenance", "discovery_ledger"]) {
      expect(t.svc.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n, table).toBe(0);
    }
    expect(t.svc.db.all("SELECT 1 FROM download_jobs WHERE requested_by = 'discovery'")).toHaveLength(0);
  });
});
