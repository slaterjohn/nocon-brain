import { AppError, newId, type Clock } from "@ncb/shared";
import type { Db } from "@ncb/db";
import { parseOrThrow } from "../lib/zod.js";
import { z } from "zod";
import type { SettingsService } from "../services/settings.js";
import { DISCLOSURE_TEXT } from "../services/settings.js";
import { checkResultUrl, canonicalKey, displayDomain, highlight, inferType, resultKey } from "./normalise.js";
import { fuse, providerWeights, type FusedItem } from "./rrf.js";
import type { ProviderService } from "./providers.js";
import type { ProviderRunner, ProviderRuntime } from "./runner.js";
import type { ProviderResponse, SearchErrorCode, StorageKind } from "./types.js";

type Json = Record<string, any>;
export type Rt = ProviderRuntime & { priority: number; weight: number; fallbackId: string | null; adapterId: string };

export type OnlineState = "disabled" | "offline" | "pending" | "done";
export interface OnlinePlan { state: "disabled" | "offline" | "pending"; runtimes: Rt[] }

export type SearchEvent = { seq: number; at: string; type: string } & Json;

interface ProviderEntry {
  id: string; name: string; adapter: string; priority: number; weight: number; storage: StorageKind;
  state: "pending" | "ok" | "error" | "skipped"; count: number; hasMore: boolean; page: number; running: boolean;
  keys: string[]; error?: { code: SearchErrorCode; message: string; retryAfterMs?: number }; fallbackFor?: string;
}

export interface OnlineSession {
  id: string;
  at: number;
  query: string;
  terms: string[];
  userId?: number;
  plan: OnlinePlan["state"];
  local: { total: number; partial: number; keys: string[]; byCanon: Map<string, string>; results: Json[]; zimLists: { id: string; name: string; weight: number; keys: string[] }[] };
  items: Map<string, Json>;            // canonical key -> online-only SearchResult (arrival order)
  overlays: Map<string, { alsoOnline: boolean }>;
  seen: Set<string>;                   // canonical keys any provider returned
  providers: Map<string, ProviderEntry>;
  events: SearchEvent[];
  seq: number;
  listeners: Set<(e: SearchEvent) => void>;
  running: number;
  done: boolean;
  ac?: AbortController;
  deadline?: NodeJS.Timeout;
  deadlineHit: boolean;
  lastReorder: string;
  saved: Map<string, { downloadId: string }>;
}

export interface OnlineDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  providers: ProviderService;
  runner: ProviderRunner;
  isOffline: () => boolean;
  urlKey: (url: string) => string;
  saveUrl: (input: { url: string; priority?: number; queue?: boolean; requestedBy: "search" }) => { downloadId: string; url: string; state: "queued"; held: boolean; priority: number };
  log: { warn(o: unknown, m?: string): void };
  /** Discovery's search collector: addresses a provider returned that are not in the archive. Never receives titles, snippets or the query. */
  onOnlineUrls?: (r: { urls: string[]; storage: StorageKind; ttlSeconds: number }) => void;
}

/** Canonical key of a result in the fusion: the normalised URL, or the package address for a knowledge-package hit. */
const resultCanon = (r: Json): string => (r.origin === "zim" ? `zim:${String(r.url)}` : canonicalKey(String(r.url)));

const MAX_EVENTS = 5000;
const TTL_MS = 30 * 60_000;

const moreBody = z.object({ providerId: z.string().min(1).max(64).optional() });
const saveBody = z.object({ priority: z.union([z.enum(["P1", "P2", "P3", "P4"]), z.number().int().min(1).max(4)]).optional(), queue: z.boolean().optional() });

/**
 * Combined search sessions (tasks O-01 to O-05): runs the providers for a search, fuses their lists with the local results by weighted
 * reciprocal rank fusion, and keeps an ordered event log per search for SSE (with resume) and polling. Everything here is in memory
 * for 30 minutes; nothing a provider returned is written to the database by this class.
 */
export class OnlineSearch {
  private readonly sessions = new Map<string, OnlineSession>();
  constructor(private readonly o: OnlineDeps) {}

  private setting<K extends string>(k: K): number {
    return (this.o.settings.internal("search") as unknown as Record<string, number>)[k]!;
  }

  // ---- planning ------------------------------------------------------------------------------

