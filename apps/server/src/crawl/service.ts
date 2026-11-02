import {
  crawlUrl, rankLinks, resolveCrawlConfig, Scope, selectLinks, TrapGuard, validateCrawlConfig, type CrawlConfig, type LinkCandidate, type LinkRegion,
  type StopReason,
} from "@ncb/crawl";
import { backoffDelayMs, type Db, type Job, type JobQueue } from "@ncb/db";
import { FetchError, type RobotsService } from "@ncb/fetch";
import type { Clock } from "@ncb/shared";
import { AppError, newId } from "@ncb/shared";
import { PermanentJobError } from "../runtime/protocol.js";
import { RetryJobLater, RobotsBlocked, type FetchStoreOutcome, type MainHandler, type PipelineService } from "../pipeline/service.js";
import { DEFAULT_CAPS, type CaptureOptions } from "../pipeline/types.js";
import type { ActivityLog } from "../services/activity.js";
import type { EventBus } from "../services/events.js";
import { DbTrapStore, tallySkip } from "./store.js";

export interface CrawlServiceDeps {
  db: Db;
  clock: Clock;
  queue: JobQueue;
  activity: ActivityLog;
  events: EventBus;
  pipeline: PipelineService;
  robots?: Pick<RobotsService, "check">;
  log?: { warn(o: unknown, m?: string): void };
}

export interface CrawlStart {
  downloadId: string;
  downloadJobId: number;
  /** Null for `capture` mode, which has no crawl row. */
  crawlJobId: number | null;
  mode: CrawlConfig["mode"];
  jobIds: number[];
}

export interface CrawlStatus {
  crawlJobId: number;
  downloadId: string;
  downloadJobId: number;
  sourceId: number | null;
  mode: string;
  profile: string;
  state: "running" | "paused" | "completed" | "cancelled" | "failed" | "queued";
  stopReason: StopReason | null;
  pagesDiscovered: number;
  pagesFetched: number;
  pagesFailed: number;
  pagesSkipped: number;
  bytesFetched: number;
  depthReached: number;
  startedAt: number | null;
  finishedAt: number | null;
  skips: Record<string, number>;
  followed: Record<string, number>;
  frontier: { queued: number; running: number; held: number; done: number; other: number };
}

interface FrontierPayload {
  crawl: true;
  externalDepth: number;
  /** External depth of the page this link was found on (for judging redirects). */
  parentExternalDepth: number;
  via?: unknown;
  done?: 1;
  aliasOf?: number;
}

interface CrawlRow {
  id: number;
  download_job_id: number;
  source_id: number | null;
  config_id: number | null;
  mode: string;
  max_pages: number | null;
  max_bytes: number | null;
  deadline_at: number | null;
  pages_discovered: number;
  pages_fetched: number;
  pages_failed: number;
  pages_skipped: number;
  bytes_fetched: number;
  depth_reached: number;
  stop_reason: StopReason | null;
  started_at: number | null;
  paused_at: number | null;
  finished_at: number | null;
  config_json: string;
  dstate: string;
  public_id: string;
}

interface Loaded {
  row: CrawlRow;
  config: CrawlConfig;
  scope: Scope;
  guard: TrapGuard;
}

/** Raised from the per-hop hook when a redirect leaves the crawl's scope. */
class OutOfScopeRedirect extends Error {
  constructor(readonly reason: string, url: string) {
    super(`The redirect to ${url} is outside the crawl scope (${reason}).`);
  }
}

/** robots.txt could not be fetched and the rules say wait. */
class RobotsUnreachable extends Error {}

const causedBy = <T extends Error>(e: unknown, C: new (...a: never[]) => T): T | undefined => {
  for (let x: unknown = e, i = 0; x && i < 4; x = (x as { cause?: unknown }).cause, i++) if (x instanceof C) return x;
  return undefined;
};

const hostOf = (u: string) => new URL(u).hostname.toLowerCase();
const SEED_SCORE = 1000;

/**
 * The crawl engine (tasks C-01 to C-05). `startCrawl` creates the rows; the `fetch` jobs it enqueues are claimed by the
 * job runner (per-host politeness comes from the queue claim) and run `handleFetch`, which captures the page with the
 * normal pipeline and then turns its stored links into new frontier rows through the scope, priority and trap rules.
 */
export class CrawlService {
  private readonly cache = new Map<number, Loaded>();
  private readonly aborts = new Map<number, Set<AbortController>>();
  private sweeper?: NodeJS.Timeout;

  constructor(private readonly d: CrawlServiceDeps) {}

  /** Main-thread handlers for the runner: frontier `fetch` jobs go to the engine, plain captures to the pipeline. */
  mainHandlers(base: Record<string, MainHandler>): Record<string, MainHandler> {
    return {
      ...base,
      fetch: (job, ctx) => (job.crawlJobId != null ? this.handleFetch(job, ctx.signal) : base.fetch!(job, ctx)),
    };
  }

