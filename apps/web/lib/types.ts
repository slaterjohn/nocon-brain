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

export interface PageSummary {
  id: string;
  url: string;
  canonicalUrl: string;
  title: string;
  domain: string;
  type: string;
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
