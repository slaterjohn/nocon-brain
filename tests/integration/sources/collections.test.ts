import { describe, expect, it } from "vitest";
import { collectionReferences } from "../../../apps/server/src/collections/references.js";
import { startSourcesServer, until, useFixtures, type SourcesTest } from "./helpers.js";

const fixtures = useFixtures();
const art = () => fixtures().urls.article;

async function save(t: SourcesTest, slugs: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const slug of slugs) {
    const r = await t.api("POST", "/api/browser/save", { url: `${art()}/${slug}` });
    const cap = await until(() => {
      const c = t.pipeline.getCapture(r.body.downloadId);
      return c && (c.state === "completed" || c.state === "failed") ? c : undefined;
    });
    ids.push(cap.pageId!);
  }
  return ids;
}

const col = async (t: SourcesTest, body: Record<string, unknown>) => {
  const r = await t.api("POST", "/api/collections", body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};

const storage = (t: SourcesTest) => ({
  blobs: t.svc.db.get<{ n: number; b: number; r: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS b, COALESCE(SUM(refcount),0) AS r FROM blobs"),
  versions: t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM page_versions")!.n,
  assets: t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM assets")!.n,
});

describe("C-13 collections: shape and guards", () => {
  it("creates manual collections with a name, description and an icon from the fixed set", async () => {
    const t = await startSourcesServer();
    const c = await col(t, { name: "Space", description: "Things above us", icon: "rocket" });
    expect(c).toMatchObject({ name: "Space", icon: "rocket", kind: "manual", parentId: null, priorityFloor: null, itemCount: 0 });
    expect((await col(t, { name: "Plain" })).icon).toBe("folder");
    const bad = await t.api("POST", "/api/collections", { name: "X", icon: "<img onerror=1>" });
    expect(bad.status).toBe(400);
    expect(bad.body.details.fields[0].path).toBe("icon");
    expect((await t.api("GET", "/api/collections/icons")).body.items).toContain("rocket");
    expect((await t.api("POST", "/api/collections", { name: "" })).status).toBe(400);
  });

  it("starts with a Favourites collection that cannot be deleted or duplicated", async () => {
    const t = await startSourcesServer();
    const list = (await t.api("GET", "/api/collections")).body.items;
    const fav = list.find((c: any) => c.kind === "favourites");
    expect(fav).toMatchObject({ name: "Favourites", icon: "star" });
    expect((await t.api("DELETE", `/api/collections/${fav.id}`)).status).toBe(409);
    expect((await t.api("POST", "/api/collections", { name: "More", kind: "favourites" })).status).toBe(409);
    expect((await t.api("PATCH", `/api/collections/${fav.id}`, { name: "Best" })).body.name).toBe("Best");
    const [p] = await save(t, ["astronomy"]);
    expect((await t.api("POST", `/api/collections/${fav.id}/items`, { add: [{ pageId: p }] })).body.added).toBe(1);
  });

  it("nests collections, returns a tree, and refuses cycles at API and database level", async () => {
    const t = await startSourcesServer();
    const a = await col(t, { name: "A" });
    const b = await col(t, { name: "B", parentId: a.id });
    const c = await col(t, { name: "C", parentId: b.id });
    const tree = (await t.api("GET", "/api/collections?tree=true")).body.items;
    const root = tree.find((x: any) => x.id === a.id);
    expect(root.children[0].id).toBe(b.id);
    expect(root.children[0].children[0].id).toBe(c.id);

    const loop = await t.api("PATCH", `/api/collections/${a.id}`, { parentId: c.id });
    expect(loop.status).toBe(400);
    expect(loop.body.details.fields[0]).toMatchObject({ path: "parentId", message: "That would make a loop" });
    expect((await t.api("PATCH", `/api/collections/${a.id}`, { parentId: a.id })).status).toBe(400);

    // The database says no as well, whatever the service does.
    const ids = Object.fromEntries(t.svc.db.all<{ id: number; public_id: string }>("SELECT id, public_id FROM collections").map((r) => [r.public_id, r.id]));
    expect(() => t.svc.db.run("UPDATE collections SET parent_id = ? WHERE id = ?", [ids[c.id]!, ids[a.id]!])).toThrow(/cycle/);
    expect(() => t.svc.db.run("UPDATE collections SET parent_id = id WHERE id = ?", [ids[a.id]!])).toThrow(/cycle/);
    // Moving a sub-tree up is fine.
    expect((await t.api("PATCH", `/api/collections/${c.id}`, { parentId: null })).body.parentId).toBeNull();
  });

  it("limits nesting to eight levels", async () => {
    const t = await startSourcesServer();
    let parent: string | undefined;
    const made: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const c = await col(t, { name: `L${i}`, parentId: parent });
      made.push(c.id);
      parent = c.id;
    }
    const tooDeep = await t.api("POST", "/api/collections", { name: "L9", parentId: parent });
    expect(tooDeep.status).toBe(400);
    expect(tooDeep.body.message).toMatch(/8 levels/);
    // Moving a deep branch under a deep parent is refused for the same reason.
    const other = await col(t, { name: "Other" });
    const lone = await col(t, { name: "Lone", parentId: other.id });
    expect((await t.api("PATCH", `/api/collections/${made[0]}`, { parentId: lone.id })).status).toBe(400);
    // The database trigger holds the same line.
    const row = t.svc.db.get<{ id: number }>("SELECT id FROM collections WHERE public_id = ?", [made[7]!])!;
    expect(() => t.svc.db.run(`INSERT INTO collections (public_id, name, parent_id, created_at, updated_at) VALUES ('col_x', 'x', ?, 1, 1)`, [row.id])).toThrow(/too deep/);
  });

  it("saved-search collections and ZIM items are stubbed with a clear message", async () => {
    const t = await startSourcesServer();
    const ss = await t.api("POST", "/api/collections", { name: "Saved", kind: "saved_search" });
    expect(ss.status).toBe(501);
    expect(ss.body.message).toMatch(/Saved-search collections arrive with saved searches/);
    const c = await col(t, { name: "M" });
    const zim = await t.api("POST", `/api/collections/${c.id}/items`, { add: [{ zimId: "zim_x", path: "A/Foo" }] });
    expect(zim.status).toBe(501);
    // The stored kind exists for later phases.
    expect(() => t.svc.db.run(`INSERT INTO collections (public_id, name, kind, created_at, updated_at) VALUES ('col_s', 's', 'saved_search', 1, 1)`)).not.toThrow();
  });
});

describe("C-13 membership is many-to-many and adds no storage", () => {
  it("adds a page to three collections without changing storage, removes it, and reports unknown pages", async () => {
    const t = await startSourcesServer();
    const [p1, p2] = await save(t, ["astronomy", "moon"]);
    const cols = [await col(t, { name: "One" }), await col(t, { name: "Two" }), await col(t, { name: "Three" })];
    const before = storage(t);
    for (const c of cols) {
      const r = await t.api("POST", `/api/collections/${c.id}/items`, { add: [{ pageId: p1 }, { pageId: p2 }] });
      expect(r.body).toMatchObject({ added: 2, alreadyMember: 0, notFound: [] });
    }
    expect(storage(t)).toEqual(before);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM collection_memberships")!.n).toBe(6);
    // Adding again changes nothing.
    expect((await t.api("POST", `/api/collections/${cols[0]!.id}/items`, { add: [{ pageId: p1 }] })).body).toMatchObject({ added: 0, alreadyMember: 1 });
    // The page shows all three in the library.
    const del = await t.api("DELETE", `/api/archive/pages/${p1}?dryRun=true`);
    expect(del.body.references.collections.sort()).toEqual(cols.map((c) => c.id).sort());

    const list = (await t.api("GET", `/api/collections/${cols[1]!.id}/items`)).body;
    expect(list.total).toBe(2);
    expect(list.items.map((i: any) => i.pageId).sort()).toEqual([p1, p2].sort());
    expect(list.items[0]).toMatchObject({ addedBy: "user" });
    expect((await t.api("GET", `/api/collections/${cols[1]!.id}/items?limit=1`)).body.nextCursor).toBe("1");

    const rm = await t.api("POST", `/api/collections/${cols[1]!.id}/items`, { add: [{ pageId: "pg_00000000000000000000000000" }], remove: [{ pageId: p2 }] });
    expect(rm.body).toMatchObject({ removed: 1, notFound: ["pg_00000000000000000000000000"] });
    expect(storage(t)).toEqual(before);

    // Deleting a page leaves no membership behind.
    await t.api("DELETE", `/api/archive/pages/${p2}`);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM collection_memberships WHERE page_id IS NOT NULL")!.n).toBe(3);
  });

  it("deleting a collection moves its children up and keeps the pages", async () => {
    const t = await startSourcesServer();
    const [p] = await save(t, ["astronomy"]);
    const top = await col(t, { name: "Top" });
    const mid = await col(t, { name: "Mid", parentId: top.id });
    const kid1 = await col(t, { name: "Kid1", parentId: mid.id });
    const kid2 = await col(t, { name: "Kid2", parentId: mid.id });
    await t.api("POST", `/api/collections/${mid.id}/items`, { add: [{ pageId: p }] });
    const del = await t.api("DELETE", `/api/collections/${mid.id}`);
    expect(del.body).toMatchObject({ reparented: 2, membershipsRemoved: 1 });
    expect((await t.api("GET", `/api/collections/${mid.id}`)).status).toBe(404);
    expect((await t.api("GET", `/api/collections/${kid1.id}`)).body.parentId).toBe(top.id);
    expect((await t.api("GET", `/api/collections/${kid2.id}`)).body.parentId).toBe(top.id);
    expect((await t.api("GET", `/api/archive/pages/${p}`)).status).toBe(200);
    // Deleting a root collection moves its children to the root.
    await t.api("DELETE", `/api/collections/${top.id}`);
    expect((await t.api("GET", `/api/collections/${kid1.id}`)).body.parentId).toBeNull();
  });

  it("lists a collection's items including sub-collections when asked", async () => {
    const t = await startSourcesServer();
    const [p1, p2] = await save(t, ["astronomy", "moon"]);
    const top = await col(t, { name: "Top" });
    const sub = await col(t, { name: "Sub", parentId: top.id });
    await t.api("POST", `/api/collections/${top.id}/items`, { add: [{ pageId: p1 }] });
    await t.api("POST", `/api/collections/${sub.id}/items`, { add: [{ pageId: p2 }, { pageId: p1 }] });
    expect((await t.api("GET", `/api/collections/${top.id}/items`)).body.total).toBe(1);
    const deep = (await t.api("GET", `/api/collections/${top.id}/items?recursive=true`)).body;
    expect(deep.total).toBe(2);
    expect(deep.items).toHaveLength(2);
  });
});

describe("C-13 automatic collections", () => {
  it("fills from a domain, source or title rule, and updates after a capture", async () => {
    const t = await startSourcesServer();
    const host = new URL(art()).hostname;
    const byTitle = await col(t, { name: "Astro", kind: "auto", rule: { match: "all", conditions: [{ field: "title", value: "astronomy" }] } });
    const byDomain = await col(t, { name: "Local", kind: "auto", rule: { conditions: [{ field: "domain", value: host }] } });
    const src = (await t.api("POST", "/api/sources", { name: "Moon", type: "single_page", startUrl: `${art()}/moon` })).body;
    const bySource = await col(t, { name: "FromMoon", kind: "auto", rule: { conditions: [{ field: "source", value: src.id }] } });
    expect(byTitle.itemCount + byDomain.itemCount + bySource.itemCount).toBe(0);

    await save(t, ["astronomy"]);
    expect((await t.api("GET", `/api/collections/${byTitle.id}`)).body.itemCount).toBe(1);
    expect((await t.api("GET", `/api/collections/${byDomain.id}`)).body.itemCount).toBe(1);
    expect((await t.api("GET", `/api/collections/${bySource.id}`)).body.itemCount).toBe(0);

    // A page arrives through the source: the source rule picks it up when the capture finishes.
    await t.api("POST", `/api/sources/${src.id}/run`);
    await t.settled(src.id);
    await until(() => (t.svc.collections.get(bySource.id).itemCount === 1) || undefined);
    expect((await t.api("GET", `/api/collections/${byDomain.id}`)).body.itemCount).toBe(2);
    expect((await t.api("GET", `/api/collections/${byTitle.id}`)).body.itemCount).toBe(1);
    const items = (await t.api("GET", `/api/collections/${byDomain.id}/items`)).body.items;
    expect(items.every((i: any) => i.addedBy === "rule")).toBe(true);
    // By-hand edits are refused: the rule is the truth.
    const [p] = await save(t, ["mars"]);
    expect((await t.api("POST", `/api/collections/${byTitle.id}/items`, { add: [{ pageId: p }] })).status).toBe(409);
  });

  it("changing the rule re-evaluates it, and rebuild repairs membership", async () => {
    const t = await startSourcesServer();
    await save(t, ["astronomy", "moon", "mars"]);
    const c = await col(t, { name: "M", kind: "auto", rule: { match: "any", conditions: [{ field: "title", value: "moon" }, { field: "title", value: "mars" }] } });
    expect(c.itemCount).toBe(2);
    const narrowed = await t.api("PATCH", `/api/collections/${c.id}`, { rule: { conditions: [{ field: "title", value: "moon" }] } });
    expect(narrowed.body.itemCount).toBe(1);
    t.svc.db.run("DELETE FROM collection_memberships");
    expect(t.svc.collections.get(c.id).itemCount).toBe(0);
    expect((await t.api("POST", `/api/collections/${c.id}/rebuild`)).body).toEqual({ added: 1, removed: 0 });
    const manual = await col(t, { name: "Manual" });
    expect((await t.api("POST", `/api/collections/${manual.id}/rebuild`)).status).toBe(409);
    expect((await t.api("PATCH", `/api/collections/${manual.id}`, { rule: { conditions: [{ field: "title", value: "x" }] } })).status).toBe(400);
  });

  it("a rule that names a missing source or has no conditions is refused", async () => {
    const t = await startSourcesServer();
    expect((await t.api("POST", "/api/collections", { name: "A", kind: "auto" })).status).toBe(400);
    expect((await t.api("POST", "/api/collections", { name: "A", kind: "auto", rule: { conditions: [] } })).status).toBe(400);
    const r = await t.api("POST", "/api/collections", { name: "A", kind: "auto", rule: { conditions: [{ field: "source", value: "src_00000000000000000000000000" }] } });
    expect(r.status).toBe(400);
    expect(r.body.details.fields[0].path).toBe("rule.conditions.0.value");
  });
});

describe("C-13 source collections and priority_floor", () => {
  it("pages captured for a source join the source's collections, and a later change backfills", async () => {
    const t = await startSourcesServer();
    const c1 = await col(t, { name: "Moons" });
    const c2 = await col(t, { name: "Later" });
    const s = (await t.api("POST", "/api/sources", { name: "Moon", type: "single_page", startUrl: `${art()}/moon`, collections: [c1.id] })).body;
    expect(s.collections).toEqual([c1.id]);
    await t.api("POST", `/api/sources/${s.id}/run`);
    await t.settled(s.id);
    await until(() => (t.svc.collections.get(c1.id).itemCount === 1) || undefined);
    expect((await t.api("GET", `/api/collections/${c1.id}/items`)).body.items[0].addedBy).toBe("source");
    await t.api("PATCH", `/api/sources/${s.id}`, { collections: [c1.id, c2.id] });
    expect(t.svc.collections.get(c2.id).itemCount).toBe(1);
    expect((await t.api("POST", "/api/sources", { name: "Bad", type: "single_page", startUrl: `${art()}/moon`, collections: ["col_00000000000000000000000000"] })).status).toBe(400);
  });

  it("priority_floor makes membership a reference at that priority; plain membership protects nothing", async () => {
    const t = await startSourcesServer();
    // A page at the lowest priority first.
    const r = await t.api("POST", "/api/browser/save", { url: `${art()}/astronomy`, priority: "P4" });
    const cap = await until(() => { const c = t.pipeline.getCapture(r.body.downloadId); return c && c.state === "completed" ? c : undefined; });
    const pageRow = t.svc.db.get<{ id: number; effective_priority: number }>("SELECT id, effective_priority FROM pages WHERE public_id = ?", [cap.pageId!])!;
    expect(pageRow.effective_priority).toBe(4);

    const plain = await col(t, { name: "Plain" });
    const keep = await col(t, { name: "Keep", priorityFloor: "P2" });
    expect(keep.priorityFloor).toBe("P2");
    await t.api("POST", `/api/collections/${plain.id}/items`, { add: [{ pageId: cap.pageId }] });
    expect(collectionReferences(t.svc.db, pageRow.id)).toEqual([]);
    expect(t.svc.db.get<{ p: number }>("SELECT effective_priority AS p FROM pages WHERE id = ?", [pageRow.id])!.p).toBe(4);

    await t.api("POST", `/api/collections/${keep.id}/items`, { add: [{ pageId: cap.pageId }] });
    expect(collectionReferences(t.svc.db, pageRow.id)).toMatchObject([{ collectionPublicId: keep.id, priority: 2, addedBy: "user" }]);
    expect(t.svc.db.get<{ p: number }>("SELECT effective_priority AS p FROM pages WHERE id = ?", [pageRow.id])!.p).toBe(2);

    // Raising the floor on a collection raises its members; deleting the collection ends the reference.
    await t.api("PATCH", `/api/collections/${keep.id}`, { priorityFloor: "P1" });
    expect(t.svc.db.get<{ p: number }>("SELECT effective_priority AS p FROM pages WHERE id = ?", [pageRow.id])!.p).toBe(1);
    expect((await t.api("PATCH", `/api/collections/${keep.id}`, { priorityFloor: null })).body.priorityFloor).toBeNull();
    expect(collectionReferences(t.svc.db, pageRow.id)).toEqual([]);
    expect((await t.api("POST", "/api/collections", { name: "Bad", priorityFloor: "P9" })).status).toBe(400);
  });
});