  /** Finishes crawls whose last job ended while the process was down, and watches deadlines. Call once after startup. */
  start(intervalMs = 1000): void {
    this.recover();
    this.sweeper = setInterval(() => {
      try {
        this.sweep();
      } catch (e) {
        this.d.log?.warn({ err: String(e) }, "crawl sweep failed");
      }
    }, intervalMs);
    this.sweeper.unref();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  // ---- commands ------------------------------------------------------------------------------

  startCrawl(config: CrawlConfig): CrawlStart {
    const issues = validateCrawlConfig(config);
    if (config.startUrls.length === 0) issues.push({ path: "startUrls", message: "Add at least one start address." });
    if (config.mode === "capture" && config.startUrls.length !== 1) issues.push({ path: "startUrls", message: "Capture saves exactly one page." });
    if (issues.length) {
      throw new AppError("bad_request", "That crawl is not valid.", { fields: issues.map((i) => ({ in: "body", path: i.path, message: i.message })) });
    }
    const priority = config.priority ?? 3;
    if (config.mode === "capture") {
      const r = this.d.pipeline.captureUrl(config.startUrls[0]!, {
        priority, requestedBy: config.requestedBy ?? "user", sourceId: config.sourceId, caps: config.capture?.caps,
        versioning: config.capture?.versioning as CaptureOptions["versioning"], userInitiated: false,
      });
      const dl = this.d.db.get<{ id: number }>("SELECT id FROM download_jobs WHERE public_id = ?", [r.downloadId])!;
      return { downloadId: r.downloadId, downloadJobId: dl.id, crawlJobId: null, mode: "capture", jobIds: [r.jobId] };
    }

    const seeds: { url: string; key: string; host: string }[] = [];
    for (const [i, u] of config.startUrls.entries()) {
      const c = crawlUrl(u, config.query);
      if (!c) throw new AppError("bad_request", "That is not a web address the archive can crawl.", { fields: [{ in: "body", path: `startUrls.${i}`, message: "That is not a web address." }] });
      if (!seeds.some((s) => s.key === c.key)) seeds.push({ url: c.fetchUrl, key: c.key, host: c.host });
    }
    const { db, clock, queue } = this.d;
    const out = db.transaction(() => {
      const now = clock.now();
      const publicId = newId("dl");
      const dl = db.run(
        `INSERT INTO download_jobs (public_id, source_id, config_id, kind, state, priority, requested_url, requested_by, started_at, created_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
        [publicId, config.sourceId ?? null, config.configId ?? null, config.mode, priority, seeds[0]!.url, config.requestedBy ?? "user", now, now],
      );
      const downloadJobId = Number(dl.lastInsertRowid);
      const cj = db.run(
        `INSERT INTO crawl_jobs (download_job_id, source_id, config_id, mode, max_depth, max_pages, max_bytes, deadline_at, max_duration_ms, started_at,
                                 seed_urls_json, config_json, pages_discovered)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          downloadJobId, config.sourceId ?? null, config.configId ?? null, config.mode, config.scope.maxDepth, config.limits.maxPages, config.limits.maxBytes,
          now + config.limits.maxDurationMs, config.limits.maxDurationMs, now, JSON.stringify(seeds.map((s) => s.url)), JSON.stringify(config), seeds.length,
        ],
      );
      const crawlJobId = Number(cj.lastInsertRowid);
      const jobIds: number[] = [];
      for (const s of seeds) {
        this.ensureHost(s.host, config);
        const payload: FrontierPayload = { crawl: true, externalDepth: 0, parentExternalDepth: 0 };
        const q = queue.enqueue({
          type: "fetch", queue: "crawl", host: s.host, url: s.url, urlKey: s.key, downloadJobId, crawlJobId, depth: 0, score: SEED_SCORE,
          priority: 5 - priority, payload, maxAttempts: 4,
        });
        jobIds.push(q.id);
        new DbTrapStore(db, crawlJobId).add("host_enq", new URL(s.url).host, 1); // start URLs use the host budget too
      }
      return { downloadId: publicId, downloadJobId, crawlJobId, mode: config.mode, jobIds };
    });
    this.d.activity.write({
      level: "info", area: "crawl", message: `Crawl started (${config.mode}, ${config.profile}) from ${seeds[0]!.url}`, downloadJobId: out.downloadJobId,
      details: { crawlJobId: out.crawlJobId, startUrls: seeds.map((s) => s.url), limits: config.limits, maxDepth: config.scope.maxDepth, resource: config.resource, sourceId: config.sourceId },
    });
    this.publish(out.crawlJobId);
    return out;
  }

