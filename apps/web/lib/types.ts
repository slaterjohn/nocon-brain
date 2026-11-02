// Shapes from docs/api.md. Copied, not imported: the web app has no workspace dependencies.

export type Priority = "P1" | "P2" | "P3" | "P4";
export type ConnectivityState = "online" | "offline" | "unknown";

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
  requestId: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
  total?: number;
}

export interface SetupStatus {
  adminExists: boolean;
  storageConfigured: boolean;
  profile?: ResourceProfile | null;
  firstSourceCreated: boolean;
  complete: boolean;
}

export type ResourceProfile = "pi-lite" | "standard";

export interface Me {
  user: { id?: string; username: string };
  mode: "admin" | "guest";
  csrfRequired: boolean;
}

export interface Volume {
  id: string;
  name: string;
  rootPath: string;
  state: "online" | "offline" | "readonly" | "draining" | "disabled";
  isDefault: boolean;
  capacityBytes: number;
  quotaBytes?: number;
  usedBytes: number;
  availableBytes: number;
  reservedBytes: number;
  reserveFreeBytes: number;
}

export type StorageWarning = "on_container_filesystem" | "sd_card_suspected" | "low_free_space";

export interface SetupStorageResponse {
  volume: Volume;
  warnings: StorageWarning[];
}

/** POST /api/setup/storage/validate. Registers nothing. */
export interface SetupStorageValidateResponse {
  ok: boolean;
  path?: string;
  totalBytes?: number;
  freeBytes?: number;
  warnings: StorageWarning[];
  errors: { path: string; message: string }[];
}

export interface WorkerStatus {
  name: "runner" | "extract" | "index" | "search" | "zim" | "renderer";
  state: "idle" | "busy" | "down" | "disabled";
  lastHeartbeatAt?: string;
  currentJobId?: string;
  memoryMb?: number;
}

export interface Dashboard {
  pages: { total: number; archived: number; partial: number; evicted: number };
  sources: { total: number; enabled: number };
  collections: number;
  index: { docs: number; sizeBytes: number; drift: number; state: "ok" | "rebuilding" | "missing" };
  storage: { usedBytes: number; availableBytes: number; byPriority: Record<Priority, number> };
  jobs: { active: number; queued: number; failedLast24h: number };
  lastUpdateAt?: string;
  workers: WorkerStatus[];
  connectivity: ConnectivityState;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
// Areas from docs/data-model.md (activity_log.area).
export const LOG_AREAS = ["crawl", "pipeline", "storage", "search", "auth", "system", "zim", "provider"] as const;
export type LogArea = (typeof LOG_AREAS)[number];

/** docs/api.md does not define the log row. This is the shape assumed from the activity_log table. */
export interface LogEntry {
  id: string | number;
  at: string;
  level: LogLevel;
  area: LogArea | string;
  message: string;
  details?: unknown;
  downloadJobId?: string;
}

export interface ConnectivityInfo {
  state: ConnectivityState;
  since?: string;
  source?: "passive" | "probe" | "forced";
}

// ---- Browser, archive, bookmarks and history (docs/api.md sections 3, 4 and 14) ----

export type LinkStateName = "cached" | "partial" | "live_only" | "queued" | "unavailable";

export type PageType = "html" | "pdf" | "markdown" | "text" | "rendered";

export interface PageSummary {
  id: string;
  url: string;
  canonicalUrl: string;
  title: string;
  domain: string;
  type: PageType;
  /** Set for a page made by uploading a file. Its `url` is a made-up address that is never shown. */
  imported?: { filename: string; sizeBytes: number; pageCount?: number };
  language?: string;
  availability: "archived" | "partial" | "evicted" | "failed";
  effectivePriority: Priority;
  latestVersionId?: string;
  versionCount: number;
  firstCapturedAt?: string;
  lastCapturedAt?: string;
  inboundCount: number;
  totalBytes?: number;
}

export interface VersionSummary {
  id: string;
  pageId: string;
  versionNo: number;
  status: string;
  partialReason?: string;
  fetchedAt: string;
  totalBytes: number;
}

export interface FrameInfo {
  url: string;
  frameId: string;
  expiresAt: string;
  sandbox: string;
}

export type Resolution =
  | { kind: "search"; query: string }
  | { kind: "archive"; page: PageSummary; version: VersionSummary; mode: "original" | "reader"; frame: FrameInfo }
  | { kind: "live"; url: string; frameable: boolean | "unknown"; canSave: true; queued?: { downloadId: string } }
  | { kind: "offline"; url: string; reason: "offline" | "forced_offline" | "blocked" | "not_archived"; canQueue: boolean; queued?: { downloadId: string } };

export interface ResolveResponse {
  normalizedUrl: string;
  urlKey: string;
  resolution: Resolution;
  alternatives: ("archive" | "cache" | "zim" | "live" | "reader")[];
  connectivity: ConnectivityState;
}

export interface FrameStateInfo {
  frameId: string;
  url: string;
  title?: string;
  state: LinkStateName | "zim";
  pageId?: string;
  versionId?: string;
  reader?: boolean;
  interstitial?: boolean;
  at: string;
  seq: number;
}

export interface CaptureProgress {
  downloadId: string;
  url: string | null;
  state: "queued" | "running" | "completed" | "failed" | "cancelled" | "paused";
  held: boolean;
  outcome: "pending" | "created" | "unchanged" | "failed";
  label: string;
  percent: number;
  stage?: string;
  pageId?: string;
  versionId?: string;
  failureMessage?: string | null;
}

export interface SaveResponse {
  downloadId: string;
  url: string;
  state: "queued";
  held: boolean;
  priority: number;
}

export interface Bookmark {
  id: string;
  originalUrl: string;
  title: string;
  archive?: { pageId: string; versionId?: string; availability: PageSummary["availability"] };
  referencePriority: number;
  createdAt: string;
}

export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  visitedAt: string;
  servedFrom: "archive" | "cache" | "zim" | "live" | "offline";
  pageId?: string;
}

