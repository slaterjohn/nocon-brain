# API specification (conceptual)

Status: proposed contract. Shapes are TypeScript-style and will be implemented as zod 4 schemas shared by `server` and `web`. Anything not listed here is not part of v1.

## 1. Conventions

- Base: the `server` Fastify service on its internal port. The browser only talks to the `web` container, which proxies `/api/*` (including streaming responses) and forwards an explicit header allowlist: `Cookie`, `Content-Type`, `Accept`, `Origin`, `Referer`, `Sec-Fetch-Site`, `Sec-Fetch-Mode`, `Last-Event-ID`, `X-NoCon-CSRF`, plus the stamped `x-nocon-client-ip`, `x-nocon-proxy-secret` and `x-forwarded-host`. Client-supplied forwarding headers are dropped (pattern from NoConMedia).
- JSON everywhere unless stated (SSE, uploads, archive listener). Dates are ISO 8601 strings in UTC. Sizes are bytes (numbers). IDs are public IDs (prefixed ULIDs, e.g. `pg_01J…`).
- Types used below:

```ts
type Priority = "P1" | "P2" | "P3" | "P4";       // Protected, Important, Standard, Opportunistic
type Iso = string;
interface Page<T> { items: T[]; nextCursor?: string; total?: number }   // ?limit= (default 50, max 200) &cursor=
interface ApiError { error: ErrorCode; message: string; details?: unknown; requestId: string }
type ErrorCode = "bad_request" | "unauthorized" | "forbidden" | "csrf" | "not_found" | "conflict"
  | "rate_limited" | "setup_required" | "offline" | "blocked" | "insufficient_storage"
  | "provider_error" | "not_implemented" | "internal";
```

- **Auth.** Cookie `ncb_session` (`HttpOnly`, `SameSite=Lax`). Legend used in the tables:
  - **S** session required; **S+C** session and CSRF; **P** public (no session).
  - **G** also readable by a trusted-LAN guest (read-only; never any mutation) when `NCB_AUTH_MODE` allows.
