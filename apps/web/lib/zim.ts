// Client logic for knowledge packages and Wikipedia (docs/api.md sections 15, 6.3 and 3): types, plain-language copy, formatting,
// the add-a-package and topic-crawl drafts with their validation, the removal summary and the safe reading of package snippets.
// No React in here, so it is unit tested directly (apps/web/test/zim.test.ts).

import { ApiError, errorMessage, fieldErrors } from "./api";
import { markedParts, type SearchResult, type SnippetPart } from "./search";
import type { Priority } from "./types";

// ---- Types (copied from docs/api.md 15.1 and 15.2) ----

export type ZimState = "importing" | "ready" | "degraded" | "missing" | "removing";

export interface ZimPackage {
  id: string;
  name: string;
  title: string;
  description: string | null;
  language: string | null;
  creator: string | null;
  publisher: string | null;
  date: string | null;
  flavour: string | null;
  tags: string[];
  uuid: string;
  state: ZimState;
  stateDetail: string | null;
  storageMode: "in_place" | "copied";
  path: string;
  volumeId: string | null;
  sizeBytes: number;
  checksum: { sha256: string | null; state: "pending" | "done" | "failed" };
  counts: { articles: number; media: number; entries: number };
  hasFulltextIndex: boolean;
  hasTitleIndex: boolean;
  newNamespaceScheme: boolean;
  mainPath: string | null;
  illustrationUrl: string | null;
  license: { name: string | null; url: string | null; known: boolean };
  attribution: string | null;
  sourceUrl: string | null;
  priority: Priority;
  neverAutoEvicted: true;
  enabledForSearch: boolean;
  sourceId: string | null;
  importedAt: string;
  lastVerifiedAt: string | null;
}

export interface ZimList { items: ZimPackage[]; total: number }

export interface ZimEntry { zimId: string; path: string; title: string }
export interface ZimEntries { items: ZimEntry[]; total: number; nextCursor?: string }

export interface ZimReferences {
  bookmarks: { count: number; items: { id: string; title: string; path: string }[] };
  collections: { count: number; items: { collectionId: string; name: string; entries: number }[] };
  sources: { count: number; items: { id: string; name: string }[] };
  history: { count: number };
}

export interface RemovalPlan {
  package: { id: string; title: string };
  deletesFile: boolean;
  fileBytes: number;
  references: ZimReferences;
  needsConfirmation: boolean;
}

export interface VerifyResult { ok: boolean; checks: string[]; package: ZimPackage }

export interface WikipediaStatus {
  contactConfigured: boolean;
  breaker: { state: "closed" | "open" | "half_open"; reopensAt?: string };
  minIntervalMs: number;
  requests: number;
  retries: number;
  rateLimited: number;
  bytes: number;
  lastStatus: number;
  replacementOrigin: string | null;
  userAgentPreview: string | null;
  zimPackages: boolean;
}

export interface PreviewLevel {
  depth: number;
  candidates: number;
  willFetch: number;
  inKnowledgePackage: number;
  skipped: { disambiguation: number; lists: number; years: number; missing: number };
  estimated: boolean;
}

export interface WikipediaPreview {
  estimate: true;
  article: { title: string; language: string; url: string; revisionId: string | null; bytes: number; redirectedFrom: string | null };
  caps: { depth: number; maxPages: number; maxDepth: 3; maxPagesCeiling: 2000 };
  options: { images: boolean; preferZim: boolean; skipDisambiguation: boolean; skipLists: boolean; skipYears: boolean };
  levels: PreviewLevel[];
  totals: { pages: number; images: number; requests: number; seconds: number; bytes: number };
  knowledgePackages: { checked: number; present: number; packages: { id: string; title: string }[] };
  sample: { title: string; lead: boolean; count: number; inKnowledgePackage: boolean }[];
  requestsMade: number;
  pace: { requestsPerSecond: number };
  warnings: string[];
}

