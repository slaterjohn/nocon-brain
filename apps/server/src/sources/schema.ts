import { z } from "zod";
import { parsePriority, type PriorityNumber } from "@ncb/shared";
import { windowInputSchema } from "../schedule/service.js";
import { ceilingsFor, presetFor, type ResourceProfile, type SourceCeilings, type SourceProfile } from "./limits.js";

export const SOURCE_TYPES = ["single_page", "website", "section", "linked_collection", "sitemap", "feed", "saved_search", "knowledge_package", "imported_documents"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
/** Types a source can have in this release. The rest are rejected with a message saying which phase brings them. */
export const SUPPORTED_TYPES = ["single_page", "website", "section", "linked_collection", "sitemap", "feed", "imported_documents"] as const;
/** Types that start from a web address. `imported_documents` holds uploaded files and has no start address. */
export const WEB_TYPES = new Set<string>(["single_page", "website", "section", "linked_collection", "sitemap", "feed"]);

const LATER: Record<string, string> = {
  saved_search: "Saved-search sources arrive with online search. Choose a website, section, sitemap or feed for now.",
  knowledge_package: "Knowledge-package sources arrive with ZIM support. Choose a website, section, sitemap or feed for now.",
};

export const priorityInput = z
  .union([z.enum(["P1", "P2", "P3", "P4"]), z.number().int().min(1).max(4)], { error: "Use P1, P2, P3 or P4" })
  .transform((v) => parsePriority(v) as PriorityNumber);

const host = z.string().trim().min(1).max(253).transform((s) => s.toLowerCase());
const glob = z.string().trim().min(1).max(300);

/** The stored and resolved config (docs/data-model.md section 3.3, API names from docs/api.md section 7). */
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
  /** Sitemap and feed sources: how deep a sitemap index may nest. */
  sitemapMaxDepth: number;
}

const versioning = z
  .object({
    mode: z.enum(["latest_only", "all", "last_n", "period", "on_change"]),
    n: z.number().int().min(1).max(1000).optional(),
    period: z.enum(["day", "week", "month"]).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === "last_n" && v.n === undefined) ctx.addIssue({ code: "custom", path: ["n"], message: "Say how many versions to keep" });
    if (v.mode === "period" && v.period === undefined) ctx.addIssue({ code: "custom", path: ["period"], message: "Choose day, week or month" });
  });

const num = (label: string, min: number) => z.number({ error: `${label} must be a number` }).int(`${label} must be a whole number`).min(min, `${label} must be at least ${min}`);

/** The user-supplied part of a config: every field optional, resolved against the profile preset afterwards. */
export const configInputSchema = z.object({
  depth: num("Depth", 0).optional(),
  maxPages: num("Maximum pages", 1).optional(),
  maxBytes: num("Maximum size", 1024).optional(),
  maxDurationSeconds: num("Maximum duration", 10).optional(),
  allowedDomains: z.array(host).max(100).optional(),
  excludedDomains: z.array(host).max(100).optional(),
  allowedPaths: z.array(glob).max(100).optional(),
  excludedPaths: z.array(glob).max(100).optional(),
  includeExternal: z.boolean().optional(),
  externalDepth: num("External depth", 0).optional(),
  assets: z.enum(["all", "same_origin", "images_css_only", "none"]).optional(),
  concurrency: num("Concurrency", 1).optional(),
  perDomainDelayMs: num("Delay between requests", 0).optional(),
  retries: num("Retries", 0).optional(),
  queryParamPolicy: z.enum(["keep_all", "strip_tracking", "allowlist", "drop_all"]).optional(),
  queryParamAllowlist: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  respectRobots: z.boolean().optional(),
  versioning: versioning.optional(),
  renderMode: z.enum(["never", "auto", "always"]).optional(),
  linkWeights: z.partialRecord(z.enum(["main", "heading", "related", "nav", "footer"]), z.number().min(0).max(10)).optional(),
  maxLinksPerPage: num("Links per page", 1).max(5000).optional(),
  userAgentSuffix: z.string().trim().max(60).regex(/^[\w .\-/]*$/, "Use letters, numbers and . - / only").optional(),
  sitemapMaxDepth: num("Sitemap nesting", 0).max(5).optional(),
});
export type ConfigInput = z.infer<typeof configInputSchema>;

export const retentionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }),
  z.object({ mode: z.literal("latest"), count: z.number().int().min(1).max(1000) }),
  z.object({ mode: z.literal("time"), days: z.number().int().min(1).max(36500), keepLatest: z.boolean().optional() }),
  z.object({ mode: z.literal("budget"), bytes: z.number().int().min(1) }),
]);
const retentionOrCustom = z.union([
  retentionSchema,
  z.object({ mode: z.literal("custom"), combine: z.enum(["union", "intersection"]), rules: z.array(retentionSchema).min(1).max(4) }),
]);
export type RetentionSpec = z.infer<typeof retentionOrCustom>;
export { retentionOrCustom as retentionSpecSchema };

