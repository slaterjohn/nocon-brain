import { createHash } from "node:crypto";
import { registrableDomain } from "@ncb/content";
import { FetchError, normaliseUrl, type RobotsService } from "@ncb/fetch";
import { AppError, newId } from "@ncb/shared";
import type { Job } from "@ncb/db";
import type { PipelineStage } from "@ncb/db/schema";
import { PIPELINE_STAGES } from "@ncb/db/schema";
import { PermanentJobError } from "../runtime/protocol.js";
import { runPipeline, type RunOutcome } from "./orchestrator.js";
import { DEFAULT_VERSIONING, parseVersioning } from "./policy.js";
import { captureEvent, publishCapture } from "./progress.js";
import { sha256Hex } from "./store.js";
import { linkPageSource } from "../sources/references.js";
import { pageByKey } from "./stages/links.js";
import {
  DEFAULT_CAPS, type CaptureOptions, type FetchJobPayload, type PipelineDeps, type PipelineFetcher, type PipelineFetchResult,
} from "./types.js";

/** Thrown by a main-thread handler to retry later; the runner passes the delays to the queue. */
export class RetryJobLater extends Error {
  constructor(message: string, readonly retryAfterMs?: number, readonly hostBackoffMs?: number) {
    super(message);
  }
}

/** What the fetch half of a capture found. `unchanged` carries the latest stored version (null when the page has none). */
export type FetchStoreOutcome =
  | { kind: "stored"; versionId: number; status: number; finalUrl: string; rawBytes: number; redirects: number }
  | { kind: "unchanged"; via: "304" | "bytes"; versionId: number | null; status: number; finalUrl: string; redirects: number }
  | { kind: "http_error"; status: number; retryAfterMs?: number; finalUrl: string };

export type MainHandler = (job: Job, ctx: { signal: AbortSignal }) => Promise<void>;

const HEADER_ALLOW = ["content-type", "last-modified", "etag", "link", "content-language"];

export interface VersionSummary {
  id: number; publicId: string; versionNo: number; status: string; partialReason: string | null; title: string | null;
  fetchedAt: number; wordCount: number | null; totalBytes: number | null; contentHash: string | null;
}

export interface PageDetail {
  id: number; publicId: string; urlKey: string; canonicalUrl: string; host: string; title: string | null; language: string | null;
  availability: string; latestVersionId: number | null; latestVersionPublicId: string | null; versionCount: number; inboundCount: number;
  effectivePriority: number | null; firstCapturedAt: number | null; lastCapturedAt: number | null; lastCheckedAt: number | null;
  aliases: { urlKey: string; kind: string }[];
}

export interface VersionDetail extends VersionSummary {
  pageId: number; pagePublicId: string; requestedUrl: string; finalUrl: string; httpStatus: number | null; mime: string | null;
  rawHash: string | null; documentSha256: string | null; etag: string | null; lastModified: string | null; description: string | null;
  language: string | null; author: string | null; siteName: string | null; publishedAt: number | null; modifiedAt: number | null;
  publishedSource: string | null; publishedConfidence: string | null; duplicateOfVersionId: number | null; failureStage: string | null;
  failureMessage: string | null; extractorVersion: string | null; rewriterVersion: string | null; pipelineVersion: string | null;
  content: { textSha256: string | null; readerSha256: string | null; outlineSha256: string | null; extractionMethod: string | null };
  stages: { stage: PipelineStage; state: string; attempts: number; lastError: string | null }[];
}

export interface VersionResource {
  key: string; url: string; role: string; status: "ok" | "missing" | "blocked" | "skipped"; viaKey: string | null;
  blobSha256: string | null; blobId: number | null; mime: string | null; kind: string | null; sizeBytes: number | null;
}

export interface CaptureResult {
  downloadId: string;
  state: string;
  outcome: "pending" | "created" | "unchanged" | "failed";
  versionId?: string;
  pageId?: string;
  failureCode?: string | null;
  failureMessage?: string | null;
}

export interface PipelineServiceOptions {
  deps: PipelineDeps;
  fetcher: PipelineFetcher;
  robots?: Pick<RobotsService, "check">;
  /** Applied to every key the pipeline computes. Default `strip_tracking`. */
  queryPolicy?: "keep_all" | "strip_tracking";
}

