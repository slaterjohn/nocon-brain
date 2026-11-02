// Search shapes from docs/api.md section 6 (copied, not imported), the URL <-> state mapping for the results page, and small pure helpers.
// Facets, suggestions, saved searches and history are not fully typed in docs/api.md, so the readers below accept the likely spellings.

export type Iso = string;
export type Scope = "all" | "offline" | "online" | "images" | "documents";
export type Availability = "cached" | "partial" | "queued" | "online_only";

export interface SearchFilters {
  sources?: string[];
  collections?: string[];
  domains?: string[];
  types?: string[];
  downloadedFrom?: Iso;
  downloadedTo?: Iso;
  publishedFrom?: Iso;
  publishedTo?: Iso;
  availability?: Availability[];
  languages?: string[];
}

export interface SearchRequest {
  query: string;
  scope?: Scope;
  filters?: SearchFilters;
  online?: "auto" | "off" | "on";
  /** Typo tolerance and "did you mean". Off for "Search instead for ...". */
  typo?: boolean;
  page?: number;
  pageSize?: number;
}

export interface Facet {
  value: string;
  label: string;
  count: number;
}

export interface Facets {
  sources: Facet[];
  collections: Facet[];
  domains: Facet[];
  types: Facet[];
  languages: Facet[];
  availability: Facet[];
  /** True when the counts were taken over a capped set of matches. */
  approximate: boolean;
}

export interface SearchResult {
  key: string;
  url: string;
  canonicalUrl: string;
  title: string;
  /** The title with matches in <mark>; same rules as `snippet`. */
  titleHtml?: string;
  /** HTML restricted to <mark> by the server. Never inserted as HTML here (see `markedParts`). */
  snippet: string;
  origin: "archive" | "zim" | "online";
  availability: "cached" | "partial" | "queued" | "online_only" | "zim";
  pageId?: string;
  zimId?: string;
  zimPath?: string;
  domain: string;
  type: string;
  language?: string;
  capturedAt?: Iso;
  publishedAt?: Iso;
  attribution?: { kind: "local" | "zim" | "provider"; id: string; name: string; rank: number }[];
  alsoOnline?: boolean;
  storage?: "persist" | "transient";
  actions?: { open: string; saveForOffline: boolean };
  /** Near-identical pages collapsed into this result. */
  alsoAt?: { pageId: string; url: string; title: string }[];
  /** A same-origin path to the archived favicon, or null. Never a remote address. */
  faviconUrl?: string | null;
  sourceName?: string | null;
  collections?: { id: string; name: string }[];
}

export interface Coverage {
  cachedMatches: number;
  onlineMatches: number;
  onlineNotArchived: number;
  queued: number;
  partial: number;
  basis: "local_exact" | "online_page_estimate";
}

export interface SearchResponse {
  searchId: string;
  parsed?: { terms: string[]; phrases: string[]; excluded: string[]; operators: Record<string, string>; warnings: string[] };
  results: SearchResult[];
  didYouMean?: { text: string; corrected: { from: string; to: string }[]; appliedAutomatically: boolean };
  coverage?: Coverage;
  facets?: Partial<Record<keyof Facets, unknown>>;
  total?: number;
  totalCapped?: boolean;
  online?: { state: "disabled" | "offline" | "pending" | "done"; pending: string[]; disclosure: string };
  index?: { state: "ok" | "building" | "missing" | "rebuilding" | "error" };
  warnings?: string[];
  tookMs?: { local: number; zim: number };
  nextCursor?: string;
}

// ---- State in the address of the results page ----

export interface SearchState {
  q: string;
  scope: Scope;
  sources: string[];
  collections: string[];
  domains: string[];
  types: string[];
  /** Dates as yyyy-mm-dd, the value of a date field. */
  dlFrom: string;
  dlTo: string;
  pubFrom: string;
  pubTo: string;
  availability: Availability[];
  languages: string[];
  /** "Search instead for ...": keep the words as typed (no typo correction). */
  exact: boolean;
  /** Set when a saved search is being run again: page 1 comes from POST /api/search/saved/{id}/run. */
  saved: string;
}