export interface FindResult {
  query: string;
  count: number;
  anchors: string[];
  truncated: boolean;
}

export interface DeletePreview {
  versions: number;
  exclusiveBytes: number;
  sharedBytesKept: number;
  references: { sources: string[]; collections: string[]; bookmarks: number; pins: Priority[] };
  requiresConfirmation: boolean;
}

export interface BrowserSettings {
  showLinkStates: boolean;
  liveFrames: boolean;
  bookmarkPriority: number;
  autoCacheOpened: boolean;
  preferCached: boolean;
  quickSavePriority: number;
}

// ---- Sources, collections and downloads (docs/api.md sections 7 and 8) ----

export type SourceType =
  | "single_page" | "website" | "section" | "linked_collection" | "sitemap" | "feed"
  | "saved_search" | "knowledge_package" | "imported_documents";
export type SourceProfile = "focused" | "balanced" | "comprehensive" | "custom";
export type SourceStrategy = "capture" | "explore" | "mirror";
export type SourceStatus = "never" | "running" | "ok" | "failed" | "paused" | "cancelled";

export interface SourceConfig {
  depth: number;
  maxPages: number;
  maxBytes: number;
  maxDurationSeconds: number;
  allowedDomains: string[];
  excludedDomains: string[];
  allowedPaths: string[];
  excludedPaths: string[];
  includeExternal: boolean;
  externalDepth: number;
  assets: "all" | "same_origin" | "images_css_only" | "none";
  concurrency: number;
  perDomainDelayMs: number;
  retries: number;
  queryParamPolicy: "keep_all" | "strip_tracking" | "allowlist" | "drop_all";
  queryParamAllowlist: string[];
  respectRobots: boolean;
  versioning: { mode: "latest_only" | "all" | "last_n" | "period" | "on_change"; n?: number; period?: "day" | "week" | "month" };
  renderMode: "never" | "auto" | "always";
  linkWeights: Partial<Record<"main" | "heading" | "related" | "nav" | "footer", number>>;
  maxLinksPerPage: number;
  userAgentSuffix?: string;
  sitemapMaxDepth: number;
}