export type ZimMode = "unified" | "federated" | "off";

/** One package's list in a search response (`zim.groups[]`, docs/api.md 6.3). */
export interface ZimGroup {
  zimId: string;
  title: string;
  language: string | null;
  flavour: string | null;
  mode: "fulltext" | "titles";
  state: "ok" | "partial" | "timeout" | "error";
  message?: string;
  estimatedMatches: number;
  tookMs: number;
  hits: SearchResult[];
}

export interface ZimBlock {
  state: "ok" | "none";
  mode: "unified" | "federated";
  scope: "mixed" | "zim";
  budgetMs: number;
  tookMs: number;
  shown: number;
  groups: ZimGroup[];
  skipped: { zimId: string; title: string; reason: "cap" | "language" | "disabled" | "unavailable" }[];
}

// ---- Plain-language copy ----

export const STATE_TEXT: Record<ZimState, { label: string; variant: "success" | "warning" | "destructive" | "secondary"; help: string }> = {
  ready: { label: "Ready", variant: "success", help: "The package opens and is searched." },
  importing: { label: "Copying", variant: "secondary", help: "The file is being copied. The package is ready when the copy finishes." },
  degraded: { label: "Degraded", variant: "warning", help: "The package had a problem the last time it was read. It is tried again on the next use, and Check package can confirm it." },
  missing: { label: "File missing", variant: "destructive", help: "The file is no longer where it was added. Put it back, or remove the package." },
  removing: { label: "Being removed", variant: "secondary", help: "The package is being removed." },
};

export function stateOf(p: Pick<ZimPackage, "state">) {
  return STATE_TEXT[p.state] ?? { label: p.state, variant: "secondary" as const, help: "" };
}

export const ZIM_MODE_LABELS: Record<ZimMode, string> = {
  unified: "Mixed into the results",
  federated: "In their own groups",
  off: "Not searched",
};
export const ZIM_MODE_HELP: Record<ZimMode, string> = {
  unified: "Package results are ranked together with your saved pages.",
  federated: "Your saved pages stay as they are. Each package gets its own list.",
  off: "Packages are left out of search.",
};
export const ZIM_MODES: ZimMode[] = ["unified", "federated", "off"];
export const isZimMode = (v: unknown): v is ZimMode => v === "unified" || v === "federated" || v === "off";

export const SKIP_REASON_TEXT: Record<ZimBlock["skipped"][number]["reason"], string> = {
  cap: "left out because too many packages matched",
  language: "left out by the language filter",
  disabled: "switched off for search",
  unavailable: "not available right now",
};

const GROUP_STATE_TEXT: Record<ZimGroup["state"], string> = {
  ok: "",
  partial: "Stopped early, so the list may be short.",
  timeout: "Took too long to answer.",
  error: "Could not be searched.",
};

/** The sentence under a package's list: why it is short, or that only titles were searched. */
export function groupNote(g: Pick<ZimGroup, "state" | "mode" | "message">): string {
  if (g.message) return g.message;
  const parts = [GROUP_STATE_TEXT[g.state]];
  if (g.mode === "titles") parts.push("This package has no full-text index, so only titles were searched.");
  return parts.filter(Boolean).join(" ");
}

// ---- Formatting ----

const FLAVOUR_TEXT: Record<string, string> = { maxi: "Full", nopic: "Without images", mini: "Introductions only", nodet: "Without details" };
export const flavourLabel = (f: string | null | undefined): string => (f ? (FLAVOUR_TEXT[f] ?? f) : "Not stated");

let names: Intl.DisplayNames | null | undefined;
/** "eng" becomes "English"; "eng,fra" becomes "English, French". An unknown code is shown as it is. */
export function languageLabel(code: string | null | undefined): string {
  if (!code) return "Not stated";
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames(["en-GB"], { type: "language" });
    } catch {
      names = null;
    }
  }
  return code
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((c) => {
      try {
        const n = names?.of(c);
        return n && n !== c ? n : c;
      } catch {
        return c;
      }
    })
    .join(", ");
}

