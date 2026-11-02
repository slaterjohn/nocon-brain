import { decodeHtml } from "@ncb/content";
import { PIPELINE_STAGES } from "@ncb/db/schema";
import type { Job } from "@ncb/db";
import type { RobotsService } from "@ncb/fetch";
import { PermanentJobError } from "../runtime/protocol.js";
import { sha256Hex } from "../pipeline/store.js";
import { RetryJobLater, type MainHandler } from "../pipeline/service.js";
import { DEFAULT_CAPS, type CaptureOptions, type PipelineDeps } from "../pipeline/types.js";
import { RenderBusy, RenderFailed, type RendererClient } from "./client.js";
import { decideRender, type RenderDecision, type RenderReason } from "./triggers.js";

/** The queue treats this as the "host" of every render job, so `host_state.max_concurrent` is the render concurrency. */
export const RENDER_QUEUE_HOST = "renderer.internal";

export interface RenderServiceOptions {
  deps: PipelineDeps;
  /** Undefined when the renderer is not configured: nothing is ever rendered and the rest of the stack is unaffected. */
  client: RendererClient | undefined;
  robots?: Pick<RobotsService, "check">;
  /** Pages rendered at once. Read on every use, so a settings change applies without a restart. */
  concurrency: () => number;
  neverHosts: () => readonly string[];
  timeoutMs: number;
  userAgent: string;
  assertOnline: () => void;
  log: PipelineDeps["log"];
}

export interface RenderPayload {
  versionId: number;
  options: CaptureOptions;
  reasons: RenderReason[];
}

interface VersionRow {
  id: number; page_id: number; source_id: number | null; download_job_id: number | null; requested_url: string; final_url: string; http_status: number | null;
  mime: string | null; raw_hash: string | null; render_mode: string; headers_json: string | null; host: string; status: string;
}

/**
 * Optional browser rendering (task C-16). After a normal capture finishes, `consider` applies the deterministic triggers
 * and, when one fires and the renderer is configured, queues a `render` job. The job asks the renderer container for the
 * page's DOM after its scripts ran and stores that DOM as a second version of the same page, flagged
 * `render_mode = 'browser'`, which goes through the ordinary pipeline. Scripts never run in the archive: the DOM is only
 * ever text until the listener sanitises it at serve time.
 */
export class RenderService {
  constructor(private readonly o: RenderServiceOptions) {}

  get enabled(): boolean {
    return this.o.client !== undefined;
  }

  get handlers(): Record<string, MainHandler> {
    return { render: (job, ctx) => this.handleRender(job, ctx.signal) };
  }

  /** Called after a version's pipeline finished. Never throws. */
  consider(versionId: number, options: CaptureOptions): void {
    if (!this.o.client) return;
    void this.evaluate(versionId, options).catch((e) => this.o.log.warn({ err: String(e), versionId }, "render check failed"));
  }

  /** Writes the current render concurrency to the queue's per-host limit. Called when a render is queued and when the setting changes. */
  applyConcurrency(): void {
    const max = Math.max(1, this.o.concurrency());
    this.o.deps.db.run(
      "INSERT INTO host_state (host, max_concurrent) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET max_concurrent = excluded.max_concurrent",
      [RENDER_QUEUE_HOST, max]);
  }

  /** Applies the triggers to a finished version and queues a render job. Returns the decision (for tests). */
  async evaluate(versionId: number, options: CaptureOptions): Promise<RenderDecision | undefined> {
    const d = this.o.deps;
    const v = this.version(versionId);
    if (!v || (v.status !== "ready" && v.status !== "partial")) return undefined;
    const blobs = d.db.get<{ text: string | null; method: string | null }>(
      `SELECT t.sha256 AS text, vc.extraction_method AS method FROM version_content vc LEFT JOIN blobs t ON t.id = vc.text_blob_id WHERE vc.version_id = ?`, [versionId]);
    const text = blobs?.text ? (await d.blobs.read(blobs.text)).data.toString("utf8") : "";
    const html = v.raw_hash ? decodeHtml((await d.blobs.read(v.raw_hash)).data, "text/html").text : "";
    const decision = decideRender({
      html, extractedChars: text.trim().length, extractionMethod: blobs?.method ?? null, httpStatus: v.http_status, mime: v.mime,
      renderMode: this.sourceRenderMode(v.source_id), host: v.host, neverHosts: this.o.neverHosts(), rendered: v.render_mode === "browser",
    });
    if (!decision.render) return decision;
    this.applyConcurrency();
    const payload: RenderPayload = { versionId, options, reasons: decision.reasons };
    d.queue.enqueue({
      type: "render", queue: "crawl", host: RENDER_QUEUE_HOST, url: v.final_url, versionId, downloadJobId: v.download_job_id ?? undefined, payload,
      idempotencyKey: `render:${versionId}`, maxAttempts: 3, priority: 5 - (options.priority ?? 3),
    });
    d.activity.write({ level: "info", area: "pipeline", message: `Queued a rendered copy of ${v.final_url}`, details: { reasons: decision.reasons }, versionId });
    return decision;
  }

