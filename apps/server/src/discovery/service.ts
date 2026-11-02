import { z } from "zod";
import type { Db } from "@ncb/db";
import { AppError, parsePriority, type Clock, type PriorityNumber } from "@ncb/shared";
import type { ResourceProfile } from "@ncb/crawl";
import { RequestValidationError, parseOrThrow } from "../lib/zod.js";
import type { ActivityLog } from "../services/activity.js";
import type { SettingsService } from "../services/settings.js";
import type { CaptureOptions } from "../pipeline/types.js";
import type { CollectionService } from "../collections/service.js";
import { Ledger, dayOf, type Lane } from "./ledger.js";
import { DiscoveryRunner, enabledKinds, type Blocker, type Gates, type PassReport } from "./runner.js";
import { Scorer, type Explanation } from "./scorer.js";
import { WEIGHT_NAMES, effectiveLimits, profileMaximums, type DiscoverySettings } from "./settings.js";
import { CandidateStore, type AddResult, type CandidateState, type ProvenanceKind, type StorageKind } from "./store.js";

const iso = (ms: number | null | undefined): string | undefined => (ms == null ? undefined : new Date(ms).toISOString());
const priorityIn = z.union([z.enum(["P1", "P2", "P3", "P4"]), z.number().int().min(1).max(4)], { error: "Use P1, P2, P3 or P4" }).transform((v) => parsePriority(v) as PriorityNumber);

export interface DiscoveryServiceDeps {
  db: Db;
  clock: Clock;
  settings: SettingsService;
  activity: ActivityLog;
  log: { warn(o: unknown, m?: string): void };
  urlKey(url: string): string;
  captureUrl(url: string, opts: CaptureOptions): { downloadId: string; jobId: number };
  /** Human-initiated "download now": handles being offline by holding the capture. */
  saveNow(input: { url: string; priority: number; sourceId?: number }): { downloadId: string; held: boolean };
  cancelDownload(publicId: string): void;
  gates: Gates;
  storagePressure(): number;
  estimateBytes(sourceId: number | null): number;
  browsingCacheSourceId(): number;
  collections: Pick<CollectionService, "changeItems">;
  pageIdOf(urlKey: string): string | undefined;
  /** Is online search allowed to run and is history recorded (for collectors that depend on them). */
  historyEnabled(): boolean;
}

export interface CandidateQuery {
  state?: CandidateState[];
  sourceId?: string;
  minScore?: number;
  maxScore?: number;
  provenance?: ProvenanceKind[];
  q?: string;
  host?: string;
  sort: "score" | "-score" | "recent" | "oldest" | "cost" | "depth";
  limit: number;
  cursor?: number;
  includeHidden?: boolean;
}

type Row = {
  id: number; public_id: string; url: string; url_key: string; host: string | null; title_hint: string | null; state: CandidateState; score: number;
  est_bytes: number | null; depth: number; attempts: number; suggested_source_id: number | null; suggested_collection_id: number | null; origin_storage: StorageKind | null;
  first_seen_at: number; last_seen_at: number; expires_at: number | null; decided_by: string | null; decided_at: number | null; download_job_id: number | null;
  scored_at: number | null; score_components_json: string | null;
};

const SORTS: Record<CandidateQuery["sort"], string> = {
  score: "c.score DESC, c.id DESC", "-score": "c.score ASC, c.id ASC", recent: "c.last_seen_at DESC, c.id DESC", oldest: "c.first_seen_at ASC, c.id ASC",
  cost: "COALESCE(c.est_bytes, 0) ASC, c.id ASC", depth: "c.depth ASC, c.score DESC, c.id DESC",
};

/**
 * Discovery (Phase 7): the candidate store, the passive collectors, scoring, the active runner, the auto-cache and the API behind
 * `/api/discovery`. Everything is off until the Human switches it on; the collectors never use the network.
 */
export class DiscoveryService {
  readonly ledger: Ledger;
  readonly store: CandidateStore;
  readonly scorer: Scorer;
  readonly runner: DiscoveryRunner;
  /** Milliseconds between timer passes of the runner. 0 turns the timer off (tests call `runner.runPass()`). */
  tickMs = 30_000;

