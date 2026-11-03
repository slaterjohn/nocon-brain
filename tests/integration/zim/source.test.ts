import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerZimSource, ZimError } from "@ncb/server";
import { CHEM_UUID, NOTITLE_UUID, fixtureZims } from "./helpers.js";

const sources: WorkerZimSource[] = [];
afterEach(async () => {
  for (const s of sources.splice(0)) await s.shutdown();
});
function make(o: ConstructorParameters<typeof WorkerZimSource>[0] = {}) {
  const s = new WorkerZimSource({ testHooks: true, hangGraceMs: 300, ...o });
  sources.push(s);
  return s;
}

/** Z-01 (smoke: the native module loads and opens a fixture ZIM) and Z-02 (the ZimSource over worker threads). */
describe("ZimSource: open, read, suggest, search", () => {
  it("opens a fixture ZIM in a worker and reads its metadata", async () => {
    const z = await fixtureZims();
    const s = make();
    const meta = await s.open("zim_a", z.chem);
    expect(meta).toMatchObject({
      uuid: CHEM_UUID, title: "Chemistry (fixture)", language: "eng", flavour: "maxi", creator: "NoConBrain tests", publisher: "NoConBrain",
      hasFulltextIndex: true, hasTitleIndex: true, newNamespaceScheme: true, licenseName: "CC BY-SA 4.0",
    });
    expect(meta.articleCount).toBeGreaterThanOrEqual(7);
    expect(s.health("zim_a")).toBe("ready");
  });

  it("reads entries, follows redirects on request and reports missing ones", async () => {
    const s = make();
    await s.open("zim_a", (await fixtureZims()).chem);
    const e = await s.readEntry("zim_a", "Benzene");
    expect(e).toMatchObject({ kind: "content", mimeType: "text/html" });
    expect(Buffer.from((e as { data: Uint8Array }).data).toString()).toContain("aromatic ring hydrocarbon");
    expect(await s.readEntry("zim_a", "Methylbenzene")).toMatchObject({ kind: "redirect", target: "Toluene" });
    expect(await s.readEntry("zim_a", "Methylbenzene", { follow: true })).toMatchObject({ kind: "content", path: "Toluene" });
    expect(await s.readEntry("zim_a", "Nope")).toEqual({ kind: "missing" });
    expect(await s.hasEntry("zim_a", "I/benzene.png")).toBe(true);
    expect(await s.readEntry("zim_a", "I/benzene.png")).toMatchObject({ kind: "content", mimeType: "image/png" });
  });

  it("full-text search, title suggestions and browsing work; a package without an index refuses full text", async () => {
    const z = await fixtureZims();
    const s = make();
    await s.open("zim_a", z.chem);
    await s.open("zim_b", z.notitle);
    const hits = await s.search("zim_a", "aromatic ring", { limit: 5 });
    expect(hits.hits.map((h) => h.path)[0]).toBe("Aromaticity");
    expect(hits.hits.every((h) => h.score >= 0 && h.score <= 100)).toBe(true);
    expect(hits.partial).toBe(false);
    expect((await s.suggest("zim_a", "benz")).hits.map((h) => h.path)).toContain("Benzene");
    await expect(s.search("zim_b", "aromatic")).rejects.toMatchObject({ zimCode: "no_fulltext" });
    expect((await s.suggest("zim_b", "aromatic")).hits.map((h) => h.path)).toEqual(["Aromatic_notes"]);
    const page1 = await s.browse("zim_a", { limit: 3 });
    expect(page1.items).toHaveLength(3);
    expect(page1.next).toBeTruthy();
    const page2 = await s.browse("zim_a", { after: page1.next!, limit: 50 });
    expect(page2.items.map((x) => x.path)).not.toContain(page1.items[0]!.path);
    // the cursor continues where the last page ended: walking three at a time lists every article once, in title order
    const walked: string[] = [];
    for (let after: string | undefined, i = 0; i < 20; i++) {
      const p = await s.browse("zim_a", { after, limit: 3 });
      walked.push(...p.items.map((x) => x.title));
      if (!p.next) break;
      after = p.next;
    }
    const all = (await s.browse("zim_a", { limit: 200 })).items.map((x) => x.title);
    expect(page2.items.length).toBeGreaterThan(0);
    expect(walked).toEqual(all);
    expect(new Set(walked).size).toBe(walked.length);
    expect(all.length).toBeGreaterThan(3);
    // every listed entry is an article, not a stylesheet or image
    expect([...page1.items, ...page2.items].some((x) => x.path.startsWith("I/") || x.path.endsWith(".css"))).toBe(false);
  });

  it("cache sizes are reported and can be changed", async () => {
    const s = make({ cacheMb: 8 });
    await s.open("zim_a", (await fixtureZims()).chem);
    const a = await s.cacheSizes("zim_a");
    expect(a.clusterMax).toBe(4);
    const b = await s.setCacheSizes("zim_a", { clusterCache: 9, direntCache: 1000 });
    expect(b).toMatchObject({ clusterMax: 9, direntMax: 1000 });
  });

  it("a file that is not a ZIM is rejected as invalid, and the source keeps working", async () => {
    const z = await fixtureZims();
    const s = make();
    await expect(s.open("zim_bad", z.bad)).rejects.toMatchObject({ zimCode: "invalid_zim" });
    expect(s.isOpen("zim_bad")).toBe(false);
    await expect(s.open("zim_gone", path.join(path.dirname(z.bad), "missing.zim"))).rejects.toBeInstanceOf(ZimError);
    expect((await s.open("zim_ok", z.notitle)).uuid).toBe(NOTITLE_UUID);
  });
});