export function createPipelineDeps(d: Omit<PipelineDeps, "urlKey" | "newId" | "sleep" | "maxStageAttempts"> & Partial<Pick<PipelineDeps, "sleep" | "maxStageAttempts">> & { queryPolicy?: "keep_all" | "strip_tracking" }): PipelineDeps {
  const policy = d.queryPolicy ?? "strip_tracking";
  return {
    ...d,
    urlKey: (u) => normaliseUrl(u, { queryPolicy: policy }).key,
    newId: (p) => newId(p),
    sleep: d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    maxStageAttempts: d.maxStageAttempts ?? 3,
  };
}

const failureCodeFor = (e: unknown): string => {
  if (e instanceof FetchError) {
    switch (e.code) {
      case "ssrf_blocked": return "ssrf_blocked";
      case "size_cap": case "content_length_exceeded": return "size_cap";
      case "timeout_connect": case "timeout_headers": case "timeout_body": case "timeout_total": return "timeout";
      case "content_type_blocked": return "parse_error";
      default: return "network";
    }
  }
  return "internal";
};

/**
 * The pipeline's service API (see apps/server/src/pipeline/README.md): `captureUrl` enqueues, the `fetch` and
 * `process` job handlers do the work, and the query methods feed the archive listener and the UI.
 */
export class PipelineService {
  readonly handlers: Record<string, MainHandler>;

  constructor(private readonly o: PipelineServiceOptions) {
    this.handlers = { fetch: (job, ctx) => this.handleFetch(job, ctx.signal), process: (job, ctx) => this.handleProcess(job, ctx.signal) };
  }

  private get d(): PipelineDeps {
    return this.o.deps;
  }

  /** The dedup key for a URL, under the pipeline's query policy. */
  urlKey(url: string): string {
    return this.d.urlKey(url);
  }

  // ---- commands ------------------------------------------------------------------------------

  /** Creates a download job and enqueues the fetch. Returns the public download id and the queue job id. */
  captureUrl(url: string, opts: CaptureOptions = {}): { downloadId: string; jobId: number } {
    let n;
    try {
      n = normaliseUrl(url, { queryPolicy: "keep_all" });
    } catch {
      throw new AppError("bad_request", "That is not a web address the archive can save.", { kind: "invalid_url" });
    }
    if (n.hasCredentials) throw new AppError("bad_request", "Addresses with a username or password cannot be saved.", { kind: "credentials" });
    const { db, clock, queue } = this.d;
    const key = this.d.urlKey(n.fetchUrl);
    const result = db.transaction(() => {
      const now = clock.now();
      const publicId = this.d.newId("dl");
      const job = db.run(
        `INSERT INTO download_jobs (public_id, source_id, kind, state, priority, requested_url, requested_by, created_at) VALUES (?, ?, 'capture', 'queued', ?, ?, ?, ?)`,
        [publicId, opts.sourceId ?? null, opts.priority ?? 3, n.fetchUrl, opts.requestedBy ?? "user", now],
      );
      const downloadJobId = Number(job.lastInsertRowid);
      const payload: FetchJobPayload = { downloadJobId, url: n.fetchUrl, options: opts };
      const q = queue.enqueue({
        type: "fetch", queue: "crawl", host: n.host, url: n.fetchUrl, urlKey: key, downloadJobId, payload, maxAttempts: 3,
        priority: 5 - (opts.priority ?? 3), idempotencyKey: `capture:${key}`,
      });
      if (!q.created) {
        // The same URL is already queued or running: join it rather than fetch twice.
        db.run("DELETE FROM download_jobs WHERE id = ?", [downloadJobId]);
        const existing = db.get<{ public_id: string }>("SELECT d.public_id FROM jobs j JOIN download_jobs d ON d.id = j.download_job_id WHERE j.id = ?", [q.id]);
        return { downloadId: existing?.public_id ?? publicId, jobId: q.id };
      }
      return { downloadId: publicId, jobId: q.id };
    });
    publishCapture(db, this.d.events, db.get<{ id: number }>("SELECT id FROM download_jobs WHERE public_id = ?", [result.downloadId])?.id);
    return result;
  }

