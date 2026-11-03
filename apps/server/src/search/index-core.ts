import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Fts5Index, VocabCounter, SCHEMA_VERSION, TOKENIZERS, type IndexDoc, type SynonymConfig } from "@ncb/search";
import { countEligible, eligibleIdsAfter, loadDoc, membershipOf, type SyncDb } from "./loader.js";
import type { CheckReport, FromIndexWorker, IndexWorkerData } from "./protocol.js";

/** Wraps a read-only better-sqlite3 connection as the loader's `SyncDb`. */
export function syncDb(db: Database.Database): SyncDb {
  return {
    get: <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
  };
}

const SHADOW = "index.rebuild.db";

/** The bucket the `idxo_pages_inlinks` trigger uses (migration 0010). */
const inlinkBucket = (n: number): number => (n < 16 ? n : 16 + Math.floor(n / 16));

/**
 * The logic of the `index` worker (S-01, S-02, S-10): the one writer of `index.db`. It reads `main.db` through a read-only
 * connection and never writes to it; the main thread prunes the outbox from the `applied` events.
 * It runs in a worker thread (`index-worker.ts`) and, with an injected `emit`, in-process for tests.
 */
export class IndexCore {
  private main!: Database.Database;
  private mainSync!: SyncDb;
  idx: Fts5Index | null = null;
  private paused = false;
  private synonyms: SynonymConfig;
  private rebuilding = false;
  private batches = 0;
  readonly dir: string;

  constructor(private readonly o: IndexWorkerData, private readonly emit: (m: FromIndexWorker) => void) {
    this.synonyms = o.synonyms;
    this.dir = path.dirname(o.indexPath);
  }

  get shadowPath(): string { return path.join(this.dir, SHADOW); }

  open(): void {
    this.main = new Database(this.o.mainDbPath, { readonly: true, fileMustExist: true });
    this.main.pragma("busy_timeout = 5000");
    this.mainSync = syncDb(this.main);
    fs.mkdirSync(this.dir, { recursive: true });
    const insp = Fts5Index.inspect(this.o.indexPath);
    const shadow = Fts5Index.inspect(this.shadowPath);
    const resumable = shadow.ok && this.shadowInProgress();
    if (insp.ok) {
      this.idx = Fts5Index.openWriter(this.o.indexPath);
      this.emit({ t: "ready", state: "ok", resumable, lastAppliedId: this.idx.lastAppliedOutboxId });
    } else {
      this.emit({ t: "ready", state: (insp.reason ?? "missing") as "missing" | "corrupt" | "version", resumable, lastAppliedId: 0 });
    }
  }

  private shadowInProgress(): boolean {
    try {
      const s = Fts5Index.openWriter(this.shadowPath, { lock: false });
      try { return s.getMeta("rebuild_in_progress") === "1"; } finally { s.close(); }
    } catch {
      return false;
    }
  }

  close(): void {
    try { this.idx?.close(); } catch { /* closing */ }
    this.idx = null;
    try { this.main?.close(); } catch { /* closing */ }
  }

  pause(p: boolean): void { this.paused = p; }