export const scheduleInputSchema = z
  .object({
    kind: z.enum(["manual", "hourly", "daily", "weekly", "cron"]),
    /** hourly: minute past the hour (0 to 59). */
    minute: z.number().int().min(0).max(59).optional(),
    /** daily and weekly: local time of day, "HH:MM". */
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time such as 03:30").optional(),
    /** weekly: 0 = Sunday ... 6 = Saturday, as cron counts them. */
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    cron: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().trim().min(1).max(64).default("UTC"),
    windowId: z.string().max(64).nullable().optional(),
    /** A download window created together with the schedule (only this source's schedule uses it). */
    window: windowInputSchema.optional(),
    missedRunPolicy: z.enum(["skip", "run_once"]).default("run_once"),
    enabled: z.boolean().default(true),
  });
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

export interface SourceInput {
  name: string;
  description?: string;
  type: SourceType;
  adapter: "http";
  startUrl?: string;
  strategy?: "capture" | "explore" | "mirror";
  profile: SourceProfile;
  config: ConfigInput;
  priority: PriorityNumber;
  retention?: RetentionSpec;
  automaticEviction?: boolean;
  storageBudgetBytes?: number;
  preferredVolumeId?: string;
  discoveryEnabled: boolean;
  enabled: boolean;
  schedule?: ScheduleInput;
  collections?: string[];
  savedSearchId?: string;
}

function checkUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Ceiling checks produce one field message per limit, each naming the limit and the profile it comes from. */
export function checkCeilings(config: ConfigInput, ceilings: SourceCeilings, profile: ResourceProfile, ctx: z.RefinementCtx, prefix: (string | number)[] = ["config"]): void {
  const over = (field: keyof SourceCeilings, label: string, value: number | undefined, unit = "") => {
    if (value !== undefined && value > ceilings[field]) {
      ctx.addIssue({ code: "custom", path: [...prefix, field], message: `${label} can be at most ${ceilings[field].toLocaleString("en-GB")}${unit} on the ${profile} profile` });
    }
  };
  over("depth", "Depth", config.depth);
  over("maxPages", "Maximum pages", config.maxPages);
  over("maxBytes", "Maximum size", config.maxBytes, " bytes");
  over("maxDurationSeconds", "Maximum duration", config.maxDurationSeconds, " seconds");
  over("concurrency", "Concurrency", config.concurrency);
  over("retries", "Retries", config.retries);
  over("externalDepth", "External depth", config.externalDepth);
  if (config.perDomainDelayMs !== undefined && config.perDomainDelayMs < ceilings.minPerDomainDelayMs) {
    ctx.addIssue({ code: "custom", path: [...prefix, "perDomainDelayMs"], message: `Delay between requests must be at least ${ceilings.minPerDomainDelayMs} ms on the ${profile} profile` });
  }
}

const sourceFields = {
  name: z.string().trim().min(1, "Enter a name").max(120, "Use at most 120 characters"),
  description: z.string().trim().max(1000).optional(),
  type: z.enum(SOURCE_TYPES, { error: "Choose a source type" }),
  adapter: z.enum(["http", "wikipedia", "zim", "import"]).default("http"),
  startUrl: z.string().trim().max(4096).optional(),
  strategy: z.enum(["capture", "explore", "mirror"]).optional(),
  profile: z.enum(["focused", "balanced", "comprehensive", "custom"]).default("balanced"),
  config: configInputSchema.default({}),
  priority: priorityInput.default(3),
  retention: retentionOrCustom.optional(),
  automaticEviction: z.boolean().optional(),
  storageBudgetBytes: z.number().int().min(1024).optional(),
  preferredVolumeId: z.string().max(64).optional(),
  discoveryEnabled: z.boolean().default(false),
  enabled: z.boolean().default(true),
  schedule: scheduleInputSchema.optional(),
  collections: z.array(z.string().max(64)).max(50).optional(),
  savedSearchId: z.string().max(64).optional(),
};

/** Checks that apply to a whole source (create, or the merged result of a patch). */
export function refineSource(v: { type: string; adapter?: string; startUrl?: string; config: ConfigInput }, ctx: z.RefinementCtx, profile: ResourceProfile): void {
  if (LATER[v.type]) ctx.addIssue({ code: "custom", path: ["type"], message: LATER[v.type]! });
  const adapterOk = !v.adapter || v.adapter === "http" || (v.type === "imported_documents" && v.adapter === "import");
  if (!adapterOk) ctx.addIssue({ code: "custom", path: ["adapter"], message: "Only the web adapter is available in this release" });
  if (v.type === "imported_documents" && v.startUrl) ctx.addIssue({ code: "custom", path: ["startUrl"], message: "Imported-document sources take uploaded files, not a web address" });
  if (WEB_TYPES.has(v.type)) {
    if (!v.startUrl) ctx.addIssue({ code: "custom", path: ["startUrl"], message: "Enter the address to start from" });
    else if (!checkUrl(v.startUrl)) ctx.addIssue({ code: "custom", path: ["startUrl"], message: "Enter a web address that starts with http:// or https://, without a username or password" });
  }
  if (v.config.queryParamPolicy === "allowlist" && !(v.config.queryParamAllowlist?.length)) {
    ctx.addIssue({ code: "custom", path: ["config", "queryParamAllowlist"], message: "List the query parameters to keep" });
  }
  checkCeilings(v.config, ceilingsFor(profile), profile, ctx);
}

