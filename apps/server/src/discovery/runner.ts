import type { Db } from "@ncb/db";
import type { Clock } from "@ncb/shared";
import type { ResourceProfile } from "@ncb/crawl";
import type { ActivityLog } from "../services/activity.js";
import type { CaptureOptions } from "../pipeline/types.js";
import { budgetOf, dayOf, type Ledger, type Lane } from "./ledger.js";
import { plan, type PlanCandidate, type SkipReason as PlanSkip } from "./planner.js";
import { effectiveLimits, type DiscoverySettings, type EffectiveLimits } from "./settings.js";
import type { CandidateStore, ProvenanceKind } from "./store.js";
import type { Scorer } from "./scorer.js";

/** Why a pass did nothing (or less than it could): the gates the runner checks before it looks at a single candidate. */
export type Blocker = "disabled" | "mode_off" | "kill_switch" | "offline" | "window_closed" | "resources" | "storage_full" | "search_driven_off";

export interface Gates {
  /** Throws (any error) when background downloads must not use the internet now. */
  assertOnline(): void;
  windowOpen(): boolean;
  /** True while the disk guard has paused background downloads. */
  resourcesPaused(): boolean;
  /** Free room on the best online volume, after its reserve. */
  storageRoom(): number;
  /** Bytes still free in a source's storage budget (undefined when it has none). */
  sourceRoom(sourceId: number): number | undefined;
}

export interface RunnerDeps {
  db: Db;
  clock: Clock;
  discovery(): DiscoverySettings;
  profile(): ResourceProfile;
  store: CandidateStore;
  scorer: Scorer;
  ledger: Ledger;
  gates: Gates;
  captureUrl(url: string, opts: CaptureOptions): { downloadId: string; jobId: number };
  cancelDownload(publicId: string): void;
  browsingCacheSourceId(): number;
  activity: ActivityLog;
  log: { warn(o: unknown, m?: string): void };
}

export interface LaneReport {
  eligible: number;
  started: number;
  skipped: Partial<Record<PlanSkip | "archived" | "in_progress", number>>;
  blockedBy: Blocker[];
}

export interface PassReport {
  at: number;
  trigger: "timer" | "manual";
  active: LaneReport;
  background: LaneReport;
}

const KINDS_BY_FLAG: Record<string, ProvenanceKind> = {
  fromLinks: "link", fromVisits: "visit", fromBookmarks: "bookmark", fromMissingLinks: "missing_link", fromSavedSearches: "saved_search",
};

/** The provenance kinds that currently count: a collector that is switched off hides what it brought. */
export function enabledKinds(d: DiscoverySettings): ProvenanceKind[] {
  if (!d.enabled) return [];
  const kinds: ProvenanceKind[] = ["manual"];
  for (const [flag, kind] of Object.entries(KINDS_BY_FLAG)) if ((d.passive as Record<string, boolean>)[flag]) kinds.push(kind);
  if (d.searchDriven.searchesInfluenceDiscovery) kinds.push("search_result");
  return kinds;
}

const ACTIVE_KINDS: ProvenanceKind[] = ["link", "visit", "bookmark", "missing_link", "saved_search", "manual"];

const MIB = 1024 * 1024;
/** Sub-resources a discovery capture may fetch. A "request" in the budgets is one page capture of at most this many files plus the page. */
export const DISCOVERY_MAX_ASSETS = 40;

/** The capture caps for a byte allotment. The allotment is a hard cap: document plus sub-resources cannot exceed it. */
export function capsFor(allotment: number): NonNullable<CaptureOptions["caps"]> {
  const doc = Math.max(64 * 1024, Math.floor(allotment / 2));
  return { maxDocumentBytes: doc, maxTotalAssetBytes: Math.max(0, allotment - doc), maxAssetBytes: Math.max(64 * 1024, Math.min(25 * MIB, Math.floor(allotment / 2))), maxAssets: DISCOVERY_MAX_ASSETS };
}

interface CandRow { id: number; url: string; host: string | null; depth: number; est_bytes: number | null; state: string; suggested_source_id: number | null; primary_kind: string | null }

/**
 * The active discovery runner (tasks D-04 and D-06). One pass looks at the gates (switched on, kill switch, online, schedule window,
 * disk guard), picks eligible candidates best-first, lets the pure planner decide how many may start inside every limit, and starts
 * those downloads through the ordinary capture path (so admission control, robots and politeness still apply). It never waits on the
 * network itself: a pass is synchronous database work, and the kill switch is read again before each download is started.
 */
