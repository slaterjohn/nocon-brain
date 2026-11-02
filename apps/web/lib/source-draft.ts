import type { DayName, Priority, RetentionSpec, ScheduleKind, Source, SourceCeilings, SourceConfig, SourceInput, SourceProfile, SourceStrategy, SourceType } from "./types";

/** The form's working copy of a source. Numbers are strings so a half-typed value is not lost. */
export interface Draft {
  type: SourceType | "";
  name: string;
  description: string;
  startUrl: string;
  mode: SourceStrategy;
  profile: SourceProfile;
  depth: string;
  maxPages: string;
  maxMb: string;
  // scope (advanced)
  allowedDomains: string;
  excludedDomains: string;
  allowedPaths: string;
  excludedPaths: string;
  includeExternal: boolean;
  externalDepth: string;
  queryParamPolicy: "" | SourceConfig["queryParamPolicy"];
  queryParamAllowlist: string;
  respectRobots: boolean;
  assets: "" | SourceConfig["assets"];
  // schedule
  schedKind: ScheduleKind;
  minute: string;
  time: string;
  dayOfWeek: string;
  cron: string;
  timezone: string;
  missedRunPolicy: "run_once" | "skip";
  windowOn: boolean;
  winStart: string;
  winEnd: string;
  winDays: DayName[];
  // keep
  priority: Priority;
  retentionMode: "all" | "latest" | "time" | "budget" | "custom";
  retentionCount: string;
  retentionDays: string;
  retentionGb: string;
  automaticEviction: boolean;
  evictionTouched: boolean;
  budgetGb: string;
  collections: string[];
  enabled: boolean;
  // advanced (behaviour)
  concurrency: string;
  perDomainDelayMs: string;
  retries: string;
  renderMode: "" | SourceConfig["renderMode"];
  versioningMode: "" | SourceConfig["versioning"]["mode"];
  versioningN: string;
  versioningPeriod: "day" | "week" | "month";
  maxLinksPerPage: string;
  userAgentSuffix: string;
  sitemapMaxDepth: string;
  /** A retention the form cannot edit (custom rules set through the API). Kept as it is. */
  customRetention?: RetentionSpec;
}

