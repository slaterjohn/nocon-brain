// Client logic for the Discovery area (docs/api.md section 9): types, plain-language copy, formatting, the score table,
// the settings draft and the mapping of server validation errors to fields. No React in here, so it is unit tested directly.

import { ApiError, fieldErrors } from "./api";
import type { Priority } from "./types";

// ---- Types (copied from docs/api.md "Discovery (Phase 7, as built)") ----

export type CandidateState = "new" | "approved" | "queued" | "archived" | "dismissed" | "expired";
export type ProvenanceKind = "link" | "search_result" | "saved_search" | "visit" | "bookmark" | "missing_link" | "manual";
export type WeightName =
  | "inboundArchivedLinks" | "collectionRelevance" | "searchFrequency" | "bookmarks" | "recentActivity" | "sourcePriority" | "estimatedCost" | "storageHeadroom";

export interface Candidate {
  id: string;
  url: string;
  host: string;
  title?: string;
  state: CandidateState;
  score: number;
  depth: number;
  lane: "active" | "background";
  estimatedBytes?: number;
  attempts: number;
  provenanceKinds: ProvenanceKind[];
  provenanceCount: number;
  suggestedSource?: { id: string; name: string };
  suggestedCollectionId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  expiresAt?: string;
  decidedBy?: "user" | "runner";
  decidedAt?: string;
  downloadId?: string;
}

export interface ScoreComponent { name: WeightName; label: string; raw: number; weight: number; contribution: number; explanation: string }

export interface Provenance {
  kind: ProvenanceKind;
  detail?: string;
  weight?: number;
  pageId?: string;
  pageTitle?: string;
  pageUrl?: string;
  sourceId?: string;
  sourceName?: string;
  at: string;
}

export interface CandidateDetail extends Candidate {
  scoreComponents: ScoreComponent[];
  scoreStored: boolean;
  why: string[];
  provenance: Provenance[];
}

/** GET /api/discovery/candidates/{id}/explain: always worked out from the current settings, so its components add up to its score. */
export interface Explanation {
  id: string;
  url: string;
  score: number;
  scoreStored: boolean;
  components: ScoreComponent[];
  summary: string[];
  provenance: Provenance[];
  weights: Record<WeightName, number>;
}

export interface CandidateList {
  items: Candidate[];
  total: number;
  counts: Record<CandidateState, number>;
  nextCursor?: string;
}

export interface BulkResult { results: { id: string; ok: boolean; error?: string }[]; done: number; failed: number }

export interface LaneBudget {
  requests: { used: number; limit: number; remaining: number };
  bytes: { used: number; limit: number; remaining: number };
}

export interface Budget {
  day: string;
  resetsAt: string;
  active: LaneBudget;
  background: LaneBudget;
  month: { requests: number; bytes: number };
  perSite: { cap: number; top: { host: string; requests: number }[] };
  queue: { inFlight: number; limit: number };
  pool: { candidates: number; limit: number };
}

export interface LedgerEntry {
  id: string;
  at: string;
  day: string;
  lane: "active" | "background" | "auto_cache";
  host: string;
  requests: number;
  reservedBytes: number;
  bytes?: number;
  state: "reserved" | "settled";
  outcome?: "archived" | "unchanged" | "failed" | "cancelled";
  candidateId?: string;
  downloadId?: string;
  settledAt?: string;
}

export type RunnerBlock = "disabled" | "kill_switch" | "offline" | "window_closed" | "resources";
export type PassBlock = "disabled" | "mode_off" | "kill_switch" | "offline" | "window_closed" | "resources" | "storage_full" | "search_driven_off";
export type SkipReason = "depth" | "run_cap" | "queue_full" | "requests" | "bytes" | "site_cap" | "storage" | "source_budget" | "archived" | "in_progress";
export type ActiveMode = "off" | "approval" | "automatic";

export interface PassLane { eligible: number; started: number; skipped: Partial<Record<SkipReason, number>>; blockedBy: PassBlock[] }
export interface PassReport { at: string; trigger: "timer" | "manual"; active: PassLane; background: PassLane }

