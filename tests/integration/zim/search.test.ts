import { describe, expect, it } from "vitest";
import { addDoc, drained } from "../search/helpers.js";
import { startZimServer, type ZimTest } from "./helpers.js";

/** Z-05: federated search over knowledge packages, fused by rank into the combined search. */
async function start(extra: { budget?: number } = {}) {
  const t = await startZimServer({ env: { NCB_EXTRACT_WORKERS: "0", ...(extra.budget ? { NCB_ZIM_SEARCH_BUDGET_MS: String(extra.budget) } : {}) } });
  const chem = (await t.add("chem")).body;
  const notitle = (await t.add("notitle")).body;
  const other = (await t.add("other")).body;
  return { t, chem, notitle, other };
}
const search = (t: ZimTest, body: Record<string, unknown>) => t.api("POST", "/api/search", { online: "off", record: false, ...body });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const zimItems = (r: { results: any[] }): any[] => r.results.filter((x) => x.origin === "zim");

describe("unified search over the archive and the packages", () => {
  it("fuses the local list and each package's list by rank, weights 1.5 and 1.0, k = 60", async () => {
    const { t, chem, notitle, other } = await start();
    await addDoc(t, "ring.html", "Aromatic ring notes", "A page about the aromatic ring in organic chemistry.");
    await drained(t);
    const res = await search(t, { query: "aromatic" });
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b.zim).toMatchObject({ state: "ok", mode: "unified", scope: "mixed", budgetMs: 800 });
    expect(b.tookMs.zim).toBeGreaterThanOrEqual(0);
    const archive = b.results.filter((x: { origin: string }) => x.origin === "archive");
    const zims = zimItems(b);
    expect(archive).toHaveLength(1);
    expect(zims.length).toBeGreaterThan(2);
    // local list: rank 1 at weight 1.5; every package's first hit: rank 1 at weight 1.0, whatever Xapian scored it
    expect(archive[0].fusedScore).toBeCloseTo(1.5 / 61, 6);
    expect(archive[0].attribution).toEqual([{ kind: "local", id: "archive", name: "Archive", rank: 1 }]);
    const firsts = zims.filter((x: { attribution: { rank: number }[] }) => x.attribution[0]!.rank === 1);
    expect(firsts.map((x: { attribution: { id: string }[] }) => x.attribution[0]!.id).sort()).toEqual([chem.id, notitle.id, other.id].sort());
    for (const f of firsts) expect(f.fusedScore).toBeCloseTo(1 / 61, 6);
    // rank, not score: the second hit of a package scores 1/62 even though its Xapian score was something else entirely
    const seconds = zims.filter((x: { attribution: { rank: number }[] }) => x.attribution[0]!.rank === 2);
    for (const s of seconds) expect(s.fusedScore).toBeCloseTo(1 / 62, 6);
    // the order is the fused order: archive first (1.5/61), then equal-rank package hits, then lower ranks
    expect(b.results[0].origin).toBe("archive");
    const scores = b.results.map((x: { fusedScore: number }) => x.fusedScore);
    expect([...scores].sort((x: number, y: number) => y - x)).toEqual(scores);
    // result shape for the UI
    const hit = zims.find((x: { zimPath: string }) => x.zimPath === "Aromaticity");
    expect(hit).toMatchObject({
      origin: "zim", availability: "zim", zimId: chem.id, zimPath: "Aromaticity", title: "Aromaticity", domain: "Chemistry (fixture)", language: "eng",
      url: `zim://${chem.id}/Aromaticity`, actions: { open: `zim://${chem.id}/Aromaticity`, saveForOffline: false }, sourceName: "Chemistry (fixture)",
    });
    expect(hit.key).toMatch(/^k_[0-9a-f]{16}$/);
    const ring = (await search(t, { query: "aromatic ring", scope: "zim" })).body;
    expect(ring.results.some((x: { snippet: string }) => x.snippet.includes("<b>ring</b>"))).toBe(true);
    // the stored search can be read back with the package results in place
    const again = (await t.api("GET", `/api/search/${b.searchId}`)).body;
    expect(zimItems(again).length).toBe(zims.length);
    expect(again.zim.groups).toHaveLength(3);
  });

  it("a package without a full-text index falls back to title suggestions", async () => {
    const { t, notitle } = await start();
    const b = (await search(t, { query: "aromatic" })).body;
    const g = b.zim.groups.find((x: { zimId: string }) => x.zimId === notitle.id);
    expect(g).toMatchObject({ mode: "titles", state: "ok" });
    expect(g.message).toMatch(/no full-text index/);
    expect(g.hits.map((h: { zimPath: string }) => h.zimPath)).toEqual(["Aromatic_notes"]);
    expect(g.hits[0].snippet).toBe("");
    const full = b.zim.groups.find((x: { mode: string }) => x.mode === "fulltext");
    expect(full.hits.length).toBeGreaterThan(0);
  });

  it("federated mode keeps the local results untouched and reports each package apart; the zim scope is packages only", async () => {
    const { t, chem } = await start();
    await addDoc(t, "ring.html", "Aromatic ring notes", "A page about the aromatic ring.");
    await drained(t);
    const fed = (await search(t, { query: "aromatic ring", zim: "federated" })).body;
    expect(fed.results.every((x: { origin: string }) => x.origin === "archive")).toBe(true);
    expect(fed.zim).toMatchObject({ mode: "federated", state: "ok" });
    expect(fed.zim.groups.reduce((n: number, g: { hits: unknown[] }) => n + g.hits.length, 0)).toBeGreaterThan(2);
    const off = (await search(t, { query: "aromatic ring", zim: "off" })).body;
    expect(off.zim).toBeUndefined();
    expect(off.tookMs.zim).toBe(0);

    const only = (await search(t, { query: "aromatic ring", scope: "zim" })).body;
    expect(only.results.length).toBeGreaterThan(2);
    expect(only.results.every((x: { origin: string }) => x.origin === "zim")).toBe(true);
    expect(only.zim).toMatchObject({ scope: "zim" });
    expect(only.tookMs.local).toBe(0);
    expect(only.total).toBe(only.results.length);
    // within the zim scope the order is the fusion of the package lists alone
    expect(only.results[0].fusedScore).toBeCloseTo(1 / 61, 6);
    // restrict to one package by id
    const one = (await search(t, { query: "aromatic ring", scope: "zim", zimIds: [chem.id] })).body;
    expect(new Set(one.results.map((x: { zimId: string }) => x.zimId))).toEqual(new Set([chem.id]));
    // online providers never see a zim-only search
    expect(only.online.state).not.toBe("pending");
  });

  it("filters by language and by enabled state, and caps the number of packages asked", async () => {
    const { t, chem, notitle, other } = await start();
    const ids = (b: { zim: { groups: { zimId: string }[] } }) => b.zim.groups.map((g) => g.zimId).sort();
    expect(ids((await search(t, { query: "aromatic" })).body)).toEqual([chem.id, notitle.id, other.id].sort());
    const fr = (await search(t, { query: "aromatic", filters: { languages: ["fr"] } })).body;
    expect(ids(fr)).toEqual([other.id]);
    expect(fr.zim.skipped.filter((s: { reason: string }) => s.reason === "language")).toHaveLength(2);
    expect(ids((await search(t, { query: "aromatic", filters: { languages: ["en"] } })).body)).toEqual([chem.id, notitle.id].sort());
    expect((await search(t, { query: "aromatic", filters: { languages: ["de"] } })).body.zim.state).toBe("none");

    await t.api("PATCH", `/api/zim/packages/${chem.id}`, { enabledForSearch: false });
    expect(ids((await search(t, { query: "aromatic" })).body)).toEqual([notitle.id, other.id].sort());

    t.svc.settings.patch({ search: { zimMaxPackagesPerSearch: 1 } });
    await t.api("PATCH", `/api/zim/packages/${other.id}`, { priority: "P1" });
    await t.api("PATCH", `/api/zim/packages/${notitle.id}`, { priority: "P3" });
    const capped = (await search(t, { query: "aromatic" })).body;
    expect(ids(capped)).toEqual([other.id]); // the higher priority is asked first
    expect(capped.zim.skipped).toContainEqual({ zimId: notitle.id, title: "Notes without a full-text index", reason: "cap" });
  });

  it("a slow package does not delay the others: it times out at the budget and the rest answer at once", async () => {
    const { t, chem, other } = await start();
    t.svc.settings.patch({ search: { zimSearchBudgetMs: 300 } });
    await t.svc.zim.ensureOpen(t.svc.zim.rowByPublic(chem.id));
    void t.svc.zimSource.debug(chem.id, "sleep", 2500, 10_000).catch(() => undefined); // chem's reader is busy for 2.5 s
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    const b = (await search(t, { query: "aromatic" })).body;
    const took = Date.now() - t0;
    expect(took).toBeLessThan(1500);
    const slow = b.zim.groups.find((g: { zimId: string }) => g.zimId === chem.id);
    const fast = b.zim.groups.find((g: { zimId: string }) => g.zimId === other.id);
    expect(slow).toMatchObject({ state: "timeout", hits: [] });
    expect(slow.message).toMatch(/did not answer within 300 ms/);
    expect(fast).toMatchObject({ state: "ok" });
    expect(fast.hits.length).toBeGreaterThan(0);
    expect(b.tookMs.zim).toBeLessThan(1000);
    // the stuck reader is restarted by its watchdog (budget + grace), the package is marked degraded, then it answers again
    await new Promise((r) => setTimeout(r, 1200));
    const after = (await search(t, { query: "aromatic" })).body;
    expect(after.zim.groups.find((g: { zimId: string }) => g.zimId === chem.id)).toMatchObject({ state: "ok" });
    expect((await t.api("GET", `/api/zim/packages/${chem.id}`)).body.state).toBe("ready");
    expect((await t.api("GET", "/api/zim/status")).body.restarts).toBeGreaterThanOrEqual(1);
  });

  it("a snippet from a package is shown with nothing but <b> in it", async () => {
    const { t } = await start();
    const b = (await search(t, { query: "xyzzy", scope: "zim" })).body;
    const hit = b.results.find((x: { zimPath: string }) => x.zimPath === "Xyzzy_compound");
    expect(hit).toBeTruthy();
    const withoutB = hit.snippet.replace(/<\/?b>/g, "");
    expect(withoutB).not.toMatch(/<|>/);
    expect(hit.snippet).not.toMatch(/<img|<script|<a /i); // libzim escapes the text; whatever arrives is shown as text, never as markup
    expect(hit.titleHtml.replace(/<\/?b>/g, "")).not.toMatch(/<|>/);
  });

  it("the packages are not searched on later pages, for offline-only scope they are, and a search with only operators finds nothing in them", async () => {
    const { t } = await start();
    await addDoc(t, "ring.html", "Aromatic ring notes", "A page about the aromatic ring.");
    await drained(t);
    expect(zimItems((await search(t, { query: "aromatic", page: 2 })).body)).toHaveLength(0);
    expect(zimItems((await search(t, { query: "aromatic", scope: "offline" })).body).length).toBeGreaterThan(0);
    expect(zimItems((await search(t, { query: "aromatic", scope: "documents" })).body)).toHaveLength(0);
    const ops = (await search(t, { query: "site:example.org" })).body;
    expect(ops.zim?.state ?? "none").toBe("none");
  });

  it("a package that stops working is reported and the search still answers", async () => {
    const { t, chem } = await start();
    await t.svc.zim.ensureOpen(t.svc.zim.rowByPublic(chem.id));
    await t.svc.zimSource.killWorker(chem.id);
    const b = (await search(t, { query: "aromatic" })).body;
    expect(b.results.length).toBeGreaterThan(0);
    const g = b.zim.groups.find((x: { zimId: string }) => x.zimId === chem.id);
    expect(["ok", "error"]).toContain(g.state);
    // and it is back for the next one
    const next = (await search(t, { query: "aromatic" })).body;
    expect(next.zim.groups.find((x: { zimId: string }) => x.zimId === chem.id).state).toBe("ok");
  });
});
