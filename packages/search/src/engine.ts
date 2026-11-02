import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { WriterLock } from "@ncb/db";
import { atom, filterSql, matchExpr, synonymMap, type SynonymMap } from "./builder.js";
import { hasPositive, normaliseTypes, parseQuery, parsedForApi, type ParsedQuery } from "./parser.js";
import { BM25_WEIGHTS, compareHits, DEFAULT_RANKING, scoreDoc } from "./ranking.js";
import { SCHEMA_SQL, SCHEMA_VERSION, seedStopwords, TOKENIZERS } from "./schema.js";
import { groupForLang, guessLanguage, isStopword } from "./stopwords.js";
import { cleanText, editDistance, escapeHtml, hamming, MARK_CLOSE, MARK_OPEN, normTitle, sanitiseMarked, simhashTokens, tokenize } from "./text.js";
import type {
  BuildOptions, DidYouMean, Facet, Facets, Filters, Hit, IndexDoc, IndexStats, RankingConfig, ScoreExplanation, SearchIndex, SearchOutput, SearchParams,
  Suggestion, SuggestOutput, SynonymConfig,
} from "./types.js";

export class IndexMissingError extends Error {
  constructor(file: string) { super(`The search index ${file} does not exist.`); this.name = "IndexMissingError"; }
}
export class IndexVersionError extends Error {
  constructor(file: string, found: string | null) { super(`The search index ${file} has schema version ${found ?? "unknown"}, expected ${SCHEMA_VERSION}.`); this.name = "IndexVersionError"; }
}

export const MAX_BODY_CHARS = 120_000;
export const FACET_CAP = 2000;
const TOTAL_CAP = 2000;
/** Document frequency from which a term triggers the title-first pass. */
export const TITLE_FIRST_DF = 5000;

export interface InspectResult { exists: boolean; ok: boolean; schemaVersion: string | null; reason?: "missing" | "corrupt" | "version" }

type Stmt = Database.Statement;

/** Distinct vocabulary terms of a document: lower-case words of 3 to 32 letters that are not plain numbers. */
export function vocabTerms(...parts: string[]): Set<string> {
  const out = new Set<string>();
  for (const part of parts) addTerms(out, tokenize(part));
  return out;
}

const NUMERIC = /^\p{N}+$/u;
function addTerms(out: Set<string>, tokens: string[]): void {
  for (const t of tokens) {
    if (t.length < 3 || t.length > 32 || NUMERIC.test(t)) continue;
    out.add(t);
  }
}

/** Tokenises a document once for the vocabulary, the fingerprint and the word count. */
export function analyse(title: string, headings: string, body: string): { terms: Set<string>; simhash: string; words: number } {
  const bodyTokens = tokenize(body);
  const terms = new Set<string>();
  addTerms(terms, tokenize(title));
  addTerms(terms, tokenize(headings));
  addTerms(terms, bodyTokens);
  return { terms, simhash: simhashTokens(bodyTokens), words: bodyTokens.length };
}

/** Counts document frequency in memory for a bulk build, pruning single-use terms when the map grows too big. */
export class VocabCounter {
  readonly df = new Map<string, number>();
  pruned = 0;
  constructor(private readonly maxTerms = 2_000_000) {}
  add(terms: Iterable<string>): void {
    for (const t of terms) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    if (this.df.size > this.maxTerms) {
      for (const [t, n] of this.df) if (n === 1) { this.df.delete(t); this.pruned++; }
    }
  }
}

const gramsOf = (term: string): string[] => {
  const cps = [...term];
  const out: string[] = [];
  for (let i = 0; i + 3 <= cps.length; i++) out.push(cps.slice(i, i + 3).join(""));
  return [...new Set(out)].slice(0, 14);
};

const ftsUrl = (u: string): string => u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "");

interface DocRow {
  id: number; page_id: number; version_id: number | null; public_page_id: string; url: string; domain: string; registrable_domain: string; title: string;
  title_norm: string; description: string; lang: string | null; fts_group: "en" | "default"; type: string; origin: string; captured_at: number | null;
  published_at: number | null; date_for_ranking: number | null; availability: "archived" | "partial"; priority: number | null; inlinks: number;
  content_hash: string | null; simhash: string | null;
}

interface Candidate { id: number; s: number; group: "en" | "default"; expr: string }

export class Fts5Index implements SearchIndex {
  readonly db: Database.Database;
  readonly file: string;
  readonly role: "writer" | "reader";
  private lock?: WriterLock;
  private readonly cache = new Map<string, Stmt>();
  ranking: RankingConfig = DEFAULT_RANKING;
  private synonymCfg: SynonymConfig = { enabled: true, items: [] };
  private synMap: SynonymMap = new Map();
  /** Test and benchmark hook: replaces the clock used for freshness. */
  now: () => number = () => Date.now();

  private constructor(db: Database.Database, file: string, role: "writer" | "reader", lock?: WriterLock) {
    this.db = db;
    this.file = file;
    this.role = role;
    this.lock = lock;
  }

  // ---- opening -------------------------------------------------------------------------------

