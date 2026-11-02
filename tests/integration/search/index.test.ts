import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addDoc, drained, searchApi, startSearchServer, until } from "./helpers.js";

describe("S-01/S-02 index bootstrap, outbox and stage 12", () => {
  it("a capture becomes searchable within seconds and a delete removes it", async () => {
    const t = await startSearchServer();
    await t.svc.search.waitForRebuild();
    const page = await addDoc(t, "lighthouse.html", "Lighthouse keeper's log", "The keeper writes about fog signals and the great lamp of the lighthouse.");
    const t0 = Date.now();
    const hit = await until(async () => {
      const r = await searchApi(t, { query: "fog signals" });
      return r.body.results?.length ? r : undefined;
    }, 10_000).catch(() => undefined);
    expect(hit).toBeDefined();
    expect(Date.now() - t0).toBeLessThan(10_000);
    const res = hit!.body.results[0];
    expect(res.pageId).toBe(page.pageId);
    expect(res.snippet).toContain("<mark>");
    expect(res.origin).toBe("archive");
    expect(res.availability).toBe("cached");
    // delete -> gone
    const del = await t.api("DELETE", `/api/archive/pages/${page.pageId}`);
    expect(del.status).toBeLessThan(300);
    await drained(t);
    const after = await searchApi(t, { query: "fog signals" });
    expect(after.body.results).toHaveLength(0);
    // the outbox is pruned once applied
    await until(() => t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM index_outbox")!.n === 0, 10_000);
  });

  it("index status reports generation, size and zero drift", async () => {
    const t = await startSearchServer();
    await t.svc.search.waitForRebuild();
    await addDoc(t, "a.html", "Alpha document", "Alpha beta gamma delta epsilon text for the status test.");
    await drained(t);
    const s = await t.api("GET", "/api/index/status");
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ state: "ok", engine: "fts5", docs: 1, expectedDocs: 1, drift: 0, schemaVersion: 1 });
    expect(s.body.sizeBytes).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(t.dataDir, "index", "index.db"))).toBe(true);
  });

  it("propagates in-links, priority, eviction and collection changes; replaying the outbox is idempotent", async () => {
    const t = await startSearchServer();
    await t.svc.search.waitForRebuild();
    const a = await addDoc(t, "one.html", "Granite quarry", "The granite quarry supplies stone for the harbour wall and the old bridge near the town.");
    const b = await addDoc(t, "two.html", "Slate quarry", "The slate quarry supplies roofing slate for houses and the old bridge near the town.");
    await drained(t);
    const q = async (debug = true) => (await searchApi(t, { query: "quarry supplies", debug })).body.results as any[];
    const comp = (r: any, n: string) => r.explain.components.find((c: any) => c.name === n).value;
    const row = (id: string) => t.svc.db.get<{ id: number }>("SELECT id FROM pages WHERE public_id = ?", [id])!.id;
    expect(comp((await q()).find((r) => r.pageId === a.pageId), "linkGraph")).toBe(0);
    t.svc.db.run("UPDATE pages SET inbound_count = 60 WHERE id = ?", [row(a.pageId)]);
    await drained(t);
    expect(comp((await q()).find((r) => r.pageId === a.pageId), "linkGraph")).toBeGreaterThan(0.5);
    // duplicate and replayed outbox rows change nothing
    for (let i = 0; i < 5; i++) t.svc.db.run("INSERT INTO index_outbox (op, page_id, queued_at) VALUES ('upsert_page', ?, 1)", [row(a.pageId)]);
    await drained(t);
    expect((await t.api("GET", "/api/index/status")).body.docs).toBe(2);
    expect((await q(false)).filter((r) => r.pageId === a.pageId)).toHaveLength(1);
    // eviction removes the document
    t.svc.db.run("UPDATE pages SET availability = 'evicted' WHERE id = ?", [row(b.pageId)]);
    await drained(t);
    expect((await q(false)).map((r) => r.pageId)).toEqual([a.pageId]);
    // and an unmarked page comes back when it is archived again
    t.svc.db.run("UPDATE pages SET availability = 'archived' WHERE id = ?", [row(b.pageId)]);
    await drained(t);
    expect(await q(false)).toHaveLength(2);
    // moving a collection under a parent makes the filter follow the ancestors
    const parent = await t.api("POST", "/api/collections", { name: "Parent" });
    const child = await t.api("POST", "/api/collections", { name: "Child" });
    await t.api("POST", `/api/collections/${child.body.id}/items`, { add: [{ pageId: b.pageId }] });
    await drained(t);
    expect((await searchApi(t, { query: "quarry", filters: { collections: [parent.body.id] } })).body.results).toHaveLength(0);
    await t.api("PATCH", `/api/collections/${child.body.id}`, { parentId: parent.body.id });
    await drained(t);
    expect((await searchApi(t, { query: "quarry", filters: { collections: [parent.body.id] } })).body.results.map((r: any) => r.pageId)).toEqual([b.pageId]);
  });
});
