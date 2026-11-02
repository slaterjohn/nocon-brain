import { createHash } from "node:crypto";
import type { Db, JobQueue } from "@ncb/db";
import { AppError, newId, parsePriority, priorityToCode, type Clock, type PriorityNumber } from "@ncb/shared";
import type { CrawlService } from "../crawl/service.js";
import type { ResourceGovernor, DiskGuardTarget } from "../limits/governor.js";
import type { PipelineService } from "../pipeline/service.js";
import { captureEvent } from "../pipeline/progress.js";
import type { RefreshService } from "../refresh/service.js";
import type { Scheduler } from "../schedule/scheduler.js";
import type { ScheduleService } from "../schedule/service.js";
import type { ConnectivityService } from "../services/connectivity.js";
import type { ActivityLog } from "../services/activity.js";
import type { EventBus } from "../services/events.js";
import type { SettingsService } from "../services/settings.js";
import type { SourceService } from "../sources/service.js";
import { statusToApi } from "../schedule/windows.js";
import { failureFor, PAUSE_MESSAGES, STOP_MESSAGES, WAIT_MESSAGES, type PauseReason } from "./failures.js";
import type { AdmissionService } from "../storage/admission.js";
import { ACTIONS, allowed, RETRYABLE_KINDS, type DownloadAction, type DownloadState } from "./state.js";

const KINDS = ["capture", "explore", "mirror", "refresh", "wikipedia", "zim_import", "import", "discovery", "coverage"] as const;
export type DownloadKind = (typeof KINDS)[number];
const STATES: DownloadState[] = ["queued", "running", "paused", "completed", "failed", "cancelled"];
const iso = (n: number | null | undefined): string | undefined => (n == null ? undefined : new Date(n).toISOString());
const CRAWL_KINDS = new Set<string>(["explore", "mirror"]);

export interface DownloadEstimate {
  estimate: true;
  pages?: { low: number; high: number };
  bytes?: { low: number; high: number };
  durationSeconds?: { low: number; high: number };
  basis: string;
  confidence: "low" | "medium" | "high";
}

export interface DownloadDto {
  id: string;
  kind: DownloadKind;
  state: DownloadState;
  priority: "P1" | "P2" | "P3" | "P4";
  queueOrder: number;
  title: string;
  sourceId?: string;
  sourceName?: string;
  requestedBy: string;
  requestedUrl?: string;
  progress: { pagesDone: number; pagesFailed: number; pagesDiscovered?: number; bytesDone: number; percent?: number; label?: string; etaSeconds?: number };
  estimate?: DownloadEstimate;
  pause?: { reason: PauseReason; automatic: boolean; message: string };
  /** Why a queued or running download is not making progress although it is not paused. */
  wait?: { reason: "throttled"; message: string };
  failure?: { code: string; message: string; retryable: boolean; hint: string };
  stop?: { reason: string; message: string };
  summary?: { checked: number; unchanged: number; changed: number; gone: number; failed: number };
  attempts: number;
  controls: { pause: boolean; resume: boolean; cancel: boolean; retry: boolean; setPriority: boolean };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  scheduledFor?: string;
  updatedAt: string;
  crawl?: { mode: string; maxPages?: number; maxBytes?: number; depthReached: number; pagesSkipped: number; deadlineAt?: string; frontier: { queued: number; running: number; held: number } };
}

interface Row {
  id: number; public_id: string; source_id: number | null; kind: DownloadKind; state: DownloadState; priority: number; queue_order: number;
  requested_url: string | null; requested_by: string; estimated_pages: number | null; estimated_bytes: number | null;
  pages_done: number; pages_failed: number; bytes_done: number; failure_code: string | null; failure_message: string | null;
  scheduled_for: number | null; started_at: number | null; finished_at: number | null; created_at: number;
  paused_by_window: number; paused_by_limit: number; attempts: number; summary_json: string | null;
  source_pid: string | null; source_name: string | null;
  crawl_id: number | null; mode: string | null; max_pages: number | null; max_bytes: number | null; pages_discovered: number | null;
  pages_fetched: number | null; crawl_failed: number | null; crawl_bytes: number | null; depth_reached: number | null; pages_skipped: number | null;
  deadline_at: number | null; stop_reason: string | null;
}

interface JobCounts { queued: number; running: number; held: number; done: number; bad: number; cancelled: number; total: number }

export interface DownloadServiceDeps {
  db: Db;
  clock: Clock;
  queue: JobQueue;
  events: EventBus;
  activity: ActivityLog;
  crawl: Pick<CrawlService, "pause" | "resume" | "cancel" | "startCrawl" | "setPriority">;
  pipeline: Pick<PipelineService, "captureUrl" | "holdCapture">;
  refresh: RefreshService;
  sources: Pick<SourceService, "run" | "resolvePublicId" | "refreshStatus" | "reconcileStatuses">;
  scheduler: Pick<Scheduler, "isOpen">;
  schedules: Pick<ScheduleService, "nextScheduled">;
  connectivity: Pick<ConnectivityService, "snapshot">;
  governor: ResourceGovernor;
  settings: Pick<SettingsService, "internal">;
  /** Storage admission: tells which downloads wait because Opportunistic downloads are throttled. */
  admission?: Pick<AdmissionService, "isThrottled" | "throttledCount">;
  workers: () => unknown[];
  /** Builds a crawl config for an `explore` or `mirror` download made without a source. */
  buildCrawl: (a: { url: string; mode: "explore" | "mirror"; priority: PriorityNumber; config: unknown }) => Parameters<CrawlService["startCrawl"]>[0];
  /** Minimum time between two `download.update` events for one job. Default 200 ms. */
  eventMs?: number;
}

