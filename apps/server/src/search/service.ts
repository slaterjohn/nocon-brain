import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { Db } from "@ncb/db";
import { AppError, newId, type Clock } from "@ncb/shared";
import {
  DEFAULT_RANKING, DEFAULT_WEIGHTS, BM25_WEIGHTS, mergeRanking, normaliseTypes, parseQuery, hasAnyCriteria, MAX_QUERY_LENGTH,
  type DidYouMean, type Facets, type Filters, type RankingConfig, type RankingWeights, type SearchOutput, type Suggestion, type SynonymConfig, type IndexStats,
} from "@ncb/search";
import { parseOrThrow, RequestValidationError } from "../lib/zod.js";
import type { SettingsService } from "../services/settings.js";
import type { ActivityLog } from "../services/activity.js";
import type { CheckReport, FromIndexWorker, FromSearchWorker, IndexCommand, IndexStatusReply, IndexWorkerData, SearchReply, SearchRequest, SearchWorkerData } from "./protocol.js";

const iso = (n: number | null | undefined): string | undefined => (n == null ? undefined : new Date(n).toISOString());
const isoDateOrDay = z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v)), "Use a date such as 2026-01-31");

const filtersSchema = z.object({
  sources: z.array(z.string().max(64)).max(50).optional(),
  collections: z.array(z.string().max(64)).max(50).optional(),
  domains: z.array(z.string().max(253)).max(50).optional(),
  types: z.array(z.string().max(20)).max(10).optional(),
  downloadedFrom: isoDateOrDay.optional(), downloadedTo: isoDateOrDay.optional(), publishedFrom: isoDateOrDay.optional(), publishedTo: isoDateOrDay.optional(),
  availability: z.array(z.enum(["cached", "partial", "queued", "online_only"])).max(4).optional(),
  languages: z.array(z.string().max(12)).max(20).optional(),
});
const scopeSchema = z.enum(["all", "offline", "online", "images", "documents"]);
export const searchBodySchema = z.object({
  query: z.string().max(MAX_QUERY_LENGTH, `Use at most ${MAX_QUERY_LENGTH} characters`).default(""),
  scope: scopeSchema.default("all"),
  filters: filtersSchema.default({}),
  online: z.enum(["auto", "off", "on"]).default("auto"),
  providers: z.array(z.string().max(64)).max(20).optional(),
  page: z.number().int().min(1).max(1000).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
  typo: z.boolean().default(true),
  synonyms: z.boolean().default(true),
  facets: z.boolean().optional(),
  group: z.boolean().default(true),
  record: z.boolean().default(true),
  debug: z.boolean().default(false),
});
export type SearchBody = z.output<typeof searchBodySchema>;

const synonymsSchema = z.object({
  enabled: z.boolean().optional(),
  items: z.array(z.object({
    term: z.string().trim().min(1).max(60).regex(/^[\p{L}\p{N}][\p{L}\p{N} \-]*$/u, "Use letters, digits, spaces and hyphens"),
    expansions: z.array(z.string().trim().min(1).max(60).regex(/^[\p{L}\p{N}][\p{L}\p{N} \-]*$/u, "Use letters, digits, spaces and hyphens")).min(1).max(20),
    kind: z.enum(["twoway", "oneway"]),
  })).max(500),
});
const weightsSchema = z.object({
  relevance: z.number().min(0).max(5), exactTitle: z.number().min(0).max(5), freshness: z.number().min(0).max(5),
  linkGraph: z.number().min(0).max(5), preference: z.number().min(0).max(5), cached: z.number().min(0).max(5),
}).partial().strict();
const prefMap = z.record(z.string().max(253), z.number().min(-1).max(1));
const rankingBodySchema = z.object({ weights: weightsSchema.optional(), preferences: z.object({ domains: prefMap.optional(), sources: prefMap.optional() }).strict().optional() }).strict();

const savedBodySchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(120, "Use at most 120 characters"),
  query: z.string().max(MAX_QUERY_LENGTH).default(""),
  filters: filtersSchema.default({}),
  scope: scopeSchema.default("all"),
  includeOnline: z.boolean().default(false),
});
const savedPatchSchema = savedBodySchema.partial();

interface Pending { resolve(v: unknown): void; reject(e: Error): void; timer?: NodeJS.Timeout }

export type IndexState = "ok" | "building" | "rebuilding" | "missing" | "error";

export interface SearchServiceOptions {
  db: Db; clock: Clock; settings: SettingsService; activity: ActivityLog; dataDir: string;
  log: { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
  isOffline: () => boolean;
  searchWorkerFile?: string | URL; indexWorkerFile?: string | URL; workerExecArgv?: string[];
  pollMs?: number; batch?: number;
  testFlags?: IndexWorkerData["test"];
  /** Rebuild automatically when the index is missing or out of date (default true). */
  autoRebuild?: boolean;
}

function resolveWorker(name: string): { file: string; execArgv: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const dir of [here, path.join(here)]) {
    const js = path.join(dir, `${name}.js`);
    if (fs.existsSync(js)) return { file: js, execArgv: [] };
  }
  return { file: path.join(here, `${name}.ts`), execArgv: ["--import", "tsx"] };
}

/**
 * Local search (Phase 4). Owns the two workers (read-only `search`, writer `index`), the rebuild lifecycle, saved searches,
 * history and the mapping from index hits to the API shapes in docs/api.md section 6.1.
 */
