import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addDoc, drained, searchApi, startSearchServer, until } from "./helpers.js";
import { tempDir } from "../server/helpers.js";

const WORDS = ["lamp", "rock", "tide", "wave", "sail", "mast", "keel", "buoy", "port", "dock", "crew", "chart"];

async function seed(t: Awaited<ReturnType<typeof startSearchServer>>, n: number) {
  for (let i = 0; i < n; i++) {
    await addDoc(t, `p${i}.html`, `Page about ${WORDS[i % WORDS.length]} number ${i}`, `This page number ${i} talks about the ${WORDS[i % WORDS.length]} and the ${WORDS[(i + 3) % WORDS.length]} at sea, with enough text to be kept. `.repeat(2));
  }
}
const ranked = async (t: Awaited<ReturnType<typeof startSearchServer>>, qs: string[]) => {
  const out: Record<string, string[]> = {};
  for (const q of qs) out[q] = (await searchApi(t, { query: q })).body.results.map((r: any) => r.pageId);
  return out;
};

describe("S-10 rebuild path (acceptance criterion 19)", () => {
  it("delete index.db, restart: the index rebuilds from stored content with identical results and no refetch", async () => {
    const dataDir = tempDir("ncb-data-");
    const rootsDir = tempDir("ncb-roots-");
    const noFetch = { fetch: async () => { throw new Error("rebuild must not fetch"); } } as never;
    const one = await startSearchServer({ dataDir, rootsDir, server: { captureFetcher: noFetch } });
    await one.svc.search.waitForRebuild();
    await seed(one, 12);
    await drained(one);
    const qs = ["lamp", "tide wave", "astronamy", "page number 7", '"keel"', "buoy -port"];
    const before = await ranked(one, qs);
    expect(Object.values(before).some((l) => l.length > 0)).toBe(true);
    const status = await one.api("GET", "/api/index/status");
    expect(status.body.docs).toBe(12);
    await one.server.close();
    fs.rmSync(path.join(dataDir, "index"), { recursive: true, force: true });

    const two = await startSearchServer({ dataDir, rootsDir, signIn: true, server: { captureFetcher: noFetch } });
    // Before the rebuild finishes the API answers and says what is going on.
    const early = await searchApi(two, { query: "lamp" });
    expect(early.status).toBe(200);
    await until(async () => (await two.api("GET", "/api/index/status")).body.state === "ok", 60_000);
    const after = await ranked(two, qs);
    expect(after).toEqual(before);
    const job = (await two.api("GET", "/api/index/jobs")).body.items[0];
    expect(job).toMatchObject({ kind: "rebuild", state: "done", docsDone: 12 });
    expect((await two.api("GET", "/api/index/status")).body).toMatchObject({ docs: 12, drift: 0 });
  });

  it("a wrong schema version is rebuilt too; the explicit endpoint rebuilds while search keeps answering", async () => {
    const t = await startSearchServer();
    await t.svc.search.waitForRebuild();
    await seed(t, 6);
    await drained(t);
    const first = await t.api("POST", "/api/index/rebuild", {});
    expect(first.status).toBe(202);
    expect((await t.api("POST", "/api/index/rebuild", {})).status).toBe(409);
    for (let i = 0; i < 5; i++) expect((await searchApi(t, { query: "lamp" })).status).toBe(200);
    await t.svc.search.waitForRebuild();
    expect((await t.api("GET", "/api/index/status")).body).toMatchObject({ state: "ok", docs: 6, drift: 0 });
    // changes made during the rebuild are replayed afterwards
    await t.api("POST", "/api/index/rebuild", {});
    await addDoc(t, "late.html", "Late arrival", "This page arrived while the index was rebuilding and must still be found afterwards.");
    await t.svc.search.waitForRebuild();
    await drained(t);
    expect((await searchApi(t, { query: "late arrival" })).body.results).toHaveLength(1);
    const gens = t.svc.db.all<{ state: string }>("SELECT state FROM index_generations ORDER BY id");
    expect(gens.filter((g) => g.state === "active")).toHaveLength(1);
  });

  it("a killed rebuild resumes from its checkpoint", async () => {
    const dataDir = tempDir("ncb-data-");
    const rootsDir = tempDir("ncb-roots-");
    const one = await startSearchServer({ dataDir, rootsDir });
    await one.svc.search.waitForRebuild();
    await seed(one, 12);
    await drained(one);
    await one.server.close();
    fs.rmSync(path.join(dataDir, "index"), { recursive: true, force: true });
    const slow = await startSearchServer({ dataDir, rootsDir, signIn: true, server: { search: { testFlags: { rebuildBatch: 3, slowBatchMs: 400 } } } });
    const jobBefore = slow.svc.db.get<{ id: number }>("SELECT id FROM indexing_jobs WHERE kind = 'rebuild' AND state = 'running'")!.id;
    await until(() => fs.existsSync(path.join(dataDir, "index", "index.rebuild.db")) && Number(slow.svc.db.get<{ d: number }>("SELECT docs_done AS d FROM indexing_jobs WHERE id = ?", [jobBefore])?.d) >= 3, 20_000);
    await slow.svc.search.crashIndexWorker();
    await slow.server.close();
    expect(fs.existsSync(path.join(dataDir, "index", "index.db"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "index", "index.rebuild.db"))).toBe(true);
    const back = await startSearchServer({ dataDir, rootsDir, signIn: true });
    await until(async () => (await back.api("GET", "/api/index/status")).body.state === "ok", 60_000);
    expect((await back.api("GET", "/api/index/status")).body).toMatchObject({ docs: 12, drift: 0 });
    const job = back.svc.db.get<{ id: number; state: string }>("SELECT id, state FROM indexing_jobs WHERE kind = 'rebuild' ORDER BY id DESC LIMIT 1")!;
    expect(job).toEqual({ id: jobBefore, state: "done" });
    expect((await searchApi(back, { query: "tide" })).body.results.length).toBeGreaterThan(0);
  });

  it("drift is detected by the consistency check and repaired", async () => {
    const t = await startSearchServer();
    await t.svc.search.waitForRebuild();
    await seed(t, 8);
    await drained(t);
    const ok = await t.api("POST", "/api/index/check");
    expect(ok.body).toMatchObject({ ok: true, expected: 8, indexed: 8, missing: 0, extra: 0 });
    // Break the link between main.db and the index: no outbox rows for these changes.
    for (const trg of t.svc.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'idxo_%'")) t.svc.db.exec(`DROP TRIGGER ${trg.name}`);
    t.svc.db.run("UPDATE page_versions SET title = 'Changed behind the index' WHERE id = (SELECT latest_version_id FROM pages ORDER BY id LIMIT 1)");
    t.svc.db.run("UPDATE pages SET inbound_count = 40 WHERE id = (SELECT id FROM pages ORDER BY id DESC LIMIT 1)");
    t.svc.db.run("DELETE FROM pages WHERE id = (SELECT id FROM pages ORDER BY id LIMIT 1 OFFSET 3)");
    const bad = await t.api("POST", "/api/index/check");
    expect(bad.body.ok).toBe(false);
    expect(bad.body.extra).toBe(1);
    expect(bad.body.mismatches.some((m: any) => m.field === "inlinks")).toBe(true);
    const fixed = await t.api("POST", "/api/index/check?repair=true");
    expect(fixed.body.repaired).toBeGreaterThanOrEqual(2);
    expect((await t.api("POST", "/api/index/check")).body).toMatchObject({ ok: true, expected: 7, indexed: 7 });
    expect((await t.api("GET", "/api/index/status")).body.lastCheck.ok).toBe(true);
    // optimise
    const opt = await t.api("POST", "/api/index/optimize");
    expect(opt.body.ok).toBe(true);
    expect((await searchApi(t, { query: "tide" })).status).toBe(200);
  });
});