/**
 * The downloads queue API (task C-08). The state of a download lives in `download_jobs`; this service reads it together with the
 * internal job rows to build what the Human sees, applies the controls through the right owner (the crawl engine for crawls,
 * the queue for everything else), repairs downloads whose work all ended, and publishes `download.update` events.
 */
export class DownloadService implements DiskGuardTarget {
  private readonly dirty = new Set<number>();
  private flushTimer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private lastQueueKey = "";

  constructor(private readonly d: DownloadServiceDeps) {
    d.governor.setDiskTarget(this);
    d.governor.onStatusChange(() => this.publishQueue(true));
  }

  // ---- lifecycle -----------------------------------------------------------------------------

  start(): void {
    this.unsubscribe = this.d.events.subscribe((e) => this.onEvent(e));
    this.flushTimer = setInterval(() => this.flush(), this.d.eventMs ?? 200);
    this.flushTimer.unref();
    this.sweepTimer = setInterval(() => {
      try {
        this.sweep();
      } catch { /* the next sweep tries again */ }
    }, 1000);
    this.sweepTimer.unref();
    this.sweep();
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.flushTimer = this.sweepTimer = undefined;
  }

  private onEvent(e: { type: string; data: unknown }): void {
    const data = e.data as Record<string, unknown> | null;
    if (!data) return;
    let id: number | undefined;
    if (e.type === "download" && typeof data.downloadJobId === "number") id = data.downloadJobId;
    else if ((e.type === "capture" || e.type === "crawl" || e.type === "refresh") && typeof data.downloadId === "string") {
      id = this.d.db.get<{ id: number }>("SELECT id FROM download_jobs WHERE public_id = ?", [data.downloadId])?.id;
    }
    if (id !== undefined) this.dirty.add(id);
  }

  private flush(): void {
    if (this.dirty.size === 0) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    this.settleSources(ids);
    for (const dto of this.byIds(ids)) this.d.events.publish("download.update", { download: dto });
    this.publishQueue(false);
  }

  /** A download linked to a source has ended (completed, failed or cancelled): the source's status follows it. */
  private settleSources(ids: number[]): void {
    if (ids.length === 0) return;
    const rows = this.d.db.all<{ source_id: number }>(
      `SELECT DISTINCT source_id FROM download_jobs WHERE id IN (${ids.map(() => "?").join(",")}) AND source_id IS NOT NULL AND state IN ('completed','failed','cancelled')`, ids);
    for (const r of rows) {
      try { this.d.sources.refreshStatus(r.source_id); } catch { /* the next sweep tries again */ }
    }
  }

  /** Marks a download as changed so the next flush publishes it. */
  touch(downloadJobId: number): void {
    this.dirty.add(downloadJobId);
  }

  private publishQueue(force: boolean): void {
    const payload = { counts: this.counts(), throttle: this.d.governor.throttleStatus(), disk: this.d.governor.diskStatus(), storageThrottle: { downloads: this.d.admission?.throttledCount() ?? 0 } };
    const key = JSON.stringify({ s: payload.storageThrottle.downloads, c: payload.counts, t: [payload.throttle.active, payload.throttle.reason], d: [payload.disk.paused, payload.disk.pausedDownloads] });
    if (!force && key === this.lastQueueKey) return;
    this.lastQueueKey = key;
    this.d.events.publish("download.queue", payload);
  }

  // ---- reading -------------------------------------------------------------------------------

  private selectSql(where: string): string {
    return `SELECT d.*, s.public_id AS source_pid, s.name AS source_name,
                   c.id AS crawl_id, c.mode, c.max_pages, c.max_bytes, c.pages_discovered, c.pages_fetched, c.pages_failed AS crawl_failed,
                   c.bytes_fetched AS crawl_bytes, c.depth_reached, c.pages_skipped, c.deadline_at, c.stop_reason
            FROM download_jobs d LEFT JOIN sources s ON s.id = d.source_id LEFT JOIN crawl_jobs c ON c.download_job_id = d.id ${where}`;
  }

  private jobCounts(ids: number[]): Map<number, JobCounts> {
    const out = new Map<number, JobCounts>();
    if (ids.length === 0) return out;
    const rows = this.d.db.all<{ download_job_id: number; state: string; n: number }>(
      `SELECT download_job_id, state, COUNT(*) AS n FROM jobs WHERE download_job_id IN (${ids.map(() => "?").join(",")}) GROUP BY download_job_id, state`, ids);
    for (const r of rows) {
      const c = out.get(r.download_job_id) ?? { queued: 0, running: 0, held: 0, done: 0, bad: 0, cancelled: 0, total: 0 };
      if (r.state === "queued") c.queued += r.n;
      else if (r.state === "running") c.running += r.n;
      else if (r.state === "held") c.held += r.n;
      else if (r.state === "done") c.done += r.n;
      else if (r.state === "failed" || r.state === "dead") c.bad += r.n;
      else if (r.state === "cancelled") c.cancelled += r.n;
      c.total += r.n;
      out.set(r.download_job_id, c);
    }
    return out;
  }