  pause(id: string | number): boolean {
    const row = this.row(id);
    if (!row || row.finished_at !== null || row.dstate !== "running") return row?.dstate === "paused";
    const { db, clock, queue } = this.d;
    db.transaction(() => {
      db.run("UPDATE download_jobs SET state = 'paused' WHERE id = ? AND state = 'running'", [row.download_job_id]);
      db.run("UPDATE crawl_jobs SET paused_at = ? WHERE id = ?", [clock.now(), row.id]);
      queue.holdByDownloadJob(row.download_job_id);
    });
    this.d.activity.write({ level: "info", area: "crawl", message: "Crawl paused", downloadJobId: row.download_job_id });
    this.publish(row.id);
    return true;
  }

  resume(id: string | number): boolean {
    const row = this.row(id);
    if (!row || row.finished_at !== null) return false;
    if (row.dstate !== "paused") return row.dstate === "running";
    const { db, clock, queue } = this.d;
    db.transaction(() => {
      const now = clock.now();
      const pausedFor = row.paused_at === null ? 0 : Math.max(0, now - row.paused_at);
      db.run("UPDATE download_jobs SET state = 'running' WHERE id = ? AND state = 'paused'", [row.download_job_id]);
      db.run("UPDATE crawl_jobs SET paused_at = NULL, deadline_at = CASE WHEN deadline_at IS NULL THEN NULL ELSE deadline_at + ? END WHERE id = ?", [pausedFor, row.id]);
      queue.resumeByDownloadJob(row.download_job_id);
    });
    this.d.activity.write({ level: "info", area: "crawl", message: "Crawl resumed", downloadJobId: row.download_job_id });
    this.publish(row.id);
    return true;
  }

  cancel(id: string | number): boolean {
    const row = this.row(id);
    if (!row || row.finished_at !== null) return false;
    for (const c of this.aborts.get(row.id) ?? []) c.abort();
    this.finish(row.id, "cancelled", { cancelAll: true });
    return true;
  }

  // ---- queries -------------------------------------------------------------------------------

  get(id: string | number): CrawlStatus | undefined {
    const row = this.row(id);
    return row ? this.status(row) : undefined;
  }

  list(filter: { sourceId?: number; state?: CrawlStatus["state"] } = {}): CrawlStatus[] {
    const rows = this.d.db.all<{ id: number }>("SELECT id FROM crawl_jobs ORDER BY id DESC").map((r) => this.row(r.id)!);
    return rows
      .map((r) => this.status(r))
      .filter((s) => (filter.sourceId === undefined || s.sourceId === filter.sourceId) && (filter.state === undefined || s.state === filter.state));
  }

  // ---- internals: loading --------------------------------------------------------------------

  private row(id: string | number): CrawlRow | undefined {
    const where = typeof id === "number" ? "cj.id = ?" : "dj.public_id = ?";
    return this.d.db.get<CrawlRow>(
      `SELECT cj.*, dj.state AS dstate, dj.public_id AS public_id FROM crawl_jobs cj JOIN download_jobs dj ON dj.id = cj.download_job_id WHERE ${where}`, [id]);
  }

  private load(crawlJobId: number): Loaded | undefined {
    const row = this.row(crawlJobId);
    if (!row) return undefined;
    let l = this.cache.get(crawlJobId);
    if (!l) {
      const config = JSON.parse(row.config_json) as CrawlConfig;
      l = { row, config, scope: new Scope(config.scope, config.query, config.startUrls), guard: new TrapGuard(config.traps, new DbTrapStore(this.d.db, crawlJobId)) };
      this.cache.set(crawlJobId, l);
    }
    l.row = row;
    return l;
  }

  private status(r: CrawlRow): CrawlStatus {
    const { db } = this.d;
    const skips: Record<string, number> = {};
    for (const s of db.all<{ reason: string; count: number }>("SELECT reason, count FROM crawl_skips WHERE crawl_job_id = ? ORDER BY reason", [r.id])) skips[s.reason] = s.count;
    const followed: Record<string, number> = {};
    for (const s of db.all<{ key: string; value: number }>("SELECT key, value FROM crawl_counters WHERE crawl_job_id = ? AND kind = 'follow' ORDER BY key", [r.id])) followed[s.key] = s.value;
    const frontier = { queued: 0, running: 0, held: 0, done: 0, other: 0 };
    for (const s of db.all<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM jobs WHERE crawl_job_id = ? GROUP BY state", [r.id])) {
      if (s.state === "queued" || s.state === "running" || s.state === "held" || s.state === "done") frontier[s.state] = s.n;
      else frontier.other += s.n;
    }
    const config = JSON.parse(r.config_json) as Partial<CrawlConfig>;
    return {
      crawlJobId: r.id, downloadId: r.public_id, downloadJobId: r.download_job_id, sourceId: r.source_id, mode: r.mode, profile: config.profile ?? "custom",
      state: r.dstate as CrawlStatus["state"], stopReason: r.stop_reason, pagesDiscovered: r.pages_discovered, pagesFetched: r.pages_fetched,
      pagesFailed: r.pages_failed, pagesSkipped: r.pages_skipped, bytesFetched: r.bytes_fetched, depthReached: r.depth_reached, startedAt: r.started_at,
      finishedAt: r.finished_at, skips, followed, frontier,
    };
  }