export interface RunnerStatus {
  state: "off" | "idle" | "blocked" | "paused";
  mode: ActiveMode;
  blockedBy: RunnerBlock[];
  killSwitch: { paused: boolean; since?: string; by?: string };
  inFlight: number;
  timerSeconds: number;
  gates: { enabled: boolean; online: boolean; windowOpen: boolean; resourcesOk: boolean; storageRoomBytes: number };
  lastPass?: PassReport;
}

export interface Overview {
  enabled: boolean;
  mode: ActiveMode;
  collectors: Record<string, boolean>;
  counts: Record<CandidateState, number>;
  killSwitch: { paused: boolean; since?: string };
  budget: Pick<Budget, "day" | "resetsAt" | "active" | "background" | "month">;
  runner: { state: RunnerStatus["state"]; blockedBy: RunnerBlock[] };
}

export interface DiscoverySettings {
  enabled: boolean;
  passive: { fromLinks: boolean; fromVisits: boolean; fromBookmarks: boolean; fromMissingLinks: boolean; fromSavedSearches: boolean };
  searchDriven: {
    searchesInfluenceDiscovery: boolean;
    autoCacheOpenedOnlinePages: boolean;
    prioritiseFrequentTopics: boolean;
    requireApproval: boolean;
    backgroundBudget: { maxRequestsPerDay: number; maxBytesPerDay: number };
  };
  active: {
    mode: ActiveMode;
    allowedSourceIds: string[];
    maxCandidatesPerRun: number;
    maxDepth: number;
    maxQueued: number;
    maxBytesPerDay: number;
    maxRequestsPerDay: number;
    perSiteDailyCap: number;
    respectSchedule: boolean;
    onlyWhenOnline: true;
    minScore: number;
    automaticAcknowledgedAt: string | null;
  };
  pool: { maxCandidates: number; expireAfterDays: number; maxLinksPerPage: number };
  ceilings: { maxDepth: number; maxQueued: number; maxRequestsPerDay: number; maxBytesPerDay: number };
  weights: Record<WeightName, number>;
}

export interface EffectiveLimits {
  maxDepth: number;
  maxQueued: number;
  maxCandidatesPerRun: number;
  maxCandidates: number;
  active: { maxRequestsPerDay: number; maxBytesPerDay: number };
  background: { maxRequestsPerDay: number; maxBytesPerDay: number };
  perSiteDailyCap: number;
}

export interface ProfileMaximums { maxDepth: number; maxQueued: number; maxCandidates: number; maxRequestsPerDay: number; maxBytesPerDay: number }

export interface SettingsView {
  settings: DiscoverySettings;
  effective: EffectiveLimits;
  profile: string;
  profileMaximums: ProfileMaximums;
}

// ---- Plain-language copy ----

export const STATE_LABEL: Record<CandidateState, string> = {
  new: "To review", approved: "Approved", queued: "Downloading", archived: "Saved", dismissed: "Dismissed", expired: "Expired",
};
export const STATE_ORDER: CandidateState[] = ["new", "approved", "queued", "archived", "dismissed", "expired"];

export const KIND_LABEL: Record<ProvenanceKind, string> = {
  link: "Link on a saved page",
  search_result: "Search result",
  saved_search: "Saved search",
  visit: "Page you visited",
  bookmark: "Bookmark",
  missing_link: "Link to a page not saved yet",
  manual: "Added by hand",
};
export const KIND_SHORT: Record<ProvenanceKind, string> = {
  link: "Link", search_result: "Search result", saved_search: "Saved search", visit: "Visit", bookmark: "Bookmark", missing_link: "Missing link", manual: "By hand",
};

export const SORTS: { value: string; label: string }[] = [
  { value: "score", label: "Highest score first" },
  { value: "-score", label: "Lowest score first" },
  { value: "recent", label: "Seen most recently" },
  { value: "oldest", label: "Seen longest ago" },
  { value: "cost", label: "Smallest download first" },
  { value: "depth", label: "Fewest hops first" },
];

export const RUNNER_BLOCK_WORDS: Record<RunnerBlock, string> = {
  disabled: "Discovery is switched off in the settings.",
  kill_switch: "The kill switch is on, so nothing is downloaded.",
  offline: "The server is working offline or cannot reach the internet.",
  window_closed: "The download window is closed. Downloads wait until it opens.",
  resources: "The server is short of disk space or memory, so downloads are held back.",
};