  constructor(private readonly o: DiscoveryServiceDeps) {
    const { db, clock } = o;
    this.ledger = new Ledger(db, clock);
    this.scorer = new Scorer({ db, clock, discovery: () => this.cfg(), storagePressure: o.storagePressure, estimateBytes: o.estimateBytes });
    this.store = new CandidateStore({ db, clock, urlKey: o.urlKey, discovery: () => this.cfg(), profile: () => this.profile(), changed: (id) => { this.scorer.scoreOne(id); } });
    this.runner = new DiscoveryRunner({
      db, clock, discovery: () => this.cfg(), profile: () => this.profile(), store: this.store, scorer: this.scorer, ledger: this.ledger, gates: o.gates,
      captureUrl: o.captureUrl, cancelDownload: o.cancelDownload, browsingCacheSourceId: o.browsingCacheSourceId, activity: o.activity, log: o.log,
    });
    // New weights change every score at once.
    o.settings.onChange((group) => { if (group === "discovery") { try { this.scorer.rescore(); } catch (e) { o.log.warn({ err: String(e) }, "could not re-score candidates"); } } });
  }

  private get db(): Db { return this.o.db; }
  cfg(): DiscoverySettings { return this.o.settings.internal("discovery") as DiscoverySettings; }
  profile(): ResourceProfile { return (this.o.settings.internal("resources") as { profile: ResourceProfile }).profile; }

  /** Startup housekeeping: fills in hosts for rows older than this phase and closes ledger entries left open by a crash. */
  start(): void {
    for (const r of this.db.all<{ id: number; url: string }>("SELECT id, url FROM discovery_candidates WHERE host IS NULL")) {
      try { this.db.run("UPDATE discovery_candidates SET host = ? WHERE id = ?", [new URL(r.url).hostname.toLowerCase(), r.id]); } catch { /* leave it */ }
    }
    this.runner.reconcile();
    this.ledger.prune();
  }

  /** Called by the job runner's loop. */
  tick(): void {
    this.runner.tick(this.tickMs);
    this.afterArchived();
  }

  // ---- collectors (passive, no network) ------------------------------------------------------

  /** Pipeline stage 14 (`candidates`): the links of a freshly saved page become candidates when link collection is on. */
  fromVersion(versionId: number): Record<string, unknown> {
    const d = this.cfg();
    if (!d.enabled || !d.passive.fromLinks) return { skipped: "off" };
    const v = this.db.get<{ page_id: number; download_job_id: number | null }>("SELECT page_id, download_job_id FROM page_versions WHERE id = ?", [versionId]);
    if (!v) return { skipped: "no_version" };
    const parent = v.download_job_id === null ? 0 : (this.db.get<{ depth: number }>(
      "SELECT c.depth FROM download_jobs j JOIN discovery_candidates c ON c.id = j.candidate_id WHERE j.id = ?", [v.download_job_id])?.depth ?? 0);
    const links = this.db.all<{ to_url: string; region: string; score: number }>(
      `SELECT to_url, region, score FROM links WHERE from_version_id = ? AND rel_nofollow = 0 AND region IN ('content','heading','related') ORDER BY score DESC, position LIMIT ?`,
      [versionId, d.pool.maxLinksPerPage]);
    const tally: Record<string, number> = { considered: links.length, created: 0, updated: 0 };
    for (const l of links) {
      const r = this.store.add({ url: l.to_url, kind: "link", depth: parent + 1, refPageId: v.page_id, detail: l.region, weight: l.score });
      const k = r.outcome === "skipped" ? `skipped_${r.reason}` : r.outcome;
      tally[k] = (tally[k] ?? 0) + 1;
    }
    return tally;
  }

  /** A page view that was not served from the archive (history must be on, and so must visits). */
  onVisit(v: { url: string; servedFrom: string; archived: boolean }): AddResult | undefined {
    const d = this.cfg();
    if (!d.enabled || !d.passive.fromVisits || !this.o.historyEnabled()) return undefined;
    if (v.archived || v.servedFrom === "archive" || v.servedFrom === "cache" || v.servedFrom === "zim") return undefined;
    return this.store.add({ url: v.url, kind: "visit", depth: 0, detail: v.servedFrom });
  }