  private byIds(ids: number[]): DownloadDto[] {
    if (ids.length === 0) return [];
    const rows = this.d.db.all<Row>(this.selectSql(`WHERE d.id IN (${ids.map(() => "?").join(",")})`), ids);
    return this.toDtos(rows, false);
  }

  private titleOf(r: Row): string {
    if (r.source_name) return r.source_name;
    if (r.requested_url) {
      try {
        const u = new URL(r.requested_url);
        const path = u.pathname === "/" ? "" : u.pathname;
        return `${u.host}${path}${u.search}`.slice(0, 120);
      } catch {
        return r.requested_url.slice(0, 120);
      }
    }
    return { capture: "Saved page", explore: "Crawl", mirror: "Mirror", refresh: "Check for changes", wikipedia: "Wikipedia", zim_import: "Package import", import: "Import", discovery: "Discovery", coverage: "Offline coverage" }[r.kind] ?? r.kind;
  }

  private toDtos(rows: Row[], detail: boolean): DownloadDto[] {
    const counts = this.jobCounts(rows.map((r) => r.id));
    return rows.map((r) => this.toDto(r, counts.get(r.id) ?? { queued: 0, running: 0, held: 0, done: 0, bad: 0, cancelled: 0, total: 0 }, detail));
  }

  private toDto(r: Row, jc: JobCounts, detail: boolean): DownloadDto {
    const now = this.d.clock.now();
    const isCrawl = r.crawl_id !== null;
    // An offline hold keeps the stored state `queued` while every piece of work is held; the Human sees it as paused.
    const offlineHold = r.state === "queued" && jc.held > 0 && jc.queued === 0 && jc.running === 0;
    const state: DownloadState = offlineHold ? "paused" : r.state;
    const summary = r.summary_json ? (JSON.parse(r.summary_json) as NonNullable<DownloadDto["summary"]>) : undefined;

    let pagesDone = r.pages_done;
    let pagesFailed = r.pages_failed;
    let bytesDone = r.bytes_done;
    let discovered: number | undefined;
    let label: string | undefined;
    let percent: number | undefined;
    if (isCrawl) {
      pagesDone = r.pages_fetched ?? pagesDone;
      pagesFailed = r.crawl_failed ?? pagesFailed;
      bytesDone = r.crawl_bytes ?? bytesDone;
      discovered = r.pages_discovered ?? undefined;
      const target = Math.min(r.max_pages ?? Infinity, Math.max(discovered ?? 0, pagesDone, 1));
      percent = state === "completed" ? 100 : Math.min(99, Math.floor((pagesDone / target) * 100));
      label = state === "completed" ? `Saved ${pagesDone.toLocaleString("en-GB")} pages` : `Saved ${pagesDone.toLocaleString("en-GB")} of ${(discovered ?? pagesDone).toLocaleString("en-GB")} pages found so far`;
    } else if (r.kind === "refresh") {
      const checked = summary?.checked ?? 0;
      const failedN = summary?.failed ?? 0;
      const total = Math.max(jc.total, checked + failedN);
      pagesDone = checked;
      pagesFailed = failedN;
      discovered = total || undefined;
      percent = state === "completed" ? 100 : total > 0 ? Math.min(99, Math.floor(((checked + failedN) / total) * 100)) : 0;
      label = state === "completed" ? `Checked ${checked.toLocaleString("en-GB")} pages` : `Checked ${(checked + failedN).toLocaleString("en-GB")} of ${total.toLocaleString("en-GB")} pages`;
    } else if (r.kind === "capture") {
      const ev = state === "completed" || state === "failed" || state === "cancelled" ? undefined : captureEvent(this.d.db, r.id);
      if (state === "completed") { percent = 100; label = pagesDone > 0 ? "Saved" : "Already saved, nothing has changed"; }
      else if (state === "failed") label = "Could not be saved";
      else if (state === "cancelled") label = "Cancelled";
      else if (ev) { percent = ev.percent; label = ev.label; }
    }

    let etaSeconds: number | undefined;
    if (state === "running" && r.started_at !== null && pagesDone >= 3 && (isCrawl || r.kind === "refresh")) {
      const target = isCrawl ? Math.min(r.max_pages ?? Infinity, Math.max(discovered ?? 0, pagesDone)) : (discovered ?? 0);
      const remaining = target - pagesDone;
      const elapsed = Math.max(1, (now - r.started_at) / 1000);
      if (remaining > 0 && Number.isFinite(remaining)) etaSeconds = Math.round((elapsed / pagesDone) * remaining);
    }

    const estimate = this.estimate(r, { state, pagesDone, bytesDone, discovered, etaSeconds, isCrawl, total: jc.total });

    let pause: DownloadDto["pause"];
    if (state === "paused") {
      const reason: PauseReason = offlineHold ? "offline" : r.paused_by_limit === 1 ? "volume_full" : r.paused_by_window === 1 ? "window_closed" : "user";
      pause = { reason, automatic: reason !== "user", message: PAUSE_MESSAGES[reason] };
    }
    const wait: DownloadDto["wait"] = (state === "queued" || state === "running") && this.d.admission?.isThrottled(r.id) ? { reason: "throttled", message: WAIT_MESSAGES.throttled } : undefined;
    const failure = state === "failed" ? failureFor(r.failure_code, r.failure_message) : undefined;

    const controls = this.controlsFor(state, r.kind, pause?.reason);
    const dto: DownloadDto = {
      id: r.public_id, kind: r.kind, state, priority: priorityToCode(r.priority as PriorityNumber), queueOrder: r.queue_order,
      title: this.titleOf(r), ...(r.source_pid ? { sourceId: r.source_pid, sourceName: r.source_name ?? undefined } : {}),
      requestedBy: r.requested_by, ...(r.requested_url ? { requestedUrl: r.requested_url } : {}),
      progress: {
        pagesDone, pagesFailed, ...(discovered !== undefined ? { pagesDiscovered: discovered } : {}), bytesDone,
        ...(percent !== undefined ? { percent } : {}), ...(label ? { label } : {}), ...(etaSeconds !== undefined ? { etaSeconds } : {}),
      },
      ...(estimate ? { estimate } : {}), ...(pause ? { pause } : {}), ...(wait ? { wait } : {}), ...(failure ? { failure } : {}),
      ...(r.stop_reason ? { stop: { reason: r.stop_reason, message: STOP_MESSAGES[r.stop_reason] ?? r.stop_reason } } : {}),
      ...(summary ? { summary } : {}),
      attempts: r.attempts, controls,
      createdAt: iso(r.created_at)!, ...(r.started_at !== null ? { startedAt: iso(r.started_at) } : {}), ...(r.finished_at !== null ? { finishedAt: iso(r.finished_at) } : {}),
      ...(r.scheduled_for !== null ? { scheduledFor: iso(r.scheduled_for) } : {}),
      updatedAt: iso(Math.max(r.created_at, r.started_at ?? 0, r.finished_at ?? 0, state === "running" || state === "queued" ? now : 0))!,
    };
    if (detail && isCrawl) {
      dto.crawl = {
        mode: r.mode!, ...(r.max_pages !== null ? { maxPages: r.max_pages } : {}), ...(r.max_bytes !== null ? { maxBytes: r.max_bytes } : {}),
        depthReached: r.depth_reached ?? 0, pagesSkipped: r.pages_skipped ?? 0, ...(r.deadline_at !== null ? { deadlineAt: iso(r.deadline_at) } : {}),
        frontier: { queued: jc.queued, running: jc.running, held: jc.held },
      };
    }
    return dto;
  }