  /** Looks at a file without keeping it open: does it exist, open and carry the current schema version? */
  static inspect(file: string): InspectResult {
    if (!fs.existsSync(file)) return { exists: false, ok: false, schemaVersion: null, reason: "missing" };
    let db: Database.Database | undefined;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true });
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      const v = row?.value ?? null;
      if (v !== String(SCHEMA_VERSION)) return { exists: true, ok: false, schemaVersion: v, reason: "version" };
      const check = db.pragma("quick_check(1)", { simple: true });
      if (check !== "ok") return { exists: true, ok: false, schemaVersion: v, reason: "corrupt" };
      return { exists: true, ok: true, schemaVersion: v };
    } catch {
      return { exists: true, ok: false, schemaVersion: null, reason: "corrupt" };
    } finally {
      db?.close();
    }
  }

  /** Creates a new index file with the current schema. Fails if the file exists. */
  static create(file: string, o: { generationId?: number; lock?: boolean } = {}): Fts5Index {
    if (fs.existsSync(file)) throw new Error(`${file} already exists`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = o.lock === false ? undefined : WriterLock.acquire(`${file}.lock`);
    try {
      const db = new Database(file);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.pragma("cache_size = -32768");
      db.exec(SCHEMA_SQL);
      const ins = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      db.transaction(() => {
        ins.run("schema_version", String(SCHEMA_VERSION));
        ins.run("tokenizers", TOKENIZERS);
        ins.run("generation_id", String(o.generationId ?? 1));
        ins.run("built_at", String(Date.now()));
        ins.run("last_applied_outbox_id", "0");
        const sw = db.prepare("INSERT INTO stopwords (lang, term) VALUES (?, ?)");
        for (const [l, t] of seedStopwords()) sw.run(l, t);
      })();
      return new Fts5Index(db, file, "writer", lock);
    } catch (e) {
      lock?.release();
      throw e;
    }
  }

  /** Opens the existing index for writing. The one writer holds `<file>.lock`; a second writer throws. */
  static openWriter(file: string, o: { lock?: boolean } = {}): Fts5Index {
    if (!fs.existsSync(file)) throw new IndexMissingError(file);
    const lock = o.lock === false ? undefined : WriterLock.acquire(`${file}.lock`);
    try {
      const db = new Database(file, { fileMustExist: true });
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.pragma("cache_size = -32768");
      const v = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value ?? null;
      if (v !== String(SCHEMA_VERSION)) { db.close(); throw new IndexVersionError(file, v); }
      return new Fts5Index(db, file, "writer", lock);
    } catch (e) {
      lock?.release();
      throw e;
    }
  }

  /** A read-only connection. It works while the writer is writing (WAL). */
  static openReader(file: string): Fts5Index {
    if (!fs.existsSync(file)) throw new IndexMissingError(file);
    const db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma("cache_size = -65536");
    db.pragma("query_only = 1");
    const v = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value ?? null;
    if (v !== String(SCHEMA_VERSION)) { db.close(); throw new IndexVersionError(file, v); }
    return new Fts5Index(db, file, "reader");
  }

  close(): void {
    this.cache.clear();
    try { if (this.role === "writer") this.db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best effort */ }
    this.db.close();
    this.lock?.release();
    this.lock = undefined;
  }

  private st(sql: string): Stmt {
    let s = this.cache.get(sql);
    if (!s) {
      if (this.cache.size > 300) this.cache.clear();
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  private assertWriter(): void {
    if (this.role !== "writer") throw new Error("This connection is read-only.");
  }

  // ---- meta ----------------------------------------------------------------------------------

  getMeta(key: string): string | null {
    return (this.st("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  }
  setMeta(key: string, value: string | number): void {
    this.assertWriter();
    this.st("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
  }
  get lastAppliedOutboxId(): number { return Number(this.getMeta("last_applied_outbox_id") ?? 0); }
  get generationId(): number { return Number(this.getMeta("generation_id") ?? 0); }

  transaction<T>(fn: () => T): T {
    this.assertWriter();
    return this.db.transaction(fn).immediate();
  }

  // ---- configuration (reader side) -----------------------------------------------------------

  setRanking(cfg: RankingConfig): void { this.ranking = cfg; this.hot.clear(); }
  setSynonyms(cfg: SynonymConfig): void { this.synonymCfg = cfg; this.synMap = synonymMap(cfg); this.hot.clear(); }

  /** Mirrors the synonym list into the `synonyms` table (rebuilds and edits). */
  mirrorSynonyms(cfg: SynonymConfig): void {
    this.assertWriter();
    this.db.transaction(() => {
      this.db.exec("DELETE FROM synonyms");
      const ins = this.db.prepare("INSERT OR IGNORE INTO synonyms (term, expansion, kind) VALUES (?, ?, ?)");
      for (const e of cfg.items) for (const x of e.expansions) ins.run(e.term, x, e.kind);
    })();
  }

  // ---- writing -------------------------------------------------------------------------------

  private ftsTable(g: string): "fts_en" | "fts_default" { return g === "en" ? "fts_en" : "fts_default"; }

  private incVocab(terms: Iterable<string>): void {
    const up = this.st("UPDATE vocab SET df = df + 1 WHERE term = ?");
    const ins = this.st("INSERT INTO vocab (term, df) VALUES (?, 1)");
    const tri = this.st("INSERT INTO vocab_tri (rowid, term) VALUES (?, ?)");
    for (const t of terms) {
      if (up.run(t).changes === 0) tri.run(ins.run(t).lastInsertRowid, t);
    }
  }
  private decVocab(terms: Iterable<string>): void {
    const dec = this.st("UPDATE vocab SET df = df - 1 WHERE term = ? RETURNING rowid, df");
    const del = this.st("DELETE FROM vocab WHERE rowid = ?");
    const deltri = this.st("DELETE FROM vocab_tri WHERE rowid = ?");
    for (const t of terms) {
      const r = dec.get(t) as { rowid: number | bigint; df: number } | undefined;
      if (r && r.df <= 0) { del.run(r.rowid); deltri.run(r.rowid); }
    }
  }
  private bumpDomain(domain: string, by: number): void {
    this.st("INSERT INTO domains (domain, n) VALUES (?, ?) ON CONFLICT(domain) DO UPDATE SET n = n + excluded.n").run(domain, by);
    this.st("DELETE FROM domains WHERE domain = ? AND n <= 0").run(domain);
  }

  private removeFtsRows(id: number, group: string): { terms: Set<string> } {
    const t = this.ftsTable(group);
    const old = this.st(`SELECT title, headings, body FROM ${t} WHERE rowid = ?`).get(id) as { title: string; headings: string; body: string } | undefined;
    const terms = old ? vocabTerms(old.title, old.headings, old.body) : new Set<string>();
    this.st(`DELETE FROM ${t} WHERE rowid = ?`).run(id);
    this.st("DELETE FROM title_fts WHERE rowid = ?").run(id);
    return { terms };
  }

  private writeMembership(id: number, sources: string[], collections: string[]): void {
    this.st("DELETE FROM doc_sources WHERE doc_id = ?").run(id);
    this.st("DELETE FROM doc_collections WHERE doc_id = ?").run(id);
    const s = this.st("INSERT OR IGNORE INTO doc_sources (doc_id, source_id) VALUES (?, ?)");
    for (const x of new Set(sources)) s.run(id, x);
    const c = this.st("INSERT OR IGNORE INTO doc_collections (doc_id, collection_id) VALUES (?, ?)");
    for (const x of new Set(collections)) c.run(id, x);
  }

  private docParams(doc: IndexDoc, body: string, a: { simhash: string; words: number }): { params: unknown[]; group: "en" | "default" } {
    const lang = doc.lang ? doc.lang.toLowerCase().split(/[-_]/)[0]! : guessLanguage(`${doc.title}. ${body}`);
    const group = groupForLang(lang);
    const sim = a.simhash;
    const date = doc.publishedAt ?? doc.capturedAt;
    const words = a.words;
    return {
      group,
      params: [
        doc.pageId, doc.versionId, doc.publicPageId, doc.url, doc.domain, doc.registrableDomain, cleanText(doc.title), normTitle(doc.title), cleanText(doc.description),
        cleanText(doc.keywords), lang, group, doc.type, doc.origin, doc.capturedAt, doc.publishedAt, date, doc.availability, doc.priority, doc.inlinks,
        doc.contentHash, sim || null, words,
      ],
    };
  }

  private static readonly INSERT_DOC = `INSERT INTO docs (page_id, version_id, public_page_id, url, domain, registrable_domain, title, title_norm, description, keywords, lang, fts_group,
    type, origin, captured_at, published_at, date_for_ranking, availability, priority, inlinks, content_hash, simhash, words) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  private static readonly UPDATE_DOC = `UPDATE docs SET page_id=?, version_id=?, public_page_id=?, url=?, domain=?, registrable_domain=?, title=?, title_norm=?, description=?, keywords=?, lang=?, fts_group=?,
    type=?, origin=?, captured_at=?, published_at=?, date_for_ranking=?, availability=?, priority=?, inlinks=?, content_hash=?, simhash=?, words=? WHERE id=?`;

  private insertFts(id: number, group: string, doc: IndexDoc, body: string): void {
    const title = cleanText(doc.title);
    const headings = cleanText(doc.headings);
    this.st(`INSERT INTO ${this.ftsTable(group)} (rowid, title, headings, url, body) VALUES (?, ?, ?, ?, ?)`).run(id, title, headings, ftsUrl(doc.url), body);
    this.st("INSERT INTO title_fts (rowid, title) VALUES (?, ?)").run(id, title);
  }

  /** Adds or replaces the document for `doc.pageId`. One transaction; idempotent. */
  upsert(doc: IndexDoc): void {
    this.assertWriter();
    const body = cleanText(doc.body).slice(0, MAX_BODY_CHARS);
    const an = analyse(doc.title, doc.headings, body);
    this.db.transaction(() => {
      const existing = this.st("SELECT id, fts_group, domain FROM docs WHERE page_id = ?").get(doc.pageId) as { id: number; fts_group: string; domain: string } | undefined;
      const { params, group } = this.docParams(doc, body, an);
      let id: number;
      if (existing) {
        id = existing.id;
        const { terms } = this.removeFtsRows(id, existing.fts_group);
        this.decVocab(terms);
        this.st(Fts5Index.UPDATE_DOC).run(...params, id);
        if (existing.domain !== doc.domain) { this.bumpDomain(existing.domain, -1); this.bumpDomain(doc.domain, 1); }
      } else {
        id = Number(this.st(Fts5Index.INSERT_DOC).run(...params).lastInsertRowid);
        this.bumpDomain(doc.domain, 1);
      }
      this.insertFts(id, group, doc, body);
      this.incVocab(an.terms);
      this.writeMembership(id, doc.sourceIds, doc.collectionIds);
    }).immediate();
  }

  remove(pageId: number): boolean {
    this.assertWriter();
    return this.db.transaction(() => {
      const existing = this.st("SELECT id, fts_group, domain FROM docs WHERE page_id = ?").get(pageId) as { id: number; fts_group: string; domain: string } | undefined;
      if (!existing) return false;
      const { terms } = this.removeFtsRows(existing.id, existing.fts_group);
      this.decVocab(terms);
      this.st("DELETE FROM doc_sources WHERE doc_id = ?").run(existing.id);
      this.st("DELETE FROM doc_collections WHERE doc_id = ?").run(existing.id);
      this.st("DELETE FROM docs WHERE id = ?").run(existing.id);
      this.bumpDomain(existing.domain, -1);
      return true;
    }).immediate();
  }

  /** Updates fields that do not need the page text: in-links, priority, availability, membership. Returns false when the page is not indexed. */
  patch(pageId: number, p: { inlinks?: number; priority?: number | null; availability?: "archived" | "partial"; sourceIds?: string[]; collectionIds?: string[] }): boolean {
    this.assertWriter();
    return this.db.transaction(() => {
      const row = this.st("SELECT id FROM docs WHERE page_id = ?").get(pageId) as { id: number } | undefined;
      if (!row) return false;
      if (p.inlinks !== undefined) this.st("UPDATE docs SET inlinks = ? WHERE id = ?").run(p.inlinks, row.id);
      if (p.priority !== undefined) this.st("UPDATE docs SET priority = ? WHERE id = ?").run(p.priority, row.id);
      if (p.availability !== undefined) this.st("UPDATE docs SET availability = ? WHERE id = ?").run(p.availability, row.id);
      if (p.sourceIds || p.collectionIds) {
        if (p.sourceIds) { this.st("DELETE FROM doc_sources WHERE doc_id = ?").run(row.id); const s = this.st("INSERT OR IGNORE INTO doc_sources (doc_id, source_id) VALUES (?, ?)"); for (const x of new Set(p.sourceIds)) s.run(row.id, x); }
        if (p.collectionIds) { this.st("DELETE FROM doc_collections WHERE doc_id = ?").run(row.id); const c = this.st("INSERT OR IGNORE INTO doc_collections (doc_id, collection_id) VALUES (?, ?)"); for (const x of new Set(p.collectionIds)) c.run(row.id, x); }
      }
      return true;
    }).immediate();
  }

  /** Bulk insert for a build into an empty file: no deletion checks, vocabulary counted in memory. Call inside `transaction`. */
  bulkInsert(docs: IndexDoc[], vocab: VocabCounter): void {
    this.assertWriter();
    for (const doc of docs) {
      const body = cleanText(doc.body).slice(0, MAX_BODY_CHARS);
      const an = analyse(doc.title, doc.headings, body);
      const { params, group } = this.docParams(doc, body, an);
      const id = Number(this.st(Fts5Index.INSERT_DOC).run(...params).lastInsertRowid);
      this.insertFts(id, group, doc, body);
      vocab.add(an.terms);
      this.writeMembership(id, doc.sourceIds, doc.collectionIds);
    }
  }

  /** Writes the counted vocabulary, domain counts and bookkeeping; then optimises. Ends a bulk build. */
  finishBuild(vocab: VocabCounter, o: { optimize?: boolean } = {}): { vocabTerms: number; ms: Record<string, number> } {
    this.assertWriter();
    const ms: Record<string, number> = {};
    let t = performance.now();
    const lap = (k: string) => { const n = performance.now(); ms[k] = Math.round(n - t); t = n; };
    const trace = (m: string) => { if (process.env.NCB_SEARCH_TRACE) console.error(`[search] ${m} rss=${Math.round(process.memoryUsage().rss / 1048576)}MiB`); };
    trace("vocab start");
    this.db.transaction(() => {
      this.db.exec("DELETE FROM vocab; DELETE FROM vocab_tri;");
      const iv = this.db.prepare("INSERT INTO vocab (term, df) VALUES (?, ?)");
      const it = this.db.prepare("INSERT INTO vocab_tri (rowid, term) VALUES (?, ?)");
      for (const [term, n] of vocab.df) it.run(iv.run(term, n).lastInsertRowid, term);
      this.db.exec("DELETE FROM domains; INSERT INTO domains (domain, n) SELECT domain, COUNT(*) FROM docs GROUP BY domain;");
    })();
    lap("vocab");
    trace("vocab done");
    if (o.optimize !== false) { this.optimize(); lap("optimize"); }
    trace("optimize done");
    return { vocabTerms: vocab.df.size, ms };
  }

  /**
   * FTS5 optimise on every table, then ANALYZE. Large tables are merged in many small transactions (`merge` with a page budget, until
   * a call changes almost nothing) so the write-ahead log and the dirty pages stay small: one `optimize` of a 3.5 GB index is one
   * 3.5 GB transaction, and a 500,000-page build was killed by a 512 MB container limit in that step (docs/benchmarks.md).
   */
  optimize(): void {
    this.assertWriter();
    const trace = (m: string) => { if (process.env.NCB_SEARCH_TRACE) console.error(`[search] ${m} rss=${Math.round(process.memoryUsage().rss / 1048576)}MiB`); };
    for (const t of ["fts_en", "fts_default", "title_fts", "vocab_tri"]) {
      const big = this.docCount() > Number(process.env.NCB_SEARCH_MERGE_DOCS ?? 100_000) && (t === "fts_en" || t === "fts_default");
      if (!big) this.db.exec(`INSERT INTO ${t}(${t}) VALUES('optimize')`);
      else {
        const merge = this.db.prepare(`INSERT INTO ${t}(${t}, rank) VALUES('merge', 500)`);
        const changes = this.db.prepare("SELECT total_changes() AS n");
        for (let i = 0; i < 100_000; i++) {
          const before = (changes.get() as { n: number }).n;
          merge.run();
          if ((changes.get() as { n: number }).n - before < 2) break;
          if (i % 200 === 199) this.db.pragma("wal_checkpoint(PASSIVE)");
        }
      }
      trace(`optimised ${t}`);
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    }
    this.db.exec("ANALYZE");
    this.setMeta("last_optimize_at", Date.now());
  }

  /** Recounts the vocabulary from the stored text (admin `optimize`). */
  rebuildVocab(): number {
    this.assertWriter();
    const counter = new VocabCounter();
    for (const t of ["fts_en", "fts_default"]) {
      for (const r of this.db.prepare(`SELECT title, headings, body FROM ${t}`).iterate() as Iterable<{ title: string; headings: string; body: string }>) counter.add(vocabTerms(r.title, r.headings, r.body));
    }
    this.db.transaction(() => {
      this.db.exec("DELETE FROM vocab; DELETE FROM vocab_tri;");
      const iv = this.db.prepare("INSERT INTO vocab (term, df) VALUES (?, ?)");
      const it = this.db.prepare("INSERT INTO vocab_tri (rowid, term) VALUES (?, ?)");
      for (const [term, n] of counter.df) it.run(iv.run(term, n).lastInsertRowid, term);
    })();
    return counter.df.size;
  }

  rebuild(docs: Iterable<IndexDoc>, opts: BuildOptions): { docs: number; ms: number } {
    this.assertWriter();
    const t0 = performance.now();
    const vocab = new VocabCounter();
    let n = 0;
    let batch: IndexDoc[] = [];
    const flush = () => { if (batch.length) { const b = batch; batch = []; this.db.transaction(() => this.bulkInsert(b, vocab))(); } };
    for (const d of docs) { batch.push(d); n++; if (batch.length >= 500) flush(); }
    flush();
    this.finishBuild(vocab);
    this.setMeta("generation_id", opts.generationId);
    this.setMeta("last_applied_outbox_id", opts.outboxStart);
    this.setMeta("built_at", Date.now());
    return { docs: n, ms: Math.round(performance.now() - t0) };
  }

  // ---- inspection ----------------------------------------------------------------------------

  docCount(): number { return (this.st("SELECT COUNT(*) AS n FROM docs").get() as { n: number }).n; }

  hasPage(pageId: number): boolean { return !!this.st("SELECT 1 FROM docs WHERE page_id = ?").get(pageId); }

  pageIds(): number[] { return (this.st("SELECT page_id FROM docs ORDER BY page_id").all() as { page_id: number }[]).map((r) => r.page_id); }

  /** What the index holds about a page, for the consistency check. */
  docSummary(pageId: number): { versionId: number | null; title: string; url: string; inlinks: number; priority: number | null; availability: string; contentHash: string | null; sourceIds: string[]; collectionIds: string[] } | undefined {
    const r = this.st("SELECT id, version_id, title, url, inlinks, priority, availability, content_hash FROM docs WHERE page_id = ?").get(pageId) as
      { id: number; version_id: number | null; title: string; url: string; inlinks: number; priority: number | null; availability: string; content_hash: string | null } | undefined;
    if (!r) return undefined;
    const sourceIds = (this.st("SELECT source_id FROM doc_sources WHERE doc_id = ? ORDER BY 1").all(r.id) as { source_id: string }[]).map((x) => x.source_id);
    const collectionIds = (this.st("SELECT collection_id FROM doc_collections WHERE doc_id = ? ORDER BY 1").all(r.id) as { collection_id: string }[]).map((x) => x.collection_id);
    return { versionId: r.version_id, title: r.title, url: r.url, inlinks: r.inlinks, priority: r.priority, availability: r.availability, contentHash: r.content_hash, sourceIds, collectionIds };
  }

  stats(): IndexStats {
    const groups = { en: 0, default: 0 };
    for (const r of this.st("SELECT fts_group, COUNT(*) AS n FROM docs GROUP BY fts_group").all() as { fts_group: "en" | "default"; n: number }[]) groups[r.fts_group] = r.n;
    let sizeBytes = 0;
    for (const suffix of ["", "-wal"]) { try { sizeBytes += fs.statSync(this.file + suffix).size; } catch { /* absent */ } }
    return {
      generationId: this.generationId,
      schemaVersion: Number(this.getMeta("schema_version") ?? 0),
      builtAt: this.getMeta("built_at") ? Number(this.getMeta("built_at")) : null,
      lastAppliedOutboxId: this.lastAppliedOutboxId,
      docs: groups.en + groups.default,
      groups,
      vocabTerms: (this.st("SELECT COUNT(*) AS n FROM vocab").get() as { n: number }).n,
      sizeBytes,
      lastOptimizeAt: this.getMeta("last_optimize_at") ? Number(this.getMeta("last_optimize_at")) : null,
      tokenizers: this.getMeta("tokenizers") ?? "",
    };
  }

  // ---- typo tolerance (S-05) -----------------------------------------------------------------

  private activeGroups(): ("en" | "default")[] {
    const out: ("en" | "default")[] = [];
    if (this.st("SELECT 1 FROM docs WHERE fts_group = 'en' LIMIT 1").get()) out.push("en");
    if (this.st("SELECT 1 FROM docs WHERE fts_group = 'default' LIMIT 1").get()) out.push("default");
    return out;
  }

  vocabDf(term: string): number {
    return (this.st("SELECT df FROM vocab WHERE term = ?").get(term) as { df: number } | undefined)?.df ?? 0;
  }

  /** True when the word is in the vocabulary, or when the index finds it (through stemming) as a term. */
  private isKnown(token: string, groups: ("en" | "default")[]): boolean {
    if (this.vocabDf(token) > 0) return true;
    for (const g of groups) {
      try {
        if (this.st(`SELECT 1 FROM ${this.ftsTable(g)} WHERE ${this.ftsTable(g)} MATCH ? LIMIT 1`).get(`"${token}"`)) return true;
      } catch { /* an unusable token is not known */ }
    }
    return false;
  }

  /** Candidate corrections for a word: trigram candidates, edit distance filter, ordered by distance then document frequency. */
  suggestTerms(term: string, limit = 5): { term: string; distance: number; df: number }[] {
    const L = [...term].length;
    const maxD = L >= 8 ? 2 : L >= 4 ? 1 : 0;
    if (!maxD) return [];
    const grams = gramsOf(term);
    if (!grams.length) return [];
    const rows = this.st("SELECT v.term AS term, v.df AS df FROM vocab_tri t JOIN vocab v ON v.rowid = t.rowid WHERE vocab_tri MATCH ? ORDER BY rank LIMIT ?")
      .all(grams.map((g) => `"${g}"`).join(" OR "), L <= 6 ? 1000 : 300) as { term: string; df: number }[];
    const out: { term: string; distance: number; df: number }[] = [];
    for (const r of rows) {
      if (r.term === term) continue;
      const d = editDistance(term, r.term, maxD);
      if (d <= maxD) out.push({ term: r.term, distance: d, df: r.df });
    }
    out.sort((a, b) => a.distance - b.distance || b.df - a.df || (a.term < b.term ? -1 : 1));
    return out.slice(0, limit);
  }

  // ---- search (S-04 to S-09) -----------------------------------------------------------------

  private exact(sql: string, ...params: unknown[]): unknown[] { return this.st(sql).all(...params); }

  /** Which query terms are unknown and what they should become. */
  private corrections(parsed: ParsedQuery, groups: ("en" | "default")[]): { from: string; to: string; alts: string[] }[] {
    const out: { from: string; to: string; alts: string[] }[] = [];
    for (const t of parsed.terms) {
      if (t.prefix || t.tokens.length !== 1) continue;
      const w = t.tokens[0]!;
      if (w.length < 4 || /^\p{N}+$/u.test(w)) continue;
      if (this.isKnown(w, groups)) continue;
      const c = this.suggestTerms(w, 3);
      if (c.length) out.push({ from: w, to: c[0]!.term, alts: c.map((x) => x.term) });
    }
    return out;
  }

  /** A rare typed word with a far more common neighbour one edit away: offered, not applied. */
  private softSuggestion(parsed: ParsedQuery): { from: string; to: string }[] {
    const out: { from: string; to: string }[] = [];
    for (const t of parsed.terms) {
      if (t.prefix || t.tokens.length !== 1) continue;
      const w = t.tokens[0]!;
      if (w.length < 5 || /^\p{N}+$/u.test(w)) continue;
      const df = this.vocabDf(w);
      if (df === 0 || df > 2) continue;
      const best = this.suggestTerms(w, 3).find((c) => c.distance === 1 && c.df >= Math.max(50, df * 50));
      if (best) out.push({ from: w, to: best.term });
    }
    return out;
  }

  private didYouMeanText(parsed: ParsedQuery, map: Map<string, string>): string {
    const parts: string[] = [];
    for (const n of parsed.ast) {
      if (n.type === "operator") parts.push(`${n.negated ? "-" : ""}${n.name}:${n.value}`);
      else if (n.type === "phrase") parts.push(`${n.negated ? "-" : ""}"${n.value}"`);
      else {
        const tok = n.tokens.length === 1 ? map.get(n.tokens[0]!) : undefined;
        parts.push(`${n.negated ? "-" : ""}${tok ?? n.value}${n.prefix ? "*" : ""}`);
      }
    }
    return parts.join(" ");
  }

  private queryLang(parsed: ParsedQuery): string {
    const words = [...parsed.terms.map((t) => t.text), ...parsed.phrases.map((p) => p.join(" "))].join(" ");
    const g = guessLanguage(words.length < 40 ? words + " ".repeat(0) : words);
    return g ?? "en";
  }

  /** Builds the groups (term + alternatives) for a mode. */
  private buildParts(parsed: ParsedQuery, o: { corr: Map<string, { to: string; alts: string[] }>; variant: "best" | "alts"; synonyms: boolean; mode: "and" | "or"; dropStops: boolean }) {
    const lang = this.queryLang(parsed);
    let terms = parsed.terms;
    if (o.dropStops && terms.length + parsed.phrases.length > 1) {
      const kept = terms.filter((t) => t.prefix || t.tokens.length !== 1 || !isStopword(t.tokens[0]!, lang));
      if (kept.length + parsed.phrases.length > 0) terms = kept;
    }
    const groups: string[][] = [];
    const termTexts: string[] = [];
    for (const t of terms) {
      const w = t.tokens.length === 1 ? t.tokens[0]! : null;
      const c = w ? o.corr.get(w) : undefined;
      const words = c ? (o.variant === "alts" ? c.alts : [c.to]) : null;
      const alts: string[] = [];
      if (words) for (const x of words) alts.push(atom([x]));
      else {
        alts.push(atom(t.tokens, t.prefix));
        // The English index holds stems ("fenc"), so a prefix typed from the full word ("fenci") needs the real words too.
        if (t.prefix && w && w.length >= 2) {
          for (const r of this.st("SELECT term FROM vocab WHERE term >= ? AND term < ? ORDER BY df DESC LIMIT 12").all(w, w + "\uffff") as { term: string }[]) alts.push(atom([r.term]));
        }
      }
      if (o.synonyms && !t.prefix) {
        const keys = words ?? [t.text];
        for (const k of keys) for (const syn of this.synMap.get(k) ?? []) alts.push(atom(syn));
      }
      groups.push([...new Set(alts)]);
      termTexts.push(words ? words[0]! : t.text);
    }
    for (const p of parsed.phrases) { groups.push([atom(p)]); termTexts.push(p.join(" ")); }
    const negatives = parsed.excludedTerms.map((p) => atom(p));
    return { groups, negatives, mode: o.mode, termTexts };
  }

  /** Does a positive term match so many pages that scoring them all would be slow? (document frequency from the vocabulary) */
  private heavy(parsed: ParsedQuery, corr: Map<string, { to: string; alts: string[] }>): boolean {
    for (const t of parsed.terms) {
      if (t.tokens.length !== 1) continue;
      let w = t.tokens[0]!;
      w = corr.get(w)?.to ?? w;
      let df = this.vocabDf(w);
      if (t.prefix) {
        df = 0;
        for (const r of this.st("SELECT df FROM vocab WHERE term >= ? AND term < ? ORDER BY df DESC LIMIT 12").all(w, w + "\uffff") as { df: number }[]) df += r.df;
      }
      if (df >= TITLE_FIRST_DF) return true;
    }
    return false;
  }

  private candidateSql(group: "en" | "default", where: string, withIds: boolean): string {
    const T = this.ftsTable(group);
    return `SELECT d.id AS id, bm25(${T}, ${BM25_WEIGHTS.title}, ${BM25_WEIGHTS.headings}, ${BM25_WEIGHTS.url}, ${BM25_WEIGHTS.body}) AS s
      FROM ${T} JOIN docs d ON d.id = ${T}.rowid WHERE ${T} MATCH ? AND ${where}${withIds ? ` AND ${T}.rowid IN (SELECT value FROM json_each(?))` : ""}
      ORDER BY s LIMIT ?`;
  }

  private runCandidates(groups: ("en" | "default")[], expr: string, where: string, params: (string | number)[], cap: number, ids?: number[], snipExpr?: string): Candidate[] {
    const out: Candidate[] = [];
    for (const g of groups) {
      const sql = this.candidateSql(g, where, !!ids);
      const args: unknown[] = [expr, ...params];
      if (ids) args.push(JSON.stringify(ids));
      args.push(cap);
      for (const r of this.st(sql).all(...args) as { id: number; s: number }[]) out.push({ id: r.id, s: r.s, group: g, expr: snipExpr ?? expr });
    }
    out.sort((a, b) => a.s - b.s || a.id - b.id);
    return out.slice(0, cap);
  }

  private hot = new Map<string, SearchOutput>();
  private hotVersion = -1;
  /** Counts of hot-query cache hits and misses (benchmarks and the status endpoint). */
  hotStats = { hits: 0, misses: 0 };

  /**
   * Hot-query cache (S-13 mitigation): repeated identical searches, such as the page 1 reload after back-navigation or a saved
   * search that is run again, are answered from memory. Any commit to the index file (`PRAGMA data_version`) or a configuration
   * change empties it, so it can never serve results older than the index.
   */
  search(p: SearchParams): SearchOutput {
    if (p.debug) return this.searchUncached(p);
    const version = Number(this.db.pragma("data_version", { simple: true }));
    if (version !== this.hotVersion) { this.hot.clear(); this.hotVersion = version; }
    const key = JSON.stringify(p);
    const hit = this.hot.get(key);
    if (hit) { this.hotStats.hits++; this.hot.delete(key); this.hot.set(key, hit); return { ...hit, tookMs: 0 }; }
    this.hotStats.misses++;
    const out = this.searchUncached(p);
    this.hot.set(key, out);
    if (this.hot.size > 200) this.hot.delete(this.hot.keys().next().value as string);
    return out;
  }

  private searchUncached(p: SearchParams): SearchOutput {
    const t0 = performance.now();
    const parsed = parseQuery(p.query);
    const filters = p.filters ?? {};
    const pageSize = Math.max(1, Math.min(50, Math.floor(p.pageSize ?? 20)));
    const page = Math.max(1, Math.floor(p.page ?? 1));
    const cap = this.ranking.candidateCap;
    const groups = this.activeGroups();
    const plan: Record<string, unknown> = { groups, attempts: [] as unknown[] };
    const empty = (): SearchOutput => ({ parsed: parsedForApi(parsed), hits: [], total: 0, totalCapped: false, tookMs: ms(t0), hasMore: false, ...(p.debug ? { plan } : {}) });
    if (!groups.length) return empty();
    const filt = filterSql(parsed, filters);
    const positive = hasPositive(parsed);

    let cands: Candidate[] = [];
    let matchedBy: ScoreExplanation["matchedBy"] = "and";
    let didYouMean: DidYouMean | undefined;
    let usedExprs: { group: "en" | "default"; expr: string }[] = [];
    let exactIds = new Set<number>();
    let matchExprFacets: string | null = null;

    if (positive) {
      const corr = p.typo === false ? [] : this.corrections(parsed, groups);
      const corrMap = new Map(corr.map((c) => [c.from, { to: c.to, alts: c.alts }]));
      const synonyms = p.synonyms !== false;
      const attempts: { mode: "and" | "or"; variant: "best" | "alts"; label: ScoreExplanation["matchedBy"] }[] = [{ mode: "and", variant: "best", label: corr.length ? "corrected" : "and" }];
      if (corr.some((c) => c.alts.length > 1)) attempts.push({ mode: "and", variant: "alts", label: "corrected" });
      attempts.push({ mode: "or", variant: corr.length ? "alts" : "best", label: corr.length ? "corrected" : "or" });
      let firstGroupsCount = 0;
      let corrTitle = "";
      for (const [i, a] of attempts.entries()) {
        const parts = this.buildParts(parsed, { corr: corrMap, variant: a.variant, synonyms, mode: a.mode, dropStops: true });
        if (i === 0) { firstGroupsCount = parts.groups.length; corrTitle = parts.termTexts.join(" "); }
        if (a.mode === "or" && firstGroupsCount < 2) continue; // OR of one group is the same query
        const expr = matchExpr(parts);
        if (!expr) continue;
        // Exact title: the typed words, or the corrected ones, equal a page title.
        const typed = parsed.ast.flatMap((n) => (n.type !== "operator" && !n.negated ? [n.tokens.join(" ")] : [])).join(" ");
        const titles = [...new Set([typed, corrTitle].filter(Boolean))];
        let rows: Candidate[] = [];
        let runExpr = expr;
        if (a.mode === "and" && this.heavy(parsed, corrMap)) {
          // Title-first pass (S-13 mitigation): a query with a very common term would score every matching page. Ask for pages that
          // have the words in the title, headings or URL first; only if that gives too few does the full query run.
          const colExpr = matchExpr({ ...parts, columns: ["title", "headings", "url"] });
          if (colExpr) {
            rows = this.runCandidates(groups, colExpr, filt.where, filt.params, cap, undefined, expr);
            (plan.attempts as unknown[]).push({ expr: colExpr, mode: "title-first", rows: rows.length });
            if (rows.length >= Math.min(30, cap)) runExpr = colExpr; else rows = [];
          }
        }
        if (!rows.length) rows = this.runCandidates(groups, expr, filt.where, filt.params, cap);
        (plan.attempts as unknown[]).push({ expr, mode: a.mode, variant: a.variant, rows: rows.length });
        if (i === 0 && titles.length) {
          const ex = this.st(`SELECT d.id AS id FROM docs d WHERE d.title_norm IN (${titles.map(() => "?").join(",")}) AND ${filt.where} LIMIT 20`).all(...titles, ...filt.params) as { id: number }[];
          exactIds = new Set(ex.map((x) => x.id));
          const missing = ex.map((x) => x.id).filter((id) => !rows.some((r) => r.id === id));
          if (missing.length && rows.length >= cap) {
            rows = [...rows, ...this.runCandidates(groups, runExpr, filt.where, filt.params, missing.length, missing, expr)];
          }
        } else if (titles.length) {
          const ex = this.st(`SELECT d.id AS id FROM docs d WHERE d.title_norm IN (${titles.map(() => "?").join(",")}) AND ${filt.where} LIMIT 20`).all(...titles, ...filt.params) as { id: number }[];
          exactIds = new Set(ex.map((x) => x.id));
        }
        if (rows.length) {
          cands = rows;
          matchedBy = a.label;
          usedExprs = groups.map((g) => ({ group: g, expr }));
          matchExprFacets = expr;
          if (corr.length) {
            didYouMean = { text: this.didYouMeanText(parsed, new Map(corr.map((c) => [c.from, c.to]))), corrected: corr.map((c) => ({ from: c.from, to: c.to })), appliedAutomatically: true };
          }
          break;
        }
      }
      if (!cands.length && corr.length) {
        // Nothing found even after correcting: still say what was meant.
        didYouMean = { text: this.didYouMeanText(parsed, new Map(corr.map((c) => [c.from, c.to]))), corrected: corr.map((c) => ({ from: c.from, to: c.to })), appliedAutomatically: false };
      }
      if (!didYouMean && p.typo !== false) {
        const soft = this.softSuggestion(parsed);
        if (soft.length) didYouMean = { text: this.didYouMeanText(parsed, new Map(soft.map((c) => [c.from, c.to]))), corrected: soft, appliedAutomatically: false };
      }
    } else {
      // Only operators and exclusions: newest first.
      const neg = parsed.excludedTerms.length ? matchExpr({ groups: [parsed.excludedTerms.map((p) => atom(p))], negatives: [], mode: "or" }) : null;
      let where = filt.where;
      const params = [...filt.params];
      if (neg) for (const g of groups) { where += ` AND d.id NOT IN (SELECT rowid FROM ${this.ftsTable(g)} WHERE ${this.ftsTable(g)} MATCH ?)`; params.push(neg); }
      const rows = this.st(`SELECT d.id AS id FROM docs d WHERE ${where} ORDER BY d.date_for_ranking DESC, d.id LIMIT ?`).all(...params, cap) as { id: number }[];
      cands = rows.map((r) => ({ id: r.id, s: 0, group: "en", expr: "" }));
      matchExprFacets = neg;
      plan.listing = true;
    }

    // ---- score, order, group ----
    const now = this.now();
    const ids = cands.map((c) => c.id);
    const rowsById = new Map<number, DocRow>();
    if (ids.length) for (const r of this.st("SELECT * FROM docs WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as DocRow[]) rowsById.set(r.id, r);
    let srcByDoc: Map<number, string[]> | undefined;
    if (ids.length && Object.keys(this.ranking.preferences.sources).length) {
      srcByDoc = new Map();
      for (const r of this.st("SELECT doc_id, source_id FROM doc_sources WHERE doc_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as { doc_id: number; source_id: string }[]) {
        (srcByDoc.get(r.doc_id) ?? srcByDoc.set(r.doc_id, []).get(r.doc_id)!).push(r.source_id);
      }
    }
    const best = cands.length ? Math.min(...cands.map((c) => c.s)) : 0;
    interface Scored { c: Candidate; row: DocRow; explain: ScoreExplanation; date: number }
    const scored: Scored[] = [];
    for (const c of cands) {
      const row = rowsById.get(c.id);
      if (!row) continue;
      const isExact = exactIds.has(c.id);
      const explain = scoreDoc({
        bm25: c.s, bestBm25: best, exactTitle: isExact, dateForRanking: row.date_for_ranking, inlinks: row.inlinks, availability: row.availability,
        domain: row.domain, sourceIds: srcByDoc?.get(row.id) ?? [], now,
      }, this.ranking, isExact && matchedBy === "and" ? "exact_title" : matchedBy);
      if (!positive) { explain.total = 0; }
      scored.push({ c, row, explain, date: row.date_for_ranking ?? 0 });
    }
    scored.sort((a, b) => positive ? compareHits({ score: a.explain.total, date: a.date, pageId: a.row.page_id }, { score: b.explain.total, date: b.date, pageId: b.row.page_id })
      : (b.date - a.date) || (a.row.page_id - b.row.page_id));

    const kept: (Scored & { also: Scored[] })[] = [];
    if (p.group === false) for (const s of scored) kept.push({ ...s, also: [] });
    else {
      for (const s of scored) {
        const dup = kept.find((k) =>
          (!!s.row.content_hash && k.row.content_hash === s.row.content_hash) || (!!s.row.simhash && !!k.row.simhash && hamming(s.row.simhash, k.row.simhash) <= 3));
        if (dup) { if (dup.also.length < 5) dup.also.push(s); } else kept.push({ ...s, also: [] });
      }
    }
    const offset = (page - 1) * pageSize;
    const slice = kept.slice(offset, offset + pageSize);
    const hasMore = offset + pageSize < kept.length;

    // ---- snippets for the page only ----
    const hits: Hit[] = slice.map((s, i) => {
      const { snippet, titleHtml } = this.snippetFor(s.row, s.c.expr, usedExprs);
      const h: Hit = {
        docId: s.row.id, pageId: s.row.page_id, publicPageId: s.row.public_page_id, url: s.row.url, domain: s.row.domain, title: s.row.title || s.row.url,
        titleHtml, snippet, type: s.row.type as Hit["type"], lang: s.row.lang, capturedAt: s.row.captured_at, publishedAt: s.row.published_at,
        availability: s.row.availability, score: s.explain.total, rank: offset + i + 1,
      };
      if (s.also.length) h.alsoAt = s.also.map((a) => ({ pageId: a.row.page_id, publicPageId: a.row.public_page_id, url: a.row.url, title: a.row.title || a.row.url }));
      if (p.debug) h.explain = s.explain;
      return h;
    });

    // ---- totals and facets ----
    let total = scored.length;
    let totalCapped = false;
    if (cands.length >= cap) {
      if (positive && matchExprFacets) {
        let n = 0;
        for (const g of groups) {
          const T = this.ftsTable(g);
          n += (this.st(`SELECT COUNT(*) AS n FROM (SELECT ${T}.rowid FROM ${T} JOIN docs d ON d.id = ${T}.rowid WHERE ${T} MATCH ? AND ${filt.where} LIMIT ${TOTAL_CAP + 1})`).get(matchExprFacets, ...filt.params) as { n: number }).n;
        }
        total = Math.min(n, TOTAL_CAP);
        totalCapped = n > TOTAL_CAP;
      } else { total = kept.length; totalCapped = true; }
    }
    const out: SearchOutput = { parsed: parsedForApi(parsed), hits, total, totalCapped, tookMs: 0, hasMore };
    if (p.facets !== false && (page === 1 || p.facets === true)) out.facets = this.facets(parsed, filters, positive ? matchExprFacets : null, groups, positive);
    if (didYouMean) out.didYouMean = didYouMean;
    if (p.debug) out.plan = plan;
    out.tookMs = ms(t0);
    return out;
  }

  // NB: better-sqlite3 binds JS numbers as REAL, and FTS5 ignores a REAL rowid constraint when combined with MATCH
  // (it returns the first match instead), so the id must be CAST to INTEGER here.
  private snippetFor(row: DocRow, expr: string, used: { group: "en" | "default"; expr: string }[]): { snippet: string; titleHtml: string } {
    const T = this.ftsTable(row.fts_group);
    const fallbackLead = (): string => {
      const lead = (this.st(`SELECT substr(body, 1, 240) AS b FROM ${T} WHERE rowid = ?`).get(row.id) as { b: string } | undefined)?.b ?? "";
      return escapeHtml((row.description || lead).slice(0, 240));
    };
    if (!expr) return { snippet: fallbackLead(), titleHtml: escapeHtml(row.title || row.url) };
    try {
      const r = this.st(`SELECT snippet(${T}, 3, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 24) AS body, snippet(${T}, 1, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 16) AS heads,
          highlight(${T}, 0, '${MARK_OPEN}', '${MARK_CLOSE}') AS title FROM ${T} WHERE ${T} MATCH ? AND rowid = CAST(? AS INTEGER)`).get(expr, row.id) as { body: string; heads: string; title: string } | undefined;
      if (!r) return { snippet: fallbackLead(), titleHtml: escapeHtml(row.title || row.url) };
      let sn = r.body && r.body.includes(MARK_OPEN) ? r.body : r.heads && r.heads.includes(MARK_OPEN) ? r.heads : "";
      const snippet = sn ? sanitiseMarked(sn) : fallbackLead();
      return { snippet, titleHtml: sanitiseMarked(r.title || row.title || row.url) };
    } catch {
      return { snippet: fallbackLead(), titleHtml: escapeHtml(row.title || row.url) };
    }
  }

  // ---- facets (S-12) -------------------------------------------------------------------------

  private facets(parsed: ParsedQuery, f: Filters, expr: string | null, groups: ("en" | "default")[], positive: boolean): Facets {
    const opf = filterSql(parsed, {}, { onlyOperators: true });
    let ids: number[] = [];
    if (positive && expr) {
      for (const g of groups) {
        const T = this.ftsTable(g);
        const rows = this.st(`SELECT d.id AS id FROM ${T} JOIN docs d ON d.id = ${T}.rowid WHERE ${T} MATCH ? AND ${opf.where} LIMIT ${FACET_CAP}`).all(expr, ...opf.params) as { id: number }[];
        ids.push(...rows.map((r) => r.id));
      }
    } else {
      let where = opf.where;
      const params = [...opf.params];
      if (expr) for (const g of groups) { where += ` AND d.id NOT IN (SELECT rowid FROM ${this.ftsTable(g)} WHERE ${this.ftsTable(g)} MATCH ?)`; params.push(expr); }
      ids = (this.st(`SELECT d.id AS id FROM docs d WHERE ${where} LIMIT ${FACET_CAP}`).all(...params) as { id: number }[]).map((r) => r.id);
    }
    const approximate = ids.length >= FACET_CAP;
    ids = ids.slice(0, FACET_CAP);
    const json = JSON.stringify(ids);
    const recs = new Map<number, { domain: string; type: string; lang: string | null; availability: string; captured: number | null; published: number | null; sources: string[]; collections: string[] }>();
    for (const r of this.st("SELECT id, domain, type, lang, availability, captured_at, published_at FROM docs WHERE id IN (SELECT value FROM json_each(?))").all(json) as
      { id: number; domain: string; type: string; lang: string | null; availability: string; captured_at: number | null; published_at: number | null }[]) {
      recs.set(r.id, { domain: r.domain, type: r.type, lang: r.lang, availability: r.availability, captured: r.captured_at, published: r.published_at, sources: [], collections: [] });
    }
    for (const r of this.st("SELECT doc_id, source_id FROM doc_sources WHERE doc_id IN (SELECT value FROM json_each(?))").all(json) as { doc_id: number; source_id: string }[]) recs.get(r.doc_id)?.sources.push(r.source_id);
    for (const r of this.st("SELECT doc_id, collection_id FROM doc_collections WHERE doc_id IN (SELECT value FROM json_each(?))").all(json) as { doc_id: number; collection_id: string }[]) recs.get(r.doc_id)?.collections.push(r.collection_id);

    const now = this.now();
    const DAY = 86_400_000;
    const bucket = (t: number | null, unknownLabel: string | null): string | null => {
      if (t === null) return unknownLabel;
      const age = now - t;
      return age <= DAY ? "last_day" : age <= 7 * DAY ? "last_week" : age <= 30 * DAY ? "last_month" : age <= 365 * DAY ? "last_year" : "older";
    };
    const typesSel = f.types ? normaliseTypes(f.types) : undefined;
    const avMap: Record<string, string> = { cached: "archived", partial: "partial" };
    const passes = (r: typeof recs extends Map<number, infer V> ? V : never, skip: string): boolean => {
      if (skip !== "domains" && f.domains?.length && !f.domains.some((h) => r.domain === h.toLowerCase() || r.domain.endsWith("." + h.toLowerCase()))) return false;
      if (skip !== "types" && typesSel && !typesSel.includes(r.type)) return false;
      if (skip !== "languages" && f.languages?.length && !f.languages.map((x) => x.toLowerCase().split(/[-_]/)[0]).includes(r.lang ?? "")) return false;
      if (skip !== "availability" && f.availability?.length && !f.availability.map((x) => avMap[x]).includes(r.availability)) return false;
      if (skip !== "sources" && f.sources?.length && !r.sources.some((s) => f.sources!.includes(s))) return false;
      if (skip !== "collections" && f.collections?.length && !r.collections.some((c) => f.collections!.includes(c))) return false;
      if (skip !== "downloaded") {
        if (f.downloadedFrom !== undefined && !(r.captured !== null && r.captured >= f.downloadedFrom)) return false;
        if (f.downloadedTo !== undefined && !(r.captured !== null && r.captured <= f.downloadedTo)) return false;
      }
      if (skip !== "published") {
        if (f.publishedFrom !== undefined && !(r.published !== null && r.published >= f.publishedFrom)) return false;
        if (f.publishedTo !== undefined && !(r.published !== null && r.published <= f.publishedTo)) return false;
      }
      return true;
    };
    const tally = (skip: string, values: (r: ReturnType<typeof recs.get> & object) => (string | null)[]): Facet[] => {
      const m = new Map<string, number>();
      for (const r of recs.values()) {
        if (!passes(r, skip)) continue;
        for (const v of values(r)) if (v !== null) m.set(v, (m.get(v) ?? 0) + 1);
      }
      return [...m].map(([value, count]) => ({ value, label: value, count })).sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1)).slice(0, 20);
    };
    return {
      sources: tally("sources", (r) => r.sources),
      collections: tally("collections", (r) => r.collections),
      domains: tally("domains", (r) => [r.domain]),
      types: tally("types", (r) => [r.type]),
      languages: tally("languages", (r) => [r.lang]),
      availability: tally("availability", (r) => [r.availability === "archived" ? "cached" : "partial"]),
      downloaded: tally("downloaded", (r) => [bucket(r.captured, null)]),
      published: tally("published", (r) => [bucket(r.published, "unknown")]),
      approximate,
    };
  }

  // ---- suggestions (S-06) --------------------------------------------------------------------

  suggest(q: string, limit: number): SuggestOutput {
    const t0 = performance.now();
    limit = Math.max(1, Math.min(20, Math.floor(limit)));
    const items: Suggestion[] = [];
    const seen = new Set<string>();
    const push = (s: Suggestion) => { const k = `${s.kind}:${s.text.toLowerCase()}`; if (!seen.has(k)) { seen.add(k); items.push(s); } };
    const groupCap = Math.max(1, Math.ceil(limit / 2));
    const siteM = /(?:^|\s)-?site:(\S*)$/i.exec(q);
    if (siteM) {
      const pre = siteM[1]!.toLowerCase().replace(/^www\./, "");
      const head = q.slice(0, q.length - siteM[0].length + (siteM[0].startsWith(" ") ? 1 : 0)).trimEnd();
      for (const r of this.st("SELECT domain, n FROM domains WHERE domain >= ? AND domain < ? ORDER BY n DESC, domain LIMIT ?").all(pre, pre + "￿", limit) as { domain: string; n: number }[]) {
        push({ kind: "domain", text: `${head ? head + " " : ""}site:${r.domain}`, count: r.n });
      }
      return { items, tookMs: ms(t0) };
    }
    const words = tokenize(q);
    const endsSpace = /\s$/.test(q);
    const lastPartial = !endsSpace && words.length > 0 ? words[words.length - 1]! : null;
    const complete = lastPartial ? words.slice(0, -1) : words;
    const groups = this.activeGroups();
    if (words.length && groups.length) {
      const expr = [...complete.map((w) => `"${w}"`), ...(lastPartial ? [`"${lastPartial}"*`] : [])].join(" ");
      // No bm25 ordering: scoring every title that starts with three letters costs 50 ms at 500,000 pages. Take the first 120 matches
      // in index order, then prefer titles that start with the typed text, then shorter titles, then pages with more in-links.
      const rows = this.st("SELECT d.public_page_id AS pid, d.title AS title, d.title_norm AS tn, d.url AS url, d.domain AS domain, d.inlinks AS il FROM title_fts t JOIN docs d ON d.id = t.rowid WHERE title_fts MATCH ? LIMIT 120")
        .all(expr) as { pid: string; title: string; tn: string; url: string; domain: string; il: number }[];
      const typed = words.join(" ");
      rows.sort((a, b) => Number(b.tn.startsWith(typed)) - Number(a.tn.startsWith(typed)) || a.tn.length - b.tn.length || b.il - a.il || (a.tn < b.tn ? -1 : 1));
      for (const r of rows.slice(0, groupCap)) push({ kind: "title", text: r.title || r.url, url: r.url, pageId: r.pid, domain: r.domain });
    }
    if (lastPartial && words.length === 1 && lastPartial.length >= 2) {
      for (const r of this.st("SELECT domain, n FROM domains WHERE domain >= ? AND domain < ? ORDER BY n DESC, domain LIMIT ?").all(lastPartial, lastPartial + "￿", Math.min(3, groupCap)) as { domain: string; n: number }[]) {
        push({ kind: "domain", text: r.domain, count: r.n });
      }
    }
    if (lastPartial && lastPartial.length >= 2) {
      const head = complete.length ? complete.join(" ") + " " : "";
      for (const r of this.st("SELECT term FROM vocab WHERE term >= ? AND term < ? AND term <> ? ORDER BY df DESC LIMIT ?").all(lastPartial, lastPartial + "￿", lastPartial, groupCap) as { term: string }[]) {
        push({ kind: "term", text: head + r.term });
      }
    }
    let didYouMean: DidYouMean | undefined;
    if (words.length && groups.length) {
      const fix = new Map<string, string>();
      for (const [i, w] of words.entries()) {
        if (w.length < 4 || /^\p{N}+$/u.test(w)) continue;
        const isLast = i === words.length - 1;
        if (isLast && lastPartial) {
          // A partial last word is only wrong when nothing starts with it.
          if (this.st("SELECT 1 FROM vocab WHERE term >= ? AND term < ? LIMIT 1").get(w, w + "￿")) continue;
        }
        if (this.isKnown(w, groups)) continue;
        const c = this.suggestTerms(w, 1)[0];
        if (c) fix.set(w, c.term);
      }
      if (fix.size) didYouMean = { text: words.map((w) => fix.get(w) ?? w).join(" "), corrected: [...fix].map(([from, to]) => ({ from, to })), appliedAutomatically: false };
    }
    return { items: items.slice(0, limit), ...(didYouMean ? { didYouMean } : {}), tookMs: ms(t0) };
  }
}

const ms = (t0: number): number => Math.round((performance.now() - t0) * 100) / 100;