  private version(id: number): VersionRow | undefined {
    return this.o.deps.db.get<VersionRow>(
      `SELECT v.id, v.page_id, v.source_id, v.download_job_id, v.requested_url, v.final_url, v.http_status, v.mime, v.raw_hash, v.render_mode, v.headers_json, v.status, p.host
       FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE v.id = ?`, [id]);
  }

  private sourceRenderMode(sourceId: number | null): "never" | "auto" | "always" {
    if (sourceId === null) return "auto";
    const r = this.o.deps.db.get<{ config_json: string }>(
      "SELECT c.config_json FROM sources s JOIN source_configs c ON c.id = s.current_config_id WHERE s.id = ?", [sourceId]);
    try {
      const m = (JSON.parse(r?.config_json ?? "{}") as { renderMode?: string }).renderMode;
      return m === "never" || m === "always" ? m : "auto";
    } catch {
      return "auto";
    }
  }

  // ---- the job -------------------------------------------------------------------------------

  private async handleRender(job: Job, signal: AbortSignal): Promise<void> {
    const client = this.o.client;
    if (!client) throw new PermanentJobError("The renderer is not configured.");
    const p = job.payload as RenderPayload;
    const d = this.o.deps;
    const v = this.version(p.versionId);
    if (!v) return; // the plain version was deleted meanwhile
    this.o.assertOnline();
    const user = p.options.userInitiated ?? (p.options.requestedBy ?? "user") === "user";
    if (this.o.robots) {
      const dec = await this.o.robots.check(v.final_url, { bypass: user });
      if (!dec.allowed) throw new PermanentJobError(`robots.txt does not allow rendering ${v.final_url}.`);
    }
    const maxBytes = { ...DEFAULT_CAPS, ...p.options.caps }.maxDocumentBytes;
    let res;
    try {
      res = await client.render({ url: v.final_url, timeoutMs: this.o.timeoutMs, maxBytes, userAgent: this.o.userAgent }, signal);
    } catch (e) {
      if (e instanceof RenderBusy) throw new RetryJobLater(e.message, 5_000);
      if (e instanceof RenderFailed) {
        d.activity.write({ level: "warn", area: "pipeline", message: `Rendering ${v.final_url} failed: ${e.message}`, versionId: v.id, details: { code: e.code } });
        if (e.permanent) throw new PermanentJobError(e.message);
      }
      throw e;
    }
    if (res.status < 200 || res.status > 299) throw new PermanentJobError(`The rendered page answered ${res.status}.`);
    const bytes = Buffer.from(res.html, "utf8");
    if (bytes.length === 0) throw new PermanentJobError("The rendered page was empty.");
    const sha = sha256Hex(bytes);
    if (sha === v.raw_hash) {
      d.activity.write({ level: "info", area: "pipeline", message: `Rendering ${v.final_url} changed nothing`, versionId: v.id });
      return;
    }
    await d.blobs.put(bytes, { kind: "document", mime: "text/html", maxBytes });
    const now = d.clock.now();
    const vid = d.db.transaction(() => {
      const vno = d.db.get<{ n: number }>("SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM page_versions WHERE page_id = ?", [v.page_id])!.n;
      const ins = d.db.run(
        `INSERT INTO page_versions (public_id, page_id, version_no, source_id, download_job_id, requested_url, final_url, status, http_status, render_mode, raw_hash, raw_bytes, mime,
           headers_json, fetched_at, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 'capturing', ?, 'browser', ?, ?, 'text/html', ?, ?, ?)`,
        [d.newId("ver"), v.page_id, vno, v.source_id, v.requested_url, v.final_url, res.status, sha, bytes.length, JSON.stringify({ "content-type": "text/html; charset=utf-8" }), now, now]);
      const id = Number(ins.lastInsertRowid);
      for (const s of PIPELINE_STAGES) d.db.run("INSERT INTO pipeline_stage_runs (version_id, stage) VALUES (?, ?) ON CONFLICT DO NOTHING", [id, s]);
      d.queue.enqueue({
        type: "process", queue: "process", versionId: id, payload: { options: p.options }, idempotencyKey: `process:${id}`, maxAttempts: 3, priority: 5 - (p.options.priority ?? 3),
      });
      return id;
    });
    d.activity.write({
      level: "info", area: "pipeline", message: `Rendered ${v.final_url} in ${res.durationMs} ms`, versionId: vid,
      details: { reasons: p.reasons, loadedBytes: res.loadedBytes, domBytes: bytes.length, requests: res.requests, blockedRequests: res.blockedRequests, memoryMb: res.memoryMb },
    });
  }
}