export const EMPTY_STATE: SearchState = {
  q: "", scope: "all", sources: [], collections: [], domains: [], types: [],
  dlFrom: "", dlTo: "", pubFrom: "", pubTo: "", availability: [], languages: [], exact: false, saved: "",
};

const SCOPES: Scope[] = ["all", "offline", "online", "images", "documents"];
const AVAIL: Availability[] = ["cached", "partial", "queued", "online_only"];

type ParamReader = { get(name: string): string | null; getAll(name: string): string[] };

export function stateFromParams(p: ParamReader): SearchState {
  const scope = p.get("scope") as Scope | null;
  return {
    q: p.get("q") ?? "",
    scope: scope && SCOPES.includes(scope) ? scope : "all",
    sources: p.getAll("source"),
    collections: p.getAll("collection"),
    domains: p.getAll("domain"),
    types: p.getAll("type"),
    dlFrom: p.get("dlFrom") ?? "",
    dlTo: p.get("dlTo") ?? "",
    pubFrom: p.get("pubFrom") ?? "",
    pubTo: p.get("pubTo") ?? "",
    availability: p.getAll("avail").filter((a): a is Availability => AVAIL.includes(a as Availability)),
    languages: p.getAll("lang"),
    exact: p.get("exact") === "1",
    saved: p.get("saved") ?? "",
  };
}

export function paramsFromState(s: SearchState): URLSearchParams {
  const p = new URLSearchParams();
  p.set("q", s.q);
  if (s.scope !== "all") p.set("scope", s.scope);
  for (const v of s.sources) p.append("source", v);
  for (const v of s.collections) p.append("collection", v);
  for (const v of s.domains) p.append("domain", v);
  for (const v of s.types) p.append("type", v);
  if (s.dlFrom) p.set("dlFrom", s.dlFrom);
  if (s.dlTo) p.set("dlTo", s.dlTo);
  if (s.pubFrom) p.set("pubFrom", s.pubFrom);
  if (s.pubTo) p.set("pubTo", s.pubTo);
  for (const v of s.availability) p.append("avail", v);
  for (const v of s.languages) p.append("lang", v);
  if (s.exact) p.set("exact", "1");
  if (s.saved) p.set("saved", s.saved);
  return p;
}

export const searchHref = (s: Partial<SearchState> & { q: string }) => `/search?${paramsFromState({ ...EMPTY_STATE, ...s }).toString()}`;

/** How many filters (not counting the category) are set. */
export function filterCount(s: SearchState): number {
  return (
    s.sources.length + s.collections.length + s.domains.length + s.types.length + s.availability.length + s.languages.length +
    [s.dlFrom, s.dlTo, s.pubFrom, s.pubTo].filter(Boolean).length
  );
}

export function filtersFromState(s: SearchState): SearchFilters {
  const f: SearchFilters = {};
  if (s.sources.length) f.sources = s.sources;
  if (s.collections.length) f.collections = s.collections;
  if (s.domains.length) f.domains = s.domains;
  if (s.types.length) f.types = s.types;
  if (s.dlFrom) f.downloadedFrom = `${s.dlFrom}T00:00:00.000Z`;
  if (s.dlTo) f.downloadedTo = `${s.dlTo}T23:59:59.999Z`;
  if (s.pubFrom) f.publishedFrom = `${s.pubFrom}T00:00:00.000Z`;
  if (s.pubTo) f.publishedTo = `${s.pubTo}T23:59:59.999Z`;
  if (s.availability.length) f.availability = s.availability;
  if (s.languages.length) f.languages = s.languages;
  return f;
}