  private controlsFor(state: DownloadState, kind: string, pauseReason?: PauseReason): DownloadDto["controls"] {
    const a = ACTIONS[state];
    return {
      pause: a.includes("pause"),
      // A pause the system made for the Human's good (full disk, offline) is not overridden by hand.
      resume: a.includes("resume") && pauseReason !== "volume_full" && pauseReason !== "offline",
      cancel: a.includes("cancel"),
      retry: a.includes("retry") && RETRYABLE_KINDS.has(kind),
      setPriority: a.includes("setPriority"),
    };
  }

  private estimate(r: Row, s: { state: DownloadState; pagesDone: number; bytesDone: number; discovered?: number; etaSeconds?: number; isCrawl: boolean; total: number }): DownloadEstimate | undefined {
    if (s.state === "completed" || s.state === "cancelled" || s.state === "failed") return undefined;
    if (s.isCrawl) {
      const maxPages = r.max_pages ?? undefined;
      const known = Math.max(s.pagesDone, s.discovered ?? 0);
      const high = Math.max(known, Math.min(maxPages ?? Infinity, Math.round(known * 1.5) + 5));
      const low = Math.min(known, high);
      const avg = s.pagesDone > 0 ? s.bytesDone / s.pagesDone : undefined;
      const confidence = s.pagesDone < 10 ? "low" : s.pagesDone < 50 ? "medium" : "high";
      const cap = r.max_bytes ?? Infinity;
      return {
        estimate: true, pages: { low, high },
        ...(avg !== undefined ? { bytes: { low: Math.round(Math.min(cap, avg * low * 0.8)), high: Math.round(Math.min(cap, avg * high * 1.25)) } } : {}),
        ...(s.etaSeconds !== undefined ? { durationSeconds: { low: Math.round(s.etaSeconds * 0.6), high: Math.round(s.etaSeconds * 1.6) } } : {}),
        basis: avg !== undefined ? `Extrapolated from the ${s.pagesDone.toLocaleString("en-GB")} pages saved so far, up to the limit of ${maxPages?.toLocaleString("en-GB") ?? "pages set"}` : "Not enough pages saved yet to estimate",
        confidence,
      };
    }
    if (r.kind === "refresh" && s.total > 0) {
      return { estimate: true, pages: { low: s.total, high: s.total }, basis: `${s.total.toLocaleString("en-GB")} saved pages to check`, confidence: "high" };
    }
    if (r.estimated_pages !== null || r.estimated_bytes !== null) {
      return {
        estimate: true,
        ...(r.estimated_pages !== null ? { pages: { low: Math.round(r.estimated_pages * 0.7), high: Math.round(r.estimated_pages * 1.4) } } : {}),
        ...(r.estimated_bytes !== null ? { bytes: { low: Math.round(r.estimated_bytes * 0.7), high: Math.round(r.estimated_bytes * 1.4) } } : {}),
        basis: "From the preview before the first run", confidence: "low",
      };
    }
    return undefined;
  }