export function licenceText(p: Pick<ZimPackage, "license">): string {
  if (!p.license.name) return "Not stated";
  return p.license.known ? p.license.name : `${p.license.name} (the file did not say)`;
}

/** A package counts as a Wikipedia package when its name, title or source says so (the same rule as the server's). */
export function isWikipediaPackage(p: Pick<ZimPackage, "name" | "title" | "sourceUrl" | "creator" | "publisher">): boolean {
  return [p.name, p.title, p.sourceUrl, p.creator, p.publisher].some((v) => !!v && /wiki(pedia|media)/i.test(v));
}

export function formatCount(n: number | null | undefined): string {
  return n == null ? "–" : n.toLocaleString("en-GB");
}

/** About how long a number of seconds is, in words a person would use. */
export function formatWait(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} ${s === 1 ? "second" : "seconds"}`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} ${m === 1 ? "minute" : "minutes"}`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} ${h === 1 ? "hour" : "hours"} ${rest} min` : `${h} ${h === 1 ? "hour" : "hours"}`;
}

// ---- Addresses ----

/** `zim://{zimId}/{path}`; the path stays percent-encoded in the address, as the server writes it. */
export function zimUrl(zimId: string, path: string): string {
  return `zim://${zimId}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function parseZimUrl(url: string): { zimId: string; path: string } | null {
  const m = /^zim:\/\/([^/?#]+)\/(.+)$/i.exec(url.trim());
  if (!m) return null;
  let path = m[2]!;
  try {
    path = path.split("/").map(decodeURIComponent).join("/");
  } catch {
    /* keep the path as written */
  }
  return { zimId: m[1]!, path };
}

// ---- Package snippets: only <b> is recognised ----

/**
 * Splits a package hit's snippet into plain and bold text. The snippet is untrusted: only `<b>` and `</b>` are recognised, every other
 * angle bracket stays literal text, and the parts are rendered as React text, never as HTML.
 */
export function boldParts(snippet: string): SnippetPart[] {
  return markedParts(snippet, "b");
}

// ---- Add a package ----

export interface ImportDraft {
  path: string;
  copy: boolean;
  volumeId: string;
  priority: Priority;
  enabledForSearch: boolean;
  createSource: boolean;
  licenseName: string;
  licenseUrl: string;
  attribution: string;
}

export const emptyImportDraft = (): ImportDraft => ({
  path: "", copy: false, volumeId: "", priority: "P1", enabledForSearch: true, createSource: true, licenseName: "", licenseUrl: "", attribution: "",
});

export type FieldErrors = Record<string, string>;

export function validateImport(d: ImportDraft): FieldErrors {
  const e: FieldErrors = {};
  const p = d.path.trim();
  if (!p) e.path = "Enter the full path of the .zim file, for example /mnt/library/wikipedia_en.zim.";
  else if (!p.startsWith("/") && !/^[a-z]:[\\/]/i.test(p)) e.path = "Enter the full path, starting from the top folder.";
  else if (!/\.zim$/i.test(p)) e.path = "The file name must end in .zim. Split files (.zimaa) are not supported.";
  if (d.licenseUrl.trim() && !/^https?:\/\/\S+$/i.test(d.licenseUrl.trim())) e.licenseUrl = "Enter a web address starting with https://.";
  return e;
}

/** The body of POST /api/zim/packages/import. A copy is asynchronous so the dialog can show that it is working. */
export function importBody(d: ImportDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    path: d.path.trim(), copy: d.copy, priority: d.priority, enabledForSearch: d.enabledForSearch, createSource: d.createSource,
  };
  if (d.copy) {
    body.async = true;
    if (d.volumeId) body.volumeId = d.volumeId;
  }
  if (d.licenseName.trim()) body.licenseName = d.licenseName.trim();
  if (d.licenseUrl.trim()) body.licenseUrl = d.licenseUrl.trim();
  if (d.attribution.trim()) body.attribution = d.attribution.trim();
  return body;
}

/** Server field errors for the import dialog, plus plain wording for the duplicate case. */
export function importErrors(err: unknown): { fields: FieldErrors; general: string | null } {
  const fields = fieldErrors(err);
  if (Object.keys(fields).length) return { fields, general: null };
  if (err instanceof ApiError) {
    if (err.status === 409) {
      const existing = (err.details as { existing?: { title?: string } } | undefined)?.existing;
      return { fields: {}, general: existing?.title ? `This package is already added as "${existing.title}".` : err.message };
    }
    if (err.status === 507) return { fields: {}, general: "There is not enough room on the volume for a copy. Choose another volume, or leave the file where it is." };
    return { fields: {}, general: err.message };
  }
  return { fields: {}, general: errorMessage(err) };
}

// ---- Removal ----

export interface RefLine { key: string; label: string; count: number }

/** The lines of the dry-run list: only what is actually referenced. */
export function referenceLines(refs: ZimReferences): RefLine[] {
  const out: RefLine[] = [];
  const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
  if (refs.bookmarks.count) out.push({ key: "bookmarks", count: refs.bookmarks.count, label: `${plural(refs.bookmarks.count, "bookmark", "bookmarks")} of articles in this package. Bookmarks that point only here are deleted; ones that also point at a saved page keep the saved page.` });
  if (refs.collections.count) out.push({ key: "collections", count: refs.collections.count, label: `${plural(refs.collections.count, "collection holds", "collections hold")} articles from this package. Those entries are taken out of the collection.` });
  if (refs.sources.count) out.push({ key: "sources", count: refs.sources.count, label: `${plural(refs.sources.count, "source is", "sources are")} bound to this package. ${refs.sources.count === 1 ? "It is" : "They are"} retired.` });
  if (refs.history.count) out.push({ key: "history", count: refs.history.count, label: `${plural(refs.history.count, "history entry", "history entries")} for this package. The entries stay in History without the package link.` });
  return out;
}

/** What happens to the file. A file added in place stays on disk; only a copy NoConBrain made is deleted. */
export function fileOutcome(plan: Pick<RemovalPlan, "deletesFile" | "fileBytes">, formatBytes: (n: number) => string): string {
  return plan.deletesFile
    ? `NoConBrain made a copy of this file, so removing the package deletes that copy (${formatBytes(plan.fileBytes)}). The original file you added is not touched.`
    : "This package was added in place, so its file stays on disk where it is. Removing the package only forgets it; no file is deleted.";
}

// ---- Wikipedia topic crawl ----

export interface CrawlDraft {
  start: string;
  language: string;
  depth: string;
  maxPages: string;
  preferZim: boolean;
  skipDisambiguation: boolean;
  skipLists: boolean;
  skipYears: boolean;
  images: boolean;
  name: string;
  priority: Priority;
}

export const CRAWL_DEFAULTS: CrawlDraft = {
  start: "", language: "en", depth: "1", maxPages: "200", preferZim: true, skipDisambiguation: true, skipLists: true, skipYears: true, images: true, name: "", priority: "P3",
};
export const MAX_DEPTH = 3;
export const MAX_PAGES = 2000;

/** Languages offered in the form. Any other two or three letter code can be typed in the address instead. */
export const WIKI_LANGUAGES: { value: string; label: string }[] = [
  { value: "en", label: "English" }, { value: "simple", label: "Simple English" }, { value: "de", label: "German" }, { value: "fr", label: "French" },
  { value: "es", label: "Spanish" }, { value: "it", label: "Italian" }, { value: "pt", label: "Portuguese" }, { value: "nl", label: "Dutch" },
  { value: "cy", label: "Welsh" }, { value: "ga", label: "Irish" }, { value: "gd", label: "Scottish Gaelic" }, { value: "pl", label: "Polish" },
];

/** A start address, or a title typed as words. */
export function parseStart(input: string): { url: string } | { title: string } | null {
  const v = input.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return { url: v };
  return { title: v };
}

export function validateCrawl(d: CrawlDraft): FieldErrors {
  const e: FieldErrors = {};
  const start = parseStart(d.start);
  if (!start) e.start = "Enter an article title or a Wikipedia address.";
  else if ("url" in start && !/^https?:\/\/[a-z0-9-]+(\.m)?\.wikipedia\.org\//i.test(start.url)) e.start = "Enter an address on wikipedia.org, or just the article title.";
  const depth = Number(d.depth);
  if (!/^\d+$/.test(d.depth.trim()) || depth < 0 || depth > MAX_DEPTH) e.depth = `Enter a whole number from 0 to ${MAX_DEPTH}. For more, add a knowledge package instead.`;
  const pages = Number(d.maxPages);
  if (!/^\d+$/.test(d.maxPages.trim()) || pages < 1 || pages > MAX_PAGES) e.maxPages = `Enter a whole number from 1 to ${MAX_PAGES.toLocaleString("en-GB")}.`;
  if (start && "title" in start && !/^[a-z]{2,3}(-[a-z]+)*$/i.test(d.language.trim())) e.language = "Enter a language code such as en or de.";
  return e;
}

/** The body of the preview and the crawl. */
export function crawlBody(d: CrawlDraft): Record<string, unknown> {
  const start = parseStart(d.start)!;
  const body: Record<string, unknown> = {
    ...("url" in start ? { url: start.url } : { title: start.title, language: d.language.trim().toLowerCase() }),
    depth: Number(d.depth), maxPages: Number(d.maxPages), images: d.images, preferZim: d.preferZim,
    skipDisambiguation: d.skipDisambiguation, skipLists: d.skipLists, skipYears: d.skipYears,
  };
  return body;
}

export function crawlStartBody(d: CrawlDraft): Record<string, unknown> {
  return { ...crawlBody(d), ...(d.name.trim() ? { name: d.name.trim() } : {}), priority: d.priority };
}

/** Plain words for a failed preview or crawl. */
export function wikipediaErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return errorMessage(err);
  const wait = (err.details as { retryAfterMs?: number } | undefined)?.retryAfterMs;
  if (err.status === 404) return "Wikipedia has no article with that title. Check the spelling, or paste the address.";
  if (err.status === 409 && err.code === "offline") return "Work offline is on, or there is no connection. The preview needs to ask Wikipedia, so turn Work offline off first.";
  if (err.status === 429 || err.code === "rate_limited") return `Wikipedia asked for a pause.${wait ? ` Try again in about ${formatWait(wait / 1000)}.` : " Try again in a minute."}`;
  if (err.status === 503 || err.code === "unavailable") return `Requests to Wikipedia are paused.${wait ? ` They can start again in about ${formatWait(wait / 1000)}, or press Try again now in the status panel.` : ""}`;
  if (/NCB_CONTACT/.test(err.message)) return "NoConBrain has no contact for Wikipedia. Set NCB_CONTACT on the server (see the status panel) and restart it.";
  return err.message;
}

export interface LevelRow { depth: number; label: string; willFetch: number; inPackage: number; skipped: number; estimated: boolean }

export function levelRows(p: WikipediaPreview): LevelRow[] {
  return p.levels.map((l) => ({
    depth: l.depth,
    label: l.depth === 0 ? "The article" : `Level ${l.depth}${l.estimated ? " (estimate)" : ""}`,
    willFetch: l.willFetch,
    inPackage: l.inKnowledgePackage,
    skipped: l.skipped.disambiguation + l.skipped.lists + l.skipped.years + l.skipped.missing,
    estimated: l.estimated,
  }));
}

export function coverageText(p: WikipediaPreview): string {
  const k = p.knowledgePackages;
  if (k.packages.length === 0 && k.present === 0) return p.options.preferZim ? "No installed knowledge package holds a Wikipedia in this language, so every page would be fetched from Wikipedia." : "Package copies are not preferred, so every page would be fetched from Wikipedia.";
  const names = k.packages.map((x) => x.title).join(", ");
  return `${k.present.toLocaleString("en-GB")} of the ${k.checked.toLocaleString("en-GB")} first links ${k.present === 1 ? "is" : "are"} already in ${names || "a package"}${p.options.preferZim ? " and would not be fetched" : ""}.`;
}

export function breakerText(s: Pick<WikipediaStatus, "breaker">): { label: string; help: string; open: boolean } {
  switch (s.breaker.state) {
    case "open": return { label: "Paused", help: "Wikipedia refused several requests in a row, so NoConBrain stopped asking for five minutes.", open: true };
    case "half_open": return { label: "Trying again", help: "The pause is over. The next request decides whether Wikipedia is reachable.", open: false };
    default: return { label: "Running normally", help: "Requests to Wikipedia are allowed, at no more than one a second.", open: false };
  }
}

// ---- Search settings (group `search`) ----

export interface ZimSearchSettings { zimMaxPackagesPerSearch: number; zimHitsPerPackage: number }
export const ZIM_SETTING_DEFAULTS: ZimSearchSettings = { zimMaxPackagesPerSearch: 5, zimHitsPerPackage: 20 };
export const ZIM_SETTING_RANGES = { zimMaxPackagesPerSearch: [1, 20], zimHitsPerPackage: [1, 50] } as const;

export function validateZimSettings(draft: { zimMaxPackagesPerSearch: string; zimHitsPerPackage: string }): { values: ZimSearchSettings | null; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const out = {} as ZimSearchSettings;
  for (const k of ["zimMaxPackagesPerSearch", "zimHitsPerPackage"] as const) {
    const [lo, hi] = ZIM_SETTING_RANGES[k];
    const raw = draft[k].trim();
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < lo || n > hi) errors[k] = `Enter a whole number from ${lo} to ${hi}.`;
    else out[k] = n;
  }
  return { values: Object.keys(errors).length ? null : out, errors };
}

// ---- Verify ----

const CHECK_NAMES: Record<string, string> = {
  size: "File size", file: "File", open: "Opening the file", checksum: "Embedded checksum", dirent_pointers: "Entry pointers", dirent_order: "Entry order",
  cluster_pointers: "Content pointers",
};
const CHECK_RESULTS: Record<string, string> = { ok: "passed", failed: "failed", changed: "is different from when the package was added", missing: "is missing" };

/** One check from POST /api/zim/packages/{id}/verify as a sentence. */
export function checkText(code: string): { text: string; ok: boolean } {
  const [name = "", result = ""] = code.split(":");
  const label = CHECK_NAMES[name] ?? name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  if (name === "open" && result === "failed") return { text: "The package could not be opened.", ok: false };
  return { text: `${label} ${CHECK_RESULTS[result] ?? result}`.trim(), ok: result === "ok" };
}

// ---- Wikipedia attribution on an archived version (GET /api/archive/versions/{id}) ----

export interface VersionAttribution {
  licenseName: string | null;
  licenseUrl: string | null;
  sourceUrl: string | null;
  revisionId: string | null;
  historyUrl: string | null;
  creditText: string | null;
  retrievedAt?: string;
  images?: { file: string | null; url: string | null; author: string | null; licenseName: string | null; licenseUrl: string | null; sourcePageUrl: string | null }[];
}

/** Only http and https addresses become links; the credit data comes from a web service. */
export function safeLink(url: string | null | undefined): string | null {
  return url && /^https?:\/\/[^\s]+$/i.test(url) ? url : null;
}