/** The reverse of `filtersFromState`, for a saved search. */
export function stateFromSaved(saved: { id: string; query: string; filters?: SearchFilters; scope?: Scope }): SearchState {
  const f = saved.filters ?? {};
  const query = saved.query;
  const day = (v?: string) => (v ? v.slice(0, 10) : "");
  return {
    ...EMPTY_STATE,
    q: query,
    scope: saved.scope && SCOPES.includes(saved.scope) ? saved.scope : "all",
    saved: saved.id,
    sources: f.sources ?? [],
    collections: f.collections ?? [],
    domains: f.domains ?? [],
    types: f.types ?? [],
    dlFrom: day(f.downloadedFrom),
    dlTo: day(f.downloadedTo),
    pubFrom: day(f.publishedFrom),
    pubTo: day(f.publishedTo),
    availability: f.availability ?? [],
    languages: f.languages ?? [],
  };
}

export function requestFromState(s: SearchState, opts: { page: number; pageSize: number; onlineAvailable: boolean }): SearchRequest {
  const req: SearchRequest = { query: s.q, scope: s.scope, page: opts.page, pageSize: opts.pageSize };
  if (s.exact) req.typo = false;
  const filters = filtersFromState(s);
  if (Object.keys(filters).length) req.filters = filters;
  req.online = s.scope === "offline" || s.scope === "images" || s.scope === "documents" ? "off" : opts.onlineAvailable ? "auto" : "off";
  return req;
}

// ---- Snippets ----

export interface SnippetPart {
  text: string;
  mark: boolean;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodes the few entities a text escaper produces. Anything else stays as written. This never produces markup: the result is used as text. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e: string) => {
    const lower = e.toLowerCase();
    if (lower in ENTITIES) return ENTITIES[lower]!;
    const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
  });
}

/**
 * Splits the server's snippet into plain text and highlighted text. The snippet is untrusted: only `<mark>` and `</mark>` are
 * recognised, every other angle bracket is kept as literal text, and the parts are rendered as React text, never as HTML.
 */
export function markedParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let mark = false;
  let last = 0;
  const re = /<(\/?)mark>/gi;
  let m: RegExpExecArray | null;
  const push = (raw: string) => {
    const text = decodeEntities(raw);
    if (text) parts.push({ text, mark });
  };
  while ((m = re.exec(snippet))) {
    push(snippet.slice(last, m.index));
    mark = m[1] === "";
    last = m.index + m[0].length;
  }
  push(snippet.slice(last));
  return parts;
}

// ---- Tolerant readers for shapes docs/api.md does not type ----

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export function readFacets(raw: SearchResponse["facets"]): Facets {
  const one = (list: unknown): Facet[] =>
    (Array.isArray(list) ? list : [])
      .map((f) => {
        const o = rec(f);
        const value = str(o.value ?? o.id ?? o.key ?? o.name ?? o.label);
        return { value, label: str(o.label ?? o.name ?? o.title ?? value), count: Number(o.count ?? 0) };
      })
      .filter((f) => f.value);
  return {
    sources: one(raw?.sources), collections: one(raw?.collections), domains: one(raw?.domains), types: one(raw?.types), languages: one(raw?.languages),
    availability: one(raw?.availability), approximate: raw?.approximate === true,
  };
}

export interface Suggestion {
  text: string;
  kind: "query" | "title" | "domain" | "term" | "other";
  /** For a title suggestion: where it points. */
  url?: string;
}

export interface SuggestionsResult {
  suggestions: Suggestion[];
  didYouMean?: string;
}

export function readSuggestions(raw: unknown): SuggestionsResult {
  const o = rec(raw);
  const list = (Array.isArray(raw) ? raw : (o.suggestions ?? o.items ?? o.results ?? [])) as unknown[];
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(list) ? list : []) {
    const r = rec(item);
    const text = typeof item === "string" ? item : str(r.text ?? r.query ?? r.title ?? r.value ?? r.label ?? r.domain);
    const kindRaw = str(r.kind ?? r.type);
    const kind: Suggestion["kind"] = kindRaw === "query" || kindRaw === "title" || kindRaw === "domain" || kindRaw === "term" ? kindRaw : "other";
    if (!text || seen.has(`${kind}:${text}`)) continue;
    seen.add(`${kind}:${text}`);
    out.push({ text, kind, url: str(r.url) || undefined });
  }
  const dym = o.didYouMean;
  const didYouMean = typeof dym === "string" ? dym : str(rec(dym).text) || undefined;
  return { suggestions: out, didYouMean };
}