  /**
   * Puts a capture on hold (waiting for the connection). Held captures keep the download job `queued` and the fetch job
   * `held`; `resumeHeld` releases every one of them when the connection returns.
   */
  holdCapture(downloadId: string): void {
    const { db, queue } = this.d;
    const id = db.get<{ id: number }>("SELECT id FROM download_jobs WHERE public_id = ?", [downloadId])?.id;
    if (id === undefined) return;
    queue.holdByDownloadJob(id);
    publishCapture(db, this.d.events, id);
  }

  /** Releases captures that were held while offline. Returns how many fetch jobs were released. */
  resumeHeld(): number {
    const { db, queue } = this.d;
    const ids = db.all<{ id: number }>("SELECT DISTINCT d.id FROM download_jobs d JOIN jobs j ON j.download_job_id = d.id WHERE d.state = 'queued' AND j.state = 'held'");
    let n = 0;
    for (const { id } of ids) {
      n += queue.resumeByDownloadJob(id);
      publishCapture(db, this.d.events, id);
    }
    return n;
  }

  /** Current progress of a capture in the shape of the `capture` event. */
  captureProgress(downloadId: string) {
    const id = this.d.db.get<{ id: number }>("SELECT id FROM download_jobs WHERE public_id = ?", [downloadId])?.id;
    return id === undefined ? undefined : captureEvent(this.d.db, id);
  }

  getCapture(downloadId: string): CaptureResult | undefined {
    const { db } = this.d;
    const j = db.get<{ id: number; public_id: string; state: string; failure_code: string | null; failure_message: string | null }>(
      "SELECT id, public_id, state, failure_code, failure_message FROM download_jobs WHERE public_id = ?", [downloadId]);
    if (!j) return undefined;
    const v = db.get<{ public_id: string; status: string; page_pid: string }>(
      "SELECT v.public_id, v.status, p.public_id AS page_pid FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE v.download_job_id = ? ORDER BY v.id DESC LIMIT 1", [j.id]);
    const outcome: CaptureResult["outcome"] = j.state === "failed" ? "failed" : j.state === "completed" ? (v ? "created" : "unchanged") : "pending";
    return {
      downloadId: j.public_id, state: j.state, outcome, versionId: v?.public_id, pageId: v?.page_pid,
      failureCode: j.failure_code, failureMessage: j.failure_message,
    };
  }

  // ---- queries -------------------------------------------------------------------------------

  private pageRow(idOrPublic: number | string) {
    const where = typeof idOrPublic === "number" ? "p.id = ?" : "p.public_id = ?";
    return this.d.db.get<Record<string, any>>(`SELECT p.*, v.public_id AS latest_pid FROM pages p LEFT JOIN page_versions v ON v.id = p.latest_version_id WHERE ${where}`, [idOrPublic]);
  }

  getPage(idOrPublic: number | string): PageDetail | undefined {
    const r = this.pageRow(idOrPublic);
    if (!r) return undefined;
    const aliases = this.d.db.all<{ url_key: string; kind: string }>("SELECT url_key, kind FROM page_aliases WHERE page_id = ? ORDER BY url_key", [r.id]);
    return {
      id: r.id, publicId: r.public_id, urlKey: r.url_key, canonicalUrl: r.canonical_url, host: r.host, title: r.title, language: r.language,
      availability: r.availability, latestVersionId: r.latest_version_id, latestVersionPublicId: r.latest_pid, versionCount: r.version_count,
      inboundCount: r.inbound_count, effectivePriority: r.effective_priority, firstCapturedAt: r.first_captured_at,
      lastCapturedAt: r.last_captured_at, lastCheckedAt: r.last_checked_at, aliases: aliases.map((a) => ({ urlKey: a.url_key, kind: a.kind })),
    };
  }

  /** Finds the page for any URL: its key, a redirect or canonical alias. */
  findPageByUrl(url: string): PageDetail | undefined {
    const ref = pageByKey({ deps: this.d }, this.d.urlKey(url));
    return ref ? this.getPage(ref.id) : undefined;
  }

  private summary(r: Record<string, any>): VersionSummary {
    return {
      id: r.id, publicId: r.public_id, versionNo: r.version_no, status: r.status, partialReason: r.partial_reason, title: r.title,
      fetchedAt: r.fetched_at, wordCount: r.word_count, totalBytes: r.total_bytes, contentHash: r.content_hash,
    };
  }