export class SearchService {
  private searchW?: Worker;
  private indexW?: Worker;
  private seq = 1;
  private pendingS = new Map<number, Pending>();
  private pendingI = new Map<number, Pending>();
  private ranking: RankingConfig = DEFAULT_RANKING;
  private synonyms: SynonymConfig = { enabled: true, items: [] };
  state: IndexState = "missing";
  private indexOpen = false;
  private lastApplied = 0;
  private rebuildJob?: { id: number; generationId: number; startedAt: number; total: number; done: number; phase: string; error?: string };
  private sessions = new Map<string, { at: number; body: unknown }>();
  private stopped = false;
  private indexExited = false;
  private lastProgressWrite = 0;
  private pruneTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private waiters: ((m: FromIndexWorker) => void)[] = [];
  private readyResolve?: (m: Extract<FromIndexWorker, { t: "ready" }>) => void;
  lastCheck?: { at: number; ok: boolean; sampled: number; mismatches: number; countMismatch: number };
  /** Called after the index applied changes (the saved-search collections follow it). */
  onApplied?: () => void;
  /** Set by the server: evaluates saved-search collections. */
  collectionRefresh?: () => Promise<void>;

  constructor(private readonly o: SearchServiceOptions) {}

  private get db(): Db { return this.o.db; }
  get indexPath(): string { return path.join(this.o.dataDir, "index", "index.db"); }

  // ---- lifecycle -----------------------------------------------------------------------------

  async start(): Promise<void> {
    this.loadConfig();
    const indexSpec = this.o.indexWorkerFile ? { file: String(this.o.indexWorkerFile), execArgv: this.o.workerExecArgv ?? [] } : resolveWorker("index-worker");
    const searchSpec = this.o.searchWorkerFile ? { file: String(this.o.searchWorkerFile), execArgv: this.o.workerExecArgv ?? [] } : resolveWorker("search-worker");
    const idata: IndexWorkerData = {
      dataDir: this.o.dataDir, mainDbPath: path.join(this.o.dataDir, "db", "main.db"), indexPath: this.indexPath, synonyms: this.synonyms,
      pollMs: this.o.pollMs ?? 150, batch: this.o.batch ?? 200, test: this.o.testFlags,
    };
    const ready = new Promise<Extract<FromIndexWorker, { t: "ready" }>>((resolve) => { this.readyResolve = resolve; });
    this.indexW = new Worker(indexSpec.file, { workerData: idata, execArgv: indexSpec.execArgv });
    this.indexW.on("message", (m: FromIndexWorker) => this.onIndexMessage(m));
    this.indexW.on("error", (e) => { this.o.log.error({ err: String(e) }, "index worker failed"); this.failPending(this.pendingI, e); });
    this.indexW.on("exit", () => { this.indexExited = true; if (!this.stopped) this.o.log.warn({}, "index worker exited"); this.failPending(this.pendingI, new Error("The index worker stopped.")); });
    const r = await ready;
    await this.startSearchWorker(searchSpec);
    this.lastApplied = r.lastAppliedId;
    if (r.state === "ok") {
      this.indexOpen = true;
      this.state = "ok";
      if (r.resumable) void this.startRebuild("resume after restart").catch(() => undefined);
    } else {
      this.state = "missing";
      this.o.activity.write({ level: "info", area: "search", message: `The search index is ${r.state === "missing" ? "missing" : "not usable"} and will be rebuilt from stored content.` });
      if (this.o.autoRebuild !== false) void this.startRebuild(`index ${r.state}`).catch(() => undefined);
    }
    this.pruneTimer = setInterval(() => this.prune(), 5000);
    this.pruneTimer.unref();
  }

  private startSearchWorker(spec: { file: string; execArgv: string[] }): Promise<void> {
    const data: SearchWorkerData = { indexPath: this.indexPath, ranking: this.ranking, synonyms: this.synonyms };
    return new Promise((resolve) => {
      const w = new Worker(spec.file, { workerData: data, execArgv: spec.execArgv });
      this.searchW = w;
      w.on("message", (m: FromSearchWorker) => {
        if (m.t === "ready") { resolve(); return; }
        const p = this.pendingS.get(m.id);
        if (!p) return;
        this.pendingS.delete(m.id);
        if (p.timer) clearTimeout(p.timer);
        if (m.ok) p.resolve(m.reply);
        else p.reject(Object.assign(new Error(m.error), { code: m.code }));
      });
      w.on("error", (e) => { this.o.log.error({ err: String(e) }, "search worker failed"); this.failPending(this.pendingS, e); resolve(); });
      w.on("exit", () => { this.failPending(this.pendingS, new Error("The search worker stopped.")); resolve(); });
    });
  }