export class DiscoveryRunner {
  private lastTick = Number.NEGATIVE_INFINITY;
  private running = false;
  private last?: PassReport;

  constructor(private readonly o: RunnerDeps) {}
  private get db(): Db { return this.o.db; }

  // ---- kill switch ---------------------------------------------------------------------------

  isPaused(): boolean {
    return this.db.get<{ p: number | null }>("SELECT paused_at AS p FROM discovery_state WHERE id = 1")?.p != null;
  }

  pausedState(): { paused: boolean; since?: number; by?: string } {
    const r = this.db.get<{ p: number | null; b: string | null }>("SELECT paused_at AS p, paused_by AS b FROM discovery_state WHERE id = 1");
    return r?.p != null ? { paused: true, since: r.p, ...(r.b ? { by: r.b } : {}) } : { paused: false };
  }

  /** Stops discovery: no download starts after this returns; downloads still waiting are cancelled; one already running finishes. */
  pause(by = "user"): { cancelled: number } {
    this.db.run("UPDATE discovery_state SET paused_at = COALESCE(paused_at, ?), paused_by = COALESCE(paused_by, ?) WHERE id = 1", [this.o.clock.now(), by]);
    let cancelled = 0;
    const waiting = this.db.all<{ public_id: string }>(
      `SELECT d.public_id FROM discovery_ledger l JOIN download_jobs d ON d.id = l.download_job_id WHERE l.state = 'reserved' AND d.state IN ('queued','paused')`);
    for (const w of waiting) {
      try { this.o.cancelDownload(w.public_id); cancelled++; } catch { /* it started in the meantime */ }
    }
    this.reconcile();
    this.o.activity.write({ level: "warn", area: "crawl", message: `Discovery was stopped (${by}). ${cancelled} waiting download${cancelled === 1 ? " was" : "s were"} cancelled.` });
    return { cancelled };
  }

  resume(): void {
    this.db.run("UPDATE discovery_state SET paused_at = NULL, paused_by = NULL WHERE id = 1");
    this.o.activity.write({ level: "info", area: "crawl", message: "Discovery was resumed." });
  }

  // ---- passes --------------------------------------------------------------------------------

  /** Called from the job runner's loop. Does a pass at most once per `everyMs`. */
  tick(everyMs: number): void {
    if (everyMs <= 0) return;
    const now = this.o.clock.monotonic();
    if (now - this.lastTick < everyMs) return;
    this.lastTick = now;
    try { this.runPass("timer"); } catch (e) { this.o.log.warn({ err: String(e) }, "discovery pass failed"); }
  }

  status(): { last?: PassReport; running: boolean } {
    return { last: this.last, running: this.running };
  }

  /** Brings the ledger and the candidates in line with the downloads that have ended since the last pass. */
  reconcile(): void {
    const { db } = this;
    this.o.ledger.settle();
    const rows = db.all<{ id: number; state: string; download_state: string | null; started: number | null; decided_by: string | null; url_key: string; origin_storage: string | null; attempts: number }>(
      `SELECT c.id, c.state, d.state AS download_state, d.started_at AS started, c.decided_by, c.url_key, c.origin_storage, c.attempts FROM discovery_candidates c
       LEFT JOIN download_jobs d ON d.id = c.download_job_id WHERE c.state = 'queued' AND c.download_job_id IS NOT NULL`);
    for (const r of rows) {
      const ds = r.download_state;
      if (ds === "queued" || ds === "running" || ds === "paused") continue;
      if (ds === "completed" && this.o.store.isArchived(r.url_key)) { db.run("UPDATE discovery_candidates SET state = 'archived' WHERE id = ?", [r.id]); continue; }
      const neverRan = ds === "cancelled" && r.started === null;
      const back = r.decided_by === "user" ? "approved" : "new";
      const spent = r.attempts + (neverRan ? 0 : 1) >= 2;
      // A candidate from a provider that allows no storage exists only while approved; if it cannot continue, it is forgotten.
      if (r.origin_storage === "none" && (spent || back === "new")) { db.run("DELETE FROM discovery_candidates WHERE id = ?", [r.id]); continue; }
      db.run("UPDATE discovery_candidates SET state = ?, attempts = attempts + ? WHERE id = ?", [spent ? "expired" : back, neverRan ? 0 : 1, r.id]);
    }
    this.o.store.sweepExpired();
  }

  private commonBlockers(d: DiscoverySettings): Blocker[] {
    const out: Blocker[] = [];
    if (!d.enabled) out.push("disabled");
    if (this.isPaused()) out.push("kill_switch");
    try { this.o.gates.assertOnline(); } catch { out.push("offline"); }
    if (d.active.respectSchedule && !this.o.gates.windowOpen()) out.push("window_closed");
    if (this.o.gates.resourcesPaused()) out.push("resources");
    return out;
  }