  /** Versions of a page, newest first. Includes `capturing` and `failed` rows; callers that serve readers filter on status. */
  listVersions(pageId: number | string): VersionSummary[] {
    const page = this.pageRow(pageId);
    if (!page) return [];
    return this.d.db.all<Record<string, any>>("SELECT * FROM page_versions WHERE page_id = ? ORDER BY version_no DESC", [page.id]).map((r) => this.summary(r));
  }

  getVersion(idOrPublic: number | string): VersionDetail | undefined {
    const { db } = this.d;
    const where = typeof idOrPublic === "number" ? "v.id = ?" : "v.public_id = ?";
    const r = db.get<Record<string, any>>(
      `SELECT v.*, p.public_id AS page_pid, b.sha256 AS doc_sha FROM page_versions v JOIN pages p ON p.id = v.page_id LEFT JOIN blobs b ON b.id = v.document_blob_id WHERE ${where}`, [idOrPublic]);
    if (!r) return undefined;
    const c = db.get<Record<string, any>>(
      `SELECT t.sha256 AS text_sha, rd.sha256 AS reader_sha, o.sha256 AS outline_sha, vc.extraction_method FROM version_content vc
       LEFT JOIN blobs t ON t.id = vc.text_blob_id LEFT JOIN blobs rd ON rd.id = vc.reader_blob_id LEFT JOIN blobs o ON o.id = vc.outline_blob_id WHERE vc.version_id = ?`, [r.id]);
    const stages = db.all<{ stage: PipelineStage; state: string; attempts: number; last_error: string | null }>(
      "SELECT stage, state, attempts, last_error FROM pipeline_stage_runs WHERE version_id = ?", [r.id])
      .sort((a, b) => PIPELINE_STAGES.indexOf(a.stage) - PIPELINE_STAGES.indexOf(b.stage));
    return {
      ...this.summary(r), pageId: r.page_id, pagePublicId: r.page_pid, requestedUrl: r.requested_url, finalUrl: r.final_url,
      httpStatus: r.http_status, mime: r.mime, rawHash: r.raw_hash, documentSha256: r.doc_sha, etag: r.etag, lastModified: r.last_modified,
      description: r.description, language: r.language, author: r.author, siteName: r.site_name, publishedAt: r.published_at,
      modifiedAt: r.modified_at, publishedSource: r.published_source, publishedConfidence: r.published_confidence,
      duplicateOfVersionId: r.duplicate_of_version_id, failureStage: r.failure_stage, failureMessage: r.failure_message,
      extractorVersion: r.extractor_version, rewriterVersion: r.rewriter_version, pipelineVersion: r.pipeline_version,
      content: { textSha256: c?.text_sha ?? null, readerSha256: c?.reader_sha ?? null, outlineSha256: c?.outline_sha ?? null, extractionMethod: c?.extraction_method ?? null },
      stages: stages.map((s) => ({ stage: s.stage, state: s.state, attempts: s.attempts, lastError: s.last_error })),
    };
  }

  /** Version to resources with blob references and the rewritten keys (for the archive listener). */
  listResources(versionId: number | string): VersionResource[] {
    const { db } = this.d;
    const id = typeof versionId === "number" ? versionId : db.get<{ id: number }>("SELECT id FROM page_versions WHERE public_id = ?", [versionId])?.id;
    if (id === undefined) return [];
    return db.all<Record<string, any>>(
      `SELECT r.resource_key, r.url, r.role, r.status, r.via_resource_key, b.sha256, b.id AS blob_id, b.mime, b.kind, b.size_bytes
       FROM version_resources r LEFT JOIN assets a ON a.id = r.asset_id LEFT JOIN blobs b ON b.id = a.blob_id
       WHERE r.version_id = ? ORDER BY r.id`, [id])
      .map((x) => ({ key: x.resource_key, url: x.url, role: x.role, status: x.status, viaKey: x.via_resource_key, blobSha256: x.sha256, blobId: x.blob_id, mime: x.mime, kind: x.kind, sizeBytes: x.size_bytes }));
  }

