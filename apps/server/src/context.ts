import type { Clock, ResolvedConfig } from "@ncb/shared";
import type { BetterSqliteDb, JobQueue, MainDatabase } from "@ncb/db";
import { AppError } from "@ncb/shared";
import type { ActivityLog } from "./services/activity.js";
import type { AuthService } from "./services/auth.js";
import type { BlobStore } from "./services/blobs.js";
import type { ConnectivityService } from "./services/connectivity.js";
import type { EventBus } from "./services/events.js";
import type { Fetcher } from "./services/fetcher.js";
import type { SettingsService } from "./services/settings.js";
import type { VolumeService } from "./services/volumes.js";
import type { LoginThrottle } from "./lib/throttle.js";
import type { JobRunner } from "./runtime/runner.js";
import type { PipelineService } from "./pipeline/service.js";

/** Everything that exists once the database is open and migrated. */
export interface Services {
  config: ResolvedConfig;
  clock: Clock;
  main: MainDatabase;
  db: BetterSqliteDb;
  activity: ActivityLog;
  auth: AuthService;
  settings: SettingsService;
  volumes: VolumeService;
  blobs: BlobStore;
  connectivity: ConnectivityService;
  fetcher: Fetcher;
  events: EventBus;
  queue: JobQueue;
  runner: JobRunner;
  pipeline: PipelineService;
  throttle: LoginThrottle;
  /** Returns true when the address may use trusted-LAN read-only access. Null when the mode is off. */
  guestMatcher: ((ip: string) => boolean) | null;
}

export type Phase = "starting" | "ready" | "stopping";

/**
 * Mutable server state. The HTTP server is up before the database is open so that the health endpoint can
 * say `starting` while migrations run; `svc` throws until `attach` has been called.
 */
export class ServerState {
  phase: Phase = "starting";
  readonly startedAt = Date.now();
  private services?: Services;
  /** Open SSE responses, closed on shutdown. */
  readonly streams = new Set<{ end(): void }>();

  attach(s: Services): void {
    this.services = s;
  }

  get ready(): boolean {
    return this.phase === "ready" && this.services !== undefined;
  }

  get svc(): Services {
    if (!this.services) throw new AppError("internal", "The server is still starting. Try again in a few seconds.");
    return this.services;
  }
}