export const PASS_BLOCK_WORDS: Record<PassBlock, string> = {
  ...RUNNER_BLOCK_WORDS,
  mode_off: "Downloading is set to off.",
  storage_full: "There is not enough free storage.",
  search_driven_off: "Search-driven downloads are switched off.",
};

export const SKIP_WORDS: Record<SkipReason, string> = {
  depth: "too many hops from a saved page",
  run_cap: "the limit for one pass was reached",
  queue_full: "too many discovery downloads were already waiting",
  requests: "the requests for today were used up",
  bytes: "the bytes for today were used up",
  site_cap: "the limit for one site today was reached",
  storage: "there was not enough room in storage",
  source_budget: "the source's storage budget was full",
  archived: "the page was already saved",
  in_progress: "the page was already being downloaded",
};

export function runnerHeadline(r: RunnerStatus): string {
  switch (r.state) {
    case "off":
      return "Discovery is off. Nothing is collected or downloaded.";
    case "paused":
      return "Paused by the kill switch. No discovery download will start.";
    case "blocked":
      return "Discovery is on, but downloads are held back right now.";
    default:
      return r.mode === "off"
        ? "Discovery is on and collecting suggestions. Downloading is set to off, so nothing is downloaded."
        : `Ready. A pass runs every ${r.timerSeconds} seconds when there is something to do (mode: ${r.mode === "approval" ? "approval only" : "automatic"}).`;
  }
}

export function passLaneSummary(name: string, lane: PassLane): string {
  const parts: string[] = [];
  if (lane.blockedBy.length) parts.push(`held back: ${lane.blockedBy.map((b) => PASS_BLOCK_WORDS[b].replace(/\.$/, "").toLowerCase()).join("; ")}`);
  else parts.push(`${lane.started} of ${lane.eligible} eligible ${lane.eligible === 1 ? "page" : "pages"} started`);
  const skipped = Object.entries(lane.skipped).filter(([, n]) => (n ?? 0) > 0) as [SkipReason, number][];
  if (skipped.length) parts.push(`skipped: ${skipped.map(([k, n]) => `${n} (${SKIP_WORDS[k]})`).join("; ")}`);
  return `${name}: ${parts.join(". ")}.`;
}

// ---- Formatting ----