export type RetentionSpec =
  | { mode: "all" }
  | { mode: "latest"; count: number }
  | { mode: "time"; days: number; keepLatest?: boolean }
  | { mode: "budget"; bytes: number }
  | { mode: "custom"; combine: "union" | "intersection"; rules: Exclude<RetentionSpec, { mode: "custom" }>[] };

export type ScheduleKind = "manual" | "hourly" | "daily" | "weekly" | "cron";
export type DayName = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface DownloadWindow {
  id: string;
  sourceId: string | null;
  name: string;
  days: DayName[];
  start: string;
  end: string;
  timezone: string;
  limits: { concurrency?: number; bandwidthKbps?: number } | null;
  enabled: boolean;
}

export interface Schedule {
  id: string;
  sourceId: string | null;
  kind: ScheduleKind;
  minute?: number;
  time?: string;
  dayOfWeek?: number;
  cron?: string;
  expression: string | null;
  timezone: string;
  windowId: string | null;
  window: DownloadWindow | null;
  missedRunPolicy: "skip" | "run_once";
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface Source {
  id: string;
  name: string;
  description: string | null;
  type: SourceType;
  adapter: string;
  startUrl: string | null;
  strategy: SourceStrategy;
  profile: SourceProfile;
  config: SourceConfig;
  configVersion: number;
  priority: Priority;
  retention: RetentionSpec;
  automaticEviction: boolean;
  storageBudgetBytes: number | null;
  preferredVolumeId: string | null;
  discoveryEnabled: boolean;
  enabled: boolean;
  paused: boolean;
  system: boolean;
  systemKind: "quick_saves" | "browsing_cache" | "imports" | null;
  collections: string[];
  schedule: Schedule | null;
  pageCount: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: SourceStatus | null;
  createdAt: string;
  updatedAt: string;
}

/** What the form sends. Mirrors SourceInput in docs/api.md. */
export interface SourceInput {
  name: string;
  description?: string;
  type: SourceType;
  startUrl?: string;
  strategy?: SourceStrategy;
  profile: SourceProfile;
  config: Partial<SourceConfig>;
  priority: Priority;
  retention?: RetentionSpec;
  automaticEviction?: boolean;
  storageBudgetBytes?: number;
  enabled: boolean;
  discoveryEnabled?: boolean;
  schedule?: {
    kind: ScheduleKind;
    minute?: number;
    time?: string;
    dayOfWeek?: number;
    cron?: string;
    timezone: string;
    missedRunPolicy: "skip" | "run_once";
    enabled: boolean;
    /** A download window made together with the schedule. */
    window?: { name: string; days: DayName[]; start: string; end: string; timezone: string; enabled: boolean };
  };
  collections?: string[];
}

export interface SourceCeilings {
  depth: number;
  maxPages: number;
  maxBytes: number;
  maxDurationSeconds: number;
  concurrency: number;
  retries: number;
  externalDepth: number;
  minPerDomainDelayMs: number;
}

export interface SourcePreview {
  valid: boolean;
  type: SourceType;
  config: SourceConfig;
  scope: string[];
  estimate: { pages: { low: number; high: number }; basis: string; estimate: true; label?: string; confidence?: "low" | "medium" | "high"; bytes: { low: number; high: number } };
  sample?: { found: number; sampledFrom?: string };
  warnings: string[];
  ceilings: SourceCeilings;
}

export interface SourcePageRow {
  pageId: string;
  url: string;
  host: string;
  title: string | null;
  availability: PageSummary["availability"];
  effectivePriority: Priority;
  firstSeenAt: string;
  lastSeenAt: string;
  discoveredVia: string;
  depth: number | null;
  priorityOverride: Priority | null;
}

export interface SourceRun {
  id: string;
  kind: string;
  state: string;
  requestedBy: string;
  pagesDone: number;
  pagesFailed: number;
  bytesDone: number;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  failure?: { code: string | null; message: string };
}

export interface SourceStats {
  pages: number;
  versions: number;
  latestBytes: number;
  byPriority: { priority: Priority; pages: number }[];
  lastRuns: SourceRun[];
  failedRuns: number;
  lastRunAt: string | null;
  lastStatus: SourceStatus | null;
}

export interface RunResult {
  downloadIds: string[];
  found?: number;
  newItems?: number;
  excluded?: number;
  warnings?: string[];
}

export type RuleCondition = { field: "domain" | "source" | "title"; value: string };
export interface CollectionRule { match: "all" | "any"; conditions: RuleCondition[] }

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  icon: string;
  kind: "manual" | "auto" | "saved_search" | "favourites";
  parentId: string | null;
  rule: CollectionRule | null;
  priorityFloor: Priority | null;
  sortOrder: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  children?: Collection[];
}