  onBookmark(v: { url: string; archived: boolean }): AddResult | undefined {
    const d = this.cfg();
    if (!d.enabled || !d.passive.fromBookmarks || v.archived) return undefined;
    return this.store.add({ url: v.url, kind: "bookmark", depth: 0 });
  }

  /** The "not saved yet" page was shown for an address. */
  onMissingLink(url: string): AddResult | undefined {
    const d = this.cfg();
    if (!d.enabled || !d.passive.fromMissingLinks) return undefined;
    return this.store.add({ url, kind: "missing_link", depth: 0 });
  }

  /** A saved-search source stored a candidate (its own code did the insert): give it a score and a host. */
  onSavedSearchCandidate(id: number): void {
    this.scorer.scoreOne(id);
  }

  /** Online results that are not in the archive. Providers that allow no storage are skipped: their addresses are kept only once approved. */
  onSearchResults(r: { urls: string[]; storage: StorageKind; ttlSeconds: number }): number {
    const d = this.cfg();
    if (!d.enabled || !d.searchDriven.searchesInfluenceDiscovery || r.storage === "none") return 0;
    let n = 0;
    const expiresAt = r.storage === "ttl" ? this.o.clock.now() + Math.max(60, r.ttlSeconds) * 1000 : undefined;
    for (const url of r.urls.slice(0, 10)) {
      const res = this.store.add({ url, kind: "search_result", depth: 0, originStorage: r.storage, ...(expiresAt ? { expiresAt } : {}) });
      if (res.outcome !== "skipped") n++;
    }
    return n;
  }

  /** The Human opened this address live. */
  onOpened(url: string): { ok: boolean; reason?: string } {
    try {
      const r = this.runner.autoCache(url);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    } catch (e) {
      this.o.log.warn({ err: String(e) }, "auto-cache failed");
      return { ok: false, reason: "error" };
    }
  }

  /** Candidates that were filed into a collection when they were approved join it once their page exists. */
  private afterArchived(): void {
    const rows = this.db.all<{ id: number; url_key: string; col: string }>(
      `SELECT c.id, c.url_key, col.public_id AS col FROM discovery_candidates c JOIN collections col ON col.id = c.suggested_collection_id WHERE c.state = 'archived' AND col.deleted_at IS NULL LIMIT 50`);
    for (const r of rows) {
      const page = this.o.pageIdOf(r.url_key);
      if (!page) continue;
      try { this.o.collections.changeItems(r.col, { add: [{ pageId: page }] }); } catch (e) { this.o.log.warn({ err: String(e) }, "could not add a discovered page to its collection"); }
      this.db.run("UPDATE discovery_candidates SET suggested_collection_id = NULL WHERE id = ?", [r.id]);
    }
  }

  // ---- reading candidates --------------------------------------------------------------------

  private sourceRowId(publicId: string): number {
    const r = this.db.get<{ id: number }>("SELECT id FROM sources WHERE public_id = ? AND deleted_at IS NULL", [publicId]);
    if (!r) throw new AppError("not_found", "That source does not exist.");
    return r.id;
  }

  private collectionRowId(publicId: string): number {
    const r = this.db.get<{ id: number }>("SELECT id FROM collections WHERE public_id = ? AND deleted_at IS NULL", [publicId]);
    if (!r) throw new AppError("not_found", "That collection does not exist.");
    return r.id;
  }

  private visibleKinds(): ProvenanceKind[] { return enabledKinds(this.cfg()); }

