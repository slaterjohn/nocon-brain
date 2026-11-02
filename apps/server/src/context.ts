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
import type { ImportService } from "./imports/service.js";
import type { RenderService } from "./renderer/service.js";
import type { ArchiveListener } from "./archive/listener.js";
import type { BrowserService } from "./services/browser.js";
import type { BookmarksService, HistoryService } from "./services/bookmarks.js";
import type { LibraryService } from "./services/library.js";
import type { CrawlService } from "./crawl/service.js";
import type { SourceService } from "./sources/service.js";
import type { CollectionService } from "./collections/service.js";
import type { ScheduleService } from "./schedule/service.js";
import type { Scheduler } from "./schedule/scheduler.js";
import type { DownloadService } from "./downloads/service.js";
import type { RefreshService } from "./refresh/service.js";
import type { ResourceGovernor } from "./limits/governor.js";
import type { SearchService } from "./search/service.js";
import type { ProviderService } from "./online/providers.js";
import type { CoverageService } from "./online/coverage.js";
import type { SavedSearchSources } from "./online/saved-source.js";
import type { ProviderRunner } from "./online/runner.js";
import type { StorageService } from "./storage/service.js";

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
  /** Intelligent storage (Phase 6): planner, executor, admission control, usage, forecast, maintenance. */
  storage: StorageService;
  connectivity: ConnectivityService;
  fetcher: Fetcher;
  events: EventBus;
  queue: JobQueue;
  runner: JobRunner;
  pipeline: PipelineService;
  imports: ImportService;
  render: RenderService;
  crawl: CrawlService;
  /** The archive listener, when this process runs one: frame state and token minting. */
  archive?: ArchiveListener;
  browser: BrowserService;
  bookmarks: BookmarksService;
  history: HistoryService;
  library: LibraryService;
  sources: SourceService;
  collections: CollectionService;
  schedules: ScheduleService;
  scheduler: Scheduler;
  downloads: DownloadService;
  refresh: RefreshService;
  limits: ResourceGovernor;
  search: SearchService;
  providers: ProviderService;
  providerRunner: ProviderRunner;
  coverage: CoverageService;
  savedSources: SavedSearchSources;
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
