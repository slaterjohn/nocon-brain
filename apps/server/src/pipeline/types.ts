import type { Clock } from "@ncb/shared";
import type { Db, JobQueue } from "@ncb/db";
import type { ActivityLog } from "../services/activity.js";
import type { BlobStore } from "../services/blobs.js";
import type { EventBus } from "../services/events.js";
import type { ExtractClient } from "./extract-client.js";
import type { PipelineStage } from "@ncb/db/schema";

/**
 * The fetch seam. `@ncb/fetch`'s `createFetcher()` result satisfies it structurally, and so does the
 * fixture-backed fake the unit tests use. Errors are expected to carry a `code` (FetchError codes).
 */
export interface PipelineFetchResult {
  status: number;
  finalUrl: string;
  redirects?: { url: string; status: number; location: string }[];
  headers: Record<string, string>;
  body: Buffer | NodeJS.ReadableStream;
  contentType: string | null;
  declaredContentType?: string | null;
  charset?: string | null;
  notModified: boolean;
  truncated?: boolean;
}

export interface PipelineFetchOptions {
  method?: "GET" | "HEAD";
  conditional?: { etag?: string | null; lastModified?: string | null };
  maxBytes?: number;
  accept?: readonly string[];
  signal?: AbortSignal;
}

export interface PipelineFetcher {
  fetch(url: string, opts?: PipelineFetchOptions): Promise<PipelineFetchResult>;
}

export type VersioningPolicy =
  | { mode: "latest_only" | "all" | "on_change" }
  | { mode: "last_n"; n: number }
  | { mode: "period"; period: "day" | "week" | "month" };

/** Per-capture limits (task A-06). */
export interface CaptureCaps {
  /** Largest main document. Default 20 MiB. */
  maxDocumentBytes: number;
  /** Most sub-resources attempted for one capture, including failures. Default 300. */
  maxAssets: number;
  /** Largest single sub-resource. Default 25 MiB. */
  maxAssetBytes: number;
  /** Total bytes of sub-resources. Default 150 MiB. */
  maxTotalAssetBytes: number;
  /** Deepest `@import` chain followed. Default 5. */
  maxCssDepth: number;
  /** Parallel sub-resource fetches. Default 4. */
  assetConcurrency: number;
}

export const DEFAULT_CAPS: CaptureCaps = {
  maxDocumentBytes: 20 * 1024 * 1024,
  maxAssets: 300,
  maxAssetBytes: 25 * 1024 * 1024,
  maxTotalAssetBytes: 150 * 1024 * 1024,
  maxCssDepth: 5,
  assetConcurrency: 4,
};

export interface CaptureOptions {
  /** Storage priority 1 (Protected) to 4 (Opportunistic). Default 3. */
  priority?: 1 | 2 | 3 | 4;
  /** Default `on_change`. */
  versioning?: VersioningPolicy;
  caps?: Partial<CaptureCaps>;
  requestedBy?: "user" | "schedule" | "discovery" | "search" | "system";
  /** Skip conditional requests and the unchanged check, and always create a version. */
  force?: boolean;
  /** Plain integer, no foreign key until Phase 3. */
  sourceId?: number;
  /** Recorded in the activity log when robots.txt was overridden for a user-initiated save (A-04). */
  userInitiated?: boolean;
}

/** The JSON payload of the `fetch` job. */
export interface FetchJobPayload {
  downloadJobId: number;
  url: string;
  options: CaptureOptions;
}

/** The state a stage can read and write. */
export interface StageContext {
  readonly deps: PipelineDeps;
  readonly versionId: number;
  readonly signal?: AbortSignal;
  /** Per-run cache for large derived values (decoded HTML). Never persisted. */
  readonly cache: Map<string, unknown>;
  caps: CaptureCaps;
  versioning: VersioningPolicy;
}

export type StageResult = void | { detail?: Record<string, unknown>; outcome?: "unchanged" };
export type StageFn = (ctx: StageContext) => Promise<StageResult> | StageResult;

/** Thrown by a stage for failures that retrying will not fix. */
export class StageFailure extends Error {
  constructor(
    message: string,
    readonly code: "network" | "robots_blocked" | "ssrf_blocked" | "size_cap" | "disk_full" | "timeout" | "http_4xx" | "http_5xx" | "parse_error" | "limit_reached" | "internal" = "parse_error",
  ) {
    super(message);
    this.name = "StageFailure";
  }
}

export interface PipelineFaults {
  /** Runs after a stage is committed as done. Throw `SimulatedCrash` or kill the process to test resume. */
  afterStage?(stage: PipelineStage, versionId: number): void | Promise<void>;
  /** Runs after the stage's work and before it is committed as done. */
  beforeStageDone?(stage: PipelineStage, versionId: number): void | Promise<void>;
}

export interface PipelineDeps {
  db: Db;
  clock: Clock;
  blobs: BlobStore;
  fetcher: PipelineFetcher;
  extract: ExtractClient;
  activity: ActivityLog;
  events: EventBus;
  queue: JobQueue;
  /** Normalised dedup key for a URL (applies the pipeline's query policy). */
  urlKey(url: string): string;
  newId(prefix: "pg" | "ver" | "dl"): string;
  /** Pause between stage attempts. Tests pass a no-op. */
  sleep(ms: number): Promise<void>;
  maxStageAttempts: number;
  faults?: PipelineFaults;
  /** Replaces a built-in stage. The rendering code registers `render_prep` here. */
  stageOverrides?: Partial<Record<PipelineStage, StageFn>>;
  log: { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
}