  runPass(trigger: "timer" | "manual" = "manual"): PassReport {
    if (this.running) return this.last ?? this.empty(trigger);
    this.running = true;
    try {
      this.reconcile();
      const d = this.o.discovery();
      const limits = effectiveLimits(d, this.o.profile());
      const common = this.commonBlockers(d);
      const report: PassReport = { at: this.o.clock.now(), trigger, active: this.laneReport(), background: this.laneReport() };

      // A cheap upkeep step: candidates whose score is out of date after a settings or signal change.
      if (d.enabled) this.o.scorer.rescore(200);

      const activeBlock: Blocker[] = [...common];
      if (d.active.mode === "off") activeBlock.push("mode_off");
      report.active.blockedBy = activeBlock;
      if (activeBlock.length === 0) this.lane("active", d, limits, report.active);

      const backgroundBlock: Blocker[] = [...common];
      if (!d.searchDriven.searchesInfluenceDiscovery) backgroundBlock.push("search_driven_off");
      report.background.blockedBy = backgroundBlock;
      if (backgroundBlock.length === 0) this.lane("background", d, limits, report.background);

      this.last = report;
      this.db.run("UPDATE discovery_state SET last_pass_at = ?, last_pass_json = ? WHERE id = 1", [report.at, JSON.stringify(report)]);
      return report;
    } finally {
      this.running = false;
    }
  }

  private laneReport(): LaneReport {
    return { eligible: 0, started: 0, skipped: {}, blockedBy: [] };
  }
  private empty(trigger: "timer" | "manual"): PassReport {
    return { at: this.o.clock.now(), trigger, active: this.laneReport(), background: this.laneReport() };
  }

  /** Eligible candidates for a lane, best first. */
  private select(lane: "active" | "background", d: DiscoverySettings, limits: EffectiveLimits): CandRow[] {
    const kindsOn = enabledKinds(d);
    const where: string[] = ["c.state IN ('new','approved')"];
    const args: (string | number)[] = [];
    const now = this.o.clock.now();
    where.push("(c.expires_at IS NULL OR c.expires_at > ?)");
    args.push(now);
    where.push("c.depth <= ?");
    args.push(limits.maxDepth);
    if (lane === "active") {
      const laneKinds = ACTIVE_KINDS.filter((k) => kindsOn.includes(k));
      if (!laneKinds.length) return [];
      where.push(`EXISTS (SELECT 1 FROM candidate_provenance p WHERE p.candidate_id = c.id AND p.kind IN (${laneKinds.map(() => "?").join(",")}))`);
      args.push(...laneKinds);
      if (d.active.mode === "approval") where.push("c.state = 'approved'");
      else {
        const allowed = this.allowedSourceRows(d);
        const scope = allowed.length
          ? `EXISTS (SELECT 1 FROM candidate_provenance p WHERE p.candidate_id = c.id AND p.kind IN ('link','saved_search') AND (p.ref_source_id IN (${allowed.map(() => "?").join(",")}) OR p.ref_page_id IN (SELECT page_id FROM page_sources WHERE source_id IN (${allowed.map(() => "?").join(",")}))))`
          : "0";
        where.push(`(c.state = 'approved' OR (c.state = 'new' AND c.score >= ? AND ${scope}))`);
        args.push(d.active.minScore, ...allowed, ...allowed);
      }
    } else {
      // Search-driven: only candidates that came from searches and nothing else.
      where.push("EXISTS (SELECT 1 FROM candidate_provenance p WHERE p.candidate_id = c.id AND p.kind = 'search_result')");
      where.push("NOT EXISTS (SELECT 1 FROM candidate_provenance p WHERE p.candidate_id = c.id AND p.kind <> 'search_result')");
      if (d.searchDriven.requireApproval) where.push("c.state = 'approved'");
      else { where.push("(c.state = 'approved' OR (c.state = 'new' AND c.score >= ?))"); args.push(d.active.minScore); }
    }
    return this.db.all<CandRow>(
      `SELECT c.id, c.url, c.host, c.depth, c.est_bytes, c.state, c.suggested_source_id, NULL AS primary_kind FROM discovery_candidates c
       WHERE ${where.join(" AND ")} ORDER BY (c.state = 'approved') DESC, c.score DESC, c.id LIMIT 500`, args);
  }