  /** Decides whether a search goes online. Pure with respect to the network: it never opens a connection. */
  plan(b: { scope: string; online: "auto" | "off" | "on"; providers?: string[]; page: number }): OnlinePlan {
    if (this.o.isOffline()) return { state: "offline", runtimes: [] };
    if (b.online === "off" || (b.scope !== "all" && b.scope !== "online") || b.page > 1 || !this.o.providers.onlineAllowed()) return { state: "disabled", runtimes: [] };
    const runtimes = this.o.providers.enabledRuntimes(b.providers);
    if (!runtimes.length) return { state: "disabled", runtimes: [] };
    return { state: "pending", runtimes };
  }

  /** Registers the session and, when planned, starts the providers. Never throws. */
  register(searchId: string, plan: OnlinePlan, ctx: { query: string; terms: string[]; response: Json; userId?: number; zimLists?: { id: string; name: string; weight: number; keys: string[] }[] }): void {
    try {
      this.sweep();
      const results = (ctx.response.results as Json[]) ?? [];
      const byCanon = new Map<string, string>();
      for (const r of results) byCanon.set(resultCanon(r), String(r.key));
      const s: OnlineSession = {
        id: searchId, at: Date.now(), query: ctx.query, terms: ctx.terms, userId: ctx.userId, plan: plan.state,
        local: {
          total: Number(ctx.response.total ?? 0), partial: Number((ctx.response.coverage as Json | undefined)?.partial ?? 0),
          // A package hit is in the list but is not an archive result: it has its own fusion list (Phase 8).
          keys: results.filter((r) => r.origin !== "zim").map((r) => canonicalKey(String(r.url))), byCanon, results, zimLists: ctx.zimLists ?? [],
        },
        items: new Map(), overlays: new Map(), seen: new Set(), providers: new Map(), events: [], seq: 0, listeners: new Set(), running: 0, done: false, deadlineHit: false,
        lastReorder: "", saved: new Map(),
      };
      this.sessions.set(searchId, s);
      if (plan.state !== "pending") { this.emit(s, { type: "done", reason: "no_providers" }); s.done = true; return; }
      for (const rt of plan.runtimes) s.providers.set(rt.id, this.entry(rt));
      this.round(s, plan.runtimes.map((rt) => ({ rt, page: 1 })));
    } catch (e) {
      this.o.log.warn({ err: String(e) }, "could not start the online part of a search");
    }
  }

  private entry(rt: Rt): ProviderEntry {
    return { id: rt.id, name: rt.name, adapter: rt.adapterId, priority: rt.priority, weight: rt.weight, storage: rt.storage.kind, state: "pending", count: 0, hasMore: false, page: 0, running: false, keys: [] };
  }