  private publish(crawlJobId: number): void {
    const r = this.row(crawlJobId);
    if (!r) return;
    this.d.events.publish("crawl", {
      crawlJobId: r.id, downloadId: r.public_id, state: r.dstate, stopReason: r.stop_reason, pagesFetched: r.pages_fetched,
      pagesDiscovered: r.pages_discovered, pagesFailed: r.pages_failed,
    });
  }

  // ---- internals: lifecycle ------------------------------------------------------------------

  /** Ends a crawl: records the reason, completes (or cancels) the download job and drops the waiting frontier. */
  private finish(crawlJobId: number, reason: StopReason, o: { cancelAll?: boolean } = {}): boolean {
    const { db, clock, queue } = this.d;
    const row = this.row(crawlJobId);
    if (!row || row.finished_at !== null) return false;
    const now = clock.now();
    db.transaction(() => {
      db.run("UPDATE crawl_jobs SET stop_reason = ?, finished_at = ?, paused_at = NULL WHERE id = ? AND finished_at IS NULL", [reason, now, crawlJobId]);
      db.run(
        "UPDATE download_jobs SET state = ?, finished_at = ?, pages_done = ?, pages_failed = ?, bytes_done = ? WHERE id = ?",
        [reason === "cancelled" ? "cancelled" : "completed", now, row.pages_fetched, row.pages_failed, row.bytes_fetched, row.download_job_id],
      );
      if (o.cancelAll) queue.cancelByDownloadJob(row.download_job_id);
      else db.run("UPDATE jobs SET state = 'cancelled', finished_at = ? WHERE crawl_job_id = ? AND state IN ('queued','held')", [Date.now(), crawlJobId]);
    });
    const fresh = this.row(crawlJobId)!;
    this.cache.delete(crawlJobId);
    this.aborts.delete(crawlJobId);
    this.d.activity.write({
      level: reason === "cancelled" ? "warn" : "info", area: "crawl", downloadJobId: row.download_job_id,
      message: `Crawl ${reason === "cancelled" ? "cancelled" : "finished"}: ${reason}. ${fresh.pages_fetched} pages fetched, ${fresh.pages_failed} failed`,
      details: { crawlJobId, stopReason: reason, pagesFetched: fresh.pages_fetched, pagesFailed: fresh.pages_failed, pagesDiscovered: fresh.pages_discovered, bytesFetched: fresh.bytes_fetched },
    });
    this.publish(crawlJobId);
    return true;
  }

  /** Finishes the crawl when nothing is left to do. Safe to call at any time. */
  maybeFinish(crawlJobId: number): void {
    const row = this.row(crawlJobId);
    if (!row || row.finished_at !== null || row.dstate !== "running") return;
    const open = this.d.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE crawl_job_id = ? AND state IN ('queued','running','held')", [crawlJobId])!.n;
    if (open > 0) return;
    const depthLimited = this.d.db.get<{ value: number }>("SELECT value FROM crawl_counters WHERE crawl_job_id = ? AND kind = 'flag' AND key = 'depth_limited'", [crawlJobId])?.value ?? 0;
    this.finish(crawlJobId, depthLimited > 0 ? "max_depth" : "completed");
  }

  /** Startup recovery: a crawl whose last job finished just before a crash has nothing left to wake it. */
  recover(): void {
    for (const r of this.d.db.all<{ id: number }>("SELECT id FROM crawl_jobs WHERE finished_at IS NULL")) this.maybeFinish(r.id);
  }

  /** Deadlines for crawls that have no job running (everything waiting out a back-off or delay), and the finish safety net. */
  sweep(): void {
    const now = this.d.clock.now();
    for (const r of this.d.db.all<{ id: number; deadline_at: number | null; dstate: string }>(
      "SELECT cj.id, cj.deadline_at, dj.state AS dstate FROM crawl_jobs cj JOIN download_jobs dj ON dj.id = cj.download_job_id WHERE cj.finished_at IS NULL")) {
      if (r.dstate === "running" && r.deadline_at !== null && now >= r.deadline_at) this.finish(r.id, "deadline");
      else this.maybeFinish(r.id);
    }
  }

