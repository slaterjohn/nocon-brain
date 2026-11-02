import { describe, expect, it } from "vitest";
import { addDoc, drained, searchApi, startSearchServer } from "../integration/search/helpers.js";
import { expectConsistent, startStorageTest } from "./helpers.js";

describe("index updates on eviction go through the index outbox", () => {
  it("an evicted page leaves the search results, via the migration 0010 triggers, with no direct index write", async () => {
    const t = await startSearchServer({ signIn: false });
    const { pageId } = await addDoc(t, "tides.html", "Tidal energy", "Tidal barrages harvest the rise and fall of the sea.");
    await drained(t);
    const hit = async () => ((await searchApi(t, { query: "tidal barrages" })).body.results as { pageId?: string }[]).some((r) => r.pageId === pageId);
    expect(await hit()).toBe(true);

    // The Imports source is P3 and keeps its pages out of automatic eviction; make them Opportunistic and evictable.
    const imports = (await t.api("GET", "/api/sources?system=true")).body.items.find((s: { systemKind?: string }) => s.systemKind === "imports");
    const patch = await t.api("PATCH", `/api/sources/${imports.id}`, { priority: "P4", automaticEviction: true });
    expect(patch.status).toBe(200);
    const lastOutbox = t.svc.db.get<{ n: number }>("SELECT COALESCE(MAX(id), 0) AS n FROM index_outbox")!.n;

    const plan = t.svc.storage.planAndStore({ bytesNeeded: 1, incomingPriority: 1 });
    expect(plan.items.map((i) => i.pageId)).toContain(pageId);
    const run = await t.svc.storage.runPlan(plan.planId);
    expect(run.evicted).toBeGreaterThan(0);

    // The change reached the index only through outbox rows written by the triggers in the eviction's own transaction.
    const rows = t.svc.db.all<{ op: string; page_id: number }>("SELECT op, page_id FROM index_outbox WHERE id > ?", [lastOutbox]);
    expect(rows.some((r) => r.op === "upsert_page" || r.op === "delete_page")).toBe(true);
    await drained(t);
    expect(await hit()).toBe(false);
    expect(t.svc.db.get<{ a: string }>("SELECT availability AS a FROM pages WHERE public_id = ?", [pageId])!.a).toBe("evicted");
    // the library still lists the tombstone, with its reason one query away
    const why = (await t.api("GET", `/api/storage/pages/${pageId}`)).body;
    expect(why.versions[0]).toMatchObject({ status: "evicted" });
    expect(why.versions[0].reasons.join(" ")).toMatch(/Removed/);
    expect(why.history[0]).toMatchObject({ kind: "evicted", trigger: "manual" });
    expectConsistent(t, expect);
    // the index and the archive agree afterwards
    const check = await t.svc.search.check(false);
    expect(check.missing + check.extra).toBe(0);
  });
});

describe("explicit deletion is a different operation from eviction", () => {
  it("deleting a Protected page needs confirmation, is recorded as 'deleted' (not 'evicted'), and keeps blobs that other pages use", async () => {
    const t = await startStorageTest();
    const keep = t.seed.source({ priority: 1, retention: { mode: "all" }, automaticEviction: false });
    const other = t.seed.source({ priority: 3 });
    const shared = { tag: "shared", bytes: 300 };
    const a = await t.seed.page({ url: "https://d.test/a", sources: [keep], versions: [{ blobs: [{ tag: "a", bytes: 100 }, shared] }] });
    const b = await t.seed.page({ url: "https://d.test/b", sources: [other], versions: [{ blobs: [{ tag: "b", bytes: 100 }, shared] }] });

    const refused = await t.api("DELETE", `/api/archive/pages/${a.publicId}`);
    expect(refused.status).toBe(409);
    expect(t.seed.versionStatus(a.versionIds[0]!)).toBe("ready");
    const dry = await t.api("DELETE", `/api/archive/pages/${a.publicId}?dryRun=true`);
    expect(dry.body).toMatchObject({ requiresConfirmation: true });

    const done = await t.api("DELETE", `/api/archive/pages/${a.publicId}?confirmProtected=true`);
    expect(done.status).toBe(200);
    expect(t.svc.db.get("SELECT 1 AS x FROM pages WHERE id = ?", [a.pageId])).toBeUndefined();
    // the blob only A used is unreferenced now (collected after the grace period); the shared one is still referenced by B
    expect(t.svc.blobs.bySha(a.blobShas[0]!)).toMatchObject({ refcount: 0 });
    expect(t.svc.blobs.bySha(a.blobShas[1]!)).toMatchObject({ refcount: 1 });
    expect(t.seed.blobExists(a.blobShas[1]!)).toBe(true);
    expect(t.seed.versionStatus(b.versionIds[0]!)).toBe("ready");

    const audit = t.svc.db.all<{ kind: string; confirmed_protected: number; trigger: string; reason: string }>("SELECT kind, confirmed_protected, trigger, reason FROM storage_audit ORDER BY id");
    expect(audit).toEqual([{ kind: "deleted", confirmed_protected: 1, trigger: "explicit", reason: expect.stringContaining("Deleted by you") }]);
    // I-13 treats a confirmed explicit deletion as legitimate: nothing was evicted
    expect((await t.svc.storage.maintenance.verify({ checks: ["I-13"] })).findings).toEqual([]);
    expect(t.svc.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM storage_audit WHERE kind = 'evicted'")!.n).toBe(0);
    // eviction never touches what is left of A's references either: there are none, and B is Standard and unaffected by A
    const history = (await t.api("GET", "/api/storage/audit?kind=deleted")).body;
    expect(history.items).toHaveLength(1); // the page row is gone, so only the list (not a per-page lookup) can find it
    expect(history.items[0]).toMatchObject({ kind: "deleted", pageUrl: "https://d.test/a", confirmedProtected: true });
    expectConsistent(t, expect);
  });
});