  private failPending(map: Map<number, Pending>, e: Error): void {
    for (const [id, p] of map) { map.delete(id); if (p.timer) clearTimeout(p.timer); p.reject(e); }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.indexW && !this.indexExited) {
      try { await this.callIndex({ cmd: "stop" } as unknown as IndexCommand, 5000); } catch { /* terminating anyway */ }
      await this.indexW.terminate().catch(() => undefined);
    }
    await this.searchW?.terminate().catch(() => undefined);
    this.prune();
  }

  /** Kills the index worker without a clean stop (crash tests). */
  async crashIndexWorker(): Promise<void> {
    this.stopped = true;
    await this.indexW?.terminate();
    await this.searchW?.terminate();
  }

  // ---- worker plumbing -----------------------------------------------------------------------

  private callSearch(req: SearchRequest, timeoutMs = 30_000): Promise<SearchReply> {
    const w = this.searchW;
    if (!w) return Promise.reject(new Error("The search worker is not running."));
    const id = this.seq++;
    return new Promise<SearchReply>((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingS.delete(id); reject(new AppError("internal", "The search took too long.")); }, timeoutMs);
      this.pendingS.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      w.postMessage({ id, ...req });
    });
  }

  private callIndex<T = unknown>(cmd: IndexCommand, timeoutMs = 120_000): Promise<T> {
    const w = this.indexW;
    if (!w) return Promise.reject(new Error("The index worker is not running."));
    const id = this.seq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingI.delete(id); reject(new AppError("internal", "The index worker did not answer in time.")); }, timeoutMs);
      this.pendingI.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      w.postMessage({ id, ...cmd });
    });
  }

  private onIndexMessage(m: FromIndexWorker): void {
    switch (m.t) {
      case "ready": this.readyResolve?.(m); break;
      case "reply": {
        const p = this.pendingI.get(m.id);
        if (!p) break;
        this.pendingI.delete(m.id);
        if (p.timer) clearTimeout(p.timer);
        if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
        break;
      }
      case "applied":
        this.lastApplied = Math.max(this.lastApplied, m.lastId);
        this.scheduleRefresh();
        break;
      case "progress": {
        if (this.rebuildJob && this.rebuildJob.id === m.jobId) {
          Object.assign(this.rebuildJob, { done: m.done, total: m.total, phase: m.phase });
          const now = Date.now();
          if (now - this.lastProgressWrite > 400) {
            this.lastProgressWrite = now;
            try { this.db.run("UPDATE indexing_jobs SET docs_done = ?, docs_total = ? WHERE id = ?", [m.done, m.total, m.jobId]); } catch { /* shutting down */ }
          }
        }
        break;
      }
      case "swapped": {
        const now = this.o.clock.now();
        this.lastApplied = m.lastAppliedId;
        try {
          this.db.transaction(() => {
            this.db.run("UPDATE index_generations SET state = 'retired' WHERE state = 'active'");
            this.db.run("UPDATE index_generations SET state = 'active', doc_count = ?, built_at = ? WHERE id = ?", [m.docs, now, m.generationId]);
            this.db.run("UPDATE indexing_jobs SET state = 'done', docs_done = ?, docs_total = ?, finished_at = ?, detail_json = ? WHERE id = ?",
              [m.docs, m.docs, now, JSON.stringify({ ms: m.ms }), m.jobId]);
          });
        } catch { /* closing */ }
        this.indexOpen = true;
        this.state = "ok";
        this.rebuildJob = undefined;
        void this.callSearch({ op: "reopen" }).catch(() => undefined);
        this.o.activity.write({ level: "info", area: "search", message: `Search index rebuilt: ${m.docs} pages in ${(m.ms / 1000).toFixed(1)} s.` });
        this.prune();
        this.scheduleRefresh();
        break;
      }
      case "rebuild_failed": {
        try {
          this.db.run("UPDATE indexing_jobs SET state = 'failed', error = ?, finished_at = ? WHERE id = ?", [m.error.slice(0, 500), this.o.clock.now(), m.jobId]);
          this.db.run("UPDATE index_generations SET state = 'failed' WHERE state = 'building'");
        } catch { /* closing */ }
        if (this.rebuildJob) this.rebuildJob.error = m.error;
        this.state = this.indexOpen ? "ok" : "error";
        this.o.activity.write({ level: "error", area: "search", message: `Search index rebuild failed: ${m.error}` });
        break;
      }
      case "error": this.o.log.error({ message: m.message }, "index worker error"); break;
    }
    for (const w of this.waiters.splice(0)) w(m);
  }

  private prune(): void {
    if (this.rebuildJob || !this.indexOpen) return;
    try { this.db.run("DELETE FROM index_outbox WHERE id <= ?", [this.lastApplied]); } catch { /* closing */ }
  }

  private scheduleRefresh(): void {
    this.onApplied?.();
    if (!this.collectionRefresh || this.refreshTimer || this.stopped) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.collectionRefresh?.().catch(() => undefined);
    }, 1500);
    this.refreshTimer.unref();
  }

  /** Nudges the index worker to look at the outbox now. */
  wake(): void {
    try { this.indexW?.postMessage({ id: this.seq++, cmd: "resume" }); } catch { /* not running */ }
  }

  /** Waits until the outbox is empty (tests and the check endpoint). */
  async drain(timeoutMs = 30_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (this.rebuildJob) { await new Promise((r) => setTimeout(r, 50)); if (Date.now() > end) throw new Error("drain timed out"); continue; }
      const pending = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM index_outbox WHERE id > ?", [this.lastApplied])!.n;
      if (pending === 0 && this.indexOpen) return;
      if (Date.now() > end) throw new Error("drain timed out");
      this.wake();
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  // ---- configuration -------------------------------------------------------------------------

  private loadConfig(): void {
    const get = (k: string) => this.db.get<{ value: string }>("SELECT value FROM app_meta WHERE key = ?", [k])?.value;
    try {
      const r = get("search.ranking");
      if (r) this.ranking = mergeRanking(DEFAULT_RANKING, JSON.parse(r));
      const s = get("search.synonyms");
      if (s) this.synonyms = JSON.parse(s) as SynonymConfig;
    } catch { /* defaults */ }
  }
  private putMeta(k: string, v: unknown): void {
    this.db.run("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, JSON.stringify(v)]);
  }

  getSynonyms(): SynonymConfig { return this.synonyms; }
  async putSynonyms(body: unknown): Promise<SynonymConfig> {
    const v = parseOrThrow(synonymsSchema, body);
    this.synonyms = { enabled: v.enabled ?? this.synonyms.enabled, items: v.items };
    this.putMeta("search.synonyms", this.synonyms);
    await this.callSearch({ op: "config", synonyms: this.synonyms });
    if (this.indexOpen) await this.callIndex({ cmd: "synonyms", synonyms: this.synonyms }).catch(() => undefined);
    return this.synonyms;
  }

  getRanking(): { weights: RankingWeights; defaults: RankingWeights; bm25: typeof BM25_WEIGHTS; preferences: RankingConfig["preferences"] } {
    return { weights: this.ranking.weights, defaults: DEFAULT_WEIGHTS, bm25: BM25_WEIGHTS, preferences: this.ranking.preferences };
  }
  async putRanking(body: unknown): Promise<ReturnType<SearchService["getRanking"]>> {
    const v = parseOrThrow(rankingBodySchema, body);
    this.ranking = mergeRanking(this.ranking, { weights: v.weights as Partial<RankingWeights>, preferences: v.preferences as Partial<RankingConfig["preferences"]> });
    this.putMeta("search.ranking", { weights: this.ranking.weights, preferences: this.ranking.preferences });
    await this.callSearch({ op: "config", ranking: this.ranking });
    return this.getRanking();
  }

  // ---- search --------------------------------------------------------------------------------

  private toFilters(f: SearchBody["filters"], scope: SearchBody["scope"]): { filters: Filters; none: boolean } {
    const day = (v: string | undefined, end: boolean): number | undefined => {
      if (!v) return undefined;
      const t = Date.parse(v);
      return /^\d{4}-\d{2}-\d{2}$/.test(v) && end ? t + 86_400_000 - 1 : t;
    };
    const filters: Filters = {
      sources: f.sources, collections: f.collections, domains: f.domains, types: f.types, languages: f.languages, availability: f.availability,
      downloadedFrom: day(f.downloadedFrom, false), downloadedTo: day(f.downloadedTo, true), publishedFrom: day(f.publishedFrom, false), publishedTo: day(f.publishedTo, true),
    };
    for (const k of Object.keys(filters) as (keyof Filters)[]) if (filters[k] === undefined) delete filters[k];
    let none = false;
    const scoped = scope === "images" ? ["image"] : scope === "documents" ? ["pdf", "text"] : undefined;
    if (scoped) {
      if (filters.types) {
        const mine = normaliseTypes(filters.types).filter((t) => scoped.includes(t));
        filters.types = mine;
        if (!mine.length) none = true;
      } else filters.types = scoped;
    }
    return { filters, none };
  }

  /** Runs a search and maps it to the API response. */
  async search(raw: unknown, ctx: { userId?: number; searchIdFor?: string; recordHistory?: boolean } = {}): Promise<Record<string, unknown>> {
    const t0 = performance.now();
    const b = parseOrThrow(searchBodySchema, raw);
    const parsed = parseQuery(b.query);
    const { filters, none } = this.toFilters(b.filters, b.scope);
    if (!b.query.trim() && !Object.keys(b.filters).length && b.scope === "all") {
      throw new RequestValidationError([{ in: "body", path: "query", message: "Enter something to search for" }]);
    }
    if (!b.query.trim() && !hasAnyCriteria(parsed) && !Object.keys(filters).length) {
      throw new RequestValidationError([{ in: "body", path: "query", message: "Enter something to search for" }]);
    }
    let out: SearchOutput | undefined;
    if (b.scope !== "online" && !none) {
      try {
        const r = await this.callSearch({
          op: "search",
          params: { query: b.query, page: b.page, pageSize: b.pageSize, filters, typo: b.typo, synonyms: b.synonyms, group: b.group, facets: b.facets, debug: b.debug },
        });
        if (r.kind === "search") out = r.out;
      } catch (e) {
        if ((e as { code?: string }).code !== "index_unavailable") throw e;
      }
    }
    const empty = !out;
    const hits = out?.hits ?? [];
    const pageIds = hits.flatMap((h) => [h.pageId, ...(h.alsoAt ?? []).map((a) => a.pageId)]);
    const extra = this.pageExtras(hits.map((h) => h.pageId), pageIds);
    const results = hits.map((h) => {
      const x = extra.get(h.pageId);
      const key = "k_" + createHash("sha1").update(h.url).digest("hex").slice(0, 16);
      return {
        key, url: h.url, canonicalUrl: h.url, title: h.title, titleHtml: h.titleHtml, snippet: h.snippet, origin: "archive" as const,
        availability: h.availability === "archived" ? ("cached" as const) : ("partial" as const),
        pageId: h.publicPageId, domain: h.domain, type: h.type, ...(h.lang ? { language: h.lang } : {}),
        ...(h.capturedAt ? { capturedAt: iso(h.capturedAt) } : {}), ...(h.publishedAt ? { publishedAt: iso(h.publishedAt) } : {}),
        attribution: [{ kind: "local" as const, id: "archive", name: "Archive", rank: h.rank }], fusedRank: h.rank, fusedScore: h.score,
        storage: "persist" as const, actions: { open: `/library/pages/${h.publicPageId}`, saveForOffline: false },
        faviconUrl: x?.favicon ? `/api/search/favicon/${h.publicPageId}` : null, sourceName: x?.sourceName ?? null, collections: x?.collections ?? [],
        ...(h.alsoAt ? { alsoAt: h.alsoAt.map((a) => ({ pageId: a.publicPageId, url: a.url, title: a.title })) } : {}),
        ...(b.debug && h.explain ? { explain: h.explain } : {}),
      };
    });
    const facets = out?.facets ? this.labelFacets(out.facets) : undefined;
    const searchId = ctx.searchIdFor ?? newId("sch");
    const total = out?.total ?? 0;
    const response: Record<string, unknown> = {
      searchId,
      parsed: out?.parsed ?? { terms: parsed.terms.map((t) => t.text), phrases: [], excluded: [], operators: {}, warnings: parsed.warnings },
      results,
      ...(out?.didYouMean ? { didYouMean: out.didYouMean as DidYouMean } : {}),
      coverage: { cachedMatches: total, onlineMatches: 0, onlineNotArchived: 0, queued: 0, partial: facets?.availability.find((f) => f.value === "partial")?.count ?? 0, basis: "local_exact" },
      ...(facets ? { facets } : {}),
      total, totalCapped: out?.totalCapped ?? false, page: b.page, pageSize: b.pageSize,
      online: { state: this.o.isOffline() ? "offline" : "disabled", pending: [], disclosure: "" },
      tookMs: { local: out?.tookMs ?? 0, zim: 0 },
      index: { state: this.state },
      ...(out?.hasMore ? { nextCursor: String(b.page + 1) } : {}),
      ...(b.debug && out?.plan ? { plan: out.plan } : {}),
    };
    if (empty && this.state !== "ok") response.warnings = ["The search index is being rebuilt. Results will appear when it is ready."];
    this.sessions.set(searchId, { at: Date.now(), body: response });
    this.sweepSessions();
    if (b.record && b.page === 1 && ctx.recordHistory !== false && ctx.userId !== undefined && b.query.trim()) this.recordHistory(ctx.userId, b.query, b.scope, total);
    void t0;
    return response;
  }

  private docsHint = 0;

  private sweepSessions(): void {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [k, v] of this.sessions) if (v.at < cutoff) this.sessions.delete(k);
    if (this.sessions.size > 500) for (const k of [...this.sessions.keys()].slice(0, this.sessions.size - 500)) this.sessions.delete(k);
  }

  snapshot(searchId: string): unknown {
    this.sweepSessions();
    const s = this.sessions.get(searchId);
    if (!s) throw new AppError("not_found", "That search has expired. Run it again.");
    return s.body;
  }

  private labelFacets(f: Facets): Facets {
    const names = new Map<string, string>();
    const ids = [...f.sources.map((x) => x.value), ...f.collections.map((x) => x.value)];
    if (ids.length) {
      const marks = ids.map(() => "?").join(",");
      for (const r of this.db.all<{ public_id: string; name: string }>(`SELECT public_id, name FROM sources WHERE public_id IN (${marks}) UNION ALL SELECT public_id, name FROM collections WHERE public_id IN (${marks})`, [...ids, ...ids])) names.set(r.public_id, r.name);
    }
    const lab = (x: { value: string; label: string; count: number }) => ({ ...x, label: names.get(x.value) ?? x.label });
    return { ...f, sources: f.sources.map(lab), collections: f.collections.map(lab) };
  }

  private pageExtras(pageIds: number[], _all: number[]): Map<number, { sourceName: string | null; collections: { id: string; name: string }[]; favicon: boolean }> {
    const out = new Map<number, { sourceName: string | null; collections: { id: string; name: string }[]; favicon: boolean }>();
    if (!pageIds.length) return out;
    for (const id of pageIds) out.set(id, { sourceName: null, collections: [], favicon: false });
    const json = JSON.stringify(pageIds);
    for (const r of this.db.all<{ page_id: number; name: string }>(
      `SELECT ps.page_id, s.name FROM page_sources ps JOIN sources s ON s.id = ps.source_id WHERE ps.page_id IN (SELECT value FROM json_each(?)) AND s.deleted_at IS NULL ORDER BY s.id DESC`, [json])) {
      out.get(r.page_id)!.sourceName = r.name;
    }
    for (const r of this.db.all<{ page_id: number; public_id: string; name: string }>(
      `SELECT m.page_id, c.public_id, c.name FROM collection_memberships m JOIN collections c ON c.id = m.collection_id
       WHERE m.page_id IN (SELECT value FROM json_each(?)) AND c.deleted_at IS NULL ORDER BY c.id`, [json])) {
      out.get(r.page_id)!.collections.push({ id: r.public_id, name: r.name });
    }
    for (const r of this.db.all<{ id: number }>(
      `SELECT DISTINCT p.id FROM pages p JOIN asset_references r ON r.version_id = p.latest_version_id AND r.role = 'icon'
       JOIN assets a ON a.id = r.asset_id AND a.status = 'ok' AND a.blob_id IS NOT NULL WHERE p.id IN (SELECT value FROM json_each(?))`, [json])) {
      out.get(r.id)!.favicon = true;
    }
    return out;
  }

  /** The archived favicon of a page, or undefined. Only image types are served. */
  faviconBlob(publicPageId: string): { sha256: string; mime: string } | undefined {
    const r = this.db.get<{ sha256: string; mime: string | null; bmime: string | null }>(
      `SELECT b.sha256, a.mime, b.mime AS bmime FROM pages p JOIN asset_references r ON r.version_id = p.latest_version_id AND r.role = 'icon'
       JOIN assets a ON a.id = r.asset_id AND a.status = 'ok' JOIN blobs b ON b.id = a.blob_id AND b.state = 'ready'
       WHERE p.public_id = ? AND p.deleted_at IS NULL ORDER BY (a.mime LIKE 'image/png') DESC, b.size_bytes DESC LIMIT 1`, [publicPageId]);
    if (!r) return undefined;
    const mime = (r.mime ?? r.bmime ?? "").split(";")[0]!.trim().toLowerCase();
    if (!/^image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml|avif)$/.test(mime)) return undefined;
    return { sha256: r.sha256, mime };
  }

  // ---- suggestions ---------------------------------------------------------------------------

  async suggestions(q: string, limit: number, userId?: number): Promise<{ q: string; items: Suggestion[]; didYouMean?: DidYouMean }> {
    limit = Math.max(1, Math.min(20, limit));
    const half = Math.max(1, Math.ceil(limit / 2));
    let titles: Suggestion[] = [], domains: Suggestion[] = [], terms: Suggestion[] = [];
    let dym: DidYouMean | undefined;
    if (q.trim()) {
      try {
        const r = await this.callSearch({ op: "suggest", q, limit });
        if (r.kind === "suggest") {
          titles = r.out.items.filter((i) => i.kind === "title");
          domains = r.out.items.filter((i) => i.kind === "domain");
          terms = r.out.items.filter((i) => i.kind === "term");
          dym = r.out.didYouMean;
        }
      } catch { /* the index may be rebuilding */ }
    } else {
      domains = this.db.all<{ host: string; n: number }>(
        "SELECT host, COUNT(*) AS n FROM pages WHERE deleted_at IS NULL AND availability IN ('archived','partial') GROUP BY host ORDER BY n DESC, host LIMIT 5")
        .map((r) => ({ kind: "domain" as const, text: r.host, count: r.n }));
    }
    let queries: Suggestion[] = [];
    if (userId !== undefined && this.historyEnabled()) {
      const norm = q.trim().toLowerCase();
      const rows = this.db.all<{ query: string }>(
        `SELECT query FROM search_history WHERE user_id = ? AND normalised_query LIKE ? ESCAPE '\\' GROUP BY normalised_query ORDER BY MAX(at) DESC LIMIT ?`,
        [userId, norm.replace(/[\\%_]/g, (c) => `\\${c}`) + "%", half]);
      queries = rows.filter((r) => r.query.toLowerCase() !== norm).map((r) => ({ kind: "query" as const, text: r.query }));
    }
    const items: Suggestion[] = [];
    const seen = new Set<string>();
    for (const g of [titles.slice(0, half), queries.slice(0, half), domains.slice(0, half), terms.slice(0, half)]) {
      for (const s of g) { const k = `${s.kind}:${s.text.toLowerCase()}`; if (!seen.has(k)) { seen.add(k); items.push(s); } }
    }
    return { q, items: items.slice(0, limit), ...(dym ? { didYouMean: dym } : {}) };
  }

  // ---- history -------------------------------------------------------------------------------

  historyEnabled(): boolean {
    try { return (this.o.settings.internal("privacy") as { searchHistory: { enabled: boolean } }).searchHistory.enabled; } catch { return false; }
  }

  private recordHistory(userId: number, query: string, scope: string, count: number): void {
    if (!this.historyEnabled()) return;
    const norm = query.trim().toLowerCase().replace(/\s+/g, " ");
    this.db.run("INSERT INTO search_history (user_id, query, normalised_query, at, local_count, scope) VALUES (?, ?, ?, ?, ?, ?)", [userId, query.trim().slice(0, 500), norm.slice(0, 500), this.o.clock.now(), count, scope]);
    this.db.run("DELETE FROM search_history WHERE user_id = ? AND id NOT IN (SELECT id FROM search_history WHERE user_id = ? ORDER BY id DESC LIMIT 1000)", [userId, userId]);
  }

  listHistory(userId: number | null, limit: number, cursor?: number): { enabled: boolean; items: unknown[]; nextCursor?: string } {
    const enabled = this.historyEnabled();
    if (!enabled || userId === null) return { enabled, items: [] };
    const rows = this.db.all<{ id: number; query: string; scope: string; at: number; local_count: number }>(
      "SELECT id, query, scope, at, local_count FROM search_history WHERE user_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?", [userId, cursor ?? null, cursor ?? null, limit + 1]);
    const page = rows.slice(0, limit);
    return {
      enabled,
      items: page.map((r) => ({ id: String(r.id), query: r.query, scope: r.scope, at: iso(r.at), localCount: r.local_count })),
      ...(rows.length > limit ? { nextCursor: String(page[page.length - 1]!.id) } : {}),
    };
  }
  clearHistory(userId: number): { removed: number } { return { removed: this.db.run("DELETE FROM search_history WHERE user_id = ?", [userId]).changes }; }
  deleteHistory(userId: number, id: number): void {
    if (this.db.run("DELETE FROM search_history WHERE user_id = ? AND id = ?", [userId, id]).changes === 0) throw new AppError("not_found", "That history entry does not exist.");
  }

  // ---- saved searches ------------------------------------------------------------------------

  private savedOut(r: { public_id: string; name: string; query: string; filters_json: string; scope: string; include_online: number; created_at: number; last_run_at: number | null; last_result_count: number | null; collection_id: number | null }) {
    const col = r.collection_id == null ? undefined : this.db.get<{ public_id: string }>("SELECT public_id FROM collections WHERE id = ? AND deleted_at IS NULL", [r.collection_id])?.public_id;
    return {
      id: r.public_id, name: r.name, query: r.query, filters: JSON.parse(r.filters_json) as unknown, scope: r.scope, includeOnline: r.include_online === 1,
      createdAt: iso(r.created_at), ...(r.last_run_at ? { lastRunAt: iso(r.last_run_at) } : {}),
      ...(r.last_result_count != null ? { lastResultCount: r.last_result_count } : {}), ...(col ? { collectionId: col } : {}),
    };
  }
  private savedRow(userId: number, publicId: string) {
    const r = this.db.get<Parameters<SearchService["savedOut"]>[0] & { id: number }>("SELECT * FROM saved_searches WHERE public_id = ? AND user_id = ?", [publicId, userId]);
    if (!r) throw new AppError("not_found", "That saved search does not exist.");
    return r;
  }
  listSaved(userId: number | null): { items: unknown[] } {
    if (userId === null) return { items: [] };
    return { items: this.db.all<Parameters<SearchService["savedOut"]>[0]>("SELECT * FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC, id DESC", [userId]).map((r) => this.savedOut(r)) };
  }
  getSaved(userId: number, id: string): unknown { return this.savedOut(this.savedRow(userId, id)); }
  createSaved(userId: number, body: unknown): unknown {
    const v = parseOrThrow(savedBodySchema, body);
    if (!v.query.trim() && !Object.keys(v.filters).length) throw new RequestValidationError([{ in: "body", path: "query", message: "Enter something to search for" }]);
    const now = this.o.clock.now();
    const pid = newId("ss");
    this.db.transaction(() => this.db.run(
      "INSERT INTO saved_searches (public_id, user_id, name, query, filters_json, scope, include_online, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [pid, userId, v.name, v.query, JSON.stringify(v.filters), v.scope, v.includeOnline ? 1 : 0, now, now]), { durable: true });
    return this.getSaved(userId, pid);
  }
  patchSaved(userId: number, id: string, body: unknown): unknown {
    const cur = this.savedRow(userId, id);
    const v = parseOrThrow(savedPatchSchema, body);
    this.db.run(
      "UPDATE saved_searches SET name = ?, query = ?, filters_json = ?, scope = ?, include_online = ?, updated_at = ? WHERE id = ?",
      [v.name ?? cur.name, v.query ?? cur.query, JSON.stringify(v.filters ?? JSON.parse(cur.filters_json)), v.scope ?? cur.scope, (v.includeOnline ?? cur.include_online === 1) ? 1 : 0, this.o.clock.now(), cur.id]);
    return this.getSaved(userId, id);
  }
  deleteSaved(userId: number, id: string): void {
    const cur = this.savedRow(userId, id);
    if (cur.collection_id != null && this.db.get("SELECT 1 AS x FROM collections WHERE id = ? AND deleted_at IS NULL", [cur.collection_id])) {
      throw new AppError("conflict", "A collection is built on this saved search. Delete the collection first.");
    }
    this.db.run("DELETE FROM saved_searches WHERE id = ?", [cur.id]);
  }
  async runSaved(userId: number, id: string, body: { page?: number; pageSize?: number }): Promise<Record<string, unknown>> {
    const cur = this.savedRow(userId, id);
    const res = await this.search({ query: cur.query, scope: cur.scope, filters: JSON.parse(cur.filters_json), page: body.page ?? 1, pageSize: body.pageSize ?? 20, record: false }, { userId, recordHistory: false });
    this.db.run("UPDATE saved_searches SET last_run_at = ?, last_result_count = ? WHERE id = ?", [this.o.clock.now(), res.total as number, cur.id]);
    return res;
  }

  /** Link between a saved search and its collection; checks the id for `POST /api/collections`. */
  savedSearchRef(publicId: string): { id: number; publicId: string; userId: number } {
    const r = this.db.get<{ id: number; public_id: string; user_id: number }>("SELECT id, public_id, user_id FROM saved_searches WHERE public_id = ?", [publicId]);
    if (!r) throw new RequestValidationError([{ in: "body", path: "savedSearchId", message: "Choose a saved search that exists" }]);
    return { id: r.id, publicId: r.public_id, userId: r.user_id };
  }
  linkCollection(savedId: number, collectionId: number): void { this.db.run("UPDATE saved_searches SET collection_id = ? WHERE id = ?", [collectionId, savedId]); }

  /** Re-evaluates one saved-search collection; members are stored as `added_by = 'rule'`. */
  async refreshCollection(collectionId: number): Promise<{ added: number; removed: number }> {
    const c = this.db.get<{ rule_json: string | null }>("SELECT rule_json FROM collections WHERE id = ? AND kind = 'saved_search' AND deleted_at IS NULL", [collectionId]);
    if (!c?.rule_json) return { added: 0, removed: 0 };
    const sid = (JSON.parse(c.rule_json) as { savedSearchId?: string }).savedSearchId;
    const s = sid ? this.db.get<{ query: string; filters_json: string; scope: string }>("SELECT query, filters_json, scope FROM saved_searches WHERE public_id = ?", [sid]) : undefined;
    if (!s) return { added: 0, removed: 0 };
    const body = parseOrThrow(searchBodySchema, { query: s.query, scope: s.scope, filters: JSON.parse(s.filters_json) });
    const { filters, none } = this.toFilters(body.filters, body.scope);
    let ids: number[] = [];
    if (!none && body.scope !== "online" && this.state === "ok") {
      const r = await this.callSearch({ op: "pageIds", params: { query: s.query, filters, typo: body.typo, synonyms: body.synonyms }, limit: 2000 });
      if (r.kind === "pageIds") ids = r.ids;
    } else if (this.state !== "ok") return { added: 0, removed: 0 };
    const now = this.o.clock.now();
    return this.db.transaction(() => {
      const existing = new Set(this.db.all<{ page_id: number }>("SELECT page_id FROM collection_memberships WHERE collection_id = ? AND added_by = 'rule' AND page_id IS NOT NULL", [collectionId]).map((r) => r.page_id));
      const want = new Set(ids);
      let added = 0, removed = 0;
      for (const id of want) if (!existing.has(id)) added += this.db.run("INSERT INTO collection_memberships (collection_id, page_id, added_by, added_at) SELECT ?, id, 'rule', ? FROM pages WHERE id = ? ON CONFLICT DO NOTHING", [collectionId, now, id]).changes;
      for (const id of existing) if (!want.has(id)) removed += this.db.run("DELETE FROM collection_memberships WHERE collection_id = ? AND page_id = ? AND added_by = 'rule'", [collectionId, id]).changes;
      if (added || removed) this.db.run("UPDATE collections SET updated_at = ? WHERE id = ?", [now, collectionId]);
      return { added, removed };
    });
  }

  async refreshAllCollections(): Promise<void> {
    for (const c of this.db.all<{ id: number }>("SELECT id FROM collections WHERE kind = 'saved_search' AND deleted_at IS NULL")) await this.refreshCollection(c.id);
  }

  // ---- index admin ---------------------------------------------------------------------------

  private expectedDocs(): number {
    return this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM pages p JOIN page_versions v ON v.id = p.latest_version_id WHERE p.deleted_at IS NULL AND p.availability IN ('archived','partial') AND v.status IN ('ready','partial')")!.n;
  }

  async status(): Promise<Record<string, unknown>> {
    let stats: IndexStats | null = null;
    try { const r = await this.callSearch({ op: "stats" }, 5000); if (r.kind === "stats") stats = r.stats; } catch { /* rebuilding */ }
    const expected = this.expectedDocs();
    const docs = stats?.docs ?? 0;
    this.docsHint = docs;
    const pending = this.db.get<{ n: number; oldest: number | null }>("SELECT COUNT(*) AS n, MIN(queued_at) AS oldest FROM index_outbox WHERE id > ?", [this.lastApplied])!;
    const job = this.rebuildJob ?? this.db.get<{ id: number; state: string; docs_done: number; docs_total: number; started_at: number | null; error: string | null }>(
      "SELECT id, state, docs_done, docs_total, started_at, error FROM indexing_jobs WHERE kind = 'rebuild' ORDER BY id DESC LIMIT 1") ?? undefined;
    let rebuild: unknown;
    if (this.rebuildJob) {
      rebuild = { jobId: this.rebuildJob.id, state: "running", docsDone: this.rebuildJob.done, docsTotal: this.rebuildJob.total, startedAt: iso(this.rebuildJob.startedAt), resumable: true };
    } else if (job && "state" in job && job.state === "failed") {
      rebuild = { jobId: job.id, state: "failed", docsDone: job.docs_done, docsTotal: job.docs_total, startedAt: iso(job.started_at), resumable: true, error: job.error ?? undefined };
    }
    return {
      state: this.state, engine: "fts5", generationId: stats?.generationId ?? 0, schemaVersion: stats?.schemaVersion ?? 0, ...(stats?.builtAt ? { builtAt: iso(stats.builtAt) } : {}),
      docs, expectedDocs: expected, drift: expected - docs, sizeBytes: stats?.sizeBytes ?? 0,
      outbox: { pending: pending.n, oldestAgeMs: pending.oldest ? Math.max(0, Date.now() - pending.oldest) : null, lastAppliedId: this.lastApplied },
      ...(rebuild ? { rebuild } : {}),
      ...(stats?.lastOptimizeAt ? { lastOptimizeAt: iso(stats.lastOptimizeAt) } : {}),
      ...(this.lastCheck ? { lastCheck: { at: iso(this.lastCheck.at), ok: this.lastCheck.ok, sampled: this.lastCheck.sampled, mismatches: this.lastCheck.mismatches, countMismatch: this.lastCheck.countMismatch } } : {}),
      vocabTerms: stats?.vocabTerms ?? 0, groups: stats?.groups ?? { en: 0, default: 0 },
    };
  }

  jobs(): { items: unknown[] } {
    return {
      items: this.db.all<{ id: number; kind: string; state: string; docs_total: number; docs_done: number; error: string | null; created_at: number; started_at: number | null; finished_at: number | null; scope_json: string | null }>(
        "SELECT * FROM indexing_jobs ORDER BY id DESC LIMIT 50").map((r) => ({
        id: r.id, kind: r.kind, state: r.state, docsTotal: r.docs_total, docsDone: r.docs_done, ...(r.error ? { error: r.error } : {}),
        createdAt: iso(r.created_at), ...(r.started_at ? { startedAt: iso(r.started_at) } : {}), ...(r.finished_at ? { finishedAt: iso(r.finished_at) } : {}),
        ...(r.scope_json ? { scope: JSON.parse(r.scope_json) as unknown } : {}),
      })),
    };
  }

  async startRebuild(reason: string, o: { fresh?: boolean } = {}): Promise<{ jobId: number; state: "running" }> {
    if (this.rebuildJob) throw new AppError("conflict", "A rebuild is already running.");
    const now = this.o.clock.now();
    const resumeJob = o.fresh ? undefined : this.db.get<{ id: number; generation_id: number | null }>("SELECT id, generation_id FROM indexing_jobs WHERE kind = 'rebuild' AND state = 'running' ORDER BY id DESC LIMIT 1");
    let jobId: number, gen: number;
    if (resumeJob?.generation_id) {
      jobId = resumeJob.id; gen = resumeJob.generation_id;
    } else {
      this.db.run("UPDATE indexing_jobs SET state = 'failed', error = 'interrupted', finished_at = ? WHERE kind = 'rebuild' AND state = 'running'", [now]);
      gen = Number(this.db.run("INSERT INTO index_generations (schema_version, tokenizer_config_json, state, rebuild_reason) VALUES (1, ?, 'building', ?)", [JSON.stringify({ en: "porter unicode61", default: "unicode61" }), reason]).lastInsertRowid);
      jobId = Number(this.db.run("INSERT INTO indexing_jobs (kind, scope_json, state, generation_id, created_at, started_at) VALUES ('rebuild', ?, 'running', ?, ?, ?)", [JSON.stringify({ reason }), gen, now, now]).lastInsertRowid);
    }
    this.rebuildJob = { id: jobId, generationId: gen, startedAt: now, total: this.expectedDocs(), done: 0, phase: "starting" };
    this.state = this.indexOpen ? "rebuilding" : "building";
    await this.callIndex({ cmd: "rebuild", jobId, reason, generationId: gen, fresh: o.fresh });
    return { jobId, state: "running" };
  }

  async waitForRebuild(timeoutMs = 120_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (this.rebuildJob) {
      if (Date.now() > end) throw new Error("rebuild timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async optimize(): Promise<{ ok: true; tookMs: number }> {
    if (!this.indexOpen) throw new AppError("conflict", "There is no search index to optimise yet.");
    const r = await this.callIndex<{ tookMs: number }>({ cmd: "optimize" }, 600_000);
    await this.callSearch({ op: "reopen" });
    return { ok: true, tookMs: r.tookMs };
  }

  async check(repair: boolean): Promise<CheckReport> {
    if (!this.indexOpen) throw new AppError("conflict", "There is no search index to check yet.");
    const r = await this.callIndex<CheckReport>({ cmd: "check", repair }, 600_000);
    this.lastCheck = { at: Date.now(), ok: r.ok, sampled: r.sampled, mismatches: r.mismatches.length, countMismatch: r.missing + r.extra };
    if (repair && r.needsRebuild && !this.rebuildJob) void this.startRebuild("consistency check found drift").catch(() => undefined);
    return r;
  }

  indexStatusSimple(): { docs: number; sizeBytes: number; drift: number; state: "ok" | "rebuilding" | "missing" } {
    const expected = this.expectedDocs();
    return { docs: this.docsHint, sizeBytes: 0, drift: expected - this.docsHint, state: this.state === "ok" ? "ok" : this.state === "missing" || this.state === "error" ? "missing" : "rebuilding" };
  }
}

export type { IndexStatusReply };
