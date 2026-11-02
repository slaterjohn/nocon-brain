import type { Db, Job, JobQueue } from "@ncb/db";
import { FetchError, type RobotsService } from "@ncb/fetch";
import { AppError, newId, type Clock } from "@ncb/shared";
import { PermanentJobError } from "../runtime/protocol.js";
import { parseVersioning } from "../pipeline/policy.js";
import { RetryJobLater, RobotsBlocked, type MainHandler, type PipelineService } from "../pipeline/service.js";
import type { CaptureOptions } from "../pipeline/types.js";
import type { ActivityLog } from "../services/activity.js";
import type { EventBus } from "../services/events.js";

export interface RefreshSummary {
  checked: number;
  unchanged: number;
  changed: number;
  gone: number;
  failed: number;
}

const EMPTY: RefreshSummary = { checked: 0, unchanged: 0, changed: 0, gone: 0, failed: 0 };

export interface RefreshServiceDeps {
  db: Db;
  clock: Clock;
  queue: Pick<JobQueue, "enqueue" | "retry">;
  pipeline: Pick<PipelineService, "fetchForCrawl" | "runVersion">;
  robots?: Pick<RobotsService, "check">;
  activity: ActivityLog;
  events: EventBus;
  log?: { warn(o: unknown, m?: string): void };
}

interface CheckPayload {
  pageId: number;
  options: CaptureOptions & { respectRobots?: boolean };
}

const hostOf = (u: string) => new URL(u).hostname.toLowerCase();
const causedBy = <T extends Error>(e: unknown, C: new (...a: never[]) => T): T | undefined => {
  for (let x: unknown = e, i = 0; x && i < 4; x = (x as { cause?: unknown }).cause, i++) if (x instanceof C) return x;
  return undefined;
};

/**
 * Refresh and change detection (task C-11). `refreshSource` makes one `refresh` download with a `refresh_check` job for each saved
 * page of a source. A check sends a conditional request (ETag, Last-Modified), compares the bytes and then the extracted content,
 * and only a real change becomes a new version, under the source's versioning policy. A page that answers 404 or 410 is kept
 * and marked gone. The result is a `summary` of what was found, on the download.
 */
export class RefreshService {
  readonly handlers: Record<string, MainHandler>;

  constructor(private readonly d: RefreshServiceDeps) {
    this.handlers = { refresh_check: (job, ctx) => this.handleCheck(job, ctx.signal) };
  }