  // ---- queries -------------------------------------------------------------------------------

  list(f: { state?: string[]; kind?: string[]; priority?: PriorityNumber; sourceId?: string; limit: number; cursor?: number }): { items: DownloadDto[]; nextCursor?: string; total: number } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const offlineSql = "(d.state = 'queued' AND EXISTS (SELECT 1 FROM jobs j WHERE j.download_job_id = d.id AND j.state = 'held') AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.download_job_id = d.id AND j.state IN ('queued','running')))";
    if (f.state?.length) {
      const parts: string[] = [];
      const plain = f.state.filter((s) => s !== "paused" && s !== "queued");
      if (plain.length) { parts.push(`d.state IN (${plain.map(() => "?").join(",")})`); args.push(...plain); }
      if (f.state.includes("paused")) parts.push(`(d.state = 'paused' OR ${offlineSql})`);
      if (f.state.includes("queued")) parts.push(`(d.state = 'queued' AND NOT ${offlineSql})`);
      where.push(`(${parts.join(" OR ")})`);
    }
    if (f.kind?.length) { where.push(`d.kind IN (${f.kind.map(() => "?").join(",")})`); args.push(...f.kind); }
    if (f.priority) { where.push("d.priority = ?"); args.push(f.priority); }
    if (f.sourceId) {
      const sid = this.d.sources.resolvePublicId(f.sourceId);
      where.push("d.source_id = ?"); args.push(sid);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = this.d.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM download_jobs d ${w}`, args)!.n;
    const cw = f.cursor ? `${w ? w + " AND" : "WHERE"} d.id < ?` : w;
    const rows = this.d.db.all<Row>(`${this.selectSql(cw)} ORDER BY d.id DESC LIMIT ?`, [...args, ...(f.cursor ? [f.cursor] : []), f.limit + 1]);
    const page = rows.slice(0, f.limit);
    return { items: this.toDtos(page, false), total, ...(rows.length > f.limit ? { nextCursor: String(page[page.length - 1]!.id) } : {}) };
  }

  private row(publicId: string): Row {
    const r = /^dl_[0-9A-HJKMNP-TV-Z]{26}$/.test(publicId) ? this.d.db.get<Row>(this.selectSql("WHERE d.public_id = ?"), [publicId]) : undefined;
    if (!r) throw new AppError("not_found", "That download does not exist.");
    return r;
  }

  get(publicId: string): DownloadDto {
    return this.toDtos([this.row(publicId)], true)[0]!;
  }

  log(publicId: string, o: { level?: string[]; limit: number; cursor?: number }) {
    const r = this.row(publicId);
    const where = ["a.download_job_id = ?"];
    const args: (string | number)[] = [r.id];
    if (o.level?.length) { where.push(`a.level IN (${o.level.map(() => "?").join(",")})`); args.push(...o.level); }
    if (o.cursor) { where.push("a.id < ?"); args.push(o.cursor); }
    const rows = this.d.db.all<{ id: number; at: number; level: string; area: string; message: string; details_json: string | null; job_id: number | null; version_id: number | null }>(
      `SELECT a.* FROM activity_log a WHERE ${where.join(" AND ")} ORDER BY a.id DESC LIMIT ?`, [...args, o.limit + 1]);
    const page = rows.slice(0, o.limit);
    return {
      items: page.map((x) => ({
        id: x.id, at: iso(x.at)!, level: x.level, area: x.area, message: x.message,
        ...(x.details_json ? { details: JSON.parse(x.details_json) as unknown } : {}), downloadJobId: publicId,
        ...(x.job_id !== null ? { jobId: String(x.job_id) } : {}), ...(x.version_id !== null ? { versionId: String(x.version_id) } : {}),
      })),
      ...(rows.length > o.limit ? { nextCursor: String(page[page.length - 1]!.id) } : {}),
    };
  }

  counts(): Record<DownloadState, number> {
    const out = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<DownloadState, number>;
    for (const r of this.d.db.all<{ state: DownloadState; n: number }>("SELECT state, COUNT(*) AS n FROM download_jobs GROUP BY state")) out[r.state] = r.n;
    // Offline holds count as paused, as the list shows them.
    const held = this.d.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM download_jobs d WHERE d.state = 'queued' AND EXISTS (SELECT 1 FROM jobs j WHERE j.download_job_id = d.id AND j.state = 'held')
         AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.download_job_id = d.id AND j.state IN ('queued','running'))`)!.n;
    out.queued -= held;
    out.paused += held;
    return out;
  }

  queueSummary() {
    const running = this.d.db.all<Row>(`${this.selectSql("WHERE d.state = 'running'")} ORDER BY d.priority, d.queue_order, d.id LIMIT 20`);
    const win = statusToApi(this.d.scheduler.isOpen(null, "schedule"));
    const next = this.d.schedules.nextScheduled();
    return {
      counts: this.counts(), running: this.toDtos(running, false), workers: this.d.workers(),
      window: { open: win.open, ...(win.opensAt ? { opensAt: win.opensAt } : {}), ...(win.closesAt ? { closesAt: win.closesAt } : {}) },
      limits: this.d.governor.limits(), throttle: this.d.governor.throttleStatus(), disk: this.d.governor.diskStatus(),
      connectivity: this.d.connectivity.snapshot().state, storageThrottle: { downloads: this.d.admission?.throttledCount() ?? 0 }, ...(next ? { nextScheduled: next } : {}),
    };
  }

  // ---- controls ------------------------------------------------------------------------------

  private assertAllowed(r: Row, action: DownloadAction, dtoState: DownloadState): void {
    if (!allowed(dtoState, action) || (action === "retry" && !RETRYABLE_KINDS.has(r.kind))) {
      const verb = { pause: "paused", resume: "resumed", cancel: "cancelled", retry: "retried", setPriority: "changed" }[action];
      const why = action === "retry" && allowed(dtoState, action)
        ? "A crawl cannot be retried. Start a new run from its source."
        : `A download that is ${dtoState} cannot be ${verb}.`;
      throw new AppError("conflict", why, { state: dtoState, action, allowed: ACTIONS[dtoState].filter((a) => a !== "retry" || RETRYABLE_KINDS.has(r.kind)) });
    }
  }

  private effectiveState(r: Row): DownloadState {
    return this.toDtos([r], false)[0]!.state;
  }

  pause(publicId: string): DownloadDto {
    const r = this.row(publicId);
    this.assertAllowed(r, "pause", this.effectiveState(r));
    this.pauseRow(r, false);
    this.log_(r, "Paused by you");
    return this.get(publicId);
  }

  private pauseRow(r: Row, byLimit: boolean): void {
    const { db, queue } = this.d;
    if (CRAWL_KINDS.has(r.kind) && r.crawl_id !== null) {
      this.d.crawl.pause(r.public_id);
      if (byLimit) db.run("UPDATE download_jobs SET paused_by_limit = 1 WHERE id = ?", [r.id]);
    } else {
      db.transaction(() => {
        db.run("UPDATE download_jobs SET state = 'paused', paused_by_limit = ? WHERE id = ? AND state IN ('queued','running')", [byLimit ? 1 : 0, r.id]);
        queue.holdByDownloadJob(r.id);
      });
    }
    this.touch(r.id);
  }

  resume(publicId: string): DownloadDto {
    const r = this.row(publicId);
    this.assertAllowed(r, "resume", this.effectiveState(r));
    const dto = this.get(publicId);
    if (!dto.controls.resume) throw new AppError("conflict", dto.pause?.message ?? "This download cannot be resumed by hand now.", { state: dto.state, action: "resume", reason: dto.pause?.reason });
    this.resumeRow(r);
    this.log_(r, "Resumed by you");
    return this.get(publicId);
  }

  private resumeRow(r: Row): void {
    const { db, queue } = this.d;
    if (CRAWL_KINDS.has(r.kind) && r.crawl_id !== null) {
      this.d.crawl.resume(r.public_id);
      db.run("UPDATE download_jobs SET paused_by_window = 0, paused_by_limit = 0 WHERE id = ?", [r.id]);
    } else {
      db.transaction(() => {
        db.run("UPDATE download_jobs SET state = 'queued', paused_by_window = 0, paused_by_limit = 0 WHERE id = ? AND state = 'paused'", [r.id]);
        queue.resumeByDownloadJob(r.id);
      });
    }
    this.touch(r.id);
  }

  cancel(publicId: string): DownloadDto {
    const r = this.row(publicId);
    this.assertAllowed(r, "cancel", this.effectiveState(r));
    const { db, queue, clock } = this.d;
    if (CRAWL_KINDS.has(r.kind) && r.crawl_id !== null) this.d.crawl.cancel(r.public_id);
    else {
      db.transaction(() => {
        queue.cancelByDownloadJob(r.id);
        db.run(
          "UPDATE download_jobs SET state = 'cancelled', failure_code = 'cancelled_by_user', failure_message = NULL, finished_at = ?, paused_by_window = 0, paused_by_limit = 0 WHERE id = ? AND state IN ('queued','running','paused')",
          [clock.now(), r.id]);
      });
    }
    this.log_(r, "Cancelled by you");
    this.d.events.publish("download", { downloadJobId: r.id, state: "cancelled" });
    this.touch(r.id);
    return this.get(publicId);
  }

  retry(publicId: string): DownloadDto {
    const r = this.row(publicId);
    this.assertAllowed(r, "retry", this.effectiveState(r));
    const { db, queue } = this.d;
    db.transaction(() => {
      db.run(
        "UPDATE download_jobs SET state = 'queued', failure_code = NULL, failure_message = NULL, finished_at = NULL, attempts = attempts + 1, pages_failed = 0 WHERE id = ? AND state = 'failed'", [r.id]);
      const bad = db.all<{ id: number; type: string }>("SELECT id, type FROM jobs WHERE download_job_id = ? AND state IN ('failed','dead')", [r.id]);
      for (const j of bad) queue.retry(j.id);
      if (r.kind === "capture") {
        // A capture that failed inside the pipeline: run the failed stage again.
        db.run(
          `UPDATE pipeline_stage_runs SET state = 'pending', attempts = 0 WHERE state = 'failed' AND version_id IN (SELECT id FROM page_versions WHERE download_job_id = ?)`, [r.id]);
        db.run("UPDATE page_versions SET status = 'capturing', failure_stage = NULL, failure_message = NULL WHERE download_job_id = ? AND status = 'failed'", [r.id]);
        const stored = db.get<{ id: number }>("SELECT id FROM page_versions WHERE download_job_id = ? AND status = 'capturing' ORDER BY id DESC LIMIT 1", [r.id]);
        const alive = db.get("SELECT 1 AS x FROM jobs WHERE download_job_id = ? AND state IN ('queued','running','held')", [r.id]);
        if (!alive && stored) {
          queue.enqueue({ type: "process", queue: "process", versionId: stored.id, downloadJobId: r.id, payload: { options: { priority: r.priority } }, idempotencyKey: `process:${stored.id}`, maxAttempts: 3, priority: 5 - r.priority });
        } else if (!alive && r.requested_url) {
          const host = new URL(r.requested_url).hostname.toLowerCase();
          queue.enqueue({
            type: "fetch", queue: "crawl", host, url: r.requested_url, downloadJobId: r.id, maxAttempts: 3, priority: 5 - r.priority,
            payload: { downloadJobId: r.id, url: r.requested_url, options: { priority: r.priority, requestedBy: r.requested_by, sourceId: r.source_id ?? undefined } },
          });
        }
      } else if (r.kind === "refresh") {
        this.d.refresh.resetAfterRetry(r.id);
      }
    });
    this.d.activity.write({ level: "info", area: "crawl", message: `Retry ${r.attempts + 1} started by you`, downloadJobId: r.id });
    this.touch(r.id);
    return this.get(publicId);
  }

  setPriority(publicId: string, patch: { priority?: PriorityNumber; queueOrder?: "top" | "bottom" | number }): DownloadDto {
    const r = this.row(publicId);
    this.assertAllowed(r, "setPriority", this.effectiveState(r));
    const { db } = this.d;
    db.transaction(() => {
      if (patch.priority !== undefined && patch.priority !== r.priority) {
        db.run("UPDATE download_jobs SET priority = ? WHERE id = ?", [patch.priority, r.id]);
        if (r.crawl_id !== null) this.d.crawl.setPriority(r.public_id, patch.priority);
        db.run(
          `UPDATE jobs SET priority = ?,
              payload_json = CASE WHEN json_type(payload_json, '$.options') IS NOT NULL THEN json_set(payload_json, '$.options.priority', ?) ELSE payload_json END
           WHERE download_job_id = ? AND state IN ('queued','held') AND crawl_job_id IS NULL`, [5 - patch.priority, patch.priority, r.id]);
        db.run("UPDATE jobs SET priority = ? WHERE download_job_id = ? AND state IN ('queued','held') AND crawl_job_id IS NOT NULL", [5 - patch.priority, r.id]);
      }
      if (patch.queueOrder !== undefined) {
        const pr = patch.priority ?? r.priority;
        const range = db.get<{ lo: number | null; hi: number | null }>(
          "SELECT MIN(queue_order) AS lo, MAX(queue_order) AS hi FROM download_jobs WHERE state IN ('queued','paused') AND priority = ? AND id <> ?", [pr, r.id])!;
        const order = patch.queueOrder === "top" ? (range.lo ?? 0) - 1 : patch.queueOrder === "bottom" ? (range.hi ?? 0) + 1 : patch.queueOrder;
        db.run("UPDATE download_jobs SET queue_order = ? WHERE id = ?", [order, r.id]);
        // Lower runs first: the claim takes the higher score first within a priority.
        db.run("UPDATE jobs SET score = ? WHERE download_job_id = ? AND state IN ('queued','held') AND crawl_job_id IS NULL", [-order, r.id]);
      }
    });
    this.d.activity.write({ level: "info", area: "crawl", message: "Priority or order changed by you", downloadJobId: r.id, details: patch });
    this.touch(r.id);
    return this.get(publicId);
  }

  private log_(r: Row, message: string): void {
    this.d.activity.write({ level: "info", area: "crawl", message, downloadJobId: r.id });
    this.touch(r.id);
  }

  // ---- creating ------------------------------------------------------------------------------

  async create(body: {
    kind: string; url?: string; sourceId?: string; priority?: PriorityNumber; config?: unknown; asCollection?: unknown;
  }, idem?: string): Promise<{ download: DownloadDto; replay: boolean }> {
    const { db, clock } = this.d;
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    if (idem) {
      db.run("DELETE FROM idempotency_keys WHERE created_at < ?", [clock.now() - 24 * 3600_000]);
      const hit = db.get<{ request_hash: string; public_id: string }>(
        "SELECT k.request_hash, d.public_id FROM idempotency_keys k JOIN download_jobs d ON d.id = k.download_job_id WHERE k.key = ?", [idem]);
      if (hit) {
        if (hit.request_hash !== hash) throw new AppError("conflict", "That Idempotency-Key was already used for a different request.");
        return { download: this.get(hit.public_id), replay: true };
      }
    }
    const created = await this.createNew(body);
    if (idem) {
      const id = db.get<{ id: number }>("SELECT id FROM download_jobs WHERE public_id = ?", [created.id])!.id;
      db.run("INSERT OR IGNORE INTO idempotency_keys (key, request_hash, download_job_id, created_at) VALUES (?, ?, ?, ?)", [idem, hash, id, clock.now()]);
    }
    return { download: this.get(created.id), replay: false };
  }

  private async createNew(body: { kind: string; url?: string; sourceId?: string; priority?: PriorityNumber; config?: unknown; asCollection?: unknown }): Promise<{ id: string }> {
    const fail = (path: string, message: string) => new AppError("bad_request", message, { fields: [{ in: "body", path, message }] });
    if (!(KINDS as readonly string[]).includes(body.kind)) throw fail("kind", "Choose capture, explore, mirror or refresh.");
    if (body.asCollection) throw new AppError("not_implemented", "Saving the result straight into a new collection is not available yet. Create the collection and add the pages afterwards.");
    const priority = (body.priority ?? 3) as PriorityNumber;
    switch (body.kind) {
      case "capture": {
        if (body.sourceId && !body.url) return { id: (await this.d.sources.run(body.sourceId, { requestedBy: "user" })).downloadIds[0]! };
        if (!body.url) throw fail("url", "Enter the address to save.");
        const r = this.d.pipeline.captureUrl(body.url, { priority, requestedBy: "user", userInitiated: true, sourceId: body.sourceId ? this.d.sources.resolvePublicId(body.sourceId) : undefined, force: false });
        if (this.d.connectivity.snapshot().state === "offline") this.d.pipeline.holdCapture(r.downloadId);
        return { id: r.downloadId };
      }
      case "explore":
      case "mirror": {
        if (body.sourceId && !body.url) return { id: (await this.d.sources.run(body.sourceId, { requestedBy: "user" })).downloadIds[0]! };
        if (!body.url) throw fail("url", "Enter the address to start from.");
        const cfg = this.d.buildCrawl({ url: body.url, mode: body.kind as "explore" | "mirror", priority, config: body.config });
        return { id: this.d.crawl.startCrawl(cfg).downloadId };
      }
      case "refresh": {
        if (!body.sourceId) throw fail("sourceId", "Choose the source to check.");
        const out = await this.d.refresh.refreshSource(this.d.sources.resolvePublicId(body.sourceId), { requestedBy: "user" });
        return { id: out.downloadId };
      }
      default:
        throw new AppError("not_implemented", `Downloads of this kind (${body.kind}) arrive in a later release.`);
    }
  }

  // ---- limits: the disk guard's hands --------------------------------------------------------

  /** Downloads that count as background work: everything except a single page the Human saved. */
  private backgroundWhere = "NOT (d.kind = 'capture' AND d.requested_by = 'user')";

  pauseForLimit(): number {
    const rows = this.d.db.all<Row>(`${this.selectSql(`WHERE d.state IN ('queued','running') AND ${this.backgroundWhere}`)}`);
    let n = 0;
    for (const r of rows) {
      this.pauseRow(r, true);
      n++;
    }
    return n;
  }

  resumeFromLimit(): number {
    const rows = this.d.db.all<Row>(this.selectSql("WHERE d.state = 'paused' AND d.paused_by_limit = 1"));
    for (const r of rows) this.resumeRow(r);
    return rows.length;
  }

  countPausedByLimit(): number {
    return this.d.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM download_jobs WHERE state = 'paused' AND paused_by_limit = 1")!.n;
  }

  // ---- repair --------------------------------------------------------------------------------

  /**
   * Closes captures whose work all ended without the download being closed (a worker died with attempts used up, or a crash
   * left it half way), and lets the refresh service close refresh downloads. A held or waiting job keeps its download open.
   */
  sweep(): number {
    const { db, clock } = this.d;
    let n = 0;
    const open = db.all<{ id: number; kind: string }>(
      "SELECT id, kind FROM download_jobs WHERE state IN ('queued','running') AND kind = 'capture'");
    const counts = this.jobCounts(open.map((o) => o.id));
    for (const o of open) {
      const c = counts.get(o.id);
      if (!c || c.total === 0 || c.queued + c.running + c.held > 0) continue;
      if (c.bad > 0) {
        const last = db.get<{ last_error: string | null }>("SELECT last_error FROM jobs WHERE download_job_id = ? AND state IN ('failed','dead') ORDER BY id DESC LIMIT 1", [o.id]);
        db.run("UPDATE download_jobs SET state = 'failed', failure_code = 'internal', failure_message = ?, pages_failed = 1, finished_at = ? WHERE id = ? AND state IN ('queued','running')",
          [(last?.last_error ?? "The work stopped before it finished.").slice(0, 500), clock.now(), o.id]);
        n++;
      } else if (c.cancelled === c.total) {
        db.run("UPDATE download_jobs SET state = 'cancelled', failure_code = 'cancelled_by_user', finished_at = ? WHERE id = ? AND state IN ('queued','running')", [clock.now(), o.id]);
        n++;
      }
      this.touch(o.id);
    }
    n += this.d.refresh.sweep();
    // Catches endings that published no event (a failure inside a pipeline stage, a crash repaired at start).
    this.d.sources.reconcileStatuses();
    return n;
  }

  /** Tells the Human how to read a priority. */
  static priorityOf(v: unknown): PriorityNumber | undefined {
    return parsePriority(v);
  }
}

export { newId };
