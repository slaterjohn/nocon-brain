import { PIPELINE_STAGES, type PipelineStage } from "@ncb/db/schema";
import type { Db } from "@ncb/db";
import type { EventBus } from "../services/events.js";

/** Plain-English stage names for the progress line (docs/api.md has no stage names; these are UI copy). */
export const STAGE_LABELS: Record<PipelineStage, string> = {
  validate: "Checking the page",
  store_original: "Saving the page",
  assets: "Saving images and styles",
  metadata: "Reading the details",
  readable: "Finding the article text",
  sections: "Outlining the headings",
  links: "Collecting links",
  normalise: "Matching the address",
  dedup: "Checking for copies",
  reader: "Preparing reader view",
  render_prep: "Preparing the offline view",
  index: "Finishing",
  link_graph: "Finishing",
  candidates: "Finishing",
  status: "Finishing",
};

export interface CaptureEvent {
  downloadId: string;
  url: string | null;
  state: "queued" | "running" | "completed" | "failed" | "cancelled" | "paused";
  /** Offline: the capture waits until the connection returns. */
  held: boolean;
  outcome: "pending" | "created" | "unchanged" | "failed";
  /** Human wording for the stage that is running, or the final state. */
  label: string;
  percent: number;
  stage?: PipelineStage;
  pageId?: string;
  versionId?: string;
  failureMessage?: string | null;
}

/** Builds the `capture` event for one download job from the database. Returns undefined for an unknown job. */
export function captureEvent(db: Db, downloadJobId: number, stage?: PipelineStage): CaptureEvent | undefined {
  const j = db.get<{ public_id: string; state: CaptureEvent["state"]; requested_url: string | null; failure_message: string | null }>(
    "SELECT public_id, state, requested_url, failure_message FROM download_jobs WHERE id = ?", [downloadJobId]);
  if (!j) return undefined;
  const v = db.get<{ id: number; public_id: string; status: string; page_pid: string }>(
    "SELECT v.id, v.public_id, v.status, p.public_id AS page_pid FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE v.download_job_id = ? ORDER BY v.id DESC LIMIT 1", [downloadJobId]);
  const held = !!db.get("SELECT 1 AS x FROM jobs WHERE download_job_id = ? AND state = 'held' LIMIT 1", [downloadJobId]);
  let percent = 0;
  if (v) {
    const done = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pipeline_stage_runs WHERE version_id = ? AND state IN ('done','skipped')", [v.id])?.n ?? 0;
    percent = Math.round((done / PIPELINE_STAGES.length) * 100);
  }
  let label: string;
  let outcome: CaptureEvent["outcome"] = "pending";
  if (j.state === "completed") {
    outcome = v ? "created" : "unchanged";
    label = v ? (v.status === "partial" ? "Saved, with some files missing" : "Saved") : "Already saved, nothing has changed";
    percent = 100;
  } else if (j.state === "failed") {
    outcome = "failed";
    label = "Could not be saved";
  } else if (held) {
    label = "Waiting for the connection to return";
  } else if (stage) {
    label = STAGE_LABELS[stage];
  } else if (j.state === "running") {
    label = v ? "Working" : "Fetching the page";
  } else {
    label = "Waiting to start";
  }
  return {
    downloadId: j.public_id, url: j.requested_url, state: j.state, held, outcome, label, percent,
    ...(stage ? { stage } : {}),
    ...(j.state === "completed" && v ? { pageId: v.page_pid, versionId: v.public_id } : {}),
    ...(j.state === "failed" ? { failureMessage: j.failure_message } : {}),
  };
}

export function publishCapture(db: Db, events: EventBus, downloadJobId: number | null | undefined, stage?: PipelineStage): void {
  if (downloadJobId == null) return;
  const e = captureEvent(db, downloadJobId, stage);
  if (e) events.publish("capture", e);
}