describe("ZimSource: crashes, hangs and time budgets", () => {
  it("a killed worker restarts on the next call, marks the package degraded and then recovers", async () => {
    const health: string[] = [];
    const s = make({ onHealth: (_id, h) => health.push(h) });
    await s.open("zim_a", (await fixtureZims()).chem);
    await s.killWorker("zim_a");
    expect(s.health("zim_a")).toBe("degraded");
    expect(health).toContain("degraded");
    // the server (this process) is alive and the next call starts a fresh worker
    expect(await s.readEntry("zim_a", "Benzene")).toMatchObject({ kind: "content" });
    expect(s.health("zim_a")).toBe("ready");
    expect(health.at(-1)).toBe("ready");
    expect(s.stats.crashes).toBeGreaterThanOrEqual(1);
  });

  it("a worker that exits mid-call fails that call only", async () => {
    const s = make();
    await s.open("zim_a", (await fixtureZims()).chem);
    await expect(s.debug("zim_a", "crash")).rejects.toMatchObject({ zimCode: "worker_crashed" });
    expect(s.health("zim_a")).toBe("degraded");
    expect((await s.suggest("zim_a", "ben")).hits.length).toBeGreaterThan(0);
    expect(s.health("zim_a")).toBe("ready");
  });

  it("libzim aborting its process (an uncaught C++ exception) costs the package its reader, not the server", async () => {
    const s = make();
    await s.open("zim_a", (await fixtureZims()).chem);
    await expect(s.debug("zim_a", "abort")).rejects.toMatchObject({ zimCode: "worker_crashed" });
    expect(s.health("zim_a")).toBe("degraded");
    expect(await s.hasEntry("zim_a", "Benzene")).toBe(true);
  });

  it("thread isolation works too (it is lighter, but an abort would take the host down, so it is opt-in)", async () => {
    const s = make({ isolation: "thread" });
    await s.open("zim_t", (await fixtureZims()).chem);
    expect((await s.suggest("zim_t", "benz")).hits.length).toBeGreaterThan(0);
    await expect(s.debug("zim_t", "crash")).rejects.toMatchObject({ zimCode: "worker_crashed" });
    expect(await s.hasEntry("zim_t", "Benzene")).toBe(true);
  });

  it("an idle reader is stopped to give back its memory and starts again on the next call without being marked degraded", async () => {
    const s = make({ idleMs: 150 });
    await s.open("zim_a", (await fixtureZims()).chem);
    expect(s.workerCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 500));
    expect(s.workerCount()).toBe(0);
    expect(s.health("zim_a")).toBe("ready");
    expect(await s.hasEntry("zim_a", "Benzene")).toBe(true);
    expect(s.workerCount()).toBe(1);
    expect(s.stats.crashes).toBe(0);
  });

  it("a blocked worker is terminated after the time budget plus grace, restarted, and the package is degraded", async () => {
    const s = make({ hangGraceMs: 300 });
    await s.open("zim_a", (await fixtureZims()).chem);
    const t0 = Date.now();
    // A search queued behind a hung call never gets an answer: the watchdog fires after budget + grace.
    void s.debug("zim_a", "hang", undefined, 60_000).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    await expect(s.search("zim_a", "aromatic", { budgetMs: 200 })).rejects.toMatchObject({ zimCode: expect.stringMatching(/worker_hung|worker_crashed/) });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(s.stats.restarts).toBeGreaterThanOrEqual(1);
    expect(s.health("zim_a")).toBe("degraded");
    expect((await s.search("zim_a", "aromatic")).hits.length).toBeGreaterThan(0);
    expect(s.health("zim_a")).toBe("ready");
  });

  it("an exhausted budget returns the partial results found so far", async () => {
    const s = make();
    await s.open("zim_a", (await fixtureZims()).chem);
    // budget 0: the worker checks it after each small chunk, so it stops early with what it has
    const r = await s.search("zim_a", "hydrocarbon", { limit: 50, budgetMs: 0 });
    expect(r.partial).toBe(true);
    expect(r.hits.length).toBeGreaterThan(0);
    const full = await s.search("zim_a", "hydrocarbon", { limit: 50, budgetMs: 5000 });
    expect(full.partial).toBe(false);
    expect(full.hits.length).toBeGreaterThan(r.hits.length);
  });
});