- **CSRF.** Every `POST`, `PUT`, `PATCH` and `DELETE` must carry `X-NoCon-CSRF: 1` and, when present, an `Origin`/`Referer` matching `NCB_APP_URL`. In addition, **any** request (including `GET`) whose `Sec-Fetch-Site` is `same-site` or `cross-site` is rejected with 403 `csrf` unless it carries the CSRF header with a matching `Origin`. `same-origin` and `none` pass. `EventSource` cannot set headers, so SSE endpoints rely on `same-origin` fetch metadata. This is the control that protects the API if script ever ran on the archive origin ([architecture.md](architecture.md#the-cookie-finding-and-what-follows)).
- **Validation.** Every body, query and param is validated with zod; unknown fields are stripped; body limit 1 MiB (uploads have their own routes).
- **Rate limits.** 600 requests/min/IP globally; login 5/min/IP and 20/hour/username; provider-triggering routes have their own limits. 429 returns `Retry-After`.
- **Idempotency.** Create endpoints for downloads accept an `Idempotency-Key` header (24 h window) so retries do not duplicate jobs.
- **Errors never include stack traces.** Messages are plain UK English and say what to do next.
- **Online-only operations while offline** return 409 `offline` with `{ canQueue: true }` where queuing is possible.

## 2. Auth and setup

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/setup/status` | `{ adminExists, storageConfigured, profile, firstSourceCreated, complete }` | P |
| POST | `/api/setup/admin` | Create the admin. Only while no admin exists; checks before hashing | P (only pre-admin) + C |
| POST | `/api/setup/storage/validate` | Validation only, registers nothing. `{ path, reserveFreeBytes? }` returns `{ ok, path?, totalBytes?, freeBytes?, warnings, errors: {path, message}[] }`. Also open to a signed-in admin after setup (Storage settings reuses it) | S+C |
| POST | `/api/setup/storage` | Validate and register the first volume | S+C |
| POST | `/api/setup/profile` | Choose resource profile | S+C |
| POST | `/api/setup/providers` | Optional: create providers (skippable) | S+C |
| POST | `/api/setup/first-source` | Create the first source and optionally start it | S+C |
| POST | `/api/setup/complete` | Mark the wizard finished | S+C |
| POST | `/api/auth/login` | `{ username, password }` sets cookie | P + C |
| POST | `/api/auth/logout` | Revokes the current session | S+C |
| GET | `/api/auth/me` | `{ user, mode: "admin" \| "guest", csrfRequired: true }` | S/G |
| GET | `/api/auth/sessions` | List sessions | S |
| DELETE | `/api/auth/sessions/{id}` | Revoke one (or `?all=true` to revoke all but current) | S+C |
| POST | `/api/auth/password` | `{ current, next }` | S+C |

Implementation notes (server, Phase 1): `/api/setup/profile` takes `{ profile: "pi-lite" | "standard" }` and applies that profile's resource preset; `/api/setup/providers` takes `{ skip: true }` (a non-empty `providers` list returns 501 until providers exist); `/api/setup/first-source` returns 501 until sources exist; the setup steps return 409 `conflict` once `/api/setup/complete` has run. `POST /api/auth/login` and `/api/setup/admin` return `{ user: { id, username } }`; `GET /api/auth/me` returns `user: { id: "guest", username: "Guest" }` for a trusted-LAN guest. `GET /api/auth/sessions` returns `{ items: { id, createdAt, lastSeenAt, expiresAt, ip, userAgent, current }[] }`; the session `id` is an opaque 16-character reference. `DELETE /api/auth/sessions/{id}?all=true` (the id is ignored) and `DELETE /api/auth/sessions` revoke every session but the current one. Unauthenticated routes other than health answer 503 with `Retry-After` while the server is starting, and 409 `setup_required` until an admin exists. Validation errors carry `details: { fields: { in, path, message }[] }`.

```ts
interface SetupStorageRequest { path: string /* under an allowed root */; name: string; quotaBytes?: number; reserveFreeBytes?: number }
interface SetupStorageResponse { volume: Volume; warnings: ("on_container_filesystem" | "sd_card_suspected" | "low_free_space")[] }
```

## 3. Browser

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | `/api/browser/resolve` | Resolve address-bar input (URL flow) | S+C, G (read-only resolve allowed) |
| GET | `/api/browser/frame-state` | `?frameId=` last document the listener served to that frame | S/G |
| POST | `/api/browser/link-states` | Batch link-state lookup (for the shell, search results, bookmarks) | S+C |
| POST | `/api/browser/live-check` | Server-side `HEAD` probe through the SSRF guard: can this URL be framed? | S+C |
| POST | `/api/browser/save` | Save the current page: queue a capture (`kind: "capture"`) | S+C |
| GET | `/api/browser/offline-page` | Data for the offline page (reason, queue offer) | S |

```ts
interface ResolveRequest {
  input: string;                       // URL, host-like text or search terms
  tabId?: string;
  prefer?: "archive" | "live" | "reader";   // archived/live switching, reader mode
  versionId?: string;                  // open a specific version
  frame?: { appOrigin: string };       // used to mint the token; checked against NCB_APP_URL
}

type Resolution =
  | { kind: "search"; query: string }                              // not a URL: go to /search
  | { kind: "archive"; page: PageSummary; version: VersionSummary; mode: "original" | "reader"; frame: FrameInfo }
  | { kind: "cache"; page: PageSummary; version: VersionSummary; mode: "original" | "reader"; frame: FrameInfo }  // browsing-cache only (P4)
  | { kind: "zim"; zim: ZimSummary; path: string; frame: FrameInfo }
  | { kind: "live"; url: string; frameable: boolean | "unknown"; canSave: true }  // online; opens in a new tab or optional frame
  | { kind: "offline"; url: string; reason: "offline" | "forced_offline" | "blocked" | "not_archived";
      canQueue: boolean; queueEstimate?: Estimate };               // offline page with an offer to queue

interface ResolveResponse {
  normalizedUrl: string;               // display form
  urlKey: string;                      // dedup key
  resolution: Resolution;
  alternatives: ("archive" | "cache" | "zim" | "live" | "reader")[];   // for the archived/live switch
  connectivity: "online" | "offline" | "unknown";
}
interface FrameInfo { url: string /* http://host:3002/a/<token>/p/pg_… */; frameId: string; expiresAt: Iso; sandbox: string /* attribute value */ }
```

Order of resolution: normalise, then archive, then ZIM, then cache, then live if online, otherwise the offline page. Resolve never fetches anything from the network itself. A live URL is opened by the user (new tab) or, if `live-check` allowed it, in a sandboxed frame.

```ts
interface LinkStateRequest { urls: string[] /* max 200 */ }
interface LinkState { url: string; state: "cached" | "partial" | "live_only" | "queued" | "unavailable"; pageId?: string;
  progress?: { downloadJobId: string; percent?: number } }
interface FrameState { frameId: string; url: string; title?: string; state: LinkState["state"] | "zim"; pageId?: string; versionId?: string; at: Iso }
```

`unavailable` means not archived and offline, evicted, blocked, or failed permanently; `live_only` means not archived and online.

## 4. Archive: pages, versions, capture

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/archive/pages` | List and filter: `q`, `sourceId`, `collectionId`, `domain`, `type`, `availability`, `priority`, `from`, `to`, `sort` | S/G |
| GET | `/api/archive/pages/{id}` | Detail incl. versions summary, references, collections | S/G |
| PATCH | `/api/archive/pages/{id}` | `{ pin?: { priority: Priority } \| null, collections?: {add: string[], remove: string[]} }` | S+C |
| POST | `/api/archive/pages/{id}/recapture` | New capture now (creates a download job) | S+C |
| DELETE | `/api/archive/pages/{id}` | **Explicit deletion.** `?dryRun=true` returns impact; `confirmProtected=true` required for P1/P2; `exclude=true` (default) adds a `url_exclusions` row | S+C |
| GET | `/api/archive/pages/{id}/links` | `?direction=in\|out`, with link states | S/G |
| GET | `/api/archive/versions` | `?pageId=` list versions | S/G |
| GET | `/api/archive/versions/{id}` | Detail: status, partial reason, pipeline stages, sizes, attribution | S/G |
| GET | `/api/archive/versions/{id}/find` | `?q=` match count for find-in-page (server-side, same algorithm as listener `?hl=`) | S/G |
| GET | `/api/archive/versions/{id}/stages` | Pipeline stage runs with errors | S |
| POST | `/api/archive/versions/{id}/reprocess` | Re-run from a stage `{ fromStage?: Stage }` | S+C |
| DELETE | `/api/archive/versions/{id}` | Explicit version deletion (same confirmation rules) | S+C |
| POST | `/api/archive/capture` | Convenience: `{ url, sourceId?, priority?, mode?: "capture" }` creates a download job | S+C |
| POST | `/api/archive/import` | `multipart/form-data` upload of HTML, PDF, text or Markdown (limit set by `NCB_IMPORT_MAX_MB`, default 50) into the `imports` system source | S+C |
| POST | `/api/archive/frame-grants` | Mint a token for a page or version without resolving: `{ pageId \| versionId, mode }` | S+C |

```ts
interface PageSummary { id: string; url: string; canonicalUrl: string; title: string; domain: string; type: DocType; language?: string;
  availability: "archived" | "partial" | "evicted" | "failed"; effectivePriority: Priority; latestVersionId?: string;
  versionCount: number; firstCapturedAt?: Iso; lastCapturedAt?: Iso; inboundCount: number }
interface VersionSummary { id: string; pageId: string; versionNo: number; status: "ready" | "partial" | "capturing" | "failed" | "evicting" | "evicted";
  partialReason?: "assets_missing" | "truncated" | "reader_only" | "size_cap"; fetchedAt: Iso; publishedAt?: Iso;
  publishedSource?: string; totalBytes: number; renderMode: "plain" | "browser"; attribution?: Attribution }
interface Attribution { licenseName: string; licenseUrl: string; sourceUrl: string; revisionId?: string; historyUrl?: string; creditText: string }
interface DeletePreview { versions: number; exclusiveBytes: number; sharedBytesKept: number; references: { sources: string[]; collections: string[]; bookmarks: number; pins: Priority[] };
  requiresConfirmation: boolean }
type DocType = "html" | "pdf" | "image" | "text" | "other";
```

## 5. Archive listener URL scheme

The archive listener is a separate HTTP server on `NCB_ARCHIVE_PORT` (default 3002). It serves archived and ZIM content only. It is read-only, ignores `Cookie`, never sets cookies, has no API routes and no auth middleware. Only `GET` and `HEAD` are accepted (others get 405 with the standard headers).

**Chosen scheme (D-1):** `/a/{token}/…`, where `token` is a signed capability.

```
/a/{token}/p/{pageId}                      latest ready/partial version of a page, rewritten document
/a/{token}/p/{pageId}/reader               reader view of the latest version
/a/{token}/v/{versionId}                   a specific version, rewritten document
/a/{token}/v/{versionId}/reader            reader view of that version
/a/{token}/v/{versionId}/r/{assetKey}      a sub-resource of that version (CSS rewritten, images, fonts)
/a/{token}/m?u={encodedUrl}&from={versionId}   interstitial for a link that is not served from the archive
/a/{token}/z/{zimId}/{path…}               an entry of a ZIM package (percent-encoded path)
/a/{token}/_/{name}                        listener static assets (interstitial and reader stylesheets)
/healthz                                   no token; "ok"
```

- **Token.** `v1.<base64url(payload)>.<base64url(HMAC-SHA256)>`; payload `{ u: userId, f: frameId, e: expiryUnixSeconds, o: appOrigin }`. Minted by `resolve` and `frame-grants` for a logged-in user; default lifetime 8 hours; signed with a key derived from `NCB_SECRET_KEY`. Rotating the key invalidates all tokens. An expired or invalid token returns a static 401 page (with the standard headers) that says the session has expired and links to the app. `/a/<token>` is redacted in logs and the CSP forbids `Referer` leakage (`no-referrer`).
- **Stable IDs.** `p/{pageId}` always shows the page's current latest version, so rewritten links in other archived pages stay valid after a re-capture. `v/{versionId}` pins a version (version selector, bookmarks of a version).
- **`assetKey`** is the base-36 form of the internal `assets.id`. This is the one place an internal ID appears in a URL (assets have no public ID). The listener only serves an asset if an `asset_references` row links it to the version in the path, so keys cannot be enumerated across captures.
- **Query parameters** (allowlisted, validated): `hl=<term>` (server-side highlight for find-in-page, wraps matches in `<mark id="ncb-hit-N">`, at most 500 matches), reader preferences `theme=light|dark`, `font=system|serif|dyslexic`, `size=1..5`, `width=narrow|medium|wide` (applied as CSS variables because no script runs).
- **Rejected alternative:** `/r/{encodedUrl}` (see [technology-decisions.md](technology-decisions.md#d-1-archive-url-scheme)).

### Response headers

Every response from the listener (including 401, 404, 405 and error pages) carries the header set in [architecture.md](architecture.md#archive-response-headers-all-route-classes). Only `/m` adds `allow-popups allow-popups-to-escape-sandbox` to the CSP `sandbox` directive. Archived documents are `Cache-Control: private, no-store`; versioned sub-resources are `private, max-age=31536000, immutable` with an `ETag` of `blob sha256 + rewriter version`.

### How rewritten links resolve

At serve time the listener parses the stored original with parse5, drops non-allowlisted nodes and attributes, resolves every URL against the page's final URL (honouring then removing `<base>`) and rewrites it. It looks up all links of a document in one batch (`url_key` and `page_aliases`) and uses the version's `asset_references` for sub-resources.

| Reference found | Rewritten to | State attribute |
|---|---|---|
| `<a href>` to a page with a `ready` latest version | `/a/{token}/p/{pageId}` (fragment kept) | `data-ncb-link="cached"` |
| `<a href>` to a page whose latest version is `partial` | `/a/{token}/p/{pageId}` | `partial` |
| `<a href>` to a URL with a `queued` or `running` job | `/a/{token}/m?u=…&from=…` | `queued` |
| `<a href>` to an unarchived URL, connectivity not offline, not blocked | `/a/{token}/m?u=…&from=…` | `live-only` |
| `<a href>` to an unarchived URL when offline, an evicted page, or a permanent failure | `/a/{token}/m?u=…&from=…` | `unavailable` |
| `<a href>` to a ZIM entry (e.g. Wikipedia URL with an enabled ZIM) | `/a/{token}/z/{zimId}/{path}` | `cached` |
| `<a href="#frag">` | unchanged | none |
| `mailto:`, `tel:`, `javascript:`, `data:` (non-image), `blob:` | `href` removed; text kept | `unsupported` |
| `img/source/video/audio/track/link[rel=stylesheet,icon]` found in the version's references | `/a/{token}/v/{versionId}/r/{assetKey}` | n/a |
| Sub-resource not in the manifest | removed, or a 1x1 transparent placeholder for `img`; `srcset` candidates not archived are dropped | n/a |
| `form[action]` | `action` removed; form kept as inert markup | n/a |
| CSS `url()`, `@import`, `@font-face src`, `image-set()` | rewritten with `css-tree` using the same manifest; unresolved ones become `none`/removed | n/a |
| `<base>`, `<meta http-equiv=refresh>`, `target=_top\|_parent`, `<script>`, `on*`, `<iframe>`, `<object>`, `<embed>`, prefetch hints | removed | n/a |

The listener injects one `<style>` block that styles `a[data-ncb-link="partial"|"queued"|"live-only"|"unavailable"]` (for example a dotted underline and a short text marker via `::after`) when the user setting `browser.showLinkStates` is on. The state of a link is determined when the page is served; reloading the frame refreshes it.

**Partial pages.** A `partial` version is served with a banner element (static HTML) that states what is missing ("3 images not saved") and offers "Download the rest" (opens an app tab). **Uncached links** never cause an external request: the listener has no outbound code path. The interstitial (`/m`) shows the URL as text, the link state, and actions: "Open the live site" (`target=_blank rel="noopener noreferrer"`, only if `http`/`https` and connectivity is not offline), "Save for offline" and "Queue" (links to app routes opened in a new tab so the Human's session is used), "Back". Offline, the "open live" action is disabled and the page explains how to queue the URL for when the connection returns.

**Non-HTML documents.** Images are served as-is with the headers above. PDFs: Chromium's PDF viewer does not run inside a sandboxed document, so the listener serves PDFs with `Content-Disposition: attachment` through an app "Download" action, and shows the extracted text via reader view (risk R-24, task C-14). SVG is rewritten to remove scripts and external references.

**ZIM entries.** `z/{zimId}/{path}` calls the `zim` worker for the entry, follows redirects with a 302 to the target path, sets `ETag` from the ZIM UUID plus path (content is immutable), sanitises HTML (scripts removed, links rewritten to the same scheme or to the interstitial for entries that do not exist or external URLs) and serves with the same headers. Both new (`Aromaticity`) and old (`A/Aromaticity`) namespace schemes are handled via `hasNewNamespaceScheme`.

## 6. Search

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | `/api/search` | Start a search; returns local and ZIM results immediately plus a `searchId` | S+C, G |
| GET | `/api/search/{searchId}/events` | **SSE** stream of online results and updates | S/G |
| GET | `/api/search/{searchId}` | Snapshot of the search; `?after=<seq>` returns events after a sequence number (polling fallback and back-navigation restore) | S/G |
| POST | `/api/search/{searchId}/more` | Next page from providers (`{ providerId? }`) | S+C |
| GET | `/api/search/suggestions` | `?q=&limit=8`: local autocomplete (titles, queries, domains) and did-you-mean; never calls providers | S/G |
| POST | `/api/search/coverage/plan` | "Improve offline coverage": estimate for selected results | S+C |
| POST | `/api/search/coverage/queue` | Queue the plan, optionally as a collection | S+C |
| GET/POST | `/api/search/providers` | List / create providers | S / S+C |
| GET/PATCH/DELETE | `/api/search/providers/{id}` | Read / update / delete | S / S+C |
| POST | `/api/search/providers/{id}/test` | Health check and a small test query; returns latency and error code | S+C |
| GET | `/api/search/providers/{id}/usage` | Request counts against caps | S |
| GET/POST/PATCH/DELETE | `/api/search/saved` , `/api/search/saved/{id}` | Saved searches; `POST /api/search/saved/{id}/run` | S / S+C |
| GET/DELETE | `/api/search/history` | Search history (only if enabled); `DELETE` clears | S / S+C |

**Progressive results: SSE chosen (D-3).** Local and ZIM results return in the `POST` response within tens of milliseconds. Online providers answer in 300 ms to a few seconds, or never. The client opens `GET /api/search/{searchId}/events` and appends. SSE was chosen over polling for server push without an interval, native reconnection with `Last-Event-ID`, and low cost. The server keeps each search session in memory for 30 minutes (ring buffer of events, URLs and titles only; snippets from providers whose `storagePolicy` is `none` stay in memory and are never written to disk), so `GET /api/search/{id}` restores the exact list for back navigation and serves as the polling fallback for environments that buffer SSE. Heartbeat comment every 15 s; `X-Accel-Buffering: no`.

```ts
interface SearchRequest {
  query: string;
  scope?: "all" | "offline" | "online" | "images" | "documents";   // "offline" = local + ZIM; "online" = providers only
  filters?: SearchFilters;
  online?: "auto" | "off" | "on";                                   // auto = per settings and connectivity
  providers?: string[];                                              // subset of enabled provider IDs
  page?: number; pageSize?: number;                                  // default 20, max 50
}
interface SearchFilters {
  sources?: string[]; collections?: string[]; domains?: string[]; types?: DocType[];
  downloadedFrom?: Iso; downloadedTo?: Iso; publishedFrom?: Iso; publishedTo?: Iso;
  availability?: ("cached" | "partial" | "queued" | "online_only")[]; languages?: string[];
}
// Operators in `query`: site:example.org  type:pdf  before:2026-01-01  after:2025-06-30  "exact phrase"  -excluded
// before:/after: use the publication date, falling back to the capture date when none is known.

interface SearchResponse {
  searchId: string;
  parsed: { terms: string[]; phrases: string[]; excluded: string[]; operators: Record<string, string>; warnings: string[] };
  results: SearchResult[];
  didYouMean?: { text: string; corrected: { from: string; to: string }[]; appliedAutomatically: boolean };
  coverage: Coverage;
  facets?: { sources: Facet[]; collections: Facet[]; domains: Facet[]; types: Facet[]; languages: Facet[] };   // local counts only
  online: { state: "disabled" | "offline" | "pending" | "done"; pending: string[] /* provider IDs */; disclosure: string };
  tookMs: { local: number; zim: number };
  nextCursor?: string;
}
interface SearchResult {
  key: string;                         // stable within the search: canonical-URL based
  url: string; canonicalUrl: string; title: string;
  snippet: string;                     // HTML restricted to <mark>; sanitised server-side
  origin: "archive" | "zim" | "online";
  availability: "cached" | "partial" | "queued" | "online_only" | "zim";
  pageId?: string; zimId?: string; zimPath?: string;
  domain: string; type: DocType; language?: string; capturedAt?: Iso; publishedAt?: Iso;
  attribution: { kind: "local" | "zim" | "provider"; id: string; name: string; rank: number }[];   // per-source rank (debug view)
  fusedRank: number; fusedScore: number;
  alsoOnline?: boolean;                // local result that providers also returned
  storage: "persist" | "transient";    // transient = provider storagePolicy none; never saved
  actions: { open: string /* app route */; saveForOffline: boolean };
}
interface Coverage {                   // counts only; no percentages of "the internet"
  cachedMatches: number; onlineMatches: number; onlineNotArchived: number; queued: number; partial: number;
  basis: "local_exact" | "online_page_estimate";   // online counts are of returned results, not totals
}

// SSE events (id: monotonically increasing sequence)
type SearchEvent =
  | { type: "provider_started"; providerId: string }
  | { type: "provider_results"; providerId: string; append: SearchResult[]; update: { key: string; alsoOnline?: true; addAttribution?: SearchResult["attribution"][number]; snippetExtra?: string }[] }
  | { type: "provider_error"; providerId: string; code: SearchErrorCode; message: string; retryAfterMs?: number }
  | { type: "coverage"; coverage: Coverage }
  | { type: "reorder_available"; fusedOrder: string[] }       // proposed order if the client wants to apply it
  | { type: "done"; reason: "all_providers_answered" | "deadline" | "cancelled" };
type SearchErrorCode = "timeout" | "rate_limited" | "auth" | "quota_exhausted" | "bad_request" | "upstream" | "network" | "disabled" | "unsupported";
```

**Merging contract.** Weighted reciprocal rank fusion `score(d) = Σ w_i / (k + rank_i(d))`, k=60, local weight 1.5, ZIM 1.0 per package, providers 1.0 each (0.7 for a second heavily overlapping provider); inputs are the top 20 to 30 per source; dedup by canonical URL (Wikipedia URLs canonicalised to `wikipedia:<lang>:<title>` so ZIM and online hits merge, preferring the offline copy); ties break by local first, higher fused score, earlier provider rank, then URL string. The server returns fusion data; the **client** enforces the display rules: new online-only results are appended below the visible list under a "More from the web" divider, rank changes to visible items are held back and offered through `reorder_available`, ordering freezes after the first interaction (scroll, focus, hover over 300 ms, filter typing), updates stop after 2 s or when all providers answer, later arrivals only through "Load more from the web", and a single `aria-live="polite"` message announces additions.

```ts
interface CoveragePlanRequest {
  searchId: string; resultKeys: string[] | "all_uncached";
  strategy: "capture" | "explore" | "mirror"; depth?: number;
  priority: Priority; retention: RetentionSpec;
  asCollection?: { name: string; icon?: string } | { collectionId: string };
}
interface CoveragePlanResponse { planId: string; urls: number; estimate: Estimate; warnings: string[]; expiresAt: Iso }
interface Estimate { estimate: true; pages: { low: number; high: number }; bytes: { low: number; high: number };
  durationSeconds: { low: number; high: number }; basis: string /* e.g. "average of 14 archived pages from these domains" */; confidence: "low" | "medium" | "high" }
```

Brave results are `transient`: they are never written to the database; "Save for offline" archives the original page by fetching it from the site and does not copy the provider's snippet into the page description. `POST /api/search` with `online: "on"` for a provider that is disabled or when forced offline returns the local results and `online.state = "disabled" | "offline"`; it never errors because of a provider.

## 7. Sources and collections

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET/POST | `/api/sources` | List / create | S/G , S+C |
| GET/PATCH/DELETE | `/api/sources/{id}` | Read / update (creates a new config version) / soft-delete (`?deletePages=false` default; references become inactive) | S/G , S+C |
| POST | `/api/sources/preview` | Dry run for a new or changed config: sampled estimate of pages and bytes, scope explanation, warnings (robots, size) | S+C |
| POST | `/api/sources/{id}/run` | Start now (creates a download job) | S+C |
| POST | `/api/sources/{id}/pause`, `/resume` | Pause or resume scheduled work | S+C |
| GET | `/api/sources/{id}/pages` | Pages of the source | S/G |
| GET | `/api/sources/{id}/stats` | Usage by priority, versions, last runs, failures | S/G |
| GET/POST | `/api/collections` | List (tree via `?tree=true`) / create | S/G , S+C |
| GET/PATCH/DELETE | `/api/collections/{id}` | Read / update / delete (children re-parent to the parent) | S/G , S+C |
| GET | `/api/collections/{id}/items` | Pages and ZIM entries | S/G |
| POST | `/api/collections/{id}/items` | `{ add: ItemRef[], remove?: ItemRef[] }` | S+C |
| POST | `/api/collections/{id}/rebuild` | Re-evaluate an `auto` or `saved_search` collection | S+C |

```ts
type SourceType = "single_page" | "website" | "section" | "linked_collection" | "sitemap" | "feed" | "saved_search" | "knowledge_package" | "imported_documents";
interface SourceInput {
  name: string; description?: string; type: SourceType; adapter?: "http" | "wikipedia" | "zim" | "import";
  startUrl?: string; strategy: "capture" | "explore" | "mirror"; profile: "focused" | "balanced" | "comprehensive" | "custom";
  config: SourceConfig; priority: Priority; retention: RetentionSpec; automaticEviction: boolean;
  storageBudgetBytes?: number; preferredVolumeId?: string; discoveryEnabled: boolean; enabled: boolean;
  schedule?: ScheduleInput; collections?: string[]; savedSearchId?: string;
}
interface SourceConfig {
  depth: number; maxPages: number; maxBytes: number; maxDurationSeconds: number;
  allowedDomains: string[]; excludedDomains: string[]; allowedPaths: string[]; excludedPaths: string[];
  includeExternal: boolean; externalDepth?: number; assets: "all" | "same_origin" | "images_css_only" | "none";
  concurrency: number; perDomainDelayMs: number; retries: number;
  queryParamPolicy: "keep_all" | "strip_tracking" | "allowlist" | "drop_all"; queryParamAllowlist?: string[];
  respectRobots: boolean; versioning: { mode: "latest_only" | "all" | "last_n" | "period" | "on_change"; n?: number; period?: "day" | "week" | "month" };
  renderMode: "never" | "auto" | "always"; linkWeights?: Partial<Record<"main" | "heading" | "related" | "nav" | "footer", number>>;
  wikipedia?: { language: string; images: boolean; linkedExpansionDepth: number; preferZim: boolean };
}
type RetentionSpec =
  | { mode: "all" } | { mode: "latest"; count: number } | { mode: "time"; days: number; keepLatest?: boolean }
  | { mode: "budget"; bytes: number } | { mode: "custom"; combine: "union" | "intersection"; rules: Exclude<RetentionSpec, { mode: "custom" }>[] };
type ItemRef = { pageId: string } | { zimId: string; path: string };
```

Validation highlights: P1 or P2 sources default `automaticEviction=false` but any value is accepted (P1 is never auto-evicted either way); `maxPages`, `depth` and `maxBytes` have hard server-side ceilings per resource profile; a `knowledge_package` source requires a ZIM package; Wikipedia sources require `NCB_CONTACT`.

## 8. Downloads, schedules and limits

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/downloads` | List: `state`, `sourceId`, `kind`, `priority` | S/G |
| POST | `/api/downloads` | Create `{ kind, url?, sourceId?, priority, config? , asCollection? }` (`Idempotency-Key` supported) | S+C |
| GET | `/api/downloads/{id}` | Detail: progress, counters, estimate, failure reason, crawl summary | S/G |
| GET | `/api/downloads/{id}/log` | Activity log for the job, paged, filter by level | S |
| POST | `/api/downloads/{id}/pause`, `/resume`, `/cancel`, `/retry` | Controls | S+C |
| PATCH | `/api/downloads/{id}` | `{ priority?: Priority, queueOrder?: "top" \| "bottom" \| number }` | S+C |
| GET | `/api/downloads/queue` | Summary: counts by state, running items with progress and ETA, workers, window status, next scheduled | S/G |
| GET/POST | `/api/schedules` | List / create (`manual`, `hourly`, `daily`, `weekly`, `cron`, with window) | S , S+C |
| PATCH/DELETE | `/api/schedules/{id}` | Update / delete | S+C |
| GET/PUT | `/api/downloads/windows` | Global download windows | S , S+C |

```ts
interface DownloadJob {
  id: string; kind: "capture" | "explore" | "mirror" | "refresh" | "wikipedia" | "zim_import" | "import" | "discovery" | "coverage";
  state: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled"; priority: Priority;
  sourceId?: string; requestedBy: "user" | "schedule" | "discovery" | "search" | "system"; requestedUrl?: string;
  progress: { pagesDone: number; pagesFailed: number; pagesDiscovered?: number; bytesDone: number; percent?: number };
  estimate?: Estimate;                 // "estimated storage" is always an estimate
  failure?: { code: string; message: string; retryable: boolean; hint: string };
  createdAt: Iso; startedAt?: Iso; finishedAt?: Iso; scheduledFor?: Iso;
}
interface QueueSummary { counts: Record<DownloadJob["state"], number>; running: DownloadJob[]; workers: WorkerStatus[];
  window: { open: boolean; opensAt?: Iso; closesAt?: Iso }; limits: ResourceLimits; connectivity: "online" | "offline" | "unknown" }
interface ResourceLimits { fetchConcurrency: number; perHostConcurrency: number; perHostDelayMs: number; bandwidthKbps?: number;
  workerMemoryMb: number; extractWorkers: number; renderConcurrency: number; cpuThrottle: "off" | "low" | "medium"; minFreeDiskBytes: number }
```

Resource limits are read and written under `/api/settings` (group `resources`). Change detection (ETag, Last-Modified, content hash, conditional requests) is internal to `refresh` jobs; the result is visible as `VersionSummary` and `activity_log` entries ("unchanged, 304").

## 9. Discovery

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/discovery` | Overview: settings summary, budget used and remaining today and this month, candidate counts by state, kill-switch state | S |
| GET | `/api/discovery/candidates` | `state`, `sourceId`, `minScore`, `provenance` | S |
| GET | `/api/discovery/candidates/{id}` | Detail incl. `scoreComponents` and provenance (why suggested) | S |
| POST | `/api/discovery/candidates/{id}/approve`, `/dismiss`, `/queue` | Decide or queue now `{ priority?, sourceId?, collectionId? }` | S+C |
| POST | `/api/discovery/candidates/bulk` | `{ ids, action }` | S+C |
| GET/PUT | `/api/discovery/settings` | Settings and weights (below) | S , S+C |
| POST | `/api/discovery/pause`, `/resume` | Kill switch for active discovery | S+C |

```ts
interface DiscoverySettings {
  passive: { enabled: boolean; fromLinks: boolean; fromVisits: boolean; fromBookmarks: boolean; fromMissingLinks: boolean; fromSavedSearches: boolean };
  searchDriven: { searchesInfluenceDiscovery: boolean; autoCacheOpenedOnlinePages: boolean; prioritiseFrequentTopics: boolean;
                  backgroundBudget: { maxRequestsPerDay: number; maxBytesPerDay: number }; requireApproval: boolean };
  active: { mode: "off" | "approval" | "automatic"; allowedSourceIds: string[]; maxCandidatesPerRun: number; maxDepth: number; maxQueued: number;
            maxBytesPerDay: number; maxRequestsPerDay: number; respectSchedule: boolean; onlyWhenOnline: true; perSiteDailyCap: number };
  weights: { inboundArchivedLinks: number; collectionRelevance: number; searchFrequency: number; bookmarks: number;
             recentActivity: number; sourcePriority: number; estimatedCost: number; storageHeadroom: number };   // cost and storage are negative contributions
}
interface Candidate { id: string; url: string; title?: string; state: "new" | "approved" | "queued" | "archived" | "dismissed" | "expired"; score: number;
  scoreComponents: { name: keyof DiscoverySettings["weights"]; raw: number; weight: number; contribution: number }[];
  provenance: { kind: string; detail?: string; pageId?: string; at: Iso }[]; estimatedBytes?: number }
```

Scoring is a transparent weighted sum (no AI). Defaults are conservative: `active.mode = "off"`, `searchDriven.*` all false, `requireApproval = true`.

## 10. Storage

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/storage` | Overview: totals, usage by priority and by source, forecast, thresholds, eviction state | S/G |
| GET/POST | `/api/storage/volumes` | List / register a volume | S , S+C |
| GET/PATCH/DELETE | `/api/storage/volumes/{id}` | Detail incl. capacity, used, available, reservations / limits, state / drain and remove (refused while it holds blobs) | S , S+C |
| POST | `/api/storage/volumes/{id}/verify` | Check marker, write test, scan | S+C |
| POST | `/api/storage/volumes/{id}/migrate` | **Reserved; returns 501 `not_implemented` in v1** (migration between volumes comes later, task T-11) | S+C |
| GET | `/api/storage/usage` | `?by=priority\|source\|kind\|volume` with `exclusiveBytes` and `sharedBytes` | S/G |
| GET | `/api/storage/forecast` | Estimates (labelled), `?sourceId=` | S/G |
| GET/PUT | `/api/storage/policy` | Global policy: `permitImportantEviction`, thresholds, grace, prune surplus | S , S+C |
| POST | `/api/storage/eviction/plan` | Dry run: `{ bytesNeeded?, incomingPriority? }` returns the plan with reasons | S+C |
| POST | `/api/storage/eviction/run` | Execute a plan (`planId`), or run maintenance eviction | S+C |
| POST | `/api/storage/maintenance/verify` | Verify-and-repair (see system) | S+C |

```ts
interface Volume { id: string; name: string; rootPath: string; state: "online" | "offline" | "readonly" | "draining" | "disabled"; isDefault: boolean;
  capacityBytes: number; quotaBytes?: number; usedBytes: number; availableBytes: number; reservedBytes: number; reserveFreeBytes: number;
  thresholds: { softPct: number; evictStartPct: number; evictTargetPct: number }; usageByPriority: Record<Priority, number> }
interface EvictionPlan { planId: string; incomingPriority: Priority; bytesNeeded: number; reclaimableBytes: number; sufficient: boolean;
  steps: { step: "throttle_p4" | "unreferenced_blobs" | "surplus_versions" | "p4" | "p3" | "p2"; versions: number; exclusiveBytes: number }[];
  items: { versionId: string; pageUrl: string; priority: Priority; reason: string; exclusiveBytes: number }[];   // capped list
  skipped: { versionId: string; reason: "p1" | "retained" | "source_auto_eviction_off" | "p2_not_permitted" | "priority_gate" | "in_use" }[] }
interface StorageForecast { estimate: true; horizonDays: number; projectedUsedBytes: { low: number; high: number }; projectedFullAt?: { earliest: Iso; latest: Iso };
  assumptions: string[] }
```

## 11. Index

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/index/status` | Generation, schema version, doc count, expected count, drift, size on disk, outbox backlog, rebuild progress, last optimise | S/G |
| POST | `/api/index/rebuild` | Start a rebuild from stored content (shadow file, atomic swap) | S+C |
| POST | `/api/index/optimize` | FTS5 `optimize`, vocab rebuild | S+C |
| POST | `/api/index/check` | Consistency check (sampled) | S+C |
| GET | `/api/index/jobs` | Indexing jobs with progress | S |
| GET/PUT | `/api/index/synonyms` | List / replace synonym sets | S , S+C |
| GET/PUT | `/api/index/ranking` | Ranking weights (title/headings/url/body, freshness, link graph, preference, cached boost) | S , S+C |

## 12. Settings

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/settings` | All groups (secrets omitted) | S/G (read) |
| PATCH | `/api/settings` | Partial update of one or more groups; validated per group | S+C |
| GET | `/api/settings/schema` | JSON Schema for the groups (drives the settings UI) | S |
| GET/PATCH | `/api/settings/user` | Per-user settings (theme, shortcuts, tab restore) | S , S+C |

Response shapes (server): `GET /api/settings` returns the groups as `{ general: {...}, resources: {...}, ... }`; secret fields are replaced by a `has<Field>` flag (for example `offline.hasProbeToken`). `PATCH /api/settings` takes a partial of any groups, validates the merged group, returns the same map and, when online search was just enabled, a top-level `disclosure` string. Enabling `privacy.onlineSearch.enabled` requires `privacy.onlineSearch.acknowledged: true` in the same patch (otherwise a field error on that path), which stores `acknowledgedAt`. Invalid values return 400 with `details.fields[].path` such as `offline.probeUrl`. `GET /api/settings/user` and `PATCH` use `{ theme, density, tabRestore, shortcuts }`.

Groups: `general` (app name, locale `en-GB`), `resources` (profile and limits), `privacy` (`history.enabled`, `searchHistory.enabled`, `onlineSearch.enabled`, disclosure text), `offline` (`forced`, probe URL), `browser` (`showLinkStates`, `liveFrames`, `bookmarkPriority`, `autoCacheOpened`), `search` (ranking, RRF `k` and weights, synonyms, ZIM budget), `discovery` (section 9), `storage` (section 10 policy), `logging`, `appearance` (theme tokens). Changing `privacy.onlineSearch.enabled` to true returns the disclosure text that the UI must show and record acknowledgement of (`acknowledgedAt`).

## 13. System

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/system/health` | HTTP 503 while `starting`, 200 otherwise. Minimal `{ status: "ok" \| "degraded" \| "starting" }` for Docker; checks DB writable, index openable, worker heartbeat fresh, free space above floor | P |
| GET | `/api/system/status` | Detailed: versions, architecture, uptime, workers (`extract`, `index`, `search`, `zim`), queue depths, memory, connectivity, renderer reachable | S |
| GET | `/api/system/dashboard` | Admin dashboard: pages, sources, collections, index size, storage used and available, active, queued and failed jobs, last update, worker status | S |
| GET | `/api/system/events` | **SSE**: job progress, worker heartbeat, connectivity, thresholds (`Last-Event-ID` supported) | S |
| GET | `/api/system/logs` | Activity log: `level` and `area` (comma-separated lists, exact match), `downloadJobId` (`dl_...`), `from`, `to`, `q` (substring), `limit` (default 50, max 200), `cursor`. Returns `{ items: { id, at, level, area, message, details?, downloadJobId?, jobId?, versionId? }[], nextCursor? }`, newest first | S |
| GET | `/api/system/connectivity` | `{ state: "unknown" \| "online" \| "offline", since, source: "passive" \| "probe" \| "forced" }`. The same object is the data of the SSE `connectivity` event | S/G |
| POST | `/api/system/connectivity` | `{ forceOffline: boolean }` ("work offline") | S+C |
| POST | `/api/system/maintenance/verify` | Verify-and-repair. `{ repair: false (default), checks?: string[] }` returns a `MaintenanceRun` | S+C |
| GET | `/api/system/maintenance/runs`, `/{id}` | History and reports | S |
| POST | `/api/system/maintenance/backup` | `VACUUM INTO` backup of `main.db` into the data volume | S+C |
| GET | `/api/system/metrics` | In-process counters for benchmarking | S |

```ts
interface Dashboard {
  pages: { total: number; archived: number; partial: number; evicted: number }; sources: { total: number; enabled: number };
  collections: number; index: { docs: number; sizeBytes: number; drift: number; state: "ok" | "rebuilding" | "missing" };
  storage: { usedBytes: number; availableBytes: number; byPriority: Record<Priority, number> };
  jobs: { active: number; queued: number; failedLast24h: number }; lastUpdateAt?: Iso;
  workers: WorkerStatus[]; connectivity: "online" | "offline" | "unknown";
}
interface WorkerStatus { name: "runner" | "extract" | "index" | "search" | "zim" | "renderer"; state: "idle" | "busy" | "down" | "disabled"; lastHeartbeatAt?: Iso; currentJobId?: string; memoryMb?: number }
interface MaintenanceRun { id: string; kind: string; dryRun: boolean; state: "running" | "done" | "failed";
  findings: { invariant: string; count: number; examples: string[]; repaired?: number }[] }
```

## 14. Bookmarks and history

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/bookmarks` | `q`, `collectionId` | S/G |
| POST | `/api/bookmarks` | `{ url, title?, collectionId?, versionId? }`; resolves and links the archive reference when one exists | S+C |
| PATCH/DELETE | `/api/bookmarks/{id}` | Update / delete | S+C |
| GET | `/api/history` | `q`, `from`, `to` (empty and `enabled:false` when disabled) | S |
| DELETE | `/api/history` | Clear all, or `?before=` | S+C |
| DELETE | `/api/history/{id}` | Delete one entry | S+C |

```ts
interface Bookmark { id: string; originalUrl: string; title: string; archive?: { pageId: string; versionId?: string; availability: PageSummary["availability"] }; zim?: { zimId: string; path: string };
  collectionId?: string; createdAt: Iso }
interface HistoryEntry { id: string; url: string; title: string; visitedAt: Iso; servedFrom: "archive" | "cache" | "zim" | "live" | "offline"; pageId?: string }
```

History recording is a user setting (`privacy.history.enabled`, default on, local only); disabling stops recording, clearing deletes rows.

## 15. ZIM packages and Wikipedia

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/zim/packages` | List with metadata and state | S/G |
| POST | `/api/zim/packages/import` | `{ path, volumeId?, copy: boolean }` registers a file already under an allowed root (`copy:false` reads it where it is); validates header, UUID, metadata; creates a `zim_import` download job | S+C |
| GET | `/api/zim/packages/{id}` | Detail incl. attribution and licence | S/G |
| PATCH | `/api/zim/packages/{id}` | `{ enabledForSearch?, priority? }` | S+C |
| DELETE | `/api/zim/packages/{id}` | Safe removal: `?dryRun=true` lists bookmarks, collection items and sources that reference it; `confirm=true` removes them and the file | S+C |
| GET | `/api/zim/packages/{id}/search` | `?q=&limit=` search inside one package | S/G |
| GET | `/api/zim/packages/{id}/suggest` | `?q=` title suggestions | S/G |
| GET | `/api/zim/packages/{id}/entry` | `?path=` entry metadata (exists, redirect target, mime) | S/G |
| GET | `/api/zim/catalogue` | **Later (task Z-11)**: browse the Kiwix library when online | S |
| POST | `/api/wikipedia/preview` | `{ title, language, depth, images, preferZim, maxPages }` returns candidate counts per level, estimated requests, time (at 1 request/s), bytes (estimates) and ZIM coverage | S+C |

Browsing a ZIM entry is through the listener (`/a/{token}/z/{zimId}/{path}`); `resolve` returns it when a URL maps to an enabled package. Creating a Wikipedia crawl is `POST /api/sources` with `adapter: "wikipedia"`. Searching across archive, ZIM and online is `POST /api/search` (unified); `GET /api/zim/packages/{id}/search` is the federated component and the "ZIM only" view. **Unified vs federated:** the Search area offers a toggle: unified (one fused list, default) or federated (separate result groups per source with their own order); both use the same endpoints with `view` set in the UI only.