  /** One resource by its rewritten key; the listener's per-request lookup. */
  getResource(versionId: number, key: string): VersionResource | undefined {
    return this.listResources(versionId).find((r) => r.key === key);
  }

  /** The version's stored blobs (document, reader HTML, text, outline) by sha256. */
  getContentBlobs(versionId: number): { document: string | null; reader: string | null; text: string | null; outline: string | null } {
    const v = this.getVersion(versionId);
    return { document: v?.documentSha256 ?? null, reader: v?.content.readerSha256 ?? null, text: v?.content.textSha256 ?? null, outline: v?.content.outlineSha256 ?? null };
  }

  // ---- job handlers --------------------------------------------------------------------------

  private async handleProcess(job: Job, signal: AbortSignal): Promise<void> {
    if (job.versionId === null) throw new PermanentJobError("A process job needs a version.");
    const payload = (job.payload ?? {}) as { options?: CaptureOptions };
    const row = this.d.db.get<{ status: string }>("SELECT status FROM page_versions WHERE id = ?", [job.versionId]);
    if (!row) return; // discarded earlier
    if (row.status === "ready" || row.status === "partial") return;
    const outcome = await this.runVersion(job.versionId, payload.options ?? {}, signal);
    if (outcome.kind === "failed") throw new PermanentJobError(`Stage ${outcome.stage} failed: ${outcome.message}`);
  }

  /** Runs (or resumes) the pipeline for one version. */
  runVersion(versionId: number, options: CaptureOptions = {}, signal?: AbortSignal): Promise<RunOutcome> {
    return runPipeline(this.d, versionId, { caps: options.caps, versioning: parseVersioning(options.versioning), signal });
  }

  private markDownload(id: number, state: "running" | "completed" | "failed", extra: { code?: string; message?: string } = {}): void {
    const now = this.d.clock.now();
    if (state === "running") this.d.db.run("UPDATE download_jobs SET state = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND state IN ('queued','running')", [now, id]);
    else if (state === "completed") this.d.db.run("UPDATE download_jobs SET state = 'completed', finished_at = ? WHERE id = ?", [now, id]);
    else this.d.db.run("UPDATE download_jobs SET state = 'failed', failure_code = ?, failure_message = ?, finished_at = ? WHERE id = ?", [extra.code ?? "internal", (extra.message ?? "").slice(0, 500), now, id]);
    this.d.events.publish("download", { downloadJobId: id, state });
    publishCapture(this.d.db, this.d.events, id);
  }

  /** Records the source reference for a capture and tells collections about the page. */
  private linkSource(pageId: number, opts: CaptureOptions): void {
    if (opts.sourceId !== undefined) {
      linkPageSource(this.d.db, { pageId, sourceId: opts.sourceId, now: this.d.clock.now(), via: opts.discoveredVia, depth: opts.depth, priority: opts.priority });
    }
    this.d.onPageChanged?.(pageId);
  }

