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