  private ensureHost(host: string, config: CrawlConfig, robotsDelayMs = 0): void {
    const delay = Math.max(config.politeness.minDelayMs, robotsDelayMs);
    this.d.db.run(
      `INSERT INTO host_state (host, crawl_delay_ms, max_concurrent) VALUES (?, ?, ?)
       ON CONFLICT (host) DO UPDATE SET crawl_delay_ms = MAX(crawl_delay_ms, excluded.crawl_delay_ms), max_concurrent = MAX(max_concurrent, excluded.max_concurrent)`,
      [host, delay, config.politeness.perHostConcurrency],
    );
  }

  // ---- internals: the frontier job -----------------------------------------------------------

  private async handleFetch(job: Job, runnerSignal: AbortSignal): Promise<void> {
    const crawlId = job.crawlJobId!;
    try {
      await this.fetchOne(job, runnerSignal);
    } finally {
      // After the runner has settled this job (microtasks done), see whether the crawl is over.
      setImmediate(() => {
        try {
          this.maybeFinish(crawlId);
        } catch (e) {
          this.d.log?.warn({ err: String(e) }, "crawl finish check failed");
        }
      });
    }
  }

  private checkLimits(c: Loaded, job: Job): "ok" | "stopped" | "deferred" {
    const r = c.row;
    if (r.finished_at !== null) return "stopped";
    if (r.deadline_at !== null && this.d.clock.now() >= r.deadline_at) {
      this.finish(r.id, "deadline");
      return "stopped";
    }
    if (r.max_bytes !== null && r.bytes_fetched >= r.max_bytes) {
      this.finish(r.id, "max_bytes");
      return "stopped";
    }
    if (r.max_pages !== null) {
      const others = this.d.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE crawl_job_id = ? AND state = 'running' AND id <> ?", [r.id, job.id])!.n;
      if (r.pages_fetched + others >= r.max_pages) {
        if (others === 0) {
          this.finish(r.id, "max_pages");
          return "stopped";
        }
        // Pages in flight may still fail; wait for them rather than overshoot.
        this.d.queue.release(job.id, "main");
        this.d.db.run("UPDATE jobs SET run_at = run_at + 200 WHERE id = ?", [job.id]);
        return "deferred";
      }
    }
    return "ok";
  }

  private captureOptions(c: Loaded, job?: Job): CaptureOptions {
    const cfg = c.config;
    const remaining = Math.max(64 * 1024, cfg.limits.maxBytes - c.row.bytes_fetched);
    const caps = { ...(cfg.capture?.caps ?? {}), assetConcurrency: cfg.politeness.assetConcurrency } as Record<string, number>;
    caps.maxDocumentBytes = Math.min(caps.maxDocumentBytes ?? DEFAULT_CAPS.maxDocumentBytes, remaining);
    caps.maxTotalAssetBytes = Math.min(caps.maxTotalAssetBytes ?? DEFAULT_CAPS.maxTotalAssetBytes, remaining);
    return {
      priority: cfg.priority ?? 3, versioning: cfg.capture?.versioning as CaptureOptions["versioning"], caps,
      requestedBy: cfg.requestedBy ?? "user", sourceId: cfg.sourceId, userInitiated: false,
      // Recorded on the source reference (page_sources) by the pipeline.
      discoveredVia: job && job.depth > 0 ? "link" : "seed", depth: job?.depth ?? 0,
    };
  }

  /** robots.txt and scope for every request, including redirect hops. No bypass exists on this path. */
  private async beforeHop(c: Loaded, job: Job, payload: FrontierPayload, url: string): Promise<void> {
    if (url !== job.url) {
      const d = c.scope.evaluate(url, { depth: job.depth - 1, externalDepth: payload.parentExternalDepth });
      if (!d.allow && d.reason !== "scope:depth") throw new OutOfScopeRedirect(d.reason, url);
    }
    const host = hostOf(url);
    if (this.d.robots) {
      const dec = await this.d.robots.check(url, { bypass: false });
      if (!dec.allowed) {
        if (dec.reason === "robots_unreachable_disallow") throw new RobotsUnreachable(`robots.txt for ${host} could not be fetched; waiting before trying again.`);
        throw new RobotsBlocked(`robots.txt does not allow ${url} (${dec.reason}).`);
      }
      this.ensureHost(host, c.config, dec.crawlDelayMs ?? 0);
    } else this.ensureHost(host, c.config);
  }