export const ALL_DAYS: DayName[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const DAY_LABEL: Record<DayName, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

export const PRESETS: Record<Exclude<SourceProfile, "custom">, { depth: number; maxPages: number; maxBytes: number }> = {
  focused: { depth: 1, maxPages: 50, maxBytes: 200 * 1024 ** 2 },
  balanced: { depth: 3, maxPages: 500, maxBytes: 2 * 1024 ** 3 },
  comprehensive: { depth: 6, maxPages: 5000, maxBytes: 20 * 1024 ** 3 },
};

const GIB = 1024 ** 3;
/** Same table as the server (apps/server/src/sources/limits.ts). The preview response carries the real ones. */
export const CEILINGS: Record<"pi-lite" | "standard", SourceCeilings> = {
  "pi-lite": { depth: 5, maxPages: 5000, maxBytes: 2 * GIB, maxDurationSeconds: 6 * 3600, concurrency: 2, retries: 3, externalDepth: 1, minPerDomainDelayMs: 1500 },
  standard: { depth: 10, maxPages: 100000, maxBytes: 20 * GIB, maxDurationSeconds: 72 * 3600, concurrency: 8, retries: 5, externalDepth: 2, minPerDomainDelayMs: 1000 },
};

export const CRAWL_TYPES: SourceType[] = ["website", "section", "linked_collection"];
export const isWebType = (t: string) => ["single_page", "website", "section", "linked_collection", "sitemap", "feed"].includes(t);

export function defaultMode(t: SourceType | ""): SourceStrategy {
  return t === "single_page" || t === "sitemap" || t === "feed" ? "capture" : "explore";
}

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function emptyDraft(): Draft {
  return {
    type: "", name: "", description: "", startUrl: "", mode: "explore", profile: "balanced",
    depth: "3", maxPages: "500", maxMb: "2048",
    allowedDomains: "", excludedDomains: "", allowedPaths: "", excludedPaths: "", includeExternal: false, externalDepth: "",
    queryParamPolicy: "", queryParamAllowlist: "", respectRobots: true, assets: "",
    schedKind: "manual", minute: "0", time: "03:00", dayOfWeek: "1", cron: "", timezone: localTimezone(), missedRunPolicy: "run_once",
    windowOn: false, winStart: "01:00", winEnd: "06:00", winDays: [...ALL_DAYS],
    priority: "P3", retentionMode: "latest", retentionCount: "1", retentionDays: "90", retentionGb: "1", automaticEviction: true, evictionTouched: false,
    budgetGb: "", collections: [], enabled: true,
    concurrency: "", perDomainDelayMs: "", retries: "", renderMode: "", versioningMode: "", versioningN: "3", versioningPeriod: "week",
    maxLinksPerPage: "", userAgentSuffix: "", sitemapMaxDepth: "",
  };
}

const lines = (a: string[] | undefined) => (a ?? []).join("\n");
const mb = (n: number) => String(Math.round((n / 1024 ** 2) * 100) / 100);

export function draftFromSource(s: Source): Draft {
  const c = s.config;
  const d = emptyDraft();
  const r = s.retention;
  return {
    ...d,
    type: s.type, name: s.name, description: s.description ?? "", startUrl: s.startUrl ?? "", mode: s.strategy, profile: s.profile,
    depth: String(c.depth), maxPages: String(c.maxPages), maxMb: mb(c.maxBytes),
    allowedDomains: lines(c.allowedDomains), excludedDomains: lines(c.excludedDomains), allowedPaths: lines(c.allowedPaths), excludedPaths: lines(c.excludedPaths),
    includeExternal: c.includeExternal, externalDepth: String(c.externalDepth), queryParamPolicy: c.queryParamPolicy, queryParamAllowlist: lines(c.queryParamAllowlist),
    respectRobots: c.respectRobots, assets: c.assets,
    schedKind: s.schedule?.kind ?? "manual", minute: String(s.schedule?.minute ?? 0), time: s.schedule?.time ?? "03:00", dayOfWeek: String(s.schedule?.dayOfWeek ?? 1),
    cron: s.schedule?.cron ?? "", timezone: s.schedule?.timezone ?? localTimezone(), missedRunPolicy: s.schedule?.missedRunPolicy ?? "run_once",
    windowOn: !!s.schedule?.window, winStart: s.schedule?.window?.start ?? "01:00", winEnd: s.schedule?.window?.end ?? "06:00", winDays: s.schedule?.window?.days ?? [...ALL_DAYS],
    priority: s.priority,
    retentionMode: r.mode, retentionCount: r.mode === "latest" ? String(r.count) : "1", retentionDays: r.mode === "time" ? String(r.days) : "90",
    retentionGb: r.mode === "budget" ? String(Math.round((r.bytes / GIB) * 100) / 100) : "1",
    customRetention: r.mode === "custom" ? r : undefined,
    automaticEviction: s.automaticEviction, evictionTouched: true,
    budgetGb: s.storageBudgetBytes ? String(Math.round((s.storageBudgetBytes / GIB) * 100) / 100) : "",
    collections: s.collections, enabled: s.enabled,
    concurrency: String(c.concurrency), perDomainDelayMs: String(c.perDomainDelayMs), retries: String(c.retries), renderMode: c.renderMode,
    versioningMode: c.versioning.mode, versioningN: String(c.versioning.n ?? 3), versioningPeriod: c.versioning.period ?? "week",
    maxLinksPerPage: String(c.maxLinksPerPage), userAgentSuffix: c.userAgentSuffix ?? "", sitemapMaxDepth: String(c.sitemapMaxDepth),
  };
}

const splitLines = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const num = (s: string) => (s.trim() === "" ? undefined : Number(s));

export function evictionDefault(p: Priority): boolean {
  return p === "P3" || p === "P4";
}

export function buildRetention(d: Draft): RetentionSpec {
  switch (d.retentionMode) {
    case "all": return { mode: "all" };
    case "time": return { mode: "time", days: Number(d.retentionDays), keepLatest: true };
    case "budget": return { mode: "budget", bytes: Math.round(Number(d.retentionGb) * GIB) };
    case "custom": return d.customRetention ?? { mode: "latest", count: 1 };
    default: return { mode: "latest", count: Number(d.retentionCount) };
  }
}

/** Builds the request body. In edit mode every config value is sent, so what the form shows is what is stored. */
export function buildInput(d: Draft, edit: boolean): SourceInput {
  const type = d.type as SourceType;
  const config: Partial<SourceConfig> = {};
  if (d.profile === "custom" || edit) {
    config.depth = Number(d.depth);
    config.maxPages = Number(d.maxPages);
    config.maxBytes = Math.round(Number(d.maxMb) * 1024 ** 2);
  }
  config.allowedDomains = splitLines(d.allowedDomains);
  config.excludedDomains = splitLines(d.excludedDomains);
  config.allowedPaths = splitLines(d.allowedPaths);
  config.excludedPaths = splitLines(d.excludedPaths);
  if (edit || d.includeExternal !== (type === "linked_collection")) config.includeExternal = d.includeExternal;
  if (!d.respectRobots) config.respectRobots = false;
  else if (edit) config.respectRobots = true;
  if (d.queryParamPolicy) config.queryParamPolicy = d.queryParamPolicy;
  if (d.queryParamPolicy === "allowlist") config.queryParamAllowlist = splitLines(d.queryParamAllowlist);
  if (d.assets) config.assets = d.assets;
  if (num(d.externalDepth) !== undefined) config.externalDepth = num(d.externalDepth);
  if (num(d.concurrency) !== undefined) config.concurrency = num(d.concurrency);
  if (num(d.perDomainDelayMs) !== undefined) config.perDomainDelayMs = num(d.perDomainDelayMs);
  if (num(d.retries) !== undefined) config.retries = num(d.retries);
  if (d.renderMode) config.renderMode = d.renderMode;
  if (d.versioningMode) {
    config.versioning = { mode: d.versioningMode, ...(d.versioningMode === "last_n" ? { n: Number(d.versioningN) } : {}), ...(d.versioningMode === "period" ? { period: d.versioningPeriod } : {}) };
  }
  if (num(d.maxLinksPerPage) !== undefined) config.maxLinksPerPage = num(d.maxLinksPerPage);
  if (d.userAgentSuffix.trim()) config.userAgentSuffix = d.userAgentSuffix.trim();
  if (num(d.sitemapMaxDepth) !== undefined) config.sitemapMaxDepth = num(d.sitemapMaxDepth);

  const input: SourceInput = {
    name: d.name.trim(),
    type,
    profile: d.profile,
    strategy: d.mode,
    config,
    priority: d.priority,
    retention: buildRetention(d),
    automaticEviction: d.automaticEviction,
    enabled: d.enabled,
    collections: d.collections,
  };
  if (d.description.trim()) input.description = d.description.trim();
  if (isWebType(type)) input.startUrl = d.startUrl.trim();
  if (d.budgetGb.trim()) input.storageBudgetBytes = Math.round(Number(d.budgetGb) * GIB);
  return input;
}

export function buildSchedule(d: Draft): NonNullable<SourceInput["schedule"]> {
  const s: NonNullable<SourceInput["schedule"]> = { kind: d.schedKind, timezone: d.timezone.trim() || "UTC", missedRunPolicy: d.missedRunPolicy, enabled: true };
  if (d.schedKind === "hourly") s.minute = Number(d.minute);
  if (d.schedKind === "daily" || d.schedKind === "weekly") s.time = d.time;
  if (d.schedKind === "weekly") s.dayOfWeek = Number(d.dayOfWeek);
  if (d.schedKind === "cron") s.cron = d.cron.trim();
  return s;
}

export function buildWindow(d: Draft) {
  return { name: "", days: d.winDays, start: d.winStart, end: d.winEnd, timezone: d.timezone.trim() || "UTC", enabled: true };
}

export function validateUrl(v: string): { ok: boolean; message?: string; suggestion?: string } {
  const t = v.trim();
  if (!t) return { ok: false, message: "Enter the address to start from." };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) {
    if (/^[^\s/]+\.[^\s/]+/.test(t)) return { ok: false, message: "Start the address with https:// or http://.", suggestion: `https://${t}` };
    return { ok: false, message: "Enter a web address, such as https://example.org/." };
  }
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, message: "Only web addresses that start with http:// or https:// can be saved." };
    if (u.username || u.password) return { ok: false, message: "Leave out the username and password. They are not supported." };
    if (!u.hostname) return { ok: false, message: "Enter a web address, such as https://example.org/." };
    return { ok: true };
  } catch {
    return { ok: false, message: "That doesn't look like a web address. Check it for typing mistakes." };
  }
}