  private maxOutboxId(): number {
    return (this.main.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM index_outbox").get() as { m: number }).m;
  }

  /** Applies up to one batch of outbox rows. Returns the number of rows read. */
  syncOnce(): number {
    if (!this.idx || this.paused || this.rebuilding) return 0;
    const idx = this.idx;
    const last = idx.lastAppliedOutboxId;
    const rows = this.main.prepare("SELECT id, op, page_id FROM index_outbox WHERE id > ? ORDER BY id LIMIT ?").all(last, this.o.batch) as { id: number; op: string; page_id: number }[];
    if (!rows.length) return 0;
    const byPage = new Map<number, Set<string>>();
    let maxId = last;
    for (const r of rows) {
      maxId = Math.max(maxId, r.id);
      (byPage.get(r.page_id) ?? byPage.set(r.page_id, new Set()).get(r.page_id)!).add(r.op);
    }
    let upserted = 0, deleted = 0;
    idx.transaction(() => {
      for (const [pageId, ops] of byPage) {
        const full = ops.has("upsert_page") || ops.has("delete_page") || !idx.hasPage(pageId);
        if (!full) {
          const m = membershipOf(this.mainSync, pageId);
          const pg = this.main.prepare("SELECT effective_priority AS p, inbound_count AS n, availability AS a FROM pages WHERE id = ?").get(pageId) as { p: number | null; n: number; a: string } | undefined;
          if (pg && (pg.a === "archived" || pg.a === "partial") && idx.patch(pageId, { priority: pg.p, inlinks: pg.n, availability: pg.a, sourceIds: m.sourceIds, collectionIds: m.collectionIds })) { upserted++; continue; }
        }
        const r = loadDoc(this.mainSync, pageId);
        if ("doc" in r) { idx.upsert(r.doc); upserted++; }
        else if (idx.remove(pageId)) deleted++;
      }
      idx.setMeta("last_applied_outbox_id", maxId);
    });
    this.batches++;
    if (this.o.test?.slowBatchMs) { const end = Date.now() + this.o.test.slowBatchMs; while (Date.now() < end) { /* spin */ } }
    this.emit({ t: "applied", lastId: maxId, count: rows.length, deleted, upserted });
    return rows.length;
  }

  syncAll(max = 1_000_000): number {
    let n = 0;
    for (;;) {
      const k = this.syncOnce();
      n += k;
      if (!k || n > max) return n;
    }
  }

  pendingCount(): number {
    if (!this.idx) return 0;
    return (this.main.prepare("SELECT COUNT(*) AS n FROM index_outbox WHERE id > ?").get(this.idx.lastAppliedOutboxId) as { n: number }).n;
  }

  setSynonyms(cfg: SynonymConfig): void {
    this.synonyms = cfg;
    this.idx?.mirrorSynonyms(cfg);
  }

  // ---- rebuild (S-10) ------------------------------------------------------------------------

  /**
   * Builds `index.rebuild.db` from stored content, resumable by page id checkpoint, then swaps it in. The outbox position
   * recorded at the start is the replay point: rows after it are applied to the new file by the normal sync.
   */
  rebuild(jobId: number, generationId: number, o: { fresh?: boolean } = {}): void {
    this.rebuilding = true;
    const t0 = performance.now();
    let shadow: Fts5Index | null = null;
    try {
      let resumed = false;
      if (!o.fresh && Fts5Index.inspect(this.shadowPath).ok && this.shadowInProgress()) {
        shadow = Fts5Index.openWriter(this.shadowPath, { lock: false });
        resumed = true;
      } else {
        for (const s of ["", "-wal", "-shm"]) fs.rmSync(this.shadowPath + s, { force: true });
        shadow = Fts5Index.create(this.shadowPath, { generationId, lock: false });
        shadow.setMeta("rebuild_in_progress", "1");
        shadow.setMeta("outbox_start", this.maxOutboxId());
        shadow.setMeta("rebuild_checkpoint", 0);
        shadow.setMeta("rebuild_done", 0);
      }
      const outboxStart = Number(shadow.getMeta("outbox_start") ?? 0);
      let checkpoint = Number(shadow.getMeta("rebuild_checkpoint") ?? 0);
      let done = Number(shadow.getMeta("rebuild_done") ?? 0);
      const total = countEligible(this.mainSync);
      const vocab = resumed ? null : new VocabCounter();
      this.emit({ t: "progress", jobId, done, total, phase: resumed ? "resuming" : "reading" });
      for (;;) {
        const ids = eligibleIdsAfter(this.mainSync, checkpoint, this.o.test?.rebuildBatch ?? 500);
        if (!ids.length) break;
        const docs: IndexDoc[] = [];
        for (const id of ids) {
          const r = loadDoc(this.mainSync, id);
          if ("doc" in r) docs.push(r.doc);
        }
        const next = ids[ids.length - 1]!;
        const sh = shadow;
        sh.transaction(() => {
          if (vocab) sh.bulkInsert(docs, vocab);
          else for (const d of docs) sh.upsert(d); // resumed: the vocabulary is recounted at the end
          sh.setMeta("rebuild_checkpoint", next);
          sh.setMeta("rebuild_done", done + docs.length);
        });
        checkpoint = next;
        done += docs.length;
        this.emit({ t: "progress", jobId, done, total, phase: "indexing" });
        if (this.o.test?.slowBatchMs) { const end = Date.now() + this.o.test.slowBatchMs; while (Date.now() < end) { /* spin */ } }
        if (this.o.test?.crashAfterBatches !== undefined && ++this.batches >= this.o.test.crashAfterBatches) {
          throw new Error("test crash during rebuild");
        }
      }
      this.emit({ t: "progress", jobId, done, total, phase: "optimising" });
      if (vocab) shadow.finishBuild(vocab);
      else { shadow.rebuildVocab(); shadow.db.exec("DELETE FROM domains; INSERT INTO domains (domain, n) SELECT domain, COUNT(*) FROM docs GROUP BY domain;"); shadow.optimize(); }
      shadow.mirrorSynonyms(this.synonyms);
      shadow.setMeta("generation_id", generationId);
      shadow.setMeta("built_at", Date.now());
      shadow.setMeta("last_applied_outbox_id", outboxStart);
      shadow.setMeta("rebuild_in_progress", "0");
      shadow.setMeta("last_optimize_at", Date.now());
      shadow.db.pragma("wal_checkpoint(TRUNCATE)");
      shadow.db.pragma("journal_mode = DELETE");
      const docs = shadow.docCount();
      shadow.close();
      shadow = null;
      this.swap();
      this.emit({ t: "swapped", jobId, generationId, docs, ms: Math.round(performance.now() - t0), lastAppliedId: outboxStart });
    } catch (e) {
      try { shadow?.close(); } catch { /* ignore */ }
      if (!this.idx && Fts5Index.inspect(this.o.indexPath).ok) this.idx = Fts5Index.openWriter(this.o.indexPath);
      this.emit({ t: "rebuild_failed", jobId, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.rebuilding = false;
    }
  }

  /** Atomic swap: close the live writer (checkpointing it), drop its sidecar files, rename the shadow over it, reopen. */
  private swap(): void {
    this.idx?.close();
    this.idx = null;
    for (const s of ["-wal", "-shm"]) fs.rmSync(this.o.indexPath + s, { force: true });
    for (const s of ["-wal", "-shm"]) fs.rmSync(this.shadowPath + s, { force: true });
    fs.renameSync(this.shadowPath, this.o.indexPath);
    this.idx = Fts5Index.openWriter(this.o.indexPath);
  }

  // ---- maintenance ---------------------------------------------------------------------------

  optimize(): { tookMs: number } {
    const t0 = performance.now();
    this.idx?.optimize();
    this.idx?.rebuildVocab();
    this.idx?.optimize();
    return { tookMs: Math.round(performance.now() - t0) };
  }

  /** Counts and sampled documents against `main.db` (invariant I-10). With `repair`, reindexes what differs. */
  check(repair: boolean): CheckReport {
    const idx = this.idx;
    if (!idx) return { ok: false, expected: countEligible(this.mainSync), indexed: 0, sampled: 0, mismatches: [], missing: 0, extra: 0, repaired: 0, needsRebuild: true };
    this.syncAll();
    const expectedIds: number[] = [];
    for (let after = 0; ;) {
      const ids = eligibleIdsAfter(this.mainSync, after, 5000);
      if (!ids.length) break;
      expectedIds.push(...ids);
      after = ids[ids.length - 1]!;
    }
    const expected = new Set(expectedIds);
    const indexedIds = idx.pageIds();
    const indexed = new Set(indexedIds);
    const missing = expectedIds.filter((id) => !indexed.has(id));
    const extra = indexedIds.filter((id) => !expected.has(id));
    const both = expectedIds.filter((id) => indexed.has(id));
    const step = Math.max(1, Math.floor(both.length / 200));
    const sample: number[] = [];
    for (let i = 0; i < both.length && sample.length < 200; i += step) sample.push(both[i]!);
    const mismatches: { pageId: number; field: string }[] = [];
    for (const id of sample) {
      const r = loadDoc(this.mainSync, id);
      const s = idx.docSummary(id);
      if (!("doc" in r) || !s) { mismatches.push({ pageId: id, field: "presence" }); continue; }
      const d = r.doc;
      const diff = (field: string, a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push({ pageId: id, field }); };
      diff("versionId", d.versionId, s.versionId);
      diff("title", d.title.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " "), s.title);
      diff("url", d.url, s.url);
      // The outbox trigger only fires when the in-link count moves between coarse buckets (exact below 16, then steps of 16;
      // migration 0010), so the index may legitimately hold a count a few links behind. Compare buckets, not exact counts.
      diff("inlinks", inlinkBucket(d.inlinks), inlinkBucket(s.inlinks));
      diff("priority", d.priority, s.priority);
      diff("availability", d.availability, s.availability);
      diff("sources", [...new Set(d.sourceIds)].sort(), s.sourceIds);
      diff("collections", [...new Set(d.collectionIds)].sort(), s.collectionIds);
    }
    let repaired = 0;
    const needsRebuild = missing.length + extra.length > Math.max(5, Math.floor(expected.size * 0.01));
    if (repair && !needsRebuild) {
      const fix = new Set<number>([...missing, ...mismatches.map((m) => m.pageId)]);
      for (const id of fix) {
        const r = loadDoc(this.mainSync, id);
        if ("doc" in r) { idx.upsert(r.doc); repaired++; }
      }
      for (const id of extra) if (idx.remove(id)) repaired++;
    }
    return {
      ok: !missing.length && !extra.length && !mismatches.length, expected: expected.size, indexed: indexed.size, sampled: sample.length,
      mismatches: mismatches.slice(0, 50), missing: missing.length, extra: extra.length, repaired, needsRebuild,
    };
  }

  status(): { open: boolean; stats: ReturnType<Fts5Index["stats"]> | null; pending: number } {
    return { open: !!this.idx, stats: this.idx ? this.idx.stats() : null, pending: this.pendingCount() };
  }
}

export { SCHEMA_VERSION, TOKENIZERS };