  private async fetchOne(job: Job, runnerSignal: AbortSignal): Promise<void> {
    const { db, queue } = this.d;
    const c = this.load(job.crawlJobId!);
    if (!c || c.row.finished_at !== null || job.url === null) return;
    const payload = job.payload as FrontierPayload;
    if (payload.done) return;
    const limit = this.checkLimits(c, job);
    if (limit !== "ok") return;
    // Queued before its family was found to be a duplicate-content trap.
    if (c.guard.isBlocked(job.url)) return this.recordSkip(c, job, "trap:duplicate_content");

    const ctrl = new AbortController();
    let set = this.aborts.get(c.row.id);
    if (!set) this.aborts.set(c.row.id, (set = new Set()));
    set.add(ctrl);
    const signal = AbortSignal.any([runnerSignal, ctrl.signal]);
    const last = job.attempts >= job.maxAttempts;
    const opts = this.captureOptions(c, job);
    try {
      // A previous run may have stored the document and died before the stages finished: pick that version up.
      const pending = db.get<{ id: number; final_url: string; http_status: number; raw_bytes: number }>(
        "SELECT id, final_url, http_status, raw_bytes FROM page_versions WHERE download_job_id = ? AND requested_url = ? AND status = 'capturing' ORDER BY id DESC LIMIT 1",
        [c.row.download_job_id, job.url]);
      let out: FetchStoreOutcome;
      if (pending) out = { kind: "stored", versionId: pending.id, status: pending.http_status, finalUrl: pending.final_url, rawBytes: pending.raw_bytes, redirects: 0 };
      else {
        out = await this.d.pipeline.fetchForCrawl({
          downloadJobId: c.row.download_job_id, url: job.url, options: opts, signal, beforeHop: (u) => this.beforeHop(c, job, payload, u),
        });
      }
      if (out.kind === "http_error") {
        if (out.status >= 500 && !last) {
          const wait = out.retryAfterMs ?? backoffDelayMs(job.attempts);
          throw new RetryJobLater(`The server answered ${out.status}.`, wait, wait);
        }
        this.recordFailure(c, job, `The server answered ${out.status}.`, out.status >= 500 ? "http_5xx" : "http_4xx");
        return;
      }
      this.tombstoneFinalUrl(c, job, out.finalUrl);

      let linkVersion: number | null = null;
      let added = 0;
      let dup = false;
      if (out.kind === "stored") {
        const run = await this.d.pipeline.runVersion(out.versionId, opts, signal);
        if (run.kind === "failed") {
          this.recordFailure(c, job, `Stage ${run.stage} failed: ${run.message}`, "parse_error");
          return;
        }
        if (run.kind === "done") {
          linkVersion = out.versionId;
          const v = db.get<{ bytes: number; dup: number }>(
            `SELECT COALESCE(raw_bytes, 0) + COALESCE(total_bytes, 0) AS bytes,
                    (duplicate_of_version_id IS NOT NULL OR EXISTS (SELECT 1 FROM page_versions o WHERE o.download_job_id = page_versions.download_job_id
                       AND o.content_hash = page_versions.content_hash AND o.id <> page_versions.id AND o.status IN ('ready','partial'))) AS dup
             FROM page_versions WHERE id = ?`, [out.versionId])!;
          added = v.bytes;
          dup = v.dup === 1;
        } else {
          // The new version was dropped as a repeat of the page's latest content.
          linkVersion = this.d.pipeline.findPageByUrl(out.finalUrl)?.latestVersionId ?? null;
          dup = this.versionBelongsToCrawl(linkVersion, c);
        }
      } else {
        linkVersion = out.versionId;
        dup = this.versionBelongsToCrawl(linkVersion, c);
      }
      this.completePage(c, job, payload, linkVersion, added, dup);
    } catch (e) {
      if (runnerSignal.aborted) throw e; // shutdown: the runner puts the job back
      if (ctrl.signal.aborted) return; // cancelled
      await this.handleError(c, job, e, last);
    } finally {
      set.delete(ctrl);
    }
  }

  private versionBelongsToCrawl(versionId: number | null, c: Loaded): boolean {
    if (versionId === null) return false;
    return this.d.db.get<{ download_job_id: number | null }>("SELECT download_job_id FROM page_versions WHERE id = ?", [versionId])?.download_job_id === c.row.download_job_id;
  }