  /** Saved pages of a source that a refresh would check. */
  pageCount(sourceRowId: number): number {
    return this.d.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM page_sources ps JOIN pages p ON p.id = ps.page_id
       WHERE ps.source_id = ? AND p.deleted_at IS NULL AND p.latest_version_id IS NOT NULL`, [sourceRowId])!.n;
  }

  /** Starts a refresh of a source's saved pages, stalest first, up to the source's page limit. */
  async refreshSource(sourceRowId: number, o: { requestedBy: "user" | "schedule" | "system" }): Promise<{ downloadId: string; downloadJobId: number; pages: number }> {
    const { db, clock, queue } = this.d;
    const src = db.get<{ id: number; name: string; priority: number; start_url: string | null; config_json: string | null; deleted_at: number | null }>(
      `SELECT s.id, s.name, s.priority, s.start_url, c.config_json, s.deleted_at FROM sources s LEFT JOIN source_configs c ON c.id = s.current_config_id WHERE s.id = ?`, [sourceRowId]);
    if (!src || src.deleted_at !== null) throw new AppError("not_found", "That source does not exist.");
    const config = (src.config_json ? JSON.parse(src.config_json) : {}) as { maxPages?: number; versioning?: unknown; respectRobots?: boolean };
    const limit = Math.max(1, config.maxPages ?? 500);
    const pages = db.all<{ id: number; url_key: string; canonical_url: string; host: string }>(
      `SELECT p.id, p.url_key, p.canonical_url, p.host FROM page_sources ps JOIN pages p ON p.id = ps.page_id
       WHERE ps.source_id = ? AND p.deleted_at IS NULL AND p.latest_version_id IS NOT NULL
       ORDER BY COALESCE(p.last_checked_at, 0), p.id LIMIT ?`, [sourceRowId, limit]);
    if (pages.length === 0) throw new AppError("conflict", "This source has no saved pages to check yet. Run it first.");

    const now = clock.now();
    const publicId = newId("dl");
    let created = 0;
    const out = db.transaction(() => {
      const dl = db.run(
        `INSERT INTO download_jobs (public_id, source_id, kind, state, priority, requested_url, requested_by, summary_json, pages_done, created_at)
         VALUES (?, ?, 'refresh', 'queued', ?, ?, ?, ?, 0, ?)`,
        [publicId, sourceRowId, src.priority, src.start_url, o.requestedBy, JSON.stringify(EMPTY), now]);
      const downloadJobId = Number(dl.lastInsertRowid);
      let existing: number | undefined;
      for (const p of pages) {
        const payload: CheckPayload = {
          pageId: p.id,
          options: {
            priority: src.priority as 1 | 2 | 3 | 4, requestedBy: o.requestedBy, sourceId: sourceRowId, versioning: config.versioning as CaptureOptions["versioning"],
            userInitiated: false, discoveredVia: "seed", respectRobots: config.respectRobots !== false,
          },
        };
        const q = queue.enqueue({
          type: "refresh_check", queue: "crawl", host: p.host, url: p.canonical_url, urlKey: p.url_key, downloadJobId, payload,
          priority: 5 - src.priority, maxAttempts: 3, idempotencyKey: `refresh:${p.id}`,
        });
        if (q.created) created++;
        else existing ??= q.id;
      }
      if (created === 0) {
        // Every page is already being checked by another refresh: join that one instead of making an empty download.
        db.run("DELETE FROM download_jobs WHERE id = ?", [downloadJobId]);
        const other = db.get<{ public_id: string; id: number }>("SELECT d.public_id, d.id FROM jobs j JOIN download_jobs d ON d.id = j.download_job_id WHERE j.id = ?", [existing!]);
        return { downloadId: other!.public_id, downloadJobId: other!.id };
      }
      return { downloadId: publicId, downloadJobId };
    });
    if (created > 0) {
      this.d.activity.write({
        level: "info", area: "crawl", message: `Checking ${created} saved page${created === 1 ? "" : "s"} of ${src.name} for changes`,
        downloadJobId: out.downloadJobId, details: { requestedBy: o.requestedBy, sourceId: sourceRowId },
      });
      this.d.events.publish("refresh", { downloadId: out.downloadId, state: "queued" });
    }
    return { ...out, pages: created };
  }

  // ---- the check -----------------------------------------------------------------------------

  private bump(downloadJobId: number, delta: Partial<RefreshSummary>, extra: { bytes?: number; failure?: { code: string; message: string } } = {}): void {
    const { db } = this.d;
    db.transaction(() => {
      const row = db.get<{ summary_json: string | null }>("SELECT summary_json FROM download_jobs WHERE id = ?", [downloadJobId]);
      if (!row) return;
      const s: RefreshSummary = { ...EMPTY, ...(row.summary_json ? (JSON.parse(row.summary_json) as Partial<RefreshSummary>) : {}) };
      for (const k of Object.keys(delta) as (keyof RefreshSummary)[]) s[k] += delta[k] ?? 0;
      db.run(
        "UPDATE download_jobs SET summary_json = ?, pages_done = ?, pages_failed = ?, bytes_done = bytes_done + ?, failure_code = COALESCE(?, failure_code), failure_message = COALESCE(?, failure_message) WHERE id = ?",
        [JSON.stringify(s), s.checked, s.failed, extra.bytes ?? 0, extra.failure?.code ?? null, extra.failure?.message?.slice(0, 500) ?? null, downloadJobId]);
    });
  }

  private publish(downloadJobId: number): void {
    const id = this.d.db.get<{ public_id: string; state: string }>("SELECT public_id, state FROM download_jobs WHERE id = ?", [downloadJobId]);
    if (id) this.d.events.publish("refresh", { downloadId: id.public_id, state: id.state });
  }

  private async handleCheck(job: Job, signal: AbortSignal): Promise<void> {
    const { db, clock, pipeline } = this.d;
    const downloadJobId = job.downloadJobId;
    if (downloadJobId === null) throw new PermanentJobError("A refresh check needs a download.");
    const payload = job.payload as CheckPayload;
    const dl = db.get<{ state: string }>("SELECT state FROM download_jobs WHERE id = ?", [downloadJobId]);
    if (!dl || dl.state === "cancelled" || dl.state === "completed" || dl.state === "failed") return;
    const page = db.get<{ id: number; canonical_url: string; deleted_at: number | null }>("SELECT id, canonical_url, deleted_at FROM pages WHERE id = ?", [payload.pageId]);
    if (!page || page.deleted_at !== null) {
      this.maybeFinish(downloadJobId);
      return;
    }
    db.run("UPDATE download_jobs SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND state = 'queued'", [clock.now(), downloadJobId]);
    const last = job.attempts >= job.maxAttempts;
    const opts = payload.options ?? {};
    const real = parseVersioning(opts.versioning);
    const url = page.canonical_url;
    try {
      // Detection always compares against the latest version (`on_change`); the source's policy decides what a change becomes.
      const out = await pipeline.fetchForCrawl({
        downloadJobId, url, signal, options: { ...opts, versioning: { mode: "on_change" }, force: false },
        beforeHop: (u) => this.beforeHop(u, opts),
      });
      const now = clock.now();
      if (out.kind === "http_error") {
        if (out.status === 404 || out.status === 410) {
          db.run("UPDATE pages SET gone_at = COALESCE(gone_at, ?), gone_status = ?, last_checked_at = ? WHERE id = ?", [now, out.status, now, page.id]);
          this.d.activity.write({ level: "warn", area: "crawl", message: `${url} is gone (${out.status}). The saved copy is kept.`, downloadJobId, jobId: job.id, details: { status: out.status } });
          this.bump(downloadJobId, { checked: 1, gone: 1 });
        } else if (out.status >= 500 && !last) {
          throw new RetryJobLater(`The server answered ${out.status}.`, out.retryAfterMs, out.retryAfterMs);
        } else {
          db.run("UPDATE pages SET last_checked_at = ? WHERE id = ?", [now, page.id]);
          this.fail(downloadJobId, job, url, `The server answered ${out.status}.`, out.status >= 500 ? "http_5xx" : "http_4xx");
        }
      } else if (out.kind === "unchanged") {
        db.run("UPDATE pages SET gone_at = NULL, gone_status = NULL, last_checked_at = ? WHERE id = ?", [now, page.id]);
        this.d.activity.write({ level: "info", area: "crawl", message: `Unchanged (${out.via === "304" ? "304" : "same content"}): ${url}`, downloadJobId, jobId: job.id });
        this.bump(downloadJobId, { checked: 1, unchanged: 1 });
      } else {
        const run = await pipeline.runVersion(out.versionId, { ...opts, versioning: real }, signal);
        db.run("UPDATE pages SET gone_at = NULL, gone_status = NULL, last_checked_at = ? WHERE id = ?", [clock.now(), page.id]);
        if (run.kind === "failed") this.fail(downloadJobId, job, url, `Stage ${run.stage} failed: ${run.message}`, "parse_error");
        else if (run.kind === "unchanged") {
          this.d.activity.write({ level: "info", area: "crawl", message: `Unchanged (the text is the same): ${url}`, downloadJobId, jobId: job.id });
          this.bump(downloadJobId, { checked: 1, unchanged: 1 });
        } else {
          const bytes = db.get<{ n: number }>("SELECT COALESCE(raw_bytes, 0) + COALESCE(total_bytes, 0) AS n FROM page_versions WHERE id = ?", [out.versionId])?.n ?? 0;
          this.d.activity.write({ level: "info", area: "crawl", message: `Changed: ${url} has a new version`, downloadJobId, jobId: job.id, versionId: out.versionId });
          this.bump(downloadJobId, { checked: 1, changed: 1 }, { bytes });
        }
      }
    } catch (e) {
      if (signal.aborted) throw e;
      if (e instanceof RetryJobLater) {
        if (last) this.fail(downloadJobId, job, url, e.message, "network");
        else throw e;
      } else if (causedBy(e, RobotsBlocked)) {
        this.fail(downloadJobId, job, url, "robots.txt does not allow checking this page.", "robots_blocked");
      } else {
        const fe = causedBy(e, FetchError);
        const msg = e instanceof Error ? e.message : String(e);
        if (fe && fe.code === "rate_limited" && !last) throw new RetryJobLater(msg, fe.retryAfterMs, fe.retryAfterMs);
        const permanent = fe && ["ssrf_blocked", "size_cap", "content_length_exceeded", "content_type_blocked", "invalid_url", "too_many_redirects", "redirect_loop", "bad_redirect"].includes(fe.code);
        if (permanent || last || e instanceof PermanentJobError) {
          const code = !fe ? "internal" : fe.code === "ssrf_blocked" ? "ssrf_blocked" : fe.code.includes("timeout") ? "timeout" : fe.code === "size_cap" || fe.code === "content_length_exceeded" ? "size_cap" : "network";
          this.fail(downloadJobId, job, url, msg, code);
        } else throw e;
      }
    } finally {
      this.publish(downloadJobId);
      setImmediate(() => {
        try {
          this.maybeFinish(downloadJobId);
        } catch (err) {
          this.d.log?.warn({ err: String(err) }, "refresh finish check failed");
        }
      });
    }
  }

  private fail(downloadJobId: number, job: Job, url: string, message: string, code: string): void {
    this.d.activity.write({ level: "warn", area: "crawl", message: `Could not check ${url}: ${message}`, downloadJobId, jobId: job.id, details: { code } });
    // Remembered on the job so that a retry by hand runs exactly the checks that failed.
    this.d.db.run("UPDATE jobs SET payload_json = json_set(payload_json, '$.failed', 1) WHERE id = ?", [job.id]);
    this.bump(downloadJobId, { failed: 1 }, { failure: { code, message } });
  }

  private async beforeHop(url: string, opts: CheckPayload["options"]): Promise<void> {
    if (!this.d.robots || opts.respectRobots === false) return;
    const dec = await this.d.robots.check(url, { bypass: false });
    if (!dec.allowed) {
      if (dec.reason === "robots_unreachable_disallow") throw new RetryJobLater(`robots.txt for ${hostOf(url)} could not be fetched; waiting before trying again.`, 5000, 5000);
      throw new RobotsBlocked(`robots.txt does not allow ${url} (${dec.reason}).`);
    }
    if (dec.crawlDelayMs) {
      this.d.db.run("INSERT INTO host_state (host, crawl_delay_ms) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET crawl_delay_ms = MAX(crawl_delay_ms, excluded.crawl_delay_ms)", [hostOf(url), dec.crawlDelayMs]);
    }
  }

  // ---- finishing -----------------------------------------------------------------------------

  /** Closes a refresh download when none of its checks is left. */
  maybeFinish(downloadJobId: number): boolean {
    const { db, clock } = this.d;
    const dl = db.get<{ state: string; kind: string; source_id: number | null; summary_json: string | null; failure_code: string | null; failure_message: string | null }>(
      "SELECT state, kind, source_id, summary_json, failure_code, failure_message FROM download_jobs WHERE id = ?", [downloadJobId]);
    if (!dl || dl.kind !== "refresh" || (dl.state !== "queued" && dl.state !== "running")) return false;
    const open = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE download_job_id = ? AND state IN ('queued','running','held')", [downloadJobId])!.n;
    if (open > 0) return false;
    const total = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE download_job_id = ?", [downloadJobId])!.n;
    if (total === 0) return false;
    const dead = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE download_job_id = ? AND state IN ('failed','dead')", [downloadJobId])!.n;
    const s: RefreshSummary = { ...EMPTY, ...(dl.summary_json ? (JSON.parse(dl.summary_json) as Partial<RefreshSummary>) : {}) };
    // Checks that died without reporting (a crash loop used up their attempts) count as failed.
    s.failed += dead;
    const success = s.unchanged + s.changed + s.gone;
    const allCancelled = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE download_job_id = ? AND state = 'cancelled'", [downloadJobId])!.n === total;
    const now = clock.now();
    let state: "completed" | "failed" | "cancelled" = "completed";
    if (allCancelled) state = "cancelled";
    else if (success === 0 && s.failed > 0) state = "failed";
    db.run(
      `UPDATE download_jobs SET state = ?, finished_at = ?, summary_json = ?, pages_done = ?, pages_failed = ?,
              failure_code = ?, failure_message = ? WHERE id = ? AND state IN ('queued','running')`,
      [state, now, JSON.stringify(s), s.checked, s.failed,
        state === "failed" ? (dl.failure_code ?? "internal") : state === "cancelled" ? "cancelled_by_user" : null,
        state === "failed" ? (dl.failure_message ?? "The checks did not finish.") : null, downloadJobId]);
    if (dl.source_id !== null) {
      db.run("UPDATE sources SET last_status = ? WHERE id = ? AND deleted_at IS NULL", [state === "completed" ? "ok" : state, dl.source_id]);
    }
    this.d.activity.write({
      level: state === "failed" ? "error" : "info", area: "crawl", downloadJobId,
      message: state === "completed"
        ? `Refresh finished: ${s.changed} changed, ${s.unchanged} unchanged, ${s.gone} gone${s.failed ? `, ${s.failed} could not be checked` : ""}`
        : `Refresh ${state}`,
      details: s,
    });
    this.publish(downloadJobId);
    return true;
  }

  /** Closes refresh downloads that have no work left (also after a restart). */
  sweep(): number {
    let n = 0;
    for (const r of this.d.db.all<{ id: number }>("SELECT id FROM download_jobs WHERE kind = 'refresh' AND state IN ('queued','running')")) {
      if (this.maybeFinish(r.id)) n++;
    }
    return n;
  }

  /** After a manual retry the failed checks run again, so their failures are not counted twice. */
  resetAfterRetry(downloadJobId: number): void {
    const { db } = this.d;
    const row = db.get<{ summary_json: string | null }>("SELECT summary_json FROM download_jobs WHERE id = ?", [downloadJobId]);
    const s: RefreshSummary = { ...EMPTY, ...(row?.summary_json ? (JSON.parse(row.summary_json) as Partial<RefreshSummary>) : {}) };
    s.failed = 0;
    db.run("UPDATE download_jobs SET summary_json = ?, pages_failed = 0 WHERE id = ?", [JSON.stringify(s), downloadJobId]);
    const failed = db.all<{ id: number }>(
      "SELECT id FROM jobs WHERE download_job_id = ? AND type = 'refresh_check' AND state = 'done' AND json_extract(payload_json, '$.failed') = 1", [downloadJobId]);
    for (const j of failed) {
      try {
        db.run(
          "UPDATE jobs SET state = 'queued', attempts = 0, run_at = 0, finished_at = NULL, payload_json = json_remove(payload_json, '$.failed') WHERE id = ?", [j.id]);
      } catch {
        /* another refresh is already checking that page */
      }
    }
  }
}