  private allowedSourceRows(d: DiscoverySettings): number[] {
    if (!d.active.allowedSourceIds.length) return [];
    return this.db.all<{ id: number }>(
      `SELECT id FROM sources WHERE deleted_at IS NULL AND enabled = 1 AND public_id IN (${d.active.allowedSourceIds.map(() => "?").join(",")})`, d.active.allowedSourceIds).map((r) => r.id);
  }

  /** The source a download is filed under: the Human's choice, else an allowed source it came from, else the Browsing cache. */
  private sourceFor(c: CandRow, lane: "active" | "background", d: DiscoverySettings): number {
    if (lane === "background") return this.o.browsingCacheSourceId();
    if (c.suggested_source_id !== null) return c.suggested_source_id;
    const allowed = this.allowedSourceRows(d);
    if (allowed.length) {
      const hit = this.db.get<{ id: number }>(
        `SELECT s.id FROM candidate_provenance p JOIN sources s ON (s.id = p.ref_source_id OR s.id IN (SELECT source_id FROM page_sources WHERE page_id = p.ref_page_id))
         WHERE p.candidate_id = ? AND s.id IN (${allowed.map(() => "?").join(",")}) ORDER BY s.priority, s.id LIMIT 1`, [c.id, ...allowed]);
      if (hit) return hit.id;
    }
    return this.o.browsingCacheSourceId();
  }

  private lane(lane: "active" | "background", d: DiscoverySettings, limits: EffectiveLimits, report: LaneReport): void {
    const budget = lane === "active" ? limits.active : limits.background;
    const rows = this.select(lane, d, limits);
    const candidates: PlanCandidate[] = [];
    const byId = new Map<number, CandRow>();
    for (const c of rows) {
      let key: string;
      try { key = this.db.get<{ k: string }>("SELECT url_key AS k FROM discovery_candidates WHERE id = ?", [c.id])!.k; } catch { continue; }
      if (this.o.store.isArchived(key)) {
        this.db.run("UPDATE discovery_candidates SET state = 'archived' WHERE id = ?", [c.id]);
        report.skipped.archived = (report.skipped.archived ?? 0) + 1;
        continue;
      }
      if (this.db.get("SELECT 1 AS x FROM jobs WHERE url_key = ? AND state IN ('queued','running','held') AND type = 'fetch'", [key]) || this.db.get("SELECT 1 AS x FROM url_exclusions WHERE url_key = ?", [key])) {
        report.skipped.in_progress = (report.skipped.in_progress ?? 0) + 1;
        continue;
      }
      let host = c.host;
      if (!host) { try { host = new URL(c.url).hostname.toLowerCase(); } catch { continue; } }
      const sourceId = this.sourceFor(c, lane, d);
      candidates.push({ id: c.id, host, depth: c.depth, estimatedBytes: c.est_bytes, sourceId });
      byId.set(c.id, c);
    }
    report.eligible = candidates.length;

    const used = this.o.ledger.used(budgetOf(lane === "active" ? "active" : "background"));
    const sourceRoom = new Map<number, number>();
    for (const sid of new Set(candidates.map((c) => c.sourceId!))) {
      const room = this.o.gates.sourceRoom(sid);
      if (room !== undefined) sourceRoom.set(sid, room);
    }
    const outcome = plan({
      maxDepth: limits.maxDepth, maxQueued: limits.maxQueued, maxCandidatesPerRun: limits.maxCandidatesPerRun, perSiteDailyCap: limits.perSiteDailyCap,
      inFlight: this.o.ledger.inFlight(),
      requests: { max: budget.maxRequestsPerDay, used: used.requests },
      bytes: { max: budget.maxBytesPerDay, used: used.bytes },
      siteUsed: this.o.ledger.sites(), storageRoom: this.o.gates.storageRoom(), sourceRoom, candidates,
    });
    for (const s of outcome.skipped) report.skipped[s.reason] = (report.skipped[s.reason] ?? 0) + 1;

    for (const s of outcome.start) {
      // The kill switch is read again before every download, so it takes effect within one job.
      if (this.isPaused()) { report.blockedBy.push("kill_switch"); break; }
      const c = byId.get(s.id)!;
      if (this.start(c, s.host, s.allotment, s.sourceId, lane)) report.started++;
    }
  }