  get(searchId: string): OnlineSession | undefined {
    const s = this.sessions.get(searchId);
    if (s && Date.now() - s.at > TTL_MS) { this.drop(searchId); return undefined; }
    return s;
  }
  private drop(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.ac?.abort();
    if (s.deadline) clearTimeout(s.deadline);
    s.listeners.clear();
    this.sessions.delete(id);
  }
  sweep(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, s] of this.sessions) if (s.at < cutoff) this.drop(id);
    if (this.sessions.size > 300) for (const id of [...this.sessions.keys()].slice(0, this.sessions.size - 300)) this.drop(id);
  }
  stop(): void { for (const id of [...this.sessions.keys()]) this.drop(id); }

  // ---- events --------------------------------------------------------------------------------

  private emit(s: OnlineSession, e: Json): SearchEvent {
    const ev = { ...e, seq: ++s.seq, at: new Date(this.o.clock.now()).toISOString() } as SearchEvent;
    s.events.push(ev);
    if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
    for (const l of [...s.listeners]) { try { l(ev); } catch { /* a broken subscriber must not stop the others */ } }
    return ev;
  }

  eventsAfter(s: OnlineSession, after: number): SearchEvent[] { return s.events.filter((e) => e.seq > after); }
  subscribe(s: OnlineSession, fn: (e: SearchEvent) => void): () => void { s.listeners.add(fn); return () => s.listeners.delete(fn); }

  // ---- running -------------------------------------------------------------------------------

  private round(s: OnlineSession, jobs: { rt: Rt; page: number }[]): void {
    s.done = false;
    s.deadlineHit = false;
    s.ac = new AbortController();
    const ac = s.ac;
    if (s.deadline) clearTimeout(s.deadline);
    s.deadline = setTimeout(() => { s.deadlineHit = true; ac.abort(); }, this.setting("onlineDeadlineMs"));
    s.deadline.unref();
    for (const j of jobs) { const e = s.providers.get(j.rt.id); if (e) { e.running = true; e.state = "pending"; } }
    const chain = new Set(jobs.map((j) => j.rt.id));
    void Promise.allSettled(jobs.map((j) => this.runOne(s, j.rt, j.page, chain, ac.signal))).then(() => {
      // Another round (from `more`) may still be running; the last one to finish says `done`.
      if ([...s.providers.values()].some((p) => p.running)) return;
      if (s.deadline) clearTimeout(s.deadline);
      this.finish(s, s.deadlineHit ? "deadline" : "all_providers_answered");
    });
  }

  private finish(s: OnlineSession, reason: string): void {
    if (s.done) return;
    s.done = true;
    this.emit(s, { type: "done", reason });
  }

  private async runOne(s: OnlineSession, rt: Rt, page: number, chain: Set<string>, signal: AbortSignal, fallbackFor?: string): Promise<void> {
    let e = s.providers.get(rt.id);
    if (!e) { e = this.entry(rt); s.providers.set(rt.id, e); }
    e.running = true; e.state = "pending"; e.page = page; if (fallbackFor) e.fallbackFor = fallbackFor;
    this.emit(s, { type: "provider_started", providerId: rt.id, name: rt.name, adapter: rt.adapterId, page, ...(fallbackFor ? { fallbackFor } : {}) });
    let out: Awaited<ReturnType<ProviderRunner["run"]>>;
    try {
      out = await this.o.runner.run(rt, { query: s.query, page, pageSize: rt.adapter.info.maxPageSize }, { signal });
    } finally {
      e.running = false;
    }
    if (out.ok) {
      e.state = "ok"; e.error = undefined;
      this.ingest(s, rt, e, out.response, page, out.tookMs, out.cached);
      return;
    }
    e.state = "error";
    e.error = { code: out.error.code, message: out.error.message, ...(out.error.retryAfterMs !== undefined ? { retryAfterMs: out.error.retryAfterMs } : {}) };
    const fb = rt.fallbackId && !chain.has(rt.fallbackId) && out.error.code !== "disabled" && !signal.aborted ? this.o.providers.runtimeById(rt.fallbackId) : undefined;
    this.emit(s, { type: "provider_error", providerId: rt.id, code: out.error.code, message: out.error.message, ...(out.error.retryAfterMs !== undefined ? { retryAfterMs: out.error.retryAfterMs } : {}), ...(fb ? { fallbackProviderId: fb.id } : {}) });
    this.emit(s, { type: "coverage", coverage: this.coverage(s) });
    if (fb) {
      chain.add(fb.id);
      await this.runOne(s, fb, page, chain, signal, rt.id);
    }
  }

  private ingest(s: OnlineSession, rt: Rt, e: ProviderEntry, resp: ProviderResponse, page: number, tookMs: number, cached: boolean): void {
    let dropped = resp.dropped ?? 0;
    const fresh: { canon: string; r: Json }[] = [];
    const updates: Json[] = [];
    const seenHere = new Set<string>();
    for (const r of resp.results) {
      const u = checkResultUrl(r.url);
      if (!u) { dropped++; continue; }
      if (seenHere.has(u.key)) continue;
      seenHere.add(u.key);
      e.keys.push(u.key);
      s.seen.add(u.key);
      const snippetHtml = r.snippet ? highlight(r.snippet, s.terms) : "";
      const localKey = s.local.byCanon.get(u.key);
      const existing = s.items.get(u.key);
      if (localKey) {
        s.overlays.set(localKey, { alsoOnline: true });
        updates.push({ key: localKey, alsoOnline: true, _canon: u.key, _rank: e.keys.length, ...(snippetHtml ? { snippetExtra: snippetHtml } : {}) });
      } else if (existing) {
        updates.push({ key: existing.key, _canon: u.key, _rank: e.keys.length, ...(snippetHtml && !existing.snippet ? { snippetExtra: snippetHtml } : {}) });
      } else {
        const item = this.build(s, rt, e, r, u, snippetHtml);
        s.items.set(u.key, item);
        fresh.push({ canon: u.key, r: item });
      }
    }
    e.count += seenHere.size;
    e.hasMore = resp.hasMore && resp.results.length > 0;
    const fused = this.refuse(s);
    const byKey = new Map(fused.map((f) => [f.key, f]));
    const attrOf = (canon: string, id: string) => {
      const f = byKey.get(canon);
      const src = f?.sources.find((x) => x.kind === "provider" && x.id === id);
      return src ? { kind: "provider" as const, id: src.id, name: src.name, rank: src.rank } : undefined;
    };
    fresh.sort((a, b) => (byKey.get(a.canon)?.rank ?? 1e9) - (byKey.get(b.canon)?.rank ?? 1e9));
    const update = updates.map(({ _canon, _rank, ...u }) => ({ ...u, ...(attrOf(_canon, rt.id) ? { addAttribution: attrOf(_canon, rt.id) } : {}) }));
    if (fresh.length) {
      try { this.o.onOnlineUrls?.({ urls: fresh.map((f) => String(f.r.url)), storage: rt.storage.kind, ttlSeconds: rt.storage.ttlSeconds }); } catch (e) { this.o.log.warn({ err: String(e) }, "discovery could not read search results"); }
    }
    this.emit(s, {
      type: "provider_results", providerId: rt.id, page, hasMore: e.hasMore, tookMs, cached, dropped,
      ...(resp.partial ? { partial: resp.partial } : {}), append: fresh.map((f) => this.fresh(f.r)), update,
    });
    this.emit(s, { type: "coverage", coverage: this.coverage(s) });
    const order = this.fusedOrder(s, fused);
    const display = [...s.local.results.map((r) => String(r.key)), ...[...s.items.values()].map((i) => String(i.key))];
    const sig = order.join(",");
    if (sig !== display.join(",") && sig !== s.lastReorder && (fresh.length || update.length)) {
      s.lastReorder = sig;
      this.emit(s, { type: "reorder_available", fusedOrder: order });
    }
  }

  private fresh(item: Json): Json {
    this.refreshAvailability(item);
    return { ...item };
  }

  private build(s: OnlineSession, rt: Rt, e: ProviderEntry, r: ProviderResponse["results"][number], u: NonNullable<ReturnType<typeof checkResultUrl>>, snippetHtml: string): Json {
    const key = resultKey(u.key);
    const item: Json = {
      key, url: u.url, canonicalUrl: u.url, title: r.title, titleHtml: highlight(r.title, s.terms), snippet: snippetHtml, origin: "online",
      availability: "online_only", domain: displayDomain(u.host), type: inferType(u.url), faviconUrl: null,
      attribution: [], fusedRank: 0, fusedScore: 0, storage: e.storage === "none" ? "transient" : "persist",
      actions: { open: u.url, saveForOffline: true }, collections: [], sourceName: null,
      ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
    };
    void rt;
    return item;
  }

  // ---- fusion --------------------------------------------------------------------------------

  /** Recomputes the fusion, writes fused numbers and attribution onto every item, returns the fused list. */
  private refuse(s: OnlineSession): FusedItem[] {
    const provs = [...s.providers.values()].filter((p) => p.keys.length).sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
    const weights = providerWeights(provs.map((p) => ({ id: p.id, weight: p.weight, keys: p.keys.slice(0, this.setting("onlineTopN")) })), this.setting("rrfSecondaryProviderWeight"));
    const fused = fuse([
      { kind: "local", id: "archive", name: "Archive", weight: this.setting("rrfLocalWeight"), keys: s.local.keys },
      ...s.local.zimLists.map((l) => ({ kind: "zim" as const, id: l.id, name: l.name, weight: l.weight, keys: l.keys })),
      ...provs.map((p) => ({ kind: "provider" as const, id: p.id, name: p.name, weight: weights.get(p.id) ?? p.weight, keys: p.keys })),
    ], { k: this.setting("rrfK"), topN: this.setting("onlineTopN") });
    const byKey = new Map(fused.map((f) => [f.key, f]));
    const apply = (item: Json, canon: string) => {
      const f = byKey.get(canon);
      if (!f) return;
      item.fusedRank = f.rank; item.fusedScore = Number(f.score.toFixed(6));
      item.attribution = f.sources.map((x) => ({ kind: x.kind, id: x.id, name: x.name, rank: x.rank }));
    };
    for (const [canon, item] of s.items) apply(item, canon);
    return fused;
  }

  private fusedOrder(s: OnlineSession, fused: FusedItem[]): string[] {
    const keyOf = new Map<string, string>();
    for (const [canon, k] of s.local.byCanon) keyOf.set(canon, k);
    for (const [canon, item] of s.items) keyOf.set(canon, String(item.key));
    const inList = new Set(keyOf.keys());
    // Items beyond the top N of every list are not in the fusion; they keep their display order after the fused ones.
    const out: string[] = fused.filter((f) => inList.has(f.key)).map((f) => keyOf.get(f.key)!);
    for (const k of [...s.local.results.map((r) => String(r.key)), ...[...s.items.values()].map((i) => String(i.key))]) if (!out.includes(k)) out.push(k);
    return out;
  }

  // ---- availability, coverage ----------------------------------------------------------------

  private pageFor(url: string): { publicId: string; availability: "archived" | "partial" } | undefined {
    let key: string;
    try { key = this.o.urlKey(url); } catch { return undefined; }
    const r = this.o.db.get<{ public_id: string; availability: string }>(
      `SELECT public_id, availability FROM pages WHERE deleted_at IS NULL AND availability IN ('archived','partial') AND (url_key = ?
         OR id = (SELECT page_id FROM page_aliases WHERE url_key = ?))`, [key, key]);
    return r ? { publicId: r.public_id, availability: r.availability as "archived" | "partial" } : undefined;
  }

  private refreshAvailability(item: Json): void {
    const page = this.pageFor(String(item.url));
    if (page) {
      item.availability = page.availability === "archived" ? "cached" : "partial";
      item.pageId = page.publicId;
      item.actions = { open: `/library/pages/${page.publicId}`, saveForOffline: false };
      return;
    }
    delete item.pageId;
    item.availability = "online_only";
    item.actions = { open: String(item.url), saveForOffline: true };
  }

  private itemAvailability(s: OnlineSession, item: Json): void {
    this.refreshAvailability(item);
    if (item.availability === "online_only") {
      const sv = s.saved.get(String(item.key));
      if (sv) {
        const st = this.o.db.get<{ state: string }>("SELECT state FROM download_jobs WHERE public_id = ?", [sv.downloadId])?.state;
        if (st === "queued" || st === "running" || st === "paused") { item.availability = "queued"; item.actions = { ...(item.actions as Json), saveForOffline: false }; }
      }
    }
  }

  coverage(s: OnlineSession): Json {
    let notArchived = 0, queued = 0, partial = s.local.partial;
    for (const item of s.items.values()) {
      this.itemAvailability(s, item);
      if (item.availability === "online_only") notArchived++;
      else if (item.availability === "queued") queued++;
      else if (item.availability === "partial") partial++;
    }
    return { cachedMatches: s.local.total, onlineMatches: s.seen.size, onlineNotArchived: notArchived, queued, partial, basis: s.seen.size ? "online_page_estimate" : "local_exact" };
  }

  /** Online-only results with their current availability (coverage planning). */
  onlineResults(s: OnlineSession): Json[] {
    return [...s.items.values()].map((i) => { this.itemAvailability(s, i); return i; });
  }

  // ---- reading -------------------------------------------------------------------------------

  onlineBlock(s: OnlineSession): Json {
    const running = [...s.providers.values()].filter((p) => p.running || p.state === "pending").map((p) => p.id);
    const state: OnlineState = s.plan !== "pending" ? s.plan : s.done ? "done" : "pending";
    return {
      state, pending: s.done ? [] : running, disclosure: s.plan === "pending" ? DISCLOSURE_TEXT : "",
      providers: [...s.providers.values()].sort((a, b) => a.priority - b.priority).map((p) => ({
        id: p.id, name: p.name, adapter: p.adapter, state: p.state, count: p.count, hasMore: p.hasMore, ...(p.error ? { error: p.error } : {}),
      })),
    };
  }

  /** Initial `online` block for the POST response. */
  initialBlock(plan: OnlinePlan): Json {
    return { state: plan.state, pending: plan.state === "pending" ? plan.runtimes.map((r) => r.id) : [], disclosure: plan.state === "pending" ? DISCLOSURE_TEXT : "" };
  }

  /** The stored response with the online part merged in (snapshot / back navigation). */
  decorate(base: Json, searchId: string, order?: "fused"): Json {
    const s = this.get(searchId);
    if (!s) return base;
    const local: Json[] = (base.results as Json[]).map((r): Json => {
      const ov = s.overlays.get(String(r.key));
      return ov ? { ...r, alsoOnline: true } : { ...r };
    });
    const fusedNums = this.refuse(s);
    const byCanon = new Map(fusedNums.map((f) => [f.key, f]));
    for (const r of local) {
      const f = byCanon.get(resultCanon(r));
      if (f && s.providers.size) { r.fusedRank = f.rank; r.fusedScore = Number(f.score.toFixed(6)); r.attribution = f.sources.map((x) => ({ kind: x.kind, id: x.id, name: x.name, rank: x.rank })); }
    }
    const online: Json[] = this.onlineResults(s).map((i): Json => ({ ...i }));
    let results: Json[] = [...local, ...online];
    if (order === "fused") {
      const pos = new Map(this.fusedOrder(s, fusedNums).map((k, i) => [k, i]));
      results = results.map((r, i) => ({ r, i })).sort((a, b) => (pos.get(String(a.r.key)) ?? 1e9) - (pos.get(String(b.r.key)) ?? 1e9) || a.i - b.i).map((x) => x.r);
    }
    return { ...base, results, coverage: this.coverage(s), online: this.onlineBlock(s), lastSeq: s.seq };
  }

  poll(searchId: string, after: number): Json {
    const s = this.get(searchId);
    if (!s) throw new AppError("not_found", "That search has expired. Run it again.");
    return { searchId, lastSeq: s.seq, done: s.done, online: this.onlineBlock(s), events: this.eventsAfter(s, after).slice(0, 200) };
  }

  // ---- more ----------------------------------------------------------------------------------

  more(searchId: string, raw: unknown): Json {
    const s = this.get(searchId);
    if (!s) throw new AppError("not_found", "That search has expired. Run it again.");
    const b = parseOrThrow(moreBody, raw ?? {});
    if (s.plan === "offline" || this.o.isOffline()) throw new AppError("offline", "The server is working offline, so nothing is loaded from the web.", { canQueue: false });
    if (s.plan !== "pending" || !this.o.providers.onlineAllowed()) throw new AppError("conflict", "Online search is not on for this search.");
    const jobs: { rt: Rt; page: number }[] = [];
    const skipped: { providerId: string; reason: string }[] = [];
    for (const e of s.providers.values()) {
      if (b.providerId && e.id !== b.providerId) continue;
      if (e.running) { skipped.push({ providerId: e.id, reason: "running" }); continue; }
      if (e.state !== "ok" || !e.hasMore) { skipped.push({ providerId: e.id, reason: "no_more" }); continue; }
      const rt = this.o.providers.runtimeById(e.id);
      if (!rt) { skipped.push({ providerId: e.id, reason: "disabled" }); continue; }
      if (this.o.runner.circuitOpenUntil(rt.rowId) !== undefined) { skipped.push({ providerId: e.id, reason: "circuit_open" }); continue; }
      if (this.o.runner.capReached(rt)) { skipped.push({ providerId: e.id, reason: "cap_reached" }); continue; }
      jobs.push({ rt, page: e.page + 1 });
    }
    if (b.providerId && !s.providers.has(b.providerId)) skipped.push({ providerId: b.providerId, reason: "disabled" });
    if (jobs.length) this.round(s, jobs);
    return { searchId, started: jobs.map((j) => j.rt.id), skipped, lastSeq: s.seq };
  }

  /** Marks results as queued for saving (coverage queue), so the counts and snapshots show them as queued. */
  markQueued(searchId: string, keys: string[], downloadIds: string[]): void {
    const s = this.get(searchId);
    if (!s) return;
    keys.forEach((k, i) => s.saved.set(k, { downloadId: downloadIds[Math.min(i, downloadIds.length - 1)]! }));
    this.emit(s, { type: "coverage", coverage: this.coverage(s) });
  }

  // ---- save for offline ----------------------------------------------------------------------

  save(searchId: string, key: string, raw: unknown): Json {
    const s = this.get(searchId);
    if (!s) throw new AppError("not_found", "That search has expired. Run it again.");
    const b = parseOrThrow(saveBody, raw ?? {});
    const item = [...s.items.values()].find((i) => i.key === key);
    if (!item) {
      if (s.local.results.some((r) => r.key === key)) throw new AppError("conflict", "That page is already in the archive.");
      throw new AppError("not_found", "That result is not part of this search.");
    }
    this.itemAvailability(s, item);
    if (item.availability === "cached" || item.availability === "partial") throw new AppError("conflict", "That page is already saved.");
    const priority = b.priority === undefined ? undefined : typeof b.priority === "number" ? b.priority : Number(b.priority.slice(1));
    // Only the address of the page goes to the capture pipeline: nothing the provider said about it.
    const r = this.o.saveUrl({ url: String(item.url), priority, queue: b.queue, requestedBy: "search" });
    s.saved.set(key, { downloadId: r.downloadId });
    this.emit(s, { type: "coverage", coverage: this.coverage(s) });
    return { downloadId: r.downloadId, url: r.url, state: "queued", held: r.held, priority: r.priority, key };
  }
}

export { newId };