export function sourceInputSchema(profile: ResourceProfile) {
  return z.object(sourceFields).superRefine((v, ctx) => refineSource(v, ctx, profile));
}

export function sourcePatchSchema(profile: ResourceProfile) {
  return z
    .object({
      name: sourceFields.name.optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      startUrl: sourceFields.startUrl,
      strategy: sourceFields.strategy,
      profile: z.enum(["focused", "balanced", "comprehensive", "custom"]).optional(),
      config: configInputSchema.optional(),
      priority: priorityInput.optional(),
      retention: retentionOrCustom.optional(),
      automaticEviction: z.boolean().optional(),
      storageBudgetBytes: z.number().int().min(1024).nullable().optional(),
      preferredVolumeId: z.string().max(64).nullable().optional(),
      discoveryEnabled: z.boolean().optional(),
      enabled: z.boolean().optional(),
      collections: z.array(z.string().max(64)).max(50).optional(),
    })
    .superRefine((v, ctx) => {
      if (v.config) checkCeilings(v.config, ceilingsFor(profile), profile, ctx);
      if (v.startUrl !== undefined && !checkUrl(v.startUrl)) ctx.addIssue({ code: "custom", path: ["startUrl"], message: "Enter a web address that starts with http:// or https://, without a username or password" });
    });
}

/** Default strategy for a type. */
export function defaultStrategy(type: SourceType): "capture" | "explore" | "mirror" {
  return type === "single_page" || type === "sitemap" || type === "feed" ? "capture" : "explore";
}

/**
 * Resolves user input into the stored config: the profile preset (clamped to the ceilings) supplies depth, pages, size,
 * time and concurrency, then the type fixes what must be true for it (a single page has depth 0 and one page).
 */
export function resolveConfig(input: ConfigInput, type: SourceType, profile: SourceProfile, resource: ResourceProfile, startUrl?: string): SourceConfig {
  const ceilings = ceilingsFor(resource);
  const preset = presetFor(profile, ceilings);
  const c: SourceConfig = {
    depth: input.depth ?? preset.depth,
    maxPages: input.maxPages ?? preset.maxPages,
    maxBytes: input.maxBytes ?? preset.maxBytes,
    maxDurationSeconds: input.maxDurationSeconds ?? preset.maxDurationSeconds,
    allowedDomains: input.allowedDomains ?? [],
    excludedDomains: input.excludedDomains ?? [],
    allowedPaths: input.allowedPaths ?? [],
    excludedPaths: input.excludedPaths ?? [],
    includeExternal: input.includeExternal ?? type === "linked_collection",
    externalDepth: input.externalDepth ?? (type === "linked_collection" ? 1 : 0),
    assets: input.assets ?? "same_origin",
    concurrency: input.concurrency ?? preset.concurrency,
    perDomainDelayMs: input.perDomainDelayMs ?? Math.max(ceilings.minPerDomainDelayMs, 1000),
    retries: input.retries ?? 2,
    queryParamPolicy: input.queryParamPolicy ?? "strip_tracking",
    queryParamAllowlist: input.queryParamAllowlist ?? [],
    respectRobots: input.respectRobots ?? true,
    versioning: input.versioning ?? { mode: "on_change" },
    renderMode: input.renderMode ?? "never",
    linkWeights: input.linkWeights ?? {},
    maxLinksPerPage: input.maxLinksPerPage ?? 500,
    userAgentSuffix: input.userAgentSuffix,
    sitemapMaxDepth: input.sitemapMaxDepth ?? 3,
  };
  if (type === "single_page") {
    c.depth = 0;
    c.maxPages = 1;
    c.includeExternal = false;
  } else if (type === "sitemap" || type === "feed") {
    c.depth = 0;
    c.includeExternal = false;
  } else if (type === "section" && startUrl && c.allowedPaths.length === 0) {
    // A section stays under the folder the address points at.
    try {
      const p = new URL(startUrl).pathname;
      const dir = p.endsWith("/") ? p : p.slice(0, p.lastIndexOf("/") + 1);
      c.allowedPaths = [`${dir}**`];
    } catch {
      /* the URL was validated before this point */
    }
  }
  // A preset is clamped to the ceilings; explicit values were already refused above them.
  c.depth = Math.min(c.depth, ceilings.depth);
  c.maxPages = Math.min(c.maxPages, ceilings.maxPages);
  c.maxBytes = Math.min(c.maxBytes, ceilings.maxBytes);
  c.maxDurationSeconds = Math.min(c.maxDurationSeconds, ceilings.maxDurationSeconds);
  c.concurrency = Math.min(c.concurrency, ceilings.concurrency);
  return c;
}

export function defaultRetention(config: SourceConfig): RetentionSpec {
  return config.versioning.mode === "all" ? { mode: "all" } : { mode: "latest", count: config.versioning.mode === "last_n" ? (config.versioning.n ?? 1) : 1 };
}