export interface CollectionItem {
  pageId: string;
  url: string;
  host: string;
  title: string | null;
  availability: PageSummary["availability"];
  effectivePriority: Priority;
  addedBy: "user" | "rule" | "source";
  addedAt: string;
}

export type DownloadState = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

export type FailureCode =
  | "network" | "robots_blocked" | "ssrf_blocked" | "size_cap" | "disk_full" | "timeout" | "http_4xx" | "http_5xx"
  | "parse_error" | "limit_reached" | "cancelled_by_user" | "internal";

export interface DownloadEstimate {
  estimate: true;
  pages?: { low: number; high: number };
  bytes?: { low: number; high: number };
  durationSeconds?: { low: number; high: number };
  basis: string;
  confidence: "low" | "medium" | "high";
}

export interface DownloadJob {
  id: string;
  kind: string;
  state: DownloadState;
  priority: Priority;
  queueOrder?: number;
  title: string;
  sourceId?: string;
  sourceName?: string;
  requestedBy: "user" | "schedule" | "discovery" | "search" | "system";
  requestedUrl?: string;
  progress: { pagesDone: number; pagesFailed: number; pagesDiscovered?: number; bytesDone: number; percent?: number; label?: string; etaSeconds?: number };
  estimate?: DownloadEstimate;
  pause?: { reason: "user" | "window_closed" | "volume_full" | "offline"; automatic: boolean; message: string };
  failure?: { code: FailureCode | string; message: string; retryable: boolean; hint: string };
  stop?: { reason: string; message: string };
  summary?: { checked: number; unchanged: number; changed: number; gone: number; failed: number };
  attempts?: number;
  controls?: { pause: boolean; resume: boolean; cancel: boolean; retry: boolean; setPriority: boolean };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  scheduledFor?: string;
  updatedAt?: string;
  crawl?: { mode: string; maxPages?: number; maxBytes?: number; depthReached: number; pagesSkipped: number; deadlineAt?: string; frontier: { queued: number; running: number; held: number } };
}

export interface QueueSummary {
  counts: Record<DownloadState, number>;
  running: DownloadJob[];
  workers: WorkerStatus[];
  window: { open: boolean; opensAt?: string; closesAt?: string };
  limits: Record<string, unknown> & { fetchConcurrency?: number; effectiveFetchConcurrency?: number; profile?: string };
  throttle: { active: boolean; level: string; reason?: string };
  disk: { paused: boolean; pausedDownloads: number; volumes: { id: string; name: string; freeBytes: number; reserveFreeBytes: number; low: boolean }[] };
  connectivity: ConnectivityState;
  nextScheduled?: { scheduleId: string; sourceId: string; sourceName: string; at: string };
}

export interface PageDetail {
  page: PageSummary;
  versions: (VersionSummary & { publishedAt?: string; renderMode?: string })[];
  bookmarks: number;
  sources: PageSourceRef[];
  collections: { id: string; name: string; kind: string; priorityFloor: Priority | null }[];
}

export interface PageSourceRef {
  id: string;
  name: string;
  type: string;
  priority: Priority;
  discoveredVia: string;
  system: boolean;
  systemKind: string | null;
}