/** What choosing a suggestion searches for. A site suggestion becomes a `site:` search. */
export function suggestionQuery(s: Suggestion): string {
  return s.kind === "domain" ? `site:${s.text}` : s.text;
}

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  filters?: SearchFilters;
  scope?: Scope;
  includeOnline?: boolean;
  collectionId?: string | null;
  createdAt?: string;
  lastRunAt?: string | null;
  lastResultCount?: number | null;
}

export function readSaved(raw: unknown): SavedSearch | null {
  const o = rec(raw);
  const id = str(o.id);
  const query = str(o.query);
  if (!id) return null;
  const filters = (o.filters ?? o.filtersJson) as SearchFilters | undefined;
  return {
    id,
    name: str(o.name) || query,
    query,
    filters: filters && typeof filters === "object" ? filters : undefined,
    scope: SCOPES.includes(o.scope as Scope) ? (o.scope as Scope) : undefined,
    includeOnline: typeof o.includeOnline === "boolean" ? o.includeOnline : undefined,
    collectionId: str(o.collectionId) || null,
    createdAt: str(o.createdAt) || undefined,
    lastRunAt: str(o.lastRunAt) || null,
    lastResultCount: typeof o.lastResultCount === "number" ? o.lastResultCount : null,
  };
}

export function readSavedList(raw: unknown): SavedSearch[] {
  const o = rec(raw);
  const list = (Array.isArray(raw) ? raw : (o.items ?? o.searches ?? [])) as unknown[];
  return (Array.isArray(list) ? list : []).map(readSaved).filter((s): s is SavedSearch => !!s);
}

export interface HistoryItem {
  id: string;
  query: string;
  scope?: Scope;
  at?: string;
}

export interface HistoryList {
  enabled: boolean;
  items: HistoryItem[];
}

export function readHistory(raw: unknown): HistoryList {
  const o = rec(raw);
  const list = (Array.isArray(raw) ? raw : (o.items ?? [])) as unknown[];
  const items = (Array.isArray(list) ? list : []).map((i, n) => {
    const r = rec(i);
    return { id: str(r.id) || String(n), query: str(r.query ?? r.text), scope: SCOPES.includes(r.scope as Scope) ? (r.scope as Scope) : undefined, at: str(r.at ?? r.searchedAt ?? r.createdAt) || undefined };
  }).filter((i) => i.query);
  return { enabled: typeof o.enabled === "boolean" ? o.enabled : true, items };
}

// ---- Labels ----

export const TYPE_LABELS: Record<string, string> = {
  html: "Web page", pdf: "PDF", markdown: "Markdown", text: "Text or Markdown", rendered: "Rendered page", image: "Image", images: "Image", other: "Other",
};
export const typeLabel = (t: string) => TYPE_LABELS[t] ?? t;

export const AVAILABILITY_LABELS: Record<SearchResult["availability"], string> = {
  cached: "Saved",
  partial: "Partly saved",
  queued: "Waiting to be saved",
  online_only: "Online only",
  zim: "Offline library",
};

export const AVAILABILITY_FILTERS: { value: Availability; label: string }[] = [
  { value: "cached", label: "Saved" },
  { value: "partial", label: "Partly saved" },
  { value: "queued", label: "Waiting to be saved" },
  { value: "online_only", label: "Online only" },
];

export const SCOPE_LABELS: Record<Scope, string> = { all: "All", offline: "Offline", online: "Online", images: "Images", documents: "Documents" };

/** An imported file has a made-up address that is never shown. */
export const isImportedAddress = (url: string) => /^https?:\/\/imports\.noconbrain\.invalid\//i.test(url);

/** The address as a reader sees it in a result: host and path without the scheme, `›` between parts. */
export function displayAddress(url: string): string {
  if (isImportedAddress(url)) return "Imported document";
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "").split("/").filter(Boolean).map(decodeURIComponentSafe);
    return [u.host, ...path].join(" › ");
  } catch {
    return url;
  }
}

function decodeURIComponentSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
