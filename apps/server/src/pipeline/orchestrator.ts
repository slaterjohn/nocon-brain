import { PIPELINE_STAGES, type PipelineStage } from "@ncb/db/schema";
import { SimulatedCrash } from "../services/blobs.js";
import { assets, storeOriginal, validate } from "./stages/capture.js";
import { metadata, readable, reader, sections } from "./stages/content.js";
import { renderPrep, skippedStage, status } from "./stages/finish.js";
import { dedup, discardAsUnchanged, links, normalise } from "./stages/links.js";
import { DEFAULT_CAPS, StageFailure, type CaptureCaps, type PipelineDeps, type StageContext, type StageFn, type VersioningPolicy } from "./types.js";
import { DEFAULT_VERSIONING } from "./policy.js";
import { publishCapture } from "./progress.js";

export const BUILTIN_STAGES: Record<PipelineStage, StageFn> = {
  validate, store_original: storeOriginal, assets, metadata, readable, sections, links, normalise, dedup, reader,
  render_prep: renderPrep,
  index: skippedStage("search indexing arrives in phase 4 (S-02)"),
  link_graph: skippedStage("link graph resolution beyond rows arrives in phase 4"),
  candidates: skippedStage("discovery candidates arrive in phase 7 (D-02)"),
  status,
};
/** Stages 12 to 14 are registered as `skipped` until their phases. */
export const STUB_STAGES: ReadonlySet<PipelineStage> = new Set(["index", "link_graph", "candidates"]);

export type RunOutcome = { kind: "done"; status: string } | { kind: "unchanged"; reason: string } | { kind: "failed"; stage: PipelineStage; message: string };

export interface RunOptions {
  caps?: Partial<CaptureCaps>;
  versioning?: VersioningPolicy;
  signal?: AbortSignal;
}

/**
 * The 15-stage state machine (task A-05). State lives in `pipeline_stage_runs`: a finished stage is never run
 * again, a stage found `running` (the process died inside it) is run again, and every stage writes with
 * upserts or content-addressed blobs so a re-run converges on the same rows.
 */
export async function runPipeline(deps: PipelineDeps, versionId: number, opts: RunOptions = {}): Promise<RunOutcome> {
  const { db, clock } = deps;
  const ctx: StageContext = {
    deps, versionId, signal: opts.signal, cache: new Map(), caps: { ...DEFAULT_CAPS, ...opts.caps }, versioning: opts.versioning ?? DEFAULT_VERSIONING,
  };
  db.transaction(() => {
    for (const s of PIPELINE_STAGES) db.run("INSERT INTO pipeline_stage_runs (version_id, stage) VALUES (?, ?) ON CONFLICT DO NOTHING", [versionId, s]);
  });
  const downloadJobId = db.get<{ download_job_id: number | null }>("SELECT download_job_id FROM page_versions WHERE id = ?", [versionId])?.download_job_id;
  const publish = (stage: PipelineStage, state: string) => {
    deps.events.publish("pipeline", { versionId, stage, state });
    publishCapture(db, deps.events, downloadJobId, state === "running" ? stage : undefined);
  };

  for (const stage of PIPELINE_STAGES) {
    const run = db.get<{ state: string; attempts: number }>("SELECT state, attempts FROM pipeline_stage_runs WHERE version_id = ? AND stage = ?", [versionId, stage])!;
    if (run.state === "done" || run.state === "skipped") continue;
    const fn = deps.stageOverrides?.[stage] ?? BUILTIN_STAGES[stage];
    let attempts = run.attempts;
    for (;;) {
      if (opts.signal?.aborted) throw new Error("The pipeline was stopped.");
      // A stage that keeps killing the process is not retried forever.
      if (attempts >= deps.maxStageAttempts) return fail(deps, versionId, stage, run.state === "running" || attempts > 0 ? "The stage did not finish after repeated attempts." : "unknown");
      attempts++;
      db.run("UPDATE pipeline_stage_runs SET state = 'running', attempts = ?, started_at = ?, finished_at = NULL WHERE version_id = ? AND stage = ?", [attempts, clock.now(), versionId, stage]);
      publish(stage, "running");
      try {
        const res = await fn(ctx);
        await deps.faults?.beforeStageDone?.(stage, versionId);
        if (res && res.outcome === "unchanged") {
          discardAsUnchanged(ctx, versionId, String(res.detail?.reason ?? "unchanged"));
          return { kind: "unchanged", reason: String(res.detail?.reason ?? "unchanged") };
        }
        const state = STUB_STAGES.has(stage) ? "skipped" : "done";
        db.run(
          "UPDATE pipeline_stage_runs SET state = ?, finished_at = ?, last_error = NULL, detail_json = COALESCE(?, detail_json) WHERE version_id = ? AND stage = ?",
          [state, clock.now(), res && res.detail ? JSON.stringify(res.detail) : null, versionId, stage],
        );
        publish(stage, state);
        await deps.faults?.afterStage?.(stage, versionId);
        break;
      } catch (e) {
        if (e instanceof SimulatedCrash) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        db.run("UPDATE pipeline_stage_runs SET last_error = ? WHERE version_id = ? AND stage = ?", [msg.slice(0, 1000), versionId, stage]);
        if (e instanceof StageFailure || attempts >= deps.maxStageAttempts) return fail(deps, versionId, stage, msg, e instanceof StageFailure ? e.code : "internal");
        deps.log.warn({ stage, versionId, attempt: attempts, err: msg }, "pipeline stage failed; retrying");
        await deps.sleep(Math.min(2000, 100 * 2 ** attempts));
      }
    }
  }
  const v = db.get<{ status: string }>("SELECT status FROM page_versions WHERE id = ?", [versionId])!;
  deps.events.publish("pipeline", { versionId, state: v.status });
  publishCapture(db, deps.events, downloadJobId);
  return { kind: "done", status: v.status };
}

function fail(deps: PipelineDeps, versionId: number, stage: PipelineStage, message: string, code: string = "internal"): RunOutcome {
  const { db, clock } = deps;
  db.transaction(() => {
    db.run("UPDATE pipeline_stage_runs SET state = 'failed', finished_at = ?, last_error = ? WHERE version_id = ? AND stage = ?", [clock.now(), message.slice(0, 1000), versionId, stage]);
    const v = db.get<{ page_id: number; download_job_id: number | null }>("SELECT page_id, download_job_id FROM page_versions WHERE id = ?", [versionId]);
    db.run("UPDATE page_versions SET status = 'failed', failure_stage = ?, failure_message = ? WHERE id = ?", [stage, message.slice(0, 1000), versionId]);
    if (v?.download_job_id) {
      const allowed = ["network", "robots_blocked", "ssrf_blocked", "size_cap", "disk_full", "timeout", "http_4xx", "http_5xx", "parse_error", "limit_reached", "internal"];
      db.run("UPDATE download_jobs SET state = 'failed', pages_failed = 1, failure_code = ?, failure_message = ?, finished_at = ? WHERE id = ?", [allowed.includes(code) ? code : "internal", `Stage ${stage}: ${message}`.slice(0, 500), clock.now(), v.download_job_id]);
    }
  });
  deps.activity.write({ level: "error", area: "pipeline", message: `Capture failed at stage ${stage}: ${message}`, versionId });
  deps.events.publish("pipeline", { versionId, stage, state: "failed", error: message });
  const dl = db.get<{ download_job_id: number | null }>("SELECT download_job_id FROM page_versions WHERE id = ?", [versionId])?.download_job_id;
  publishCapture(db, deps.events, dl);
  return { kind: "failed", stage, message };
}