/** A number with up to six decimals and no trailing zeros. Contributions are rounded to six decimals by the server, so this shows them exactly. */
export function trim6(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = (Math.round(n * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, "");
  return s === "-0" || s === "" ? "0" : s;
}

export function signed(n: number): string {
  const s = trim6(n);
  return n > 0 ? `+${s}` : s;
}

/** "12 of 50 requests used, 38 left" */
export function requestsText(used: number, limit: number): string {
  if (limit <= 0) return `${used} used. No requests are allowed today (limit 0)`;
  const left = Math.max(0, limit - used);
  return `${used.toLocaleString("en-GB")} of ${limit.toLocaleString("en-GB")} ${limit === 1 ? "request" : "requests"} used, ${left.toLocaleString("en-GB")} left`;
}

export function bytesText(used: number, limit: number, fmt: (n: number) => string): string {
  if (limit <= 0) return `${fmt(used)} used. No bytes are allowed today (limit 0)`;
  return `${fmt(used)} of ${fmt(limit)} used, ${fmt(Math.max(0, limit - used))} left`;
}

/** Share of a limit used, 0 to 100. A limit of 0 reads as 0 (or 100 when something was used anyway). */
export function percentUsed(used: number, limit: number): number {
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

export const MIB = 1024 * 1024;
export const bytesToMib = (b: number) => Math.round((b / MIB) * 1000) / 1000;
export const mibToBytes = (m: number) => Math.round(m * MIB);

export function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export const priorityOrNull = (p: string): Priority | undefined => (["P1", "P2", "P3", "P4"].includes(p) ? (p as Priority) : undefined);

// ---- The score table ----

export interface ScoreRow { name: WeightName; label: string; raw: string; weight: string; contribution: string; value: number; explanation: string }
export interface ScoreTable { rows: ScoreRow[]; sum: number; score: number; addsUp: boolean; sumText: string; scoreText: string; equation: string }

/**
 * The components as a table whose contributions add up to the score. The server rounds each contribution to six decimals and the
 * score is the sum of the rounded contributions, so `addsUp` is true for any answer the server gives. If it is ever false the panel
 * says so instead of hiding it.
 */
export function scoreTable(components: ScoreComponent[], score: number): ScoreTable {
  const rows = components.map((c) => ({
    name: c.name, label: c.label, raw: trim6(c.raw), weight: trim6(c.weight), contribution: signed(c.contribution), value: c.contribution, explanation: c.explanation,
  }));
  const sum = Math.round(components.reduce((t, c) => t + c.contribution, 0) * 1e6) / 1e6;
  const addsUp = Math.abs(sum - score) < 1e-6;
  const equation = rows.length ? rows.map((r, i) => (i === 0 ? r.contribution.replace(/^\+/, "") : `${r.value < 0 ? "-" : "+"} ${trim6(Math.abs(r.value))}`)).join(" ") : "0";
  return { rows, sum, score, addsUp, sumText: trim6(sum), scoreText: trim6(score), equation };
}

// ---- Settings: defaults, fields, draft ----

export const DEFAULTS: DiscoverySettings = {
  enabled: false,
  passive: { fromLinks: false, fromVisits: false, fromBookmarks: false, fromMissingLinks: false, fromSavedSearches: false },
  searchDriven: {
    searchesInfluenceDiscovery: false, autoCacheOpenedOnlinePages: false, prioritiseFrequentTopics: false, requireApproval: true,
    backgroundBudget: { maxRequestsPerDay: 50, maxBytesPerDay: 100 * MIB },
  },
  active: {
    mode: "off", allowedSourceIds: [], maxCandidatesPerRun: 10, maxDepth: 1, maxQueued: 20, maxBytesPerDay: 100 * MIB, maxRequestsPerDay: 50,
    perSiteDailyCap: 10, respectSchedule: true, onlyWhenOnline: true, minScore: 10, automaticAcknowledgedAt: null,
  },
  pool: { maxCandidates: 500, expireAfterDays: 30, maxLinksPerPage: 25 },
  ceilings: { maxDepth: 3, maxQueued: 100, maxRequestsPerDay: 200, maxBytesPerDay: 512 * MIB },
  weights: {
    inboundArchivedLinks: 30, collectionRelevance: 20, searchFrequency: 10, bookmarks: 25, recentActivity: 10, sourcePriority: 10, estimatedCost: -10, storageHeadroom: -15,
  },
};

export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof o[k] !== "object" || o[k] === null) o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[keys[keys.length - 1]!] = value;
}

export type NumKind = "count" | "bytes" | "score" | "weight" | "days";
export interface NumField {
  path: string;
  label: string;
  help: string;
  kind: NumKind;
  min: number;
  max: number;
  /** The unit shown beside the box. Bytes are typed in MiB. */
  unit?: string;
}

const COUNT_MAX = 2 ** 40;
const num = (path: string, label: string, kind: NumKind, min: number, max: number, help: string, unit?: string): NumField => ({ path, label, kind, min, max, help, unit });

export const LIMIT_FIELDS: NumField[] = [
  num("active.maxCandidatesPerRun", "Downloads per pass", "count", 1, COUNT_MAX, "The most pages started in one pass. A pass runs about every 30 seconds.", "pages"),
  num("active.maxDepth", "Hops from a saved page", "count", 1, 100, "How far from a page you saved discovery may go. A link on a saved page is 1 hop; a link on a page discovery downloaded is 2 hops.", "hops"),
  num("active.maxQueued", "Downloads waiting at once", "count", 1, COUNT_MAX, "Discovery downloads that are queued or running at the same time.", "downloads"),
  num("active.maxRequestsPerDay", "Requests a day", "count", 0, COUNT_MAX, "One request is one page with its images and styles (at most 40 files). The day resets at midnight UTC.", "requests"),
  num("active.maxBytesPerDay", "Data a day", "bytes", 0, COUNT_MAX, "The most data discovery may download in a day. Each download is given an allowance first and cannot go over it.", "MiB"),
  num("active.perSiteDailyCap", "Downloads per site a day", "count", 1, COUNT_MAX, "Keeps discovery polite: no more than this many downloads from one site in a day, from all sources of suggestions together.", "downloads"),
  num("active.minScore", "Lowest score for automatic downloads", "score", -1000, 1000, "In automatic mode, and for search-driven pages that are not approved, a page needs at least this score.", "points"),
  num("searchDriven.backgroundBudget.maxRequestsPerDay", "Background requests a day", "count", 0, COUNT_MAX, "Shared by search-driven downloads and the auto-cache of pages you open.", "requests"),
  num("searchDriven.backgroundBudget.maxBytesPerDay", "Background data a day", "bytes", 0, COUNT_MAX, "Shared by search-driven downloads and the auto-cache of pages you open.", "MiB"),
];

