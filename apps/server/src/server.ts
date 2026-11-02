import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Clock, ResolvedConfig } from "@ncb/shared";
import { AppError, steadyClock, systemClock } from "@ncb/shared";
import { JobQueue, openMainDatabase, type MainDatabase } from "@ncb/db";
import { buildApp, type BuildOptions } from "./app.js";
import { ArchiveTokenService, createArchiveListener, type ArchiveListener, type CaptureStore } from "./archive/index.js";
import { ServerState, type Services } from "./context.js";
import { CidrError, privateCidrMatcher } from "./lib/cidr.js";
import { loadSecretKey } from "./lib/secrets.js";
import { LoginThrottle } from "./lib/throttle.js";
import { WorkerPool, type PoolOptions } from "./runtime/pool.js";
import { allowlistFromEnv, buildUserAgent, createFetcher, createSsrfGuard, RobotsService, type FetcherOptions, type SsrfGuard } from "@ncb/fetch";
import { SqliteCaptureStore } from "./pipeline/capture-store.js";
import { BrowserService } from "./services/browser.js";
import { BookmarksService, HistoryService } from "./services/bookmarks.js";
import { LibraryService } from "./services/library.js";
import { CollectionService } from "./collections/service.js";
import { ScheduleService } from "./schedule/service.js";
import { Scheduler } from "./schedule/scheduler.js";
import { EngineCrawlPort, type CrawlPort } from "./sources/crawl-port.js";
import type { DiscoveryFetcher } from "./sources/discovery/fetch.js";
import { SourceService } from "./sources/service.js";
import { ExtractClient } from "./pipeline/extract-client.js";
import { createPipelineDeps, PipelineService } from "./pipeline/service.js";
import { ImportService } from "./imports/service.js";
import { RendererClient } from "./renderer/client.js";
import { GuardedProxy } from "./renderer/proxy.js";
import { RenderService } from "./renderer/service.js";
import { CrawlService } from "./crawl/service.js";
import { crawlConfigForDownload, DownloadService } from "./downloads/index.js";
import { RefreshService } from "./refresh/index.js";
import { ResourceGovernor } from "./limits/governor.js";
import { SearchService, type SearchServiceOptions } from "./search/service.js";
import { workerStatuses } from "./routes/system.js";
import type { PipelineFaults, PipelineFetcher } from "./pipeline/types.js";
import { VERSION } from "./version.js";
import { JobRunner } from "./runtime/runner.js";
import { ActivityLog } from "./services/activity.js";
import { AuthService } from "./services/auth.js";
import { BlobStore, type BlobStoreOptions } from "./services/blobs.js";
import { ConnectivityService, type ProbeFn } from "./services/connectivity.js";
import { EventBus } from "./services/events.js";
import { ConnectivityGuardedFetcher, isNetworkError, NotImplementedFetcher, type Fetcher } from "./services/fetcher.js";
import { SettingsService } from "./services/settings.js";
import { GIB, VolumeService, type VolumeProbes } from "./services/volumes.js";

export { buildApp } from "./app.js";
export * from "./archive/index.js";
export { ServerState, type Services } from "./context.js";
export * from "./services/blobs.js";
export * from "./services/connectivity.js";
export * from "./services/fetcher.js";
export * from "./services/settings.js";
export * from "./services/browser.js";
export * from "./services/bookmarks.js";
export * from "./services/library.js";
export * from "./services/volumes.js";
export { handlerFor, JobRunner } from "./runtime/runner.js";
export { WorkerPool } from "./runtime/pool.js";
export * from "./pipeline/index.js";
export * from "./crawl/index.js";
export * from "./downloads/index.js";
export * from "./refresh/index.js";
export * from "./limits/index.js";
export { SourceService } from "./sources/service.js";
export { CollectionService } from "./collections/service.js";
export { ScheduleService } from "./schedule/service.js";
export { Scheduler } from "./schedule/scheduler.js";
export * from "./sources/crawl-port.js";
export { linkPageSource, sourceReferences } from "./sources/references.js";
export { collectionReferences } from "./collections/references.js";
export { ImportService } from "./imports/service.js";
export { RenderService } from "./renderer/service.js";
export { SearchService } from "./search/service.js";
export { GuardedProxy } from "./renderer/proxy.js";
export { decideRender } from "./renderer/triggers.js";

