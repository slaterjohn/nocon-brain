import { z } from "zod";

/**
 * Environment configuration. Variable names follow docs/architecture.md "Environment variables".
 * Only what wave 1 needs is here; later tasks add their own variables to this schema.
 */
const bool = (d: boolean) =>
  z.preprocess(
    (v) => (v === undefined || v === "" ? d : v === true || ["true", "1", "yes"].includes(String(v).toLowerCase())),
    z.boolean(),
  );

const int = (d: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(
    (v) => (v === undefined || v === "" ? d : typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v) : v),
    z.number({ error: "must be a whole number" }).int({ error: "must be a whole number" }).min(min).max(max),
  );

const list = (d: string[]) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v === undefined ? d : v),
    z.array(z.string()),
  );

const port = (d: number) => int(d, 1, 65535);

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  NCB_APP_URL: z.url({ error: "must be an absolute URL, for example http://localhost:3000" }).default("http://localhost:3000"),
  NCB_WEB_PORT: port(3000),
  NCB_API_PORT: port(3001),
  NCB_ARCHIVE_PORT: port(3002),
  /** Where the browser reaches the archive listener. Empty: the request host plus `NCB_ARCHIVE_PORT`. */
  NCB_ARCHIVE_PUBLIC_URL: z.union([z.literal(""), z.url({ error: "must be empty or an absolute URL, for example https://archive.example.org" })]).default(""),
  /** Host the API and archive listeners bind to. The API port is not published by Compose unless the Human asks. */
  NCB_API_HOST: z.string().min(1).default("0.0.0.0"),
  NCB_ARCHIVE_HOST: z.string().min(1).default("0.0.0.0"),
  NCB_AUTH_MODE: z.enum(["password", "trusted-lan"]).default("password"),
  NCB_TRUSTED_LAN_CIDRS: list([]),
  NCB_PROXY_SECRET: z.string().min(16, "must be at least 16 characters (openssl rand -hex 32)").optional(),
  NCB_SECRET_KEY: z.string().min(16, "must be at least 16 characters").optional(),
  NCB_COOKIE_SECURE: bool(false),
  NCB_TRUST_PROXY: bool(false),
  NCB_TRUSTED_PROXY_CIDRS: list([]),
  NCB_DATA_DIR: z.string().min(1).default("/data"),
  NCB_VOLUMES_ALLOWED_ROOTS: list(["/volumes"]),
  NCB_MIN_FREE_DISK_GB: int(5, 0),
  NCB_RESOURCE_PROFILE: z.enum(["pi-lite", "standard"]).optional(),
  NCB_PER_HOST_CONCURRENCY: int(1, 1, 16),
  NCB_MAX_FETCH_CONCURRENCY: int(2, 1, 64),
  NCB_EXTRACT_WORKERS: int(1, 0, 16),
  NCB_WORKER_MEMORY_MB: int(256, 16, 16384),
  /** libzim cluster cache per open knowledge package, in MiB (task Z-02). */
  NCB_ZIM_CACHE_MB: int(16, 1, 4096),
  /** Time budget for one knowledge package in a combined search, in milliseconds (task Z-05). Default of the `search.zimSearchBudgetMs` setting. */
  NCB_ZIM_SEARCH_BUDGET_MS: int(800, 100, 10_000),
  NCB_CONTACT: z.string().optional(),
  /**
   * Replaces `https://<language>.wikipedia.org` for every Wikipedia request (task Z-07): a mirror, or the local fake the tests use. The
   * Wikimedia rules (identifying User-Agent, 1 request a second) still apply. Empty: the real Wikipedia.
   */
  NCB_WIKIPEDIA_ORIGIN: z.union([z.literal(""), z.url({ error: "must be empty or an absolute URL" })]).default(""),
  NCB_CONNECTIVITY_PROBE_URL: z.union([z.literal(""), z.url({ error: "must be empty or an absolute URL" })]).default(""),
  NCB_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  NCB_LOG_FORMAT: z.enum(["json", "pretty"]).default("json"),
  NCB_ACTIVITY_LOG_RETENTION_DAYS: int(30, 1),
  NCB_SHUTDOWN_GRACE_SECONDS: int(25, 1, 600),
  NCB_TZ: z.string().default("UTC"),
  NCB_SCHEDULER_ENABLED: bool(true),
  /** Requests a minute per client IP across the API (docs/api.md section 1). The end-to-end suite raises it. */
  NCB_RATE_LIMIT_PER_MINUTE: int(600, 10, 1_000_000),
  /** Largest file `POST /api/archive/import` accepts, in MiB (C-14). */
  NCB_IMPORT_MAX_MB: int(50, 1, 2048),
  /** Where the optional renderer container listens, for example http://renderer:8080. Empty: rendering is off (C-16). */
  NCB_RENDERER_URL: z.union([z.literal(""), z.url({ error: "must be empty or an absolute URL, for example http://renderer:8080" })]).default(""),
  /** Shared by `server` and `renderer`: the renderer's API bearer token and its password at the forward proxy. Defaults to NCB_PROXY_SECRET. */
  NCB_RENDERER_SECRET: z.string().min(16, "must be at least 16 characters").optional(),
  /** The guarded forward proxy for the renderer. It starts only when NCB_RENDERER_URL is set. 0 picks a free port (tests). */
  NCB_RENDER_PROXY_PORT: int(3128, 0, 65535),
  NCB_RENDER_PROXY_HOST: z.string().min(1).default("0.0.0.0"),
  /** Pages rendered at once. Only the default of the `resources.renderConcurrency` setting, which the renderer reads live. */
  NCB_RENDER_CONCURRENCY: int(1, 1, 4),
  /** Wall-clock budget for one rendered page, in seconds. */
  NCB_RENDER_TIMEOUT_SECONDS: int(45, 5, 300),
  /** Hosts that are never rendered, exact or `*.suffix`. */
  NCB_RENDER_NEVER_HOSTS: list([]),
});

export type Env = z.infer<typeof envSchema>;

export interface ConfigIssue {
  variable: string;
  message: string;
}

/** Thrown for invalid configuration. The message names every offending variable. */
export class ConfigError extends Error {
  readonly issues: ConfigIssue[];
  constructor(issues: ConfigIssue[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  ${i.variable}: ${i.message}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export interface ResolvedConfig extends Env {
  /** Resolved from NCB_RESOURCE_PROFILE, else `pi-lite` on arm64 and `standard` otherwise. */
  resourceProfile: "pi-lite" | "standard";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, arch: string = process.arch): ResolvedConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => ({ variable: String(i.path[0] ?? "(unknown)"), message: i.message })),
    );
  }
  const e = parsed.data;
  if (e.NODE_ENV === "production" && !e.NCB_PROXY_SECRET) {
    throw new ConfigError([{ variable: "NCB_PROXY_SECRET", message: "is required in production (openssl rand -hex 32)" }]);
  }
  return { ...e, resourceProfile: e.NCB_RESOURCE_PROFILE ?? (arch === "arm64" ? "pi-lite" : "standard") };
}