export const POOL_FIELDS: NumField[] = [
  num("pool.maxCandidates", "Suggestions kept at once", "count", 1, COUNT_MAX, "New and approved suggestions that are kept. When the pool is full, new suggestions are turned away.", "suggestions"),
  num("pool.expireAfterDays", "Forget unused suggestions after", "days", 1, 3650, "A suggestion nobody acts on expires after this long.", "days"),
  num("pool.maxLinksPerPage", "Links taken from one page", "count", 1, 200, "Most links that one saved page may add as suggestions. Menu and footer links are always skipped.", "links"),
];

export const CEILING_FIELDS: NumField[] = [
  num("ceilings.maxDepth", "Deepest hop ceiling", "count", 1, COUNT_MAX, "Nothing above can go deeper than this.", "hops"),
  num("ceilings.maxQueued", "Waiting downloads ceiling", "count", 1, COUNT_MAX, "Nothing above can queue more than this. It also caps downloads per pass.", "downloads"),
  num("ceilings.maxRequestsPerDay", "Requests a day ceiling", "count", 0, COUNT_MAX, "Nothing above can use more requests a day than this. It also caps the per-site limit.", "requests"),
  num("ceilings.maxBytesPerDay", "Data a day ceiling", "bytes", 0, COUNT_MAX, "Nothing above can download more than this in a day.", "MiB"),
];

export const WEIGHT_FIELDS: (NumField & { name: WeightName })[] = [
  { name: "inboundArchivedLinks", path: "weights.inboundArchivedLinks", label: "Links from saved pages", kind: "weight", min: -100, max: 100, help: "More saved pages that link to it means a higher score." },
  { name: "collectionRelevance", path: "weights.collectionRelevance", label: "Linked from your collections", kind: "weight", min: -100, max: 100, help: "Higher when the pages that link to it are in a collection." },
  { name: "searchFrequency", path: "weights.searchFrequency", label: "Appears in searches", kind: "weight", min: -100, max: 100, help: "Counts the days it appeared in search results. Only used when both search-driven options above are on." },
  { name: "bookmarks", path: "weights.bookmarks", label: "Bookmarks", kind: "weight", min: -100, max: 100, help: "Higher when it, or a page that links to it, is bookmarked." },
  { name: "recentActivity", path: "weights.recentActivity", label: "Seen recently", kind: "weight", min: -100, max: 100, help: "Fades by half every 7 days since it was last seen." },
  { name: "sourcePriority", path: "weights.sourcePriority", label: "Priority of the source behind it", kind: "weight", min: -100, max: 100, help: "A link from a P1 source counts most, P4 least." },
  { name: "estimatedCost", path: "weights.estimatedCost", label: "Size of the download", kind: "weight", min: -100, max: 100, help: "Usually negative: a bigger download scores lower." },
  { name: "storageHeadroom", path: "weights.storageHeadroom", label: "How full storage is", kind: "weight", min: -100, max: 100, help: "Usually negative: the fuller the storage, the lower the score." },
];

export const ALL_NUM_FIELDS: NumField[] = [...LIMIT_FIELDS, ...POOL_FIELDS, ...CEILING_FIELDS, ...WEIGHT_FIELDS];

export interface BoolField { path: string; label: string; help: string }