  /** Marks the URL a redirect landed on as visited, so the target is not fetched again under its own name. */
  private tombstoneFinalUrl(c: Loaded, job: Job, finalUrl: string): void {
    const fk = crawlUrl(finalUrl, c.config.query);
    if (!fk || fk.key === job.urlKey) return;
    this.d.db.run(
      `INSERT OR IGNORE INTO jobs (type, queue, state, host, url, url_key, download_job_id, crawl_job_id, depth, payload_json, created_at, finished_at)
       VALUES ('fetch', 'crawl', 'done', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fk.host, fk.fetchUrl, fk.key, c.row.download_job_id, c.row.id, job.depth, JSON.stringify({ crawl: true, done: 1, aliasOf: job.id }), Date.now(), Date.now()],
    );
  }

  private async handleError(c: Loaded, job: Job, e: unknown, last: boolean): Promise<void> {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof RetryJobLater) {
      if (last) return this.recordFailure(c, job, msg, "network");
      throw e;
    }
    const robots = causedBy(e, RobotsBlocked);
    if (robots) return this.recordSkip(c, job, "robots");
    const unreachable = causedBy(e, RobotsUnreachable);
    if (unreachable) {
      if (last) return this.recordFailure(c, job, unreachable.message, "network");
      const wait = backoffDelayMs(job.attempts, { baseMs: 5_000 });
      throw new RetryJobLater(unreachable.message, wait, wait);
    }
    const scope = causedBy(e, OutOfScopeRedirect);
    if (scope) return this.recordSkip(c, job, scope.reason === "scope:external" ? "scope:redirect_external" : scope.reason);
    const fe = causedBy(e, FetchError);
    if (fe) {
      switch (fe.code) {
        case "redirect_loop":
        case "too_many_redirects":
          return this.recordSkip(c, job, "trap:redirect_loop");
        case "ssrf_blocked":
          return this.recordSkip(c, job, "scope:ssrf");
        case "content_type_blocked":
          return this.recordSkip(c, job, "filter:content_type");
        case "size_cap":
        case "content_length_exceeded":
          return this.recordSkip(c, job, "filter:size_cap");
        case "bad_redirect":
        case "invalid_url":
          return this.recordFailure(c, job, msg, "network");
        case "rate_limited": {
          if (last) return this.recordFailure(c, job, msg, "network");
          const wait = fe.retryAfterMs ?? backoffDelayMs(job.attempts, { baseMs: 2_000 });
          throw new RetryJobLater(msg, wait, wait);
        }
        case "offline":
          if (last) return this.recordFailure(c, job, msg, "network");
          throw new RetryJobLater(msg, 15_000);
        default:
          if (last) return this.recordFailure(c, job, msg, "network");
          throw e;
      }
    }
    if (e instanceof PermanentJobError || last) return this.recordFailure(c, job, msg, "internal");
    throw e;
  }

  private markDone(job: Job): void {
    this.d.db.run("UPDATE jobs SET payload_json = json_set(payload_json, '$.done', 1) WHERE id = ?", [job.id]);
  }

  private recordSkip(c: Loaded, job: Job, reason: string): void {
    const { db } = this.d;
    db.transaction(() => {
      tallySkip(db, c.row.id, reason, job.url ?? "");
      db.run("UPDATE crawl_jobs SET pages_skipped = pages_skipped + 1 WHERE id = ?", [c.row.id]);
      this.markDone(job);
    });
    this.publish(c.row.id);
  }

  private recordFailure(c: Loaded, job: Job, message: string, code: string): void {
    const { db } = this.d;
    db.transaction(() => {
      db.run("UPDATE crawl_jobs SET pages_failed = pages_failed + 1 WHERE id = ?", [c.row.id]);
      db.run("UPDATE download_jobs SET pages_failed = pages_failed + 1 WHERE id = ?", [c.row.download_job_id]);
      this.markDone(job);
    });
    this.d.activity.write({ level: "warn", area: "crawl", message: `Could not fetch ${job.url}: ${message}`, downloadJobId: c.row.download_job_id, jobId: job.id, details: { code } });
    this.publish(c.row.id);
  }

  /**
   * Counts the page, then turns its stored links into frontier rows in one transaction: scope, then the region/score filters,
   * then the trap rules, then the per-page and frontier caps. Rows are inserted best first so ids follow the priority order.
   */
  private completePage(c: Loaded, job: Job, payload: FrontierPayload, versionId: number | null, bytes: number, dup: boolean): void {
    const { db, queue } = this.d;
    const cfg = c.config;
    const skips = new Map<string, { n: number; sample: string }>();
    const skip = (reason: string, url: string) => {
      const s = skips.get(reason);
      if (s) s.n++;
      else skips.set(reason, { n: 1, sample: url });
    };
    let created = 0;
    db.transaction(() => {
      const fresh = this.row(c.row.id)!;
      db.run(
        "UPDATE crawl_jobs SET pages_fetched = pages_fetched + 1, bytes_fetched = bytes_fetched + ?, depth_reached = MAX(depth_reached, ?) WHERE id = ?",
        [bytes, job.depth, c.row.id],
      );
      db.run("UPDATE download_jobs SET pages_done = pages_done + 1, bytes_done = bytes_done + ? WHERE id = ?", [bytes, c.row.download_job_id]);
      this.markDone(job);
      if (fresh.finished_at !== null || fresh.dstate === "cancelled" || versionId === null) return;
      const held = fresh.dstate === "paused";

      // Duplicate-content streaks: a family of identical pages is blocked before it can eat the budget.
      if (c.guard.observeContent(job.url!, dup)) skip("trap:duplicate_content_family", job.url!);

      const rows = db.all<{ to_url: string; anchor_text: string | null; region: LinkRegion; score: number; features_json: string | null; rel_nofollow: number; position: number | null }>(
        "SELECT to_url, anchor_text, region, score, features_json, rel_nofollow, position FROM links WHERE from_version_id = ? ORDER BY position, id", [versionId]);
      type Cand = LinkCandidate & { decision: Extract<ReturnType<Scope["evaluate"]>, { allow: true }> };
      const cands: Cand[] = [];
      for (const r of rows) {
        const d = c.scope.evaluate(r.to_url, { depth: job.depth, externalDepth: payload.externalDepth });
        if (!d.allow) {
          skip(d.reason, r.to_url);
          if (d.reason === "scope:depth" && d.internal) db.run(
            "INSERT INTO crawl_counters (crawl_job_id, kind, key, value) VALUES (?, 'flag', 'depth_limited', 1) ON CONFLICT (crawl_job_id, kind, key) DO NOTHING", [c.row.id]);
          continue;
        }
        const features = r.features_json ? (JSON.parse(r.features_json) as LinkCandidate["features"]) : null;
        if ((features as { urlShape?: string } | null)?.urlShape === "download") {
          skip("filter:download", r.to_url);
          continue;
        }
        cands.push({
          url: r.to_url, region: r.region, score: r.score, features, position: r.position ?? 0, isInternal: d.internal, relNofollow: r.rel_nofollow === 1,
          anchorText: r.anchor_text ?? undefined, decision: d,
        });
      }
      const ranked = rankLinks(cands, job.depth + 1, (l) => !l.isInternal, cfg.links.weights);
      const { follow, dropped } = selectLinks(ranked, cfg.links);
      for (const x of dropped) skip(x.reason, x.item.link.url);

      const frontier = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE crawl_job_id = ? AND state IN ('queued','held')", [c.row.id])!.n;
      let queued = frontier;
      let attempted = 0;
      for (const { link, priority } of follow) {
        if (attempted >= cfg.links.maxLinksPerPage) {
          skip("limit:per_page", link.url);
          continue;
        }
        const d = link.decision;
        if (d.sessionStripped) skip("normalised:session_id", link.url);
        attempted++;
        if (queued >= cfg.traps.maxFrontier) {
          skip("trap:frontier_full", link.url);
          continue;
        }
        const verdict = c.guard.check(d.fetchUrl);
        if (!verdict.ok) {
          skip(verdict.reason, link.url);
          continue;
        }
        const child: FrontierPayload = {
          crawl: true, externalDepth: d.externalDepth, parentExternalDepth: payload.externalDepth,
          via: { from: job.url, region: link.region, anchor: (link.anchorText ?? "").slice(0, 80), score: priority.total, components: priority.components, position: link.position },
        };
        this.ensureHost(d.host, cfg);
        const q = queue.enqueue({
          type: "fetch", queue: "crawl", host: d.host, url: d.fetchUrl, urlKey: d.key, downloadJobId: c.row.download_job_id, crawlJobId: c.row.id,
          depth: d.depth, score: priority.total, priority: 5 - (cfg.priority ?? 3), payload: child, maxAttempts: 4, held,
        });
        if (q.created) {
          verdict.commit();
          created++;
          queued++;
          db.run(
            `INSERT INTO crawl_counters (crawl_job_id, kind, key, value) VALUES (?, 'follow', ?, 1)
             ON CONFLICT (crawl_job_id, kind, key) DO UPDATE SET value = value + 1`, [c.row.id, link.region]);
        } else skip("visited", link.url);
      }
      for (const [reason, s] of skips) tallySkip(db, c.row.id, reason, s.sample, s.n);
      const skipped = [...skips].filter(([r]) => r !== "visited" && !r.startsWith("normalised:")).reduce((n, [, s]) => n + s.n, 0);
      db.run("UPDATE crawl_jobs SET pages_discovered = pages_discovered + ?, pages_skipped = pages_skipped + ? WHERE id = ?", [created, skipped, c.row.id]);
    });
    // Limits that this page may have used up.
    const after = this.row(c.row.id)!;
    if (after.finished_at === null) {
      if (after.max_bytes !== null && after.bytes_fetched >= after.max_bytes) this.finish(after.id, "max_bytes");
      else if (after.max_pages !== null && after.pages_fetched >= after.max_pages) {
        const waiting = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE crawl_job_id = ? AND state IN ('queued','held') AND id <> ?", [after.id, job.id])!.n;
        if (waiting > 0) this.finish(after.id, "max_pages");
      }
    }
    this.publish(c.row.id);
  }
}

export { resolveCrawlConfig };