export interface ServerOptions extends BuildOptions {
  config: ResolvedConfig;
  /** Wall clock. Defaults to the system clock; tests pass a `FakeClock`. */
  clock?: Clock;
  /** Bundled worker (dist/worker.js). Defaults to the file next to this module. */
  workerFile?: string | URL;
  workerExecArgv?: string[];
  pool?: Partial<PoolOptions>;
  /** Replaces the (not yet implemented) fetcher. It is still wrapped by the connectivity guard. */
  fetcher?: Fetcher;
  probe?: ProbeFn;
  volumeProbes?: VolumeProbes;
  blobFault?: BlobStoreOptions["faultBeforeRename"];
  runnerPollMs?: number;
  leaseMs?: number;
  /** Replaces the real guarded fetcher for captures (tests). */
  captureFetcher?: PipelineFetcher;
  /** Extra `createFetcher` options for captures, for example `ssrf: createSsrfGuard({ allow: "127.0.0.1" })` in tests. */
  captureFetcherOptions?: Partial<FetcherOptions>;
  pipelineFaults?: PipelineFaults;
  /** Stage implementations that replace the built-in ones (the rendering code registers `render_prep`). */
  stageOverrides?: import("./pipeline/types.js").PipelineDeps["stageOverrides"];
  /** Runs crawl-type source runs (website, section, linked collection). Defaults to the crawl engine (`startCrawl`); tests may replace it. */
  crawlPort?: CrawlPort;
  /** Scheduler tick settings (tests use a short `tickMs`). */
  scheduler?: { tickMs?: number; graceMs?: number };
  /** The SSRF guard of the renderer's forward proxy. Default: the one the capture fetcher uses (`captureFetcherOptions.ssrf`), else the environment allowlist. */
  renderProxyGuard?: SsrfGuard;
  /** Resource limit sampling. Tests pass synthetic sources and short intervals. */
  limits?: { lagSource?: () => number; loadSource?: () => number; cpuTickMs?: number; diskTickMs?: number };
  /** Start the archive listener on `listen()`. Default true. */
  archive?: boolean;
  /** Where the archive listener reads captures from. Defaults to an empty in-memory store until the pipeline supplies one. */
  archiveStore?: CaptureStore;
  /** Search workers and test flags (task S-01). */
  search?: Partial<Pick<SearchServiceOptions, "searchWorkerFile" | "indexWorkerFile" | "workerExecArgv" | "pollMs" | "batch" | "testFlags" | "autoRebuild">>;
}

export interface NcbServer {
  app: FastifyInstance;
  state: ServerState;
  /** Open the database, run migrations, start the runner and flip health to `ok`. */
  initialize(): Promise<Services>;
  /** Bind the API and archive ports. Safe to call before `initialize()`. */
  listen(): Promise<{ apiPort: number; archivePort?: number }>;
  /** Graceful stop: drain jobs, checkpoint the WAL, close everything. Idempotent. */
  close(): Promise<void>;
  readonly archiveServer?: http.Server;
  /** The archive listener (token service available after `initialize()`). */
  readonly archive?: ArchiveListener;
  /** The renderer's forward proxy; only exists when `NCB_RENDERER_URL` is set, after `initialize()`. */
  readonly renderProxy?: GuardedProxy;
}

/** Where migrations live: next to the bundle (dist/migrations) when bundled, otherwise the db package's folder. */
function migrationsDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.join(here, "migrations");
  return fs.existsSync(bundled) ? bundled : undefined;
}