export const PASSIVE_FIELDS: BoolField[] = [
  { path: "passive.fromLinks", label: "Links on saved pages", help: "Links found on pages you save become suggestions. Menu, footer and nofollow links, and addresses that look like logins or password resets, are skipped. Uses no network." },
  { path: "passive.fromVisits", label: "Pages you visit", help: "Pages you open live that are not saved become suggestions. Needs browsing history to be switched on; with history off, no visit is ever suggested." },
  { path: "passive.fromBookmarks", label: "Bookmarks", help: "A bookmark of an address with no saved copy becomes a suggestion." },
  { path: "passive.fromMissingLinks", label: "Links to pages not saved yet", help: "When the \"not saved yet\" page is shown for an address, that address becomes a suggestion." },
  { path: "passive.fromSavedSearches", label: "Saved searches", help: "Results of saved-search sources show in the suggestions and may be downloaded by the runner." },
];

export const SEARCH_FIELDS: BoolField[] = [
  { path: "searchDriven.searchesInfluenceDiscovery", label: "Web searches suggest pages", help: "Online results you have not saved become suggestions, and how often they appear counts towards the score. Only the address and a count of days are kept, never your search words. Results from providers that forbid storing them, such as Brave, are skipped." },
  { path: "searchDriven.autoCacheOpenedOnlinePages", label: "Keep pages you open from web search", help: "A page you open live is kept in the Browsing cache (lowest priority, P4). Only that page is kept, never the pages it links to." },
  { path: "searchDriven.prioritiseFrequentTopics", label: "Favour pages that keep turning up in searches", help: "How often a page appears in search results counts in the score." },
  { path: "searchDriven.requireApproval", label: "Ask before downloading search-driven pages", help: "Pages that came from searches are downloaded only after you approve them. Leave this on unless you are sure." },
];

export const WINDOW_FIELD: BoolField = { path: "active.respectSchedule", label: "Follow the download windows", help: "Discovery downloads only while the download windows in your schedule are open." };

export const MODES: { value: ActiveMode; label: string; help: string }[] = [
  { value: "off", label: "Off", help: "Discovery suggests pages but downloads nothing." },
  { value: "approval", label: "Ask first", help: "Only pages you have approved are downloaded, within the limits below." },
  { value: "automatic", label: "Automatic", help: "Pages that are new, within the sources you allow and scoring at least the lowest score are also downloaded without asking each time." },
];

/** Where a field's text is shown: "active.mode" also carries the automatic-mode confirmation. */
export const ADVANCED_GROUPS = {
  limits: ["active.maxCandidatesPerRun", "active.maxDepth", "active.maxQueued", "active.maxRequestsPerDay", "active.maxBytesPerDay", "active.perSiteDailyCap", "active.minScore", "active.respectSchedule", "searchDriven.backgroundBudget"],
  pool: ["pool"],
  ceilings: ["ceilings"],
  weights: ["weights"],
} as const;
export type AdvancedGroup = keyof typeof ADVANCED_GROUPS;

export function groupOfField(path: string): AdvancedGroup | null {
  for (const [g, prefixes] of Object.entries(ADVANCED_GROUPS) as [AdvancedGroup, readonly string[]][]) {
    if (prefixes.some((p) => path === p || path.startsWith(`${p}.`))) return g;
  }
  return null;
}

export interface Draft {
  bools: Record<string, boolean>;
  nums: Record<string, string>;
  mode: ActiveMode;
  allowedSourceIds: string[];
}

const BOOL_PATHS = ["enabled", ...PASSIVE_FIELDS.map((f) => f.path), ...SEARCH_FIELDS.map((f) => f.path), WINDOW_FIELD.path];

export function toInput(f: NumField, value: number): string {
  return f.kind === "bytes" ? String(bytesToMib(value)) : String(value);
}

export function toDraft(s: DiscoverySettings): Draft {
  const bools: Record<string, boolean> = {};
  for (const p of BOOL_PATHS) bools[p] = getPath(s, p) === true;
  const nums: Record<string, string> = {};
  for (const f of ALL_NUM_FIELDS) nums[f.path] = toInput(f, Number(getPath(s, f.path)));
  return { bools, nums, mode: s.active.mode, allowedSourceIds: [...s.active.allowedSourceIds] };
}