export interface StepKeys { type: string[]; address: string[]; schedule: string[] }
export const stepOfKey = (k: string): 0 | 1 | 2 => {
  if (k === "type") return 0;
  if (k === "name" || k === "description" || k === "startUrl" || k === "strategy" || k === "profile" || k.startsWith("config.")) {
    return /^config\.(concurrency|perDomainDelayMs|retries|renderMode|versioning|maxLinksPerPage|userAgentSuffix|sitemapMaxDepth)/.test(k) ? 2 : 1;
  }
  return 2;
};

const SCOPE_ADV = ["config.allowedDomains", "config.excludedDomains", "config.allowedPaths", "config.excludedPaths", "config.includeExternal", "config.externalDepth", "config.queryParamPolicy", "config.queryParamAllowlist", "config.respectRobots", "config.assets"];
const MORE_ADV = ["config.concurrency", "config.perDomainDelayMs", "config.retries", "config.renderMode", "config.versioning", "config.maxLinksPerPage", "config.userAgentSuffix", "config.sitemapMaxDepth", "schedule.timezone", "schedule.missedRunPolicy", "storageBudgetBytes"];
export const isScopeAdvanced = (k: string) => SCOPE_ADV.some((a) => k === a || k.startsWith(`${a}.`));
export const isMoreAdvanced = (k: string) => MORE_ADV.some((a) => k === a || k.startsWith(`${a}.`));