function resolveWorker(): { file: string; execArgv: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(here, "worker.js");
  if (fs.existsSync(js)) return { file: js, execArgv: [] };
  return { file: path.join(here, "worker.ts"), execArgv: ["--import", "tsx"] };
}

export async function createServer(opts: ServerOptions): Promise<NcbServer> {
  const config = opts.config;
  const clock = opts.clock ?? systemClock;
  const state = new ServerState();
  const app = await buildApp(state, config, opts);
  const archive: ArchiveListener | undefined =
    opts.archive === false ? undefined : createArchiveListener({ appUrl: config.NCB_APP_URL, clock, store: opts.archiveStore });
  const archiveServer = archive?.server;
  let main: MainDatabase | undefined;
  let svc: Services | undefined;
  let closed: Promise<void> | undefined;
  let jumpTimer: NodeJS.Timeout | undefined;
  let maintenanceTimer: NodeJS.Timeout | undefined;
  let renderProxy: GuardedProxy | undefined;

  const server: NcbServer = {
    get renderProxy() {
      return renderProxy;
    },
    app,
    state,
    archiveServer,
    archive,

    async listen() {
      await app.listen({ host: config.NCB_API_HOST, port: config.NCB_API_PORT });
      const address = app.server.address();
      const apiPort = typeof address === "object" && address ? address.port : config.NCB_API_PORT;
      let archivePort: number | undefined;
      if (archiveServer) {
        await new Promise<void>((resolve, reject) => {
          archiveServer.once("error", reject);
          archiveServer.listen(config.NCB_ARCHIVE_PORT, config.NCB_ARCHIVE_HOST, () => resolve());
        });
        const a = archiveServer.address();
        archivePort = typeof a === "object" && a ? a.port : config.NCB_ARCHIVE_PORT;
      }
      return { apiPort, archivePort };
    },

    async initialize() {
      // Let the event loop answer `starting` health checks before the synchronous database work begins.
      await new Promise((r) => setImmediate(r));
      for (const d of ["db", "index", "secrets", "tmp", "backups"]) fs.mkdirSync(path.join(config.NCB_DATA_DIR, d), { recursive: true });

      main = openMainDatabase({
        dataDir: config.NCB_DATA_DIR,
        clock,
        migrationsDir: migrationsDir(),
        log: (m) => app.log.info(m),
      });
      const db = main.db;
      await new Promise((r) => setImmediate(r));
      // Fail fast on an unsafe trusted-LAN configuration, before the data directory or its writer lock is touched.
      if (config.NCB_AUTH_MODE === "trusted-lan") {
        try {
          privateCidrMatcher(config.NCB_TRUSTED_LAN_CIDRS);
        } catch (e) {
          if (e instanceof CidrError) throw new AppError("bad_request", `NCB_TRUSTED_LAN_CIDRS: ${e.message}`);
          throw e;
        }
        if (config.NCB_TRUSTED_LAN_CIDRS.length === 0) throw new AppError("bad_request", "NCB_AUTH_MODE=trusted-lan needs NCB_TRUSTED_LAN_CIDRS.");
      }

      const events = new EventBus(clock);
      const activity = new ActivityLog(db, clock);
      const secretKey = loadSecretKey(config.NCB_SECRET_KEY, config.NCB_DATA_DIR);
      const settings = new SettingsService({ db, clock, config, secretKey });
      archive?.attach({
        tokens: new ArchiveTokenService({ secret: secretKey, clock }),
        showLinkStates: () => (settings.internal("browser") as { showLinkStates: boolean }).showLinkStates,
      });
      const auth = new AuthService(db, clock);
      const volumes = new VolumeService({
        db, clock,
        allowedRoots: config.NCB_VOLUMES_ALLOWED_ROOTS,
        minFreeBytes: config.NCB_MIN_FREE_DISK_GB * GIB,
        probes: opts.volumeProbes,
      });
      const blobs = new BlobStore({ db, clock, volumes, faultBeforeRename: opts.blobFault });
      const connectivity = new ConnectivityService({ clock, settings, events, probe: opts.probe });
      const fetcher = new ConnectivityGuardedFetcher(opts.fetcher ?? new NotImplementedFetcher(), connectivity);

      // Trusted-LAN read-only mode: off unless asked for, private ranges only, never without an admin.
      let guestMatcher: Services["guestMatcher"] = null;
      if (config.NCB_AUTH_MODE === "trusted-lan") {
        try {
          guestMatcher = privateCidrMatcher(config.NCB_TRUSTED_LAN_CIDRS);
        } catch (e) {
          if (e instanceof CidrError) throw new AppError("bad_request", `NCB_TRUSTED_LAN_CIDRS: ${e.message}`);
          throw e;
        }
        if (config.NCB_TRUSTED_LAN_CIDRS.length === 0) throw new AppError("bad_request", "NCB_AUTH_MODE=trusted-lan needs NCB_TRUSTED_LAN_CIDRS.");
        if (!auth.hasAdmin()) {
          throw new AppError("setup_required", "Trusted-LAN mode needs an administrator account. Start in password mode, finish setup, then switch the mode on.");
        }
      }

      // Resource limits (C-10): global concurrency, per-host limits, the shared bandwidth limiter, CPU and disk guards.
      const limits = new ResourceGovernor({
        clock, settings, volumes, events, activity, log: app.log,
        lagSource: opts.limits?.lagSource, loadSource: opts.limits?.loadSource, cpuTickMs: opts.limits?.cpuTickMs, diskTickMs: opts.limits?.diskTickMs,
      });

      // Queue time is the steady clock so a wall-clock jump cannot expire leases (F-18).
      const queue = new JobQueue(db, { clock: steadyClock(clock), leaseMs: opts.leaseMs ?? 60_000, hostLimits: () => limits.hostLimits() });

      const poolSize = settings.internal("resources").extractWorkers;
      const worker = opts.workerFile ? { file: opts.workerFile, execArgv: opts.workerExecArgv ?? [] } : resolveWorker();
      const memMb = settings.internal("resources").workerMemoryMb;
      const pool =
        poolSize > 0
          ? new WorkerPool({
              name: "extract",
              size: poolSize,
              workerFile: worker.file,
              execArgv: worker.execArgv,
              resourceLimits: { maxOldGenerationSizeMb: memMb, maxYoungGenerationSizeMb: Math.max(8, Math.floor(memMb / 8)) },
              clock,
              log: app.log,
              onHeartbeat: (s) => events.publish("worker.heartbeat", s),
              onSlotChange: (s) => events.publish("worker.state", s),
              ...opts.pool,
            })
          : undefined;

      const userAgent = buildUserAgent({ version: VERSION, contact: config.NCB_APP_URL });
      const realFetcher = createFetcher({ userAgent, isOffline: () => connectivity.forced, bodyThrottle: () => limits.bandwidth.transform(), ...opts.captureFetcherOptions });
      const rawCapture: PipelineFetcher = opts.captureFetcher ?? (realFetcher as unknown as PipelineFetcher);
      // Every outcome feeds passive connectivity, and forced offline refuses the call, as for any outbound request.
      const captureFetcher: PipelineFetcher = {
        async fetch(url, o) {
          connectivity.assertCanReachInternet({ background: false });
          try {
            const r = await rawCapture.fetch(url, o);
            connectivity.recordOutcome({ ok: true });
            return r;
          } catch (e) {
            if (isNetworkError(e) || (e as { code?: string }).code === "network") connectivity.recordOutcome({ ok: false, network: true });
            throw e;
          }
        },
      };
      const robots = new RobotsService({ fetcher: realFetcher, userAgentToken: "NoConBrain", now: () => Date.now() });
      const extractClient = new ExtractClient(pool);
      const collections = new CollectionService({ db, clock, activity });
      let searchRef: SearchService | undefined;
      // Optional renderer (C-16). Everything below is inert unless NCB_RENDERER_URL is set.
      const rendererSecret = config.NCB_RENDERER_SECRET ?? config.NCB_PROXY_SECRET;
      let render: RenderService | undefined;
      const deps = createPipelineDeps({
        db, clock, blobs, fetcher: captureFetcher, extract: extractClient, activity, events, queue, log: app.log,
        faults: opts.pipelineFaults, stageOverrides: opts.stageOverrides, onPageChanged: (id) => { collections.onPageChanged(id); searchRef?.wake(); },
        onVersionDone: (id, o) => render?.consider(id, o),
      });
      render = new RenderService({
        deps,
        client: config.NCB_RENDERER_URL ? new RendererClient({ baseUrl: config.NCB_RENDERER_URL, secret: rendererSecret }) : undefined,
        robots,
        concurrency: () => renderConcurrency(settings, config.NCB_RENDER_CONCURRENCY),
        neverHosts: () => config.NCB_RENDER_NEVER_HOSTS,
        timeoutMs: config.NCB_RENDER_TIMEOUT_SECONDS * 1000,
        userAgent,
        assertOnline: () => connectivity.assertCanReachInternet({ background: false }),
        log: app.log,
      });
      // A change to resources.renderConcurrency reaches jobs already queued, not only the next one.
      if (config.NCB_RENDERER_URL) settings.onChange((group) => { if (group === "resources") render?.applyConcurrency(); });
      if (config.NCB_RENDERER_URL) {
        renderProxy = new GuardedProxy({
          guard: opts.renderProxyGuard ?? opts.captureFetcherOptions?.ssrf ?? createSsrfGuard({ allow: allowlistFromEnv() }),
          token: rendererSecret, host: config.NCB_RENDER_PROXY_HOST, port: config.NCB_RENDER_PROXY_PORT,
          isOffline: () => connectivity.forced,
          onEvent: (e) => { if (e.type === "blocked") app.log.warn({ target: e.target, reason: e.reason, method: e.method }, "renderer proxy blocked a request"); },
        });
        const addr = await renderProxy.listen();
        app.log.info({ port: addr.port }, "renderer forward proxy listening");
      }
      const pipeline = new PipelineService({
        fetcher: captureFetcher,
        robots,
        deps,
      });

      const store: CaptureStore = opts.archiveStore ?? new SqliteCaptureStore({
        db, blobs, urlKey: deps.urlKey, connectivity: () => (connectivity.snapshot().state === "offline" ? "offline" : "online"),
      });
      archive?.attach({ store });

      // A guarded HEAD for `live-check`: the same SSRF-guarded fetcher as captures, counted by the connectivity service.
      const head = async (url: string, signal?: AbortSignal) => {
        connectivity.assertCanReachInternet({ background: false });
        try {
          const r = await realFetcher.fetch(url, { method: "HEAD", maxBytes: 64 * 1024, accept: ["*/*"], signal });
          connectivity.recordOutcome({ ok: true });
          return r;
        } catch (e) {
          if (isNetworkError(e) || (e as { code?: string }).code === "network") connectivity.recordOutcome({ ok: false, network: true });
          throw e;
        }
      };
      const refresh = new RefreshService({ db, clock, queue, pipeline, robots, activity, events, log: app.log });
      const history = new HistoryService({ db, clock, settings, pipeline });
      // Sitemaps and feeds are read through the same guarded fetcher as captures.
      const discoveryFetcher: DiscoveryFetcher = {
        fetch: async (url, o) => {
          connectivity.assertCanReachInternet({ background: true });
          try {
            const r = await realFetcher.fetch(url, { maxBytes: o.maxBytes, accept: o.accept, signal: o.signal });
            connectivity.recordOutcome({ ok: true });
            return r;
          } catch (e) {
            if (isNetworkError(e) || (e as { code?: string }).code === "network") connectivity.recordOutcome({ ok: false, network: true });
            throw e;
          }
        },
      };
      const schedules = new ScheduleService({ db, clock });
      let libraryRef: LibraryService | undefined;
      let crawlRef: CrawlService | undefined;
      const sources = new SourceService({
        db, clock, settings, schedules, pipeline, crawl: opts.crawlPort ?? new EngineCrawlPort(() => crawlRef!, () => settings.internal("resources").profile), fetcher: discoveryFetcher, queue, activity, events,
        volumeId: (pid) => db.get<{ id: number }>("SELECT id FROM volumes WHERE public_id = ?", [pid])?.id,
        deletePage: (pid) => { libraryRef?.deletePage(pid, { confirmProtected: true, exclude: true }); },
        onCollectionsChanged: (id) => collections.backfillSource(id),
        refresh, previewRobots: robots,
        freeBytes: () => {
          const room = volumes.list().filter((v) => v.state === "online").map((v) => Math.max(0, (v.statFree ?? 0) - v.reserveFreeBytes));
          return room.length ? Math.max(...room) : undefined;
        },
        crawlControl: { pause: (id) => crawlRef?.pause(id), resume: (id) => crawlRef?.resume(id), cancel: (id) => crawlRef?.cancel(id) },
      });
      sources.ensureSystemSources();
      const imports = new ImportService({ deps, maxBytes: config.NCB_IMPORT_MAX_MB * 1024 * 1024, importsSourceId: () => sources.systemId("imports") });
      collections.ensureFavourites();
      const browser = new BrowserService({ db, clock, config, settings, connectivity, pipeline, archive, history, head, quickSavesSourceId: () => sources.systemId("quick_saves") });
      const bookmarks = new BookmarksService({ db, clock, settings, pipeline });
      const library = new LibraryService({ db, clock, pipeline, browser, store, blobs, activity, collections });
      libraryRef = library;
      // Captures queued while offline wait, held, until the server is no longer known to be offline (the connection is seen
      // again, or "work offline" is switched off).
      events.subscribe((e) => {
        if (e.type === "connectivity" && (e.data as { state?: string }).state !== "offline") {
          try {
            pipeline.resumeHeld();
          } catch (err) {
            app.log.warn({ err: String(err) }, "could not release held captures");
          }
        }
      });

      const scheduler = new Scheduler({
        db, clock, service: schedules, queue, activity, events, tickMs: opts.scheduler?.tickMs, graceMs: opts.scheduler?.graceMs,
        run: (rowId) => sources.runById(rowId, { requestedBy: "schedule" }).then(() => undefined),
      });
      schedules.recomputeAll(clock.now());
      const crawl = new CrawlService({ db, clock, queue, activity, events, pipeline, robots, log: app.log });
      crawlRef = crawl;
      const runner = new JobRunner({
        queue, pool, activity, events, clock, log: app.log, pollMs: opts.runnerPollMs, leaseMs: opts.leaseMs,
        mainHandlers: { ...crawl.mainHandlers({ ...pipeline.handlers, ...refresh.handlers }), ...render.handlers }, periodic: () => { scheduler.tick(); },
        mainConcurrency: () => limits.fetchConcurrency(),
      });
      const search = new SearchService({
        db, clock, settings, activity, dataDir: config.NCB_DATA_DIR, log: app.log, isOffline: () => connectivity.forced, ...(opts.search ?? {}),
      });
      searchRef = search;
      collections.savedSearches = { ref: (id) => search.savedSearchRef(id), link: (sid, cid) => search.linkCollection(sid, cid) };
      search.collectionRefresh = () => search.refreshAllCollections();
      const downloads = new DownloadService({
        db, clock, queue, events, activity, crawl, pipeline, refresh, sources, scheduler, schedules, connectivity, governor: limits, settings,
        workers: () => workerStatuses(svc!),
        buildCrawl: (a) => crawlConfigForDownload(a, settings.internal("resources").profile),
      });

      svc = {
        config, clock, main, db, activity, auth, settings, volumes, blobs, connectivity, fetcher, events, queue, runner, pipeline, imports, render, crawl,
        archive, browser, bookmarks, history, library, sources, collections, schedules, scheduler, downloads, refresh, limits, search, throttle: new LoginThrottle(clock), guestMatcher,
      };
      state.attach(svc);

      // Startup housekeeping: every volume's leftovers from a crash are removed before any writer runs.
      await volumes.refreshAll();
      const cleaned = await blobs.cleanTmpAll(0);
      if (cleaned > 0) activity.write({ level: "info", area: "storage", message: `Removed ${cleaned} unfinished temporary file${cleaned === 1 ? "" : "s"} left by a crash` });
      activity.prune(settings.internal("logging").retentionDays);
      auth.sweepExpired();

      connectivity.start();
      runner.start(); // recoverOnStartup runs first, then the workers start
      crawl.start(); // finishes crawls whose last job ended before a crash; watches deadlines
      downloads.start(); // closes downloads whose work all ended; publishes download.update
      limits.start(); // CPU and disk guards
      jumpTimer = setInterval(() => svc?.auth.jumps.check(), 1000);
      jumpTimer.unref();
      maintenanceTimer = setInterval(() => {
        try {
          svc?.auth.sweepExpired();
          svc?.activity.prune(svc.settings.internal("logging").retentionDays);
          svc?.db.checkpoint("PASSIVE");
        } catch (e) {
          app.log.warn({ err: String(e) }, "maintenance failed");
        }
      }, 10 * 60_000);
      maintenanceTimer.unref();

      await search.start(); // opens or rebuilds index.db; searching is available while a missing index rebuilds
      state.phase = "ready";
      activity.write({ level: "info", area: "system", message: "Server started", details: { migrations: main.migration.applied, recovery: runner.recovery } });
      return svc;
    },

    close() {
      closed ??= (async () => {
        const graceMs = config.NCB_SHUTDOWN_GRACE_SECONDS * 1000;
        state.phase = "stopping";
        if (jumpTimer) clearInterval(jumpTimer);
        if (maintenanceTimer) clearInterval(maintenanceTimer);
        for (const s of state.streams) s.end();
        svc?.connectivity.stop();
        svc?.crawl.stop();
        svc?.downloads.stop();
        svc?.limits.stop();
        await renderProxy?.close();
        // Stop claiming, let running stages reach a checkpoint, put the rest back on the queue.
        const drain = svc ? await svc.runner.stop(graceMs) : undefined;
        if (svc && drain) svc.activity.write({ level: "info", area: "system", message: "Server stopping", details: drain });
        if (archiveServer?.listening) await new Promise<void>((r) => archiveServer.close(() => r()));
        archiveServer?.closeAllConnections();
        await app.close();
        await svc?.search.stop();
        main?.close(); // wal_checkpoint(TRUNCATE), close, release the writer lock
      })();
      return closed;
    },
  };
  return server;
}

/** `resources.renderConcurrency`, read every time (so a change applies live). The environment value is only the default of that setting; it is also the fallback here. */
function renderConcurrency(settings: SettingsService, fallback: number): number {
  try {
    const n = Number(settings.internal("resources").renderConcurrency);
    if (Number.isInteger(n) && n >= 0) return Math.min(Math.max(n, 1), 8);
  } catch {
    /* settings not readable yet */
  }
  return fallback;
}
  // A failed start must not keep the data directory locked: release the writer lock before rethrowing.
  const initialize = server.initialize.bind(server);
  server.initialize = async () => {
    try {
      return await initialize();
    } catch (e) {
      main?.close();
      main = undefined;
      throw e;
    }
  };