export function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Reads one box. Bytes are typed in MiB. Returns null when it is not a number. */
export function parseField(f: NumField, text: string): number | null {
  const t = text.trim();
  if (t === "" || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return f.kind === "bytes" ? mibToBytes(n) : n;
}

export type FieldErrors = Record<string, string>;

const fmt = (n: number) => n.toLocaleString("en-GB");
const fmtLimit = (f: NumField, v: number) => (f.kind === "bytes" ? `${fmt(bytesToMib(v))} MiB` : fmt(v));

/** Builds the settings the draft stands for. Errors are about boxes that are empty or not whole numbers or out of range. */
export function draftToSettings(d: Draft, base: DiscoverySettings): { settings: DiscoverySettings; errors: FieldErrors } {
  const out = JSON.parse(JSON.stringify(base)) as DiscoverySettings;
  const errors: FieldErrors = {};
  for (const [p, v] of Object.entries(d.bools)) setPath(out as unknown as Record<string, unknown>, p, v);
  for (const f of ALL_NUM_FIELDS) {
    const raw = d.nums[f.path] ?? "";
    const n = parseField(f, raw);
    if (n == null) {
      errors[f.path] = `${f.label}: enter a number.`;
      continue;
    }
    if (f.kind !== "weight" && f.kind !== "score" && !Number.isInteger(n)) {
      errors[f.path] = `${f.label}: enter a whole number.`;
      continue;
    }
    if (n < f.min) {
      errors[f.path] = `${f.label} cannot be less than ${fmtLimit(f, f.min)}.`;
      continue;
    }
    if (n > f.max) {
      errors[f.path] = `${f.label} cannot be more than ${fmtLimit(f, f.max)}.`;
      continue;
    }
    setPath(out as unknown as Record<string, unknown>, f.path, n);
  }
  out.active.mode = d.mode;
  out.active.allowedSourceIds = [...d.allowedSourceIds];
  return { settings: out, errors };
}

/** Field paths that exist in the form. `acknowledged` is shown with the active mode. */
export function knownFieldPath(path: string): boolean {
  return path === "active.mode" || path === "active.allowedSourceIds" || ALL_NUM_FIELDS.some((f) => f.path === path) || BOOL_PATHS.includes(path);
}

/**
 * Maps a failed save to fields. The server names fields as `ceilings.maxBytesPerDay` from the discovery route and as
 * `discovery.ceilings.maxBytesPerDay` (and `discovery.acknowledged`) from the general settings route; both come out the same here.
 * `general` holds anything that matches no field, so it is never lost.
 */
export function mapServerErrors(err: unknown): { fields: FieldErrors; general: string[] } {
  const raw = fieldErrors(err);
  const fields: FieldErrors = {};
  const general: string[] = [];
  for (const [k, message] of Object.entries(raw)) {
    let path = k.replace(/^discovery\./, "");
    if (path === "acknowledged") path = "active.mode";
    // Array item paths such as active.allowedSourceIds.0 belong to the list.
    const parent = path.replace(/\.\d+$/, "");
    if (knownFieldPath(path)) fields[path] = message;
    else if (knownFieldPath(parent)) fields[parent] = message;
    else general.push(message);
  }
  if (!Object.keys(raw).length && err instanceof ApiError) general.push(err.message);
  return { fields, general };
}

// ---- Limits in force ----

export interface LimitRow { key: string; label: string; setting: string; effective: string; capped: boolean; reason?: string }

/** One row per limit: what was set, what is really in force, and why they differ. */
export function limitRows(s: DiscoverySettings, e: EffectiveLimits, max: ProfileMaximums, profile: string): LimitRow[] {
  const mk = (key: string, label: string, setting: number, effective: number, ceiling: number | null, profileMax: number | null, bytes = false): LimitRow => {
    const f = (n: number) => (bytes ? `${fmt(bytesToMib(n))} MiB` : fmt(n));
    const capped = effective < setting;
    let reason: string | undefined;
    if (capped) {
      const fromCeiling = ceiling != null && ceiling <= effective && (profileMax == null || ceiling <= profileMax);
      reason = fromCeiling
        ? `Capped by the global ceiling (${f(ceiling!)}).`
        : `Capped by the ${profile} profile maximum (${f(profileMax ?? effective)}).`;
    }
    return { key, label, setting: f(setting), effective: f(effective), capped, ...(reason ? { reason } : {}) };
  };
  return [
    mk("maxDepth", "Hops from a saved page", s.active.maxDepth, e.maxDepth, s.ceilings.maxDepth, max.maxDepth),
    mk("maxQueued", "Downloads waiting at once", s.active.maxQueued, e.maxQueued, s.ceilings.maxQueued, max.maxQueued),
    mk("maxCandidatesPerRun", "Downloads per pass", s.active.maxCandidatesPerRun, e.maxCandidatesPerRun, s.ceilings.maxQueued, max.maxQueued),
    mk("maxCandidates", "Suggestions kept at once", s.pool.maxCandidates, e.maxCandidates, null, max.maxCandidates),
    mk("activeRequests", "Active requests a day", s.active.maxRequestsPerDay, e.active.maxRequestsPerDay, s.ceilings.maxRequestsPerDay, max.maxRequestsPerDay),
    mk("activeBytes", "Active data a day", s.active.maxBytesPerDay, e.active.maxBytesPerDay, s.ceilings.maxBytesPerDay, max.maxBytesPerDay, true),
    mk("backgroundRequests", "Background requests a day", s.searchDriven.backgroundBudget.maxRequestsPerDay, e.background.maxRequestsPerDay, s.ceilings.maxRequestsPerDay, max.maxRequestsPerDay),
    mk("backgroundBytes", "Background data a day", s.searchDriven.backgroundBudget.maxBytesPerDay, e.background.maxBytesPerDay, s.ceilings.maxBytesPerDay, max.maxBytesPerDay, true),
    mk("perSite", "Downloads per site a day", s.active.perSiteDailyCap, e.perSiteDailyCap, s.ceilings.maxRequestsPerDay, max.maxRequestsPerDay),
  ];
}

/** True while every setting that switches something on is at its default (off). */
export function allOffByDefault(s: DiscoverySettings): boolean {
  return !s.enabled && Object.values(s.passive).every((v) => !v) && !s.searchDriven.searchesInfluenceDiscovery && !s.searchDriven.autoCacheOpenedOnlinePages && !s.searchDriven.prioritiseFrequentTopics && s.active.mode === "off";
}

/** Default text beside a setting: "Default: off", "Default: 50", "Default: 100 MiB". */
export function defaultText(path: string): string {
  const v = getPath(DEFAULTS, path);
  if (typeof v === "boolean") return `Default: ${v ? "on" : "off"}`;
  const f = ALL_NUM_FIELDS.find((x) => x.path === path);
  if (typeof v === "number" && f) return `Default: ${f.kind === "bytes" ? `${fmt(bytesToMib(v))} MiB` : fmt(v)}`;
  return "";
}

// ---- Filters ----

export interface Filters { state: CandidateState | "all"; q: string; host: string; sourceId: string; provenance: string; minScore: string; maxScore: string; sort: string }
export const DEFAULT_FILTERS: Filters = { state: "new", q: "", host: "", sourceId: "", provenance: "", minScore: "", maxScore: "", sort: "score" };

export function filtersToQuery(f: Filters, cursor?: string, limit = 25): string {
  const p = new URLSearchParams();
  if (f.state !== "all") p.set("state", f.state);
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.host.trim()) p.set("host", f.host.trim());
  if (f.sourceId) p.set("sourceId", f.sourceId);
  if (f.provenance) p.set("provenance", f.provenance);
  if (f.minScore.trim() !== "" && Number.isFinite(Number(f.minScore))) p.set("minScore", String(Number(f.minScore)));
  if (f.maxScore.trim() !== "" && Number.isFinite(Number(f.maxScore))) p.set("maxScore", String(Number(f.maxScore)));
  p.set("sort", f.sort);
  p.set("limit", String(limit));
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

export function filtersActive(f: Filters): boolean {
  return !!(f.q.trim() || f.host.trim() || f.sourceId || f.provenance || f.minScore.trim() || f.maxScore.trim());
}

/** Whether to keep polling: while a pass is running or a discovery download is in flight. */
export function shouldPoll(runner: Pick<RunnerStatus, "inFlight" | "state"> | undefined, passRunning: boolean): boolean {
  return passRunning || (!!runner && runner.inFlight > 0 && runner.state !== "off");
}