  private async handleFetch(job: Job, signal: AbortSignal): Promise<void> {
    const p = job.payload as FetchJobPayload;
    const opts = p.options ?? {};
    this.markDownload(p.downloadJobId, "running");
    const last = job.attempts >= job.maxAttempts;
    let out: FetchStoreOutcome;
    try {
      out = await this.fetchAndStore(p, signal, (u) => this.beforeHop(u, p, opts), true);
    } catch (e) {
      const code = failureCodeFor(e);
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof FetchError && e.code === "rate_limited") {
        if (last) this.markDownload(p.downloadJobId, "failed", { code: "network", message: msg });
        throw new RetryJobLater(msg, e.retryAfterMs, e.retryAfterMs);
      }
      if (e instanceof RobotsBlocked || (e as { cause?: unknown }).cause instanceof RobotsBlocked) {
        this.markDownload(p.downloadJobId, "failed", { code: "robots_blocked", message: msg });
        throw new PermanentJobError(msg);
      }
      const permanent = e instanceof FetchError && ["ssrf_blocked", "size_cap", "content_length_exceeded", "content_type_blocked", "invalid_url", "offline", "too_many_redirects", "redirect_loop", "bad_redirect"].includes(e.code);
      if (permanent || last) {
        this.markDownload(p.downloadJobId, "failed", { code, message: msg });
        throw new PermanentJobError(msg);
      }
      throw e;
    }
    if (out.kind === "unchanged") this.markDownload(p.downloadJobId, "completed");
    else if (out.kind === "http_error") {
      this.markDownload(p.downloadJobId, "failed", { code: out.status >= 500 ? "http_5xx" : "http_4xx", message: `The server answered ${out.status}.` });
      if (out.status >= 500 && !last) throw new Error(`The server answered ${out.status}.`);
    }
  }

  /**
   * The fetch half of a capture for the crawl engine: fetches, stores the original and creates the `capturing` version,
   * but does not touch the download job and does not enqueue the `process` job (the crawl runs `runVersion` itself, so it
   * can read the page's links before it picks the next URL). Errors are thrown as they are; the crawl classifies them.
   * `beforeHop` runs before every request including redirect hops and robots decisions belong in it.
   */
  fetchForCrawl(a: { downloadJobId: number; url: string; options: CaptureOptions; signal: AbortSignal; beforeHop: (url: string) => Promise<void> | void }): Promise<FetchStoreOutcome> {
    return this.fetchAndStore({ downloadJobId: a.downloadJobId, url: a.url, options: a.options }, a.signal, a.beforeHop, false);
  }

  private async fetchAndStore(
    p: FetchJobPayload, signal: AbortSignal, beforeHop: (url: string) => Promise<void> | void, enqueueProcess: boolean,
  ): Promise<FetchStoreOutcome> {
    const opts = p.options ?? {};
    const d = this.d;
    const key = d.urlKey(p.url);
    const page = pageByKey({ deps: d }, key);
    const versioning = parseVersioning(opts.versioning);
    const latest = page?.latest_version_id
      ? d.db.get<{ id: number; etag: string | null; last_modified: string | null; raw_hash: string | null; status: string }>("SELECT id, etag, last_modified, raw_hash, status FROM page_versions WHERE id = ?", [page.latest_version_id])
      : undefined;
    const useConditional = !opts.force && versioning.mode === "on_change" && latest && (latest.status === "ready" || latest.status === "partial") && (latest.etag || latest.last_modified);
    const res: PipelineFetchResult = await this.o.fetcher.fetch(p.url, {
      conditional: useConditional ? { etag: latest!.etag, lastModified: latest!.last_modified } : undefined,
      maxBytes: { ...DEFAULT_CAPS, ...opts.caps }.maxDocumentBytes,
      accept: ["text/html", "application/xhtml+xml", "text/*", "application/*"],
      signal,
      ...({ hooks: { beforeHop: (info: { url: string }) => beforeHop(info.url) } } as object),
    });

    const now = d.clock.now();
    if (res.notModified || res.status === 304) {
      if (page) {
        d.db.run("UPDATE pages SET last_checked_at = ? WHERE id = ?", [now, page.id]);
        this.linkSource(page.id, opts);
      }
      d.activity.write({ level: "info", area: "pipeline", message: `Unchanged (304) for ${p.url}`, downloadJobId: p.downloadJobId });
      return { kind: "unchanged", via: "304", versionId: latest?.id ?? null, status: 304, finalUrl: res.finalUrl, redirects: res.redirects?.length ?? 0 };
    }
    if (res.status < 200 || res.status > 299) {
      return { kind: "http_error", status: res.status, retryAfterMs: res.retryAfterMs, finalUrl: res.finalUrl };
    }
    const body = Buffer.isBuffer(res.body) ? res.body : Buffer.concat(await collect(res.body));
    const rawHash = sha256Hex(body);
    const headers: Record<string, string> = {};
    for (const k of HEADER_ALLOW) if (res.headers[k]) headers[k] = res.headers[k]!;
    if (latest && !opts.force && versioning.mode === "on_change" && latest.raw_hash === rawHash && (latest.status === "ready" || latest.status === "partial")) {
      d.db.run("UPDATE pages SET last_checked_at = ? WHERE id = ?", [now, page!.id]);
      d.db.run("UPDATE page_versions SET etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified) WHERE id = ?", [res.headers.etag ?? null, res.headers["last-modified"] ?? null, latest.id]);
      this.linkSource(page!.id, opts);
      d.activity.write({ level: "info", area: "pipeline", message: `Unchanged (same bytes) for ${p.url}`, downloadJobId: p.downloadJobId });
      return { kind: "unchanged", via: "bytes", versionId: latest.id, status: res.status, finalUrl: res.finalUrl, redirects: res.redirects?.length ?? 0 };
    }
    const mime = (res.contentType ?? "").split(";")[0]!.trim().toLowerCase() || null;
    await d.blobs.put(body, { kind: "document", mime: mime ?? undefined, maxBytes: { ...DEFAULT_CAPS, ...opts.caps }.maxDocumentBytes });

    const versionId = d.db.transaction(() => {
      const finalNorm = normaliseUrl(res.finalUrl, { queryPolicy: "keep_all" });
      const finalKey = d.urlKey(res.finalUrl);
      let pg = pageByKey({ deps: d }, finalKey) ?? pageByKey({ deps: d }, key);
      if (!pg) {
        const created = d.db.run(
          `INSERT INTO pages (public_id, url_key, canonical_url, host, registrable_domain, origin, content_type, availability, created_at) VALUES (?, ?, ?, ?, ?, 'web', 'html', 'failed', ?)`,
          [d.newId("pg"), finalKey, finalNorm.fetchUrl, finalNorm.host, registrableDomain(finalNorm.host), now],
        );
        pg = { id: Number(created.lastInsertRowid), url_key: finalKey, version_count: 0, latest_version_id: null };
      }
      const vno = d.db.get<{ n: number }>("SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM page_versions WHERE page_id = ?", [pg.id])!.n;
      const ins = d.db.run(
        `INSERT INTO page_versions (public_id, page_id, version_no, source_id, download_job_id, requested_url, final_url, status, http_status, raw_hash, raw_bytes, mime,
           etag, last_modified, headers_json, fetched_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'capturing', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.newId("ver"), pg.id, vno, opts.sourceId ?? null, p.downloadJobId, p.url, res.finalUrl, res.status, rawHash, body.length, mime, res.headers.etag ?? null, res.headers["last-modified"] ?? null, JSON.stringify(headers), now, now],
      );
      const vid = Number(ins.lastInsertRowid);
      if (opts.sourceId !== undefined) {
        linkPageSource(d.db, { pageId: pg.id, sourceId: opts.sourceId, now, via: opts.discoveredVia, depth: opts.depth, priority: opts.priority });
      }
      for (const s of PIPELINE_STAGES) d.db.run("INSERT INTO pipeline_stage_runs (version_id, stage) VALUES (?, ?) ON CONFLICT DO NOTHING", [vid, s]);
      if (enqueueProcess) {
        d.queue.enqueue({
          type: "process", queue: "process", versionId: vid, downloadJobId: p.downloadJobId, payload: { options: opts }, idempotencyKey: `process:${vid}`,
          maxAttempts: 3, priority: 5 - (opts.priority ?? 3),
        });
      }
      return vid;
    });
    return { kind: "stored", versionId, status: res.status, finalUrl: res.finalUrl, rawBytes: body.length, redirects: res.redirects?.length ?? 0 };
  }

  private async beforeHop(url: string, p: FetchJobPayload, opts: CaptureOptions): Promise<void> {
    const robots = this.o.robots;
    if (!robots) return;
    const user = opts.userInitiated ?? (opts.requestedBy ?? "user") === "user";
    const dec = await robots.check(url, { bypass: user });
    if (dec.bypassed) {
      this.d.activity.write({
        level: "warn", area: "crawl", message: `robots.txt was overridden for a user-initiated save of ${url}`,
        details: { wouldBlockReason: dec.wouldBlockReason, robotsUrl: dec.robotsUrl }, downloadJobId: p.downloadJobId,
      });
    }
    if (!dec.allowed) throw new RobotsBlocked(`robots.txt does not allow ${url} (${dec.reason}).`);
    if (dec.crawlDelayMs) {
      const host = new URL(url).hostname.toLowerCase();
      this.d.db.run("INSERT INTO host_state (host, crawl_delay_ms) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET crawl_delay_ms = excluded.crawl_delay_ms", [host, dec.crawlDelayMs]);
    }
  }
}

export class RobotsBlocked extends Error {}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const c of stream) out.push(Buffer.from(c as Uint8Array));
  return out;
}

export { DEFAULT_VERSIONING, createHash };
