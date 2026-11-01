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
  NCB_CONTACT: z.string().optional(),
  NCB_CONNECTIVITY_PROBE_URL: z.union([z.literal(""), z.url({ error: "must be empty or an absolute URL" })]).default(""),
  NCB_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  NCB_LOG_FORMAT: z.enum(["json", "pretty"]).default("json"),
  NCB_ACTIVITY_LOG_RETENTION_DAYS: int(30, 1),
  NCB_SHUTDOWN_GRACE_SECONDS: int(25, 1, 600),
  NCB_TZ: z.string().default("UTC"),
  NCB_SCHEDULER_ENABLED: bool(true),
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