  private start(c: CandRow, host: string, allotment: number, sourceId: number | null, lane: "active" | "background"): boolean {
    const via = lane === "background" ? "search" : this.db.get<{ k: string }>("SELECT kind AS k FROM candidate_provenance WHERE candidate_id = ? ORDER BY id LIMIT 1", [c.id])?.k === "saved_search" ? "search" : "link";
    try {
      const out = this.o.captureUrl(c.url, {
        priority: 4, requestedBy: "discovery", userInitiated: false, ...(sourceId !== null ? { sourceId } : {}), discoveredVia: via, depth: c.depth,
        caps: capsFor(allotment),
      });
      this.db.transaction(() => {
        const dj = this.db.get<{ id: number }>("SELECT id FROM download_jobs WHERE public_id = ?", [out.downloadId]);
        this.db.run("UPDATE discovery_candidates SET state = 'queued', download_job_id = ?, decided_at = COALESCE(decided_at, ?), decided_by = COALESCE(decided_by, 'runner') WHERE id = ?", [dj?.id ?? null, this.o.clock.now(), c.id]);
        if (dj) this.db.run("UPDATE download_jobs SET candidate_id = ? WHERE id = ?", [c.id, dj.id]);
        this.o.ledger.reserve({ lane, candidateId: c.id, downloadJobId: dj?.id ?? null, host, bytes: allotment });
      });
      return true;
    } catch (e) {
      this.o.log.warn({ err: String(e), candidate: c.id }, "discovery could not start a download");
      this.db.run("UPDATE discovery_candidates SET attempts = attempts + 1 WHERE id = ?", [c.id]);
      return false;
    }
  }

  // ---- auto-cache ----------------------------------------------------------------------------

  /**
   * Keeps a page the Human just opened, in the Browsing cache (P4), inside the background budget and the per-site cap. Only the page
   * the Human opened is saved: nothing it links to is fetched. Returns why it did not, or `ok`.
   */
  autoCache(url: string): { ok: true; downloadId: string } | { ok: false; reason: string } {
    const d = this.o.discovery();
    if (!d.enabled || !d.searchDriven.autoCacheOpenedOnlinePages) return { ok: false, reason: "off" };
    if (this.isPaused()) return { ok: false, reason: "kill_switch" };
    try { this.o.gates.assertOnline(); } catch { return { ok: false, reason: "offline" }; }
    if (this.o.gates.resourcesPaused()) return { ok: false, reason: "resources" };
    const limits = effectiveLimits(d, this.o.profile());
    let u: URL;
    let key: string;
    try { u = new URL(url); key = this.o.store.keyOf(u.href); } catch { return { ok: false, reason: "invalid_url" }; }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return { ok: false, reason: "invalid_url" };
    if (this.o.store.isSensitive(u)) return { ok: false, reason: "sensitive" };
    if (this.o.store.isArchived(key)) return { ok: false, reason: "archived" };
    if (this.db.get("SELECT 1 AS x FROM jobs WHERE url_key = ? AND state IN ('queued','running','held') AND type = 'fetch'", [key]) || this.db.get("SELECT 1 AS x FROM url_exclusions WHERE url_key = ?", [key])) return { ok: false, reason: "in_progress" };
    const host = u.hostname.toLowerCase();
    const sourceId = this.o.browsingCacheSourceId();
    const used = this.o.ledger.used("background");
    const room = this.o.gates.sourceRoom(sourceId);
    const outcome = plan({
      maxDepth: limits.maxDepth, maxQueued: limits.maxQueued, maxCandidatesPerRun: 1, perSiteDailyCap: limits.perSiteDailyCap, inFlight: this.o.ledger.inFlight(),
      requests: { max: limits.background.maxRequestsPerDay, used: used.requests }, bytes: { max: limits.background.maxBytesPerDay, used: used.bytes },
      siteUsed: this.o.ledger.sites(), storageRoom: this.o.gates.storageRoom(), sourceRoom: room === undefined ? new Map() : new Map([[sourceId, room]]),
      candidates: [{ id: 0, host, depth: 0, estimatedBytes: null, sourceId }],
    });
    if (!outcome.start.length) return { ok: false, reason: outcome.skipped[0]?.reason ?? "limit" };
    const s = outcome.start[0]!;
    const out = this.o.captureUrl(u.href, { priority: 4, requestedBy: "discovery", userInitiated: false, sourceId, discoveredVia: "manual", depth: 0, caps: capsFor(s.allotment) });
    const dj = this.db.get<{ id: number }>("SELECT id FROM download_jobs WHERE public_id = ?", [out.downloadId]);
    this.o.ledger.reserve({ lane: "auto_cache", candidateId: null, downloadJobId: dj?.id ?? null, host, bytes: s.allotment });
    return { ok: true, downloadId: out.downloadId };
  }
}

export { dayOf };
export type { Lane };