/** Client-side checks. Keys match the server's field paths, so both kinds of error land on the same field. */
export function validateDraft(d: Draft, ceil: SourceCeilings | null, edit: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (!d.type) e.type = "Choose a source type.";
  if (!d.name.trim()) e.name = "Enter a name for the source.";
  else if (d.name.length > 120) e.name = "Use at most 120 characters.";
  if (d.type && isWebType(d.type)) {
    const u = validateUrl(d.startUrl);
    if (!u.ok) e.startUrl = u.message!;
  }
  const int = (v: string, min: number, max: number | undefined, key: string, label: string, unit = "") => {
    if (v.trim() === "") return;
    const n = Number(v);
    if (!Number.isInteger(n)) e[key] = `${label} must be a whole number.`;
    else if (n < min) e[key] = `${label} must be at least ${min.toLocaleString("en-GB")}${unit}.`;
    else if (max !== undefined && n > max) e[key] = `${label} can be at most ${max.toLocaleString("en-GB")}${unit} on this device.`;
  };
  if (d.profile === "custom" || edit) {
    if (d.depth.trim() === "") e["config.depth"] = "Enter a depth.";
    else int(d.depth, 0, ceil?.depth, "config.depth", "Depth");
    if (d.maxPages.trim() === "") e["config.maxPages"] = "Enter a number of pages.";
    else int(d.maxPages, 1, ceil?.maxPages, "config.maxPages", "Maximum pages");
    if (d.maxMb.trim() === "" || !(Number(d.maxMb) > 0)) e["config.maxBytes"] = "Enter a size above 0.";
    else if (ceil && Number(d.maxMb) * 1024 ** 2 > ceil.maxBytes) e["config.maxBytes"] = `Maximum size can be at most ${Math.floor(ceil.maxBytes / 1024 ** 2).toLocaleString("en-GB")} MB on this device.`;
  }
  int(d.concurrency, 1, ceil?.concurrency, "config.concurrency", "Requests at once");
  int(d.retries, 0, ceil?.retries, "config.retries", "Retries");
  int(d.externalDepth, 0, ceil?.externalDepth, "config.externalDepth", "Other-site depth");
  if (d.perDomainDelayMs.trim() !== "") {
    const n = Number(d.perDomainDelayMs);
    if (!Number.isInteger(n) || n < 0) e["config.perDomainDelayMs"] = "Delay must be a whole number of milliseconds.";
    else if (ceil && n < ceil.minPerDomainDelayMs) e["config.perDomainDelayMs"] = `Delay must be at least ${ceil.minPerDomainDelayMs} ms on this device.`;
  }
  int(d.maxLinksPerPage, 1, 5000, "config.maxLinksPerPage", "Links per page");
  int(d.sitemapMaxDepth, 0, 5, "config.sitemapMaxDepth", "Sitemap nesting");
  if (d.queryParamPolicy === "allowlist" && !splitLines(d.queryParamAllowlist).length) e["config.queryParamAllowlist"] = "List the query parameters to keep.";
  if (d.versioningMode === "last_n") int(d.versioningN, 1, 1000, "config.versioning.n", "Number of versions");
  // schedule
  if (d.schedKind === "hourly" && !(Number.isInteger(Number(d.minute)) && Number(d.minute) >= 0 && Number(d.minute) <= 59)) e["schedule.minute"] = "Enter a minute from 0 to 59.";
  if ((d.schedKind === "daily" || d.schedKind === "weekly") && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time)) e["schedule.time"] = "Use a 24-hour time such as 03:30.";
  if (d.schedKind === "cron" && !d.cron.trim()) e["schedule.cron"] = "Enter a cron expression with five fields, such as 0 3 * * *.";
  if (d.schedKind !== "manual" && d.windowOn) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.winStart)) e["window.start"] = "Use a 24-hour start time such as 01:00.";
    if (!/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(d.winEnd)) e["window.end"] = "Use a 24-hour end time such as 06:00.";
    else if (d.winStart === d.winEnd) e["window.end"] = "The end must differ from the start. An end earlier than the start runs past midnight.";
    if (!d.winDays.length) e["window.days"] = "Choose at least one day.";
  }
  // keep
  if (d.retentionMode === "latest") int(d.retentionCount, 1, 1000, "retention.count", "Number of versions");
  if (d.retentionMode === "latest" && d.retentionCount.trim() === "") e["retention.count"] = "Enter how many versions to keep.";
  if (d.retentionMode === "time" && !(Number(d.retentionDays) >= 1)) e["retention.days"] = "Enter a number of days, 1 or more.";
  if (d.retentionMode === "budget" && !(Number(d.retentionGb) > 0)) e["retention.bytes"] = "Enter a size above 0.";
  if (d.budgetGb.trim() !== "" && !(Number(d.budgetGb) > 0)) e.storageBudgetBytes = "Enter a size above 0, or leave it empty for no budget.";
  return e;
}