  private filter(q: Omit<CandidateQuery, "sort" | "limit" | "cursor">, withState: boolean): { where: string; args: (string | number)[] } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (!q.includeHidden) {
      const kinds = this.visibleKinds();
      if (!kinds.length) where.push("0");
      else { where.push(`EXISTS (SELECT 1 FROM candidate_provenance v WHERE v.candidate_id = c.id AND v.kind IN (${kinds.map(() => "?").join(",")}))`); args.push(...kinds); }
    }
    if (withState && q.state?.length) { where.push(`c.state IN (${q.state.map(() => "?").join(",")})`); args.push(...q.state); }
    if (q.minScore !== undefined) { where.push("c.score >= ?"); args.push(q.minScore); }
    if (q.maxScore !== undefined) { where.push("c.score <= ?"); args.push(q.maxScore); }
    if (q.provenance?.length) { where.push(`EXISTS (SELECT 1 FROM candidate_provenance p WHERE p.candidate_id = c.id AND p.kind IN (${q.provenance.map(() => "?").join(",")}))`); args.push(...q.provenance); }
    if (q.host) { where.push("c.host = ?"); args.push(q.host.toLowerCase()); }
    if (q.q) { where.push("(instr(lower(c.url), lower(?)) > 0 OR instr(lower(COALESCE(c.title_hint, '')), lower(?)) > 0)"); args.push(q.q, q.q); }
    if (q.sourceId) {
      const sid = this.sourceRowId(q.sourceId);
      where.push(`(c.suggested_source_id = ? OR EXISTS (SELECT 1 FROM candidate_provenance s WHERE s.candidate_id = c.id AND (s.ref_source_id = ? OR s.ref_page_id IN (SELECT page_id FROM page_sources WHERE source_id = ?))))`);
      args.push(sid, sid, sid);
    }
    return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", args };
  }

  private dto(r: Row) {
    const kinds = this.db.all<{ kind: string }>("SELECT DISTINCT kind FROM candidate_provenance WHERE candidate_id = ? ORDER BY kind", [r.id]).map((x) => x.kind);
    const only = kinds.length > 0 && kinds.every((k) => k === "search_result");
    const src = r.suggested_source_id == null ? undefined : this.db.get<{ public_id: string; name: string }>("SELECT public_id, name FROM sources WHERE id = ?", [r.suggested_source_id]);
    const dl = r.download_job_id == null ? undefined : this.db.get<{ public_id: string }>("SELECT public_id FROM download_jobs WHERE id = ?", [r.download_job_id]);
    const col = r.suggested_collection_id == null ? undefined : this.db.get<{ public_id: string }>("SELECT public_id FROM collections WHERE id = ?", [r.suggested_collection_id]);
    return {
      id: r.public_id, url: r.url, host: r.host ?? "", ...(r.title_hint ? { title: r.title_hint } : {}), state: r.state, score: r.score, depth: r.depth,
      lane: only ? "background" as const : "active" as const,
      ...(r.est_bytes != null ? { estimatedBytes: r.est_bytes } : {}),
      provenanceKinds: kinds,
      provenanceCount: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM candidate_provenance WHERE candidate_id = ?", [r.id])!.n,
      ...(src ? { suggestedSource: { id: src.public_id, name: src.name } } : {}),
      ...(col ? { suggestedCollectionId: col.public_id } : {}),
      firstSeenAt: iso(r.first_seen_at)!, lastSeenAt: iso(r.last_seen_at)!, ...(r.expires_at != null ? { expiresAt: iso(r.expires_at) } : {}),
      ...(r.decided_by ? { decidedBy: r.decided_by } : {}), ...(r.decided_at != null ? { decidedAt: iso(r.decided_at) } : {}),
      ...(dl ? { downloadId: dl.public_id } : {}), attempts: r.attempts,
    };
  }

  list(q: CandidateQuery) {
    const f = this.filter(q, true);
    const rows = this.db.all<Row>(`SELECT c.* FROM discovery_candidates c ${f.where} ORDER BY ${SORTS[q.sort]} LIMIT ? OFFSET ?`, [...f.args, q.limit + 1, q.cursor ?? 0]);
    const page = rows.slice(0, q.limit);
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM discovery_candidates c ${f.where}`, f.args)!.n;
    const g = this.filter(q, false);
    const counts: Record<CandidateState, number> = { new: 0, approved: 0, queued: 0, archived: 0, dismissed: 0, expired: 0 };
    for (const r of this.db.all<{ state: CandidateState; n: number }>(`SELECT c.state, COUNT(*) AS n FROM discovery_candidates c ${g.where} GROUP BY c.state`, g.args)) counts[r.state] = r.n;
    return { items: page.map((r) => this.dto(r)), total, counts, ...(rows.length > q.limit ? { nextCursor: String((q.cursor ?? 0) + q.limit) } : {}) };
  }

  private row(publicId: string): Row {
    const r = this.db.get<Row>("SELECT * FROM discovery_candidates WHERE public_id = ?", [publicId]);
    if (!r) throw new AppError("not_found", "That candidate does not exist.");
    return r;
  }

  provenance(candidateRow: number) {
    return this.db.all<{ kind: string; detail: string | null; weight: number | null; seen_at: number; page_pid: string | null; page_title: string | null; page_url: string | null; src_pid: string | null; src_name: string | null }>(
      `SELECT p.kind, p.detail, p.weight, p.seen_at, pg.public_id AS page_pid, pg.title AS page_title, pg.canonical_url AS page_url, s.public_id AS src_pid, s.name AS src_name
       FROM candidate_provenance p LEFT JOIN pages pg ON pg.id = p.ref_page_id LEFT JOIN sources s ON s.id = p.ref_source_id
       WHERE p.candidate_id = ? ORDER BY p.seen_at DESC, p.id DESC LIMIT 100`, [candidateRow]).map((p) => ({
      kind: p.kind, ...(p.detail ? { detail: p.detail } : {}), ...(p.weight != null ? { weight: p.weight } : {}),
      ...(p.page_pid ? { pageId: p.page_pid, ...(p.page_title ? { pageTitle: p.page_title } : {}), ...(p.page_url ? { pageUrl: p.page_url } : {}) } : {}),
      ...(p.src_pid ? { sourceId: p.src_pid, sourceName: p.src_name } : {}), at: iso(p.seen_at)!,
    }));
  }

  explanation(r: Row): Explanation {
    return this.scorer.explain(r.id)!;
  }

  explain(publicId: string) {
    const r = this.row(publicId);
    const e = this.explanation(r);
    return {
      id: r.public_id, url: r.url, score: e.score, scoreStored: e.stored,
      components: e.components.map((c) => ({ name: c.name, label: c.label, raw: c.raw, weight: c.weight, contribution: c.contribution, explanation: c.explanation })),
      summary: e.summary, provenance: this.provenance(r.id), weights: this.cfg().weights,
    };
  }

  get(publicId: string) {
    const r = this.row(publicId);
    const e = this.explain(publicId);
    return { ...this.dto(r), scoreComponents: e.components, scoreStored: e.scoreStored, why: e.summary, provenance: e.provenance };
  }

  // ---- deciding ------------------------------------------------------------------------------

  private decide(r: Row, state: CandidateState, extra: { sourceId?: string; collectionId?: string } = {}): void {
    const sets = ["state = ?", "decided_by = 'user'", "decided_at = ?"];
    const args: (string | number | null)[] = [state, this.o.clock.now()];
    if (extra.sourceId) { sets.push("suggested_source_id = ?"); args.push(this.sourceRowId(extra.sourceId)); }
    if (extra.collectionId) { sets.push("suggested_collection_id = ?"); args.push(this.collectionRowId(extra.collectionId)); }
    this.db.run(`UPDATE discovery_candidates SET ${sets.join(", ")} WHERE id = ?`, [...args, r.id]);
  }

  approve(publicId: string, body: { sourceId?: string; collectionId?: string }) {
    const r = this.row(publicId);
    if (r.state === "queued" || r.state === "archived") return this.get(publicId);
    this.decide(r, "approved", body);
    return this.get(publicId);
  }

  dismiss(publicId: string) {
    const r = this.row(publicId);
    if (r.state === "queued" || r.state === "archived") throw new AppError("conflict", r.state === "queued" ? "This page is already being downloaded. Cancel the download instead." : "This page is already saved.");
    if (r.origin_storage === "none") {
      // Addresses from a provider that allows no storage are kept only while approved: dismissing one forgets it.
      this.db.run("DELETE FROM discovery_candidates WHERE id = ?", [r.id]);
      return { id: r.public_id, url: r.url, state: "dismissed" as const };
    }
    this.decide(r, "dismissed");
    return this.get(publicId);
  }

  /** Download now, as the Human asked. Not counted in the daily budgets (admission control and politeness still apply). */
  queue(publicId: string, body: { priority?: PriorityNumber; sourceId?: string; collectionId?: string }) {
    const r = this.row(publicId);
    if (r.state === "queued" || r.state === "archived") return this.get(publicId);
    const sourceId = body.sourceId ? this.sourceRowId(body.sourceId) : r.suggested_source_id ?? undefined;
    if (body.collectionId) this.collectionRowId(body.collectionId);
    const out = this.o.saveNow({ url: r.url, priority: body.priority ?? 3, ...(sourceId !== undefined ? { sourceId } : {}) });
    const dj = this.db.get<{ id: number }>("SELECT id FROM download_jobs WHERE public_id = ?", [out.downloadId]);
    this.db.transaction(() => {
      this.decide(r, "queued", body);
      this.db.run("UPDATE discovery_candidates SET download_job_id = ? WHERE id = ?", [dj?.id ?? null, r.id]);
      if (dj) this.db.run("UPDATE download_jobs SET candidate_id = ? WHERE id = ?", [r.id, dj.id]);
    });
    return { ...this.get(publicId), held: out.held };
  }

  bulk(body: { ids: string[]; action: "approve" | "dismiss" | "queue"; priority?: PriorityNumber; sourceId?: string; collectionId?: string }) {
    const results = body.ids.map((id) => {
      try {
        if (body.action === "approve") this.approve(id, body);
        else if (body.action === "dismiss") this.dismiss(id);
        else this.queue(id, body);
        return { id, ok: true as const };
      } catch (e) {
        return { id, ok: false as const, error: e instanceof AppError ? { code: e.code, message: e.message } : { code: "internal", message: "That did not work." } };
      }
    });
    return { results, done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  }

  // ---- overview, budget, runner --------------------------------------------------------------

  budget() {
    const d = this.cfg();
    const limits = effectiveLimits(d, this.profile());
    const now = this.o.clock.now();
    const day = dayOf(now);
    const next = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
    const lane = (b: "active" | "background") => {
      const used = this.ledger.used(b, now);
      const lim = limits[b];
      return {
        requests: { used: used.requests, limit: lim.maxRequestsPerDay, remaining: Math.max(0, lim.maxRequestsPerDay - used.requests) },
        bytes: { used: used.bytes, limit: lim.maxBytesPerDay, remaining: Math.max(0, lim.maxBytesPerDay - used.bytes) },
      };
    };
    const month = this.db.get<{ requests: number; bytes: number }>(
      `SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(CASE WHEN state = 'settled' THEN COALESCE(bytes, 0) ELSE reserved_bytes END), 0) AS bytes FROM discovery_ledger WHERE day LIKE ?`, [`${day.slice(0, 7)}-%`])!;
    return {
      day, resetsAt: iso(next)!, active: lane("active"), background: lane("background"), month,
      perSite: { cap: limits.perSiteDailyCap, top: this.ledger.topSites(now) },
      queue: { inFlight: this.ledger.inFlight(), limit: limits.maxQueued },
      pool: { candidates: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM discovery_candidates WHERE state IN ('new','approved')")!.n, limit: limits.maxCandidates },
    };
  }

  ledgerList(f: { day?: string; lane?: Lane; limit: number; cursor?: number }) {
    const out = this.ledger.list(f);
    return {
      items: out.items.map((r) => ({
        id: String(r.id), at: iso(r.at)!, day: r.day, lane: r.lane, host: r.host, requests: r.requests, reservedBytes: r.reserved_bytes,
        ...(r.bytes != null ? { bytes: r.bytes } : {}), state: r.state, ...(r.outcome ? { outcome: r.outcome } : {}),
        ...(r.candidate_id != null ? { candidateId: this.db.get<{ p: string }>("SELECT public_id AS p FROM discovery_candidates WHERE id = ?", [r.candidate_id])?.p } : {}),
        ...(r.download_job_id != null ? { downloadId: this.db.get<{ p: string }>("SELECT public_id AS p FROM download_jobs WHERE id = ?", [r.download_job_id])?.p } : {}),
        ...(r.settled_at != null ? { settledAt: iso(r.settled_at) } : {}),
      })),
      ...(out.nextCursor ? { nextCursor: out.nextCursor } : {}),
    };
  }

  runnerStatus() {
    const d = this.cfg();
    const last = this.runner.status().last ?? (() => {
      const j = this.db.get<{ j: string | null }>("SELECT last_pass_json AS j FROM discovery_state WHERE id = 1")?.j;
      try { return j ? (JSON.parse(j) as PassReport) : undefined; } catch { return undefined; }
    })();
    const paused = this.runner.pausedState();
    const blockers: Blocker[] = [];
    if (!d.enabled) blockers.push("disabled");
    if (paused.paused) blockers.push("kill_switch");
    try { this.o.gates.assertOnline(); } catch { blockers.push("offline"); }
    if (d.active.respectSchedule && !this.o.gates.windowOpen()) blockers.push("window_closed");
    if (this.o.gates.resourcesPaused()) blockers.push("resources");
    const idle = !d.enabled || (d.active.mode === "off" && !d.searchDriven.searchesInfluenceDiscovery);
    const state = idle ? "off" : paused.paused ? "paused" : blockers.length ? "blocked" : "idle";
    return {
      state, mode: d.active.mode, blockedBy: blockers, killSwitch: { paused: paused.paused, ...(paused.since ? { since: iso(paused.since) } : {}), ...(paused.by ? { by: paused.by } : {}) },
      inFlight: this.ledger.inFlight(), timerSeconds: Math.round(this.tickMs / 1000),
      ...(last ? { lastPass: { at: iso(last.at), trigger: last.trigger, active: last.active, background: last.background } } : {}),
      gates: { enabled: d.enabled, online: !blockers.includes("offline"), windowOpen: !blockers.includes("window_closed"), resourcesOk: !blockers.includes("resources"), storageRoomBytes: this.o.gates.storageRoom() },
    };
  }

  overview() {
    const d = this.cfg();
    const b = this.budget();
    return {
      enabled: d.enabled, mode: d.active.mode,
      collectors: { ...d.passive, searchesInfluenceDiscovery: d.searchDriven.searchesInfluenceDiscovery, autoCacheOpenedOnlinePages: d.searchDriven.autoCacheOpenedOnlinePages },
      counts: this.store.counts(), killSwitch: this.runner.pausedState().paused ? { paused: true, since: iso(this.runner.pausedState().since) } : { paused: false },
      budget: { day: b.day, resetsAt: b.resetsAt, active: b.active, background: b.background, month: b.month },
      runner: { state: this.runnerStatus().state, blockedBy: this.runnerStatus().blockedBy },
    };
  }

  // ---- settings ------------------------------------------------------------------------------

  settingsView() {
    const d = this.cfg();
    const profile = this.profile();
    return { settings: d, effective: effectiveLimits(d, profile), profile, profileMaximums: profileMaximums(profile) };
  }

  putSettings(body: unknown, userId?: number) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new RequestValidationError([{ in: "body", path: "", message: "Send an object of discovery settings." }]);
    const b = body as Record<string, unknown>;
    const active = b.active as { allowedSourceIds?: unknown } | undefined;
    if (active && Array.isArray(active.allowedSourceIds)) {
      const bad = active.allowedSourceIds.filter((id): id is string => typeof id === "string" && !this.db.get("SELECT 1 AS x FROM sources WHERE public_id = ? AND deleted_at IS NULL", [id]));
      if (bad.length) throw new RequestValidationError([{ in: "body", path: "active.allowedSourceIds", message: `These sources do not exist: ${bad.join(", ")}.` }]);
    }
    this.o.settings.patch({ discovery: b }, userId);
    return this.settingsView();
  }
}

export const queryBody = {
  ids: z.array(z.string().min(1).max(64)).min(1).max(200),
  action: z.enum(["approve", "dismiss", "queue"]),
  priority: priorityIn.optional(),
  sourceId: z.string().max(64).optional(),
  collectionId: z.string().max(64).optional(),
};
export { parseOrThrow, WEIGHT_NAMES };
