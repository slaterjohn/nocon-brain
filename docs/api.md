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
| POST | `/api/setup/first-source` | Create the first source and optionally start it. Body `{ url, kind?: "page" \| "website", name?, run? }` (`kind` defaults to `page`, `run` to false). Uses the default profile (balanced) and priority (P3). `201` with `{ source, downloadIds? }`; a bad address is a 400 with a field error on `url` | S+C |
| POST | `/api/setup/complete` | Mark the wizard finished | S+C |
| POST | `/api/auth/login` | `{ username, password }` sets cookie | P + C |
| POST | `/api/auth/logout` | Revokes the current session | S+C |
| GET | `/api/auth/me` | `{ user, mode: "admin" \| "guest", csrfRequired: true }` | S/G |
| GET | `/api/auth/sessions` | List sessions | S |
| DELETE | `/api/auth/sessions/{id}` | Revoke one (or `?all=true` to revoke all but current) | S+C |
| POST | `/api/auth/password` | `{ current, next }` | S+C |

Implementation notes (server, Phase 1): `/api/setup/profile` takes `{ profile: "pi-lite" | "standard" }` and applies that profile's resource preset; `/api/setup/providers` takes `{ skip: true }` (a non-empty `providers` list returns 501 until providers exist); `/api/setup/first-source` creates a `single_page` (`kind: "page"`) or `website` source from the address, named after its host unless `name` is given, and starts it when `run` is true; `GET /api/setup/status` then reports `firstSourceCreated: true`; the setup steps return 409 `conflict` once `/api/setup/complete` has run. `POST /api/auth/login` and `/api/setup/admin` return `{ user: { id, username } }`; `GET /api/auth/me` returns `user: { id: "guest", username: "Guest" }` for a trusted-LAN guest. `GET /api/auth/sessions` returns `{ items: { id, createdAt, lastSeenAt, expiresAt, ip, userAgent, current }[] }`; the session `id` is an opaque 16-character reference. `DELETE /api/auth/sessions/{id}?all=true` (the id is ignored) and `DELETE /api/auth/sessions` revoke every session but the current one. Unauthenticated routes other than health answer 503 with `Retry-After` while the server is starting, and 409 `setup_required` until an admin exists. Validation errors carry `details: { fields: { in, path, message }[] }`.

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

**Phase 2 implementation notes (A-14 to A-18).**

- `resolve` answers `{ kind: "search" }` for text that is not an address (the shell then opens `/search?q=`), and 400 for other schemes (`javascript:`, `data:`, `file:`) and for addresses with credentials. A bare host (`example.org`) gets `https://`; an IP address, `localhost` or `host:port` gets `http://`. `prefer: "live"` returns the live resolution when the connection is not known to be down. The user setting `browser.preferCached` (default on) decides which wins when both exist and the request does not say. `frame.url` is built from `NCB_ARCHIVE_PUBLIC_URL`, or the request host (trusted only from the web proxy) plus `NCB_ARCHIVE_PORT`. The `zim` and `cache` resolutions are not produced yet. `live` and `offline` carry `queued: { downloadId }` when the address is already waiting to be saved. Live frames are not offered: `frameable` stays `"unknown"` in `resolve`; `live-check` reports it.
- `frame-state` returns `{ frameId, url, title?, state, pageId?, versionId?, reader?, interstitial?, at, seq }`. `seq` rises with every document the listener serves to the frame, so the shell applies only newer ones. A `?hl=` response is not recorded (same document). `interstitial: true` means the listener showed its notice for an address that is not saved; `url` is that address and `state` its link state. Reading it records one history visit per document when history is on. A history visit for a saved page is written by the server when the archive listener serves the document to a frame (for the signed-in user the frame was granted to), not when the shell next reads `frame-state`; reading it later records nothing twice.
- `live-check` returns `{ url, reachable, status?, finalUrl?, frameable, reason? }` and 403 `blocked` for private hosts; it needs the connection (409 `offline` otherwise).
- `save` and `POST /api/archive/capture` take `{ url, priority?: "P1".."P4", queue?: boolean }` and answer 202 `{ downloadId, url, state: "queued", held, priority }`. The default priority is the setting `browser.quickSavePriority` (3). There is no `sources` table before Phase 3, so the priority is stored on the download job, and `pages.effective_priority` takes it when the capture finishes. Offline, `queue: true` is needed (409 `offline` with `canQueue: true` otherwise); the capture is held and released when the server is no longer known to be offline. `Idempotency-Key` is honoured for 24 hours (in memory; a restart forgets it).
- `GET /api/browser/offline-page?url=` returns `{ url, reason, canQueue, archived, queued?, connectivity }`.

## 4. Archive: pages, versions, capture

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/archive/pages` | List and filter: `q`, `sourceId`, `collectionId`, `domain`, `type`, `availability`, `priority`, `from`, `to`, `minVersions`, `sort`; `limit` and `cursor` page through the result (see the filter note below) | S/G |
| GET | `/api/archive/pages/{id}` | Detail: `{ page, versions, bookmarks, sources, collections }`. `sources` are the sources that reference the page (`{ id, name, type, priority, discoveredVia, system, systemKind }`; `priority` is the reference's: the capture's override, else the source's), `collections` the collections it is in (`{ id, name, kind, priorityFloor }`). Readable by a trusted-LAN guest | S/G |
| POST | `/api/archive/pages/{id}/recapture` | New capture now (creates a download job) | S+C |
| DELETE | `/api/archive/pages/{id}` | **Explicit deletion.** `?dryRun=true` returns impact; `confirmProtected=true` required for P1/P2; `exclude=true` (default) adds a `url_exclusions` row | S+C |
| GET | `/api/archive/pages/{id}/links` | `?direction=in\|out`, with link states | S/G |
| GET | `/api/archive/versions` | `?pageId=` list versions | S/G |
| GET | `/api/archive/versions/{id}` | Detail: status, partial reason, pipeline stages, sizes, attribution | S/G |
| GET | `/api/archive/versions/{id}/find` | `?q=` match count for find-in-page (server-side, same algorithm as listener `?hl=`). Returns `{ query, count, anchors: ["ncb-hit-1", ...], truncated }`; the query is trimmed and capped at 100 characters, matches are case-insensitive within one text node, and at most 500 are marked | S/G |
| GET | `/api/archive/captures`, `/api/archive/captures/{downloadId}` | Phase 2 addition: recent single-page saves and the progress of one, in the shape of the `capture` event (section 13) | S |
| GET | `/api/archive/versions/{id}/stages` | Pipeline stage runs with errors | S |
| POST | `/api/archive/versions/{id}/reprocess` | Re-run from a stage `{ fromStage?: Stage }` | S+C |
| DELETE | `/api/archive/versions/{id}` | Explicit version deletion (same confirmation rules) | S+C |
| POST | `/api/archive/capture` | Convenience: `{ url, sourceId?, priority?, mode?: "capture" }` creates a download job | S+C |
| POST | `/api/archive/import` | `multipart/form-data` upload of one file in a field named `file`: HTML, PDF, text or Markdown (limit `NCB_IMPORT_MAX_MB`, default 50). Optional query `sourceId` (an `imported_documents` source; default the built-in Imports source) and `priority`. `202` with `{ downloadId, pageId, versionId, duplicate: false, kind, filename, mime, sizeBytes, pageCount?, title, sourceId, links }`; `200` with `duplicate: true` when the same file is already imported. Refusals are `400 bad_request` with `details.kind`: `no_file`, `empty`, `unsupported_type`, `type_mismatch` (labels disagree), `binary_content`, `file_too_large`, `malformed_pdf`, `encrypted_pdf`, `pdf_too_complex`, `invalid_name`, `wrong_source_type`. The type is decided from the bytes first (a PDF header, binary signatures, NUL bytes) and the MIME type and extension second | S+C |
| GET | `/api/archive/import/limits` | `{ maxBytes, accepted, extensions, description }` for the upload form | S/G |
| GET | `/api/archive/versions/{id}/import` | For an imported version: `{ versionId, kind, filename, detectedMime, sizeBytes, pageCount, info, importedAt, downloadUrl }`; 404 for a captured web page | S/G |
| GET | `/api/archive/versions/{id}/original` | The uploaded bytes as a download (`Content-Disposition: attachment`, `nosniff`). HTML is served as `application/octet-stream`, never as a page; PDF as `application/pdf`; Markdown and text as `text/plain`. 404 for a captured web page | S/G |
| POST | `/api/archive/frame-grants` | Mint a token for a page or version without resolving: `{ pageId \| versionId, mode }` | S+C |

**`PATCH /api/archive/pages/{id}` is not part of v1.** The earlier draft listed `{ pin, collections: { add, remove } }`. Adding a page to or removing it from a collection is `POST /api/collections/{id}/items` (`{ add: [{ pageId }], remove: [{ pageId }] }`, section 7). "Pinning" a page is putting it in a collection with a `priorityFloor` (for example Favourites or a collection set to P1); the page's `effectivePriority` follows. The page detail's `collections` shows where a page is. A call to `PATCH /api/archive/pages/{id}` answers 404.

**Page list filters** (all optional, combined with AND; a bad value is a 400 with a field message):

- `sourceId` / `collectionId`: public ids; pages the source references / pages in the collection or in any collection below it. An unknown id is a 404.
- `type`: one or more of `html`, `pdf`, `markdown`, `text`, `rendered`, comma separated. It is the type of the latest version: the import kind for an uploaded file (an uploaded HTML file is `html`), `rendered` for a copy captured with the browser renderer, otherwise `html`.
- `priority`: one or more of `P1` to `P4`, comma separated, matched against the page's `effectivePriority`.
- `from` / `to`: the page's last capture date, as `YYYY-MM-DD` or a full ISO instant. `from` is inclusive; `to` is exclusive for an instant, and a bare date includes that whole day (UTC).
- `minVersions`: pages with at least this many saved versions (`minVersions=2` finds pages that changed).
- `limit` (default 50, max 200) and `cursor` (an opaque position taken from `nextCursor`) page through the filtered result, whatever the filters and sort; `total` counts the filtered result.

```ts
interface PageSummary { id: string; url: string; canonicalUrl: string; title: string; domain: string; type: DocType; imported?: { filename: string; sizeBytes: number; pageCount?: number }; language?: string;
  availability: "archived" | "partial" | "evicted" | "failed"; effectivePriority: Priority; latestVersionId?: string;
  versionCount: number; firstCapturedAt?: Iso; lastCapturedAt?: Iso; inboundCount: number }
interface VersionSummary { id: string; pageId: string; versionNo: number; status: "ready" | "partial" | "capturing" | "failed" | "evicting" | "evicted";
  partialReason?: "assets_missing" | "truncated" | "reader_only" | "size_cap"; fetchedAt: Iso; publishedAt?: Iso;
  publishedSource?: string; totalBytes: number; renderMode: "plain" | "browser"; attribution?: Attribution }
interface Attribution { licenseName: string; licenseUrl: string; sourceUrl: string; revisionId?: string; historyUrl?: string; creditText: string }
interface DeletePreview { versions: number; exclusiveBytes: number; sharedBytesKept: number; references: { sources: string[]; collections: string[]; bookmarks: number; pins: Priority[] };
  requiresConfirmation: boolean }
type DocType = "html" | "pdf" | "markdown" | "text" | "rendered";   // PageSummary.type
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
| POST | `/api/sources/{id}/refresh` | Check the source's saved pages for changes now (creates a `refresh` download job) | S+C |
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

Implementation notes (server, Phase 3: C-06, C-07, C-09, C-13). Differences from the contract above:

- **Source types.** `single_page`, `website`, `section`, `linked_collection`, `sitemap`, `feed` and `imported_documents` work. `saved_search` and `knowledge_package` are refused at create with a 400 field error on `type` that names the phase that brings them. `adapter: "http"` is accepted (and `"import"` for `imported_documents`). For the web types `startUrl` is required, must be `http(s)` and may not carry a username or password. An `imported_documents` source takes no `startUrl` (400 if one is sent); it holds uploaded files (`POST /api/archive/import?sourceId=`), and `POST /api/sources/{id}/run` on it answers 409 (nothing to run).
- **Config.** `SourceInput.config` is partial; omitted limits come from the named `profile` (`focused`, `balanced`, `comprehensive`), clamped to the ceilings of the resource profile; `custom` starts from `balanced`. A single page is forced to depth 0 and one page; sitemaps and feeds to depth 0; a section gets `allowedPaths` under the start folder; a linked collection allows one external hop. `linkWeights` keys are `main|heading|related|nav|footer`. Extra fields: `maxLinksPerPage`, `userAgentSuffix`, `sitemapMaxDepth` (default 3). The response carries `config` (the resolved, stored config) and `configVersion`; a `PATCH` that changes the resolved config stores a new `source_configs` version, other fields are updated in place.
- **Ceilings** (400, one field message each, e.g. `config.maxPages`; they never exceed the crawl engine's own): pi-lite depth 5, pages 5,000, bytes 2 GiB, duration 6 h, concurrency 2, retries 3, external depth 1, request delay at least 1,500 ms. standard depth 10, pages 100,000, bytes 20 GiB, duration 72 h, concurrency 8, retries 5, external depth 2, delay at least 1,000 ms.
- **Built-in sources.** Quick saves (`quick_saves`, P3), Browsing cache (`browsing_cache`, P4) and Imports (`imports`, P3, no automatic eviction) exist from the first start (`GET /api/sources?system=true`). They cannot be deleted; only `priority`, `retention`, `automaticEviction` and `enabled` can be changed (409 otherwise). `POST /api/browser/save` and `POST /api/archive/capture` link the page to Quick saves (`page_sources`); `sourceId` on `/api/archive/capture` names another source instead (404 if unknown).
- **Inline schedule.** `schedule` in `POST /api/sources` takes the same fields as `POST /api/schedules` without `sourceId` (section 8), including `window` (a download window made for this source: `{ name?, days?, start, end, timezone?, limits?, enabled? }`) or `windowId`, so a source can be created with its schedule and window in one request. The source's `schedule.window` echoes it.
- **Status.** `lastStatus` follows the source's downloads: it is `running` while any download of the source is queued or running, and moves to `ok`, `failed` or `cancelled` (the newest download's outcome) when the last one ends, for captures, crawls, sitemap and feed runs, change checks and imports alike. Clients show it as it is.
- **List and read.** `GET /api/sources` takes `type`, `enabled`, `system`, `limit`, `cursor` and returns `{ items, nextCursor?, total }`. A source carries `paused`, `system`, `systemKind`, `collections` (public ids), `schedule` (its first schedule), `pageCount`, `lastRunAt`, `nextRunAt`, `lastStatus` (`never|running|ok|failed|paused|cancelled`).
- **Enable, disable, pause.** `enabled` is set with `PATCH`. A disabled source refuses `run` (409) and its schedules do nothing, but it keeps its references, so disabling never makes content evictable. `pause` and `resume` stop and restart scheduled work only; a paused source can still be run by hand. They return the source.
- **Run.** `POST /api/sources/{id}/run` answers 202 `{ downloadIds: string[], found?, newItems?, excluded?, warnings? }`. Single pages are captured directly; sitemaps and feeds are read through the guarded fetcher and every address not seen on an earlier run is captured (`found`, `newItems`, `excluded`); websites, sections and linked collections call the crawl engine's `startCrawl`. An unreachable, private (`403 blocked`) or malformed (`400`) start address fails the run with a plain message and sets `lastStatus: "failed"`.
- **Delete.** `DELETE /api/sources/{id}` soft-deletes. It removes the source's `page_sources` rows, its schedules, windows and discovery records, cancels its queued and running downloads, and keeps the pages. A page left with no reference counts as priority 4 and surplus; Phase 6 removes it by policy. With `?deletePages=true` pages with no other source and no bookmark are also deleted (with an exclusion entry). The response is `{ referencesRemoved, pagesDeleted, pagesUnreferenced, downloadsCancelled }`. Deleted sources answer 404.
- **Preview.** `POST /api/sources/preview` takes a `SourceInput` and returns `{ valid, type, config, scope: string[], scopeSummary: string, estimate: PreviewEstimate, sample?, robots, warnings: string[], ceilings, requests }`. It fetches the start page and a small sample of in-scope links (at most 12 requests in all, one at a time, with robots.txt honoured, no archive written) and extrapolates. `PreviewEstimate` is `{ estimate: true, label: "Estimate", pages: { low, high }, bytes: { low, high }, basis: string, confidence: "low" | "medium" | "high" }`. `scopeSummary` is one plain sentence ("Pages on example.org, up to 3 links from the start page, 500 pages at most"); `scope` keeps the bullet form. `sample` is `{ fetched, inScopeLinks, averageBytes, startPageBytes, sampledFrom, depthCounts? }` for crawl types and `{ found, sampledFrom }` for sitemaps and feeds. `robots` is `{ checked: boolean, allowed: boolean, crawlDelayMs?, message }`. `warnings` covers robots (start page disallowed, crawl delay, robots ignored), size (the upper bound exceeds the free space left, the page limit is near the ceiling) and an unreachable start address (the preview still answers 200 with `valid: true`, a wide range and the reason). `requests` is how many outbound requests the preview made. The range is a guess from a sample; it is never shown as a promise.
- **Pages and stats.** `/pages` returns `{ items: { pageId, url, host, title, availability, effectivePriority, firstSeenAt, lastSeenAt, discoveredVia, depth, priorityOverride }[], nextCursor?, total }`. `/stats` returns `{ pages, versions, latestBytes, byPriority, lastRuns, failedRuns, lastRunAt, lastStatus }`.
- **Collections.** `kind: "saved_search"` answers 501 `not_implemented` until saved searches exist; `kind: "auto"` needs `rule: { match: "all"|"any", conditions: ({ field: "domain"|"source"|"title", value })[] }`. `icon` must be one of `GET /api/collections/icons` (lucide names). `parentId` is a public id or null; a cycle or more than 8 levels is a 400 with a field message (and the database refuses it too). `priorityFloor` is `"P1".."P4"` or null. `GET /api/collections` returns `{ items }` (a nested `children` tree with `?tree=true`) with `itemCount` per collection. A Favourites collection (`kind: "favourites"`) exists from the first start; it cannot be deleted. `DELETE` returns `{ reparented, membershipsRemoved }`: children move up to the parent, pages stay in the archive. `GET /items` takes `limit`, `cursor`, `recursive` and returns `{ items: { pageId, url, host, title, availability, effectivePriority, addedBy, addedAt }[], nextCursor?, total }`. `POST /items` returns `{ added, alreadyMember, removed, notFound }`; it is refused with 409 on an auto collection (change the rule) and with 501 for ZIM items until ZIM support exists. `POST /rebuild` returns `{ added, removed }` and is 409 for a manual collection. Pages join collections by hand (`added_by: user`), through a rule (`rule`) or because the source feeds the collection (`source`). `priority_floor` raises the cached `pages.effective_priority` for members at once; the full reference rules are in data-model.md 5.1.

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
  id: string;                                   // dl_...
  kind: "capture" | "explore" | "mirror" | "refresh" | "wikipedia" | "zim_import" | "import" | "discovery" | "coverage";
  state: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled"; priority: Priority; queueOrder: number;
  title: string;                                // plain label: the source name, else the address shown without its scheme
  sourceId?: string; sourceName?: string; requestedBy: "user" | "schedule" | "discovery" | "search" | "system"; requestedUrl?: string;
  progress: { pagesDone: number; pagesFailed: number; pagesDiscovered?: number; bytesDone: number; percent?: number /* 0-100 */;
    label?: string /* "Saving the page", "Checking 12 of 40 pages" */; etaSeconds?: number };
  estimate?: DownloadEstimate;                  // always an estimate; the UI labels it "Estimated"
  pause?: { reason: "user" | "window_closed" | "volume_full" | "offline"; automatic: boolean; message: string };
  failure?: { code: FailureCode; message: string; retryable: boolean; hint: string };
  stop?: { reason: string; message: string };   // crawls: why it ended (completed, max_pages, max_bytes, max_depth, deadline, volume_full, cancelled)
  summary?: { checked: number; unchanged: number; changed: number; gone: number; failed: number };   // refresh jobs
  attempts: number;                             // how many times it has been retried by hand
  controls: { pause: boolean; resume: boolean; cancel: boolean; retry: boolean; setPriority: boolean };   // what is allowed now
  createdAt: Iso; startedAt?: Iso; finishedAt?: Iso; scheduledFor?: Iso; updatedAt: Iso;
  crawl?: { mode: string; maxPages?: number; maxBytes?: number; depthReached: number; pagesSkipped: number; deadlineAt?: Iso;
    frontier: { queued: number; running: number; held: number } };   // detail only (GET /api/downloads/{id})
}
type FailureCode = "network" | "robots_blocked" | "ssrf_blocked" | "size_cap" | "disk_full" | "timeout" | "http_4xx" | "http_5xx"
  | "parse_error" | "limit_reached" | "cancelled_by_user" | "internal";
interface DownloadEstimate { estimate: true; pages?: { low: number; high: number }; bytes?: { low: number; high: number };
  durationSeconds?: { low: number; high: number }; basis: string; confidence: "low" | "medium" | "high" }
interface QueueSummary { counts: Record<DownloadJob["state"], number>; running: DownloadJob[]; workers: WorkerStatus[];
  window: { open: boolean; opensAt?: Iso; closesAt?: Iso }; limits: ResourceLimits; throttle: ThrottleStatus; disk: DiskGuardStatus;
  connectivity: "online" | "offline" | "unknown"; nextScheduled?: { scheduleId: string; sourceId: string; sourceName: string; at: Iso } }
interface ResourceLimits { fetchConcurrency: number; perHostConcurrency: number; perHostDelayMs: number; bandwidthKbps?: number;
  workerMemoryMb: number; extractWorkers: number; renderConcurrency: number; cpuThrottle: "off" | "low" | "medium"; minFreeDiskBytes: number;
  profile: "pi-lite" | "standard"; effectiveFetchConcurrency: number /* after CPU throttling */ }
interface ThrottleStatus { active: boolean; level: "off" | "low" | "medium"; reason?: "event_loop_lag" | "load_average"; lagMs: number; loadPerCore: number; since?: Iso }
interface DiskGuardStatus { paused: boolean; volumes: { id: string; name: string; freeBytes: number; reserveFreeBytes: number; low: boolean }[]; pausedDownloads: number }
```

Implementation notes (server, Phase 3: C-08).

- `GET /api/downloads` takes `state` (one or a comma-separated list), `kind`, `priority` (`P1`..`P4`), `sourceId` (public id), `limit`, `cursor` and returns `Page<DownloadJob>` newest first (`total` is the count for the filter). `GET /api/downloads/{id}` adds `crawl`. A downloads list survives a restart because it is the `download_jobs` table: a job that was running when the server stopped is shown as `running` again when the server is back, with its queue entries recovered. 404 `not_found` for an unknown or malformed id.
- Controls answer 200 with the updated `DownloadJob`; a control that is not allowed in the current state answers 409 `conflict` with `details: { state, action, allowed: string[] }` and a plain message.

| Action | From | To | Notes |
|---|---|---|---|
| `pause` | `queued`, `running` | `paused` | Holds the queued work; a page already being fetched finishes. `pause.reason` is `user`. |
| `resume` | `paused` | `queued` (`running` for a crawl) | Releases held work. Also clears an automatic pause. |
| `cancel` | `queued`, `running`, `paused` | `cancelled` | Cancels all unfinished work. `failure.code` is `cancelled_by_user`. Pages already saved stay. |
| `retry` | `failed` | `queued` | Re-queues the failed work with a fresh attempt count; `attempts` goes up by one and the log says so. A crawl cannot be retried (start a new run from its source). |
| `PATCH` | `queued`, `running`, `paused` | same | `priority` changes the storage priority of what is saved from now on and the queue order against other priorities; `queueOrder` (`"top"`, `"bottom"` or a number, lower runs first within a priority) reorders queued downloads. `completed`, `failed` and `cancelled` jobs answer 409. |

  `controls` on every job says which of these are allowed now, so the UI never offers an action that would answer 409.
- Internal job states map to download states like this: a download is `queued` until its first piece of work starts, `running` while any piece runs or waits for a host, `paused` when its work is held (by the Human, by a closed download window, by the disk guard or while offline), `completed` when all work ended, `failed` when work ended and the page or pages could not be saved (a refresh that finds some pages unreachable still `completed`; its `summary.failed` counts them), `cancelled` when stopped. A sweep once a second repairs a download whose pieces all ended without the download being closed (for example after a crash).
- `failure.message` and `failure.hint` are fixed plain-English texts per `failure.code` (network, robots, blocked address, size limit, disk full, timeout, HTTP 4xx, HTTP 5xx, unreadable page, limit, cancelled, internal); `retryable` is false for `robots_blocked`, `ssrf_blocked`, `size_cap`, `http_4xx`, `cancelled_by_user`.
- `progress.bytesDone` is what has been saved so far. `estimate` is never a measurement: for a crawl it extrapolates from the pages saved so far up to the crawl's page and byte limits (`basis` says how; `confidence` is `low` until 10 pages are done), a refresh job knows its page count exactly, a single capture has no estimate until it is finished. Show it as "Estimated" and as a range.
- `GET /api/downloads/{id}/log` returns `{ items: LogItem[], nextCursor? }` (the same item shape as `/api/system/logs`, newest first) filtered by `level` (comma-separated), `limit`, `cursor`.
- `GET /api/downloads/queue` is the summary above. `running` holds up to 20 running jobs with `progress.etaSeconds` where it can be worked out. `limits` shows the effective values; `throttle.active` is true while background work is slowed because the event loop or the machine is busy; `disk.paused` is true while background downloads are paused because a volume is under its free-space reserve (the paused jobs carry `pause.reason: "volume_full"` and resume by themselves when space is free again; downloads started by the Human are not paused).
- `POST /api/downloads` takes `{ kind, url?, sourceId?, priority? = 3, config?, asCollection? }` and answers 202 with the `DownloadJob`. `kind: "capture"` needs `url` (same as `POST /api/archive/capture`); `"explore"` and `"mirror"` need `url` and take the same `config` object as a source (`depth`, `maxPages`, ..., optional `profile`); `"refresh"` needs `sourceId` and checks that source's saved pages for changes. `"capture"`, `"explore"` and `"mirror"` with a `sourceId` and no `url` run that source. Other kinds answer 501 `not_implemented`, and so does `asCollection`. `Idempotency-Key` is kept for 24 hours in the database (survives a restart): the same key with the same body answers the original job with 200, the same key with a different body is 409 `conflict`.
- **SSE.** `GET /api/system/events` carries `download.update` for every change of state or progress: `{ download: DownloadJob }` (no `crawl` block), at most about five per second per job (the last one always arrives), plus `download.queue` `{ counts, throttle, disk }` when the counts or limits status change. The older `download`, `capture` and `crawl` events still exist. A client should refetch `GET /api/downloads/{id}` after reconnecting.
- **Resource limits** are the settings group `resources`: `profile`, `maxFetchConcurrency` (global, 1-64), `perHostConcurrency` (1-16), `perHostDelayMs` (0-60000), `extractWorkers` (0-16), `workerMemoryMb` (16-16384; applies to extraction workers at the next start), `renderConcurrency` (0-8, read live by the renderer; 0 renders one page at a time; `NCB_RENDER_CONCURRENCY` is only the default of this setting), `bandwidthLimitKbps` (kilobits per second for all response bodies together; 0 is no limit), `cpuThrottle` (`off`, `low`, `medium`). They apply live except `extractWorkers` and `workerMemoryMb`. `POST /api/setup/profile` sets the preset of the chosen profile: `pi-lite` fetch 2, per host 1, delay 1500 ms, extraction workers 1, 256 MB, rendering 1, throttle `medium`; `standard` fetch 6, per host 1, delay 1000 ms, extraction workers 2, 512 MB, rendering 1, throttle `low`.
- **Refresh.** `POST /api/sources/{id}/refresh` (S+C) answers 202 `{ downloadIds: string[], pages: number }`: one `refresh` download that checks the source's saved pages (up to its page limit) with conditional requests. A page that has not changed gets no new version (its `lastCheckedAt` moves); a changed page gets a new version under the source's versioning policy; a page that answers 404 or 410 is kept and marked gone (`goneAt` and `goneStatus` on `page` in `GET /api/archive/pages/{id}`, with `lastCheckedAt`) and is un-marked if it comes back. A source with a schedule runs this instead of a full run once it has pages (sitemaps and feeds also look for new items). `summary` on the download counts the outcomes.

Implementation notes (server, Phase 3: C-09). Schedules and windows are implemented as follows.

- `POST /api/schedules` takes `{ sourceId, kind, minute?, time?, dayOfWeek?, cron?, timezone = "UTC", windowId?, window?, missedRunPolicy = "run_once", enabled = true }`. `kind` is `manual`, `hourly` (`minute` past the hour), `daily` (`time` "HH:MM" local), `weekly` (`time`, `dayOfWeek` 0 = Sunday) or `cron` (five fields, checked with `cron-parser`, never more often than every five minutes). Every kind but `manual` is stored as a cron expression (`expression`) evaluated in `timezone`, so daylight-saving changes follow local time: a local time that does not exist runs once at the shifted time, one that happens twice runs once. A schedule can also be created inline with `POST /api/sources` (`schedule`). Responses carry `nextRunAt`, `lastRunAt` and the attached `window`. Schedules need a source (global schedules are not exposed yet).
- `window` creates a download window for the schedule: `{ name?, days: ("mon".."sun")[] (default all), start: "HH:MM", end: "HH:MM" or "24:00", timezone, limits?, enabled }`. An end earlier than the start runs past midnight and belongs to the day it starts on. A schedule with a window waits for it: a due slot is not claimed while the window is shut and runs once, as the latest slot, when it opens.
- `GET /api/downloads/windows` returns `{ windows, status: { open, since?, closesAt?, opensAt? } }`; `PUT` takes `{ windows: WindowInput[] }` (at most 14) and replaces the global windows. An empty list means no restriction. Global windows apply to every download that is not user-initiated (`requestedBy` other than `user`), source windows additionally to that source's downloads; both must be open. At a closing edge the scheduler pauses such downloads (`paused`, children `held`, flagged `paused_by_window`); at the next opening it resumes only the ones it paused.
- `missedRunPolicy`: `run_once` runs the latest overdue slot once; `skip` drops a slot that is more than 10 minutes late (for a windowed schedule, late is counted from when the window opened). The scheduler tick runs on the job runner's loop (every 15 s), uses the monotonic clock for pacing and a `ScheduleGate` for slots, and does nothing for a minute after a detected wall-clock jump or while the clock reads before 2020.

Resource limits are read and written under `/api/settings` (group `resources`, see the C-08 notes above). Change detection (ETag, Last-Modified, content hash, conditional requests) is internal to `refresh` jobs; the result is visible as `VersionSummary` and `activity_log` entries ("unchanged, 304").

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

Groups: `general` (app name, locale `en-GB`), `resources` (profile and limits), `privacy` (`history.enabled`, `searchHistory.enabled`, `onlineSearch.enabled`, disclosure text), `offline` (`forced`, probe URL), `browser` (`showLinkStates`, `liveFrames`, `bookmarkPriority`, `autoCacheOpened`, and from Phase 2 `preferCached` (default true) and `quickSavePriority` (default 3)), `search` (ranking, RRF `k` and weights, synonyms, ZIM budget), `discovery` (section 9), `storage` (section 10 policy), `logging`, `appearance` (theme tokens). Changing `privacy.onlineSearch.enabled` to true returns the disclosure text that the UI must show and record acknowledgement of (`acknowledgedAt`).

## 13. System

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/system/health` | HTTP 503 while `starting`, 200 otherwise. Minimal `{ status: "ok" \| "degraded" \| "starting" }` for Docker; checks DB writable, index openable, worker heartbeat fresh, free space above floor | P |
| GET | `/api/system/status` | Detailed: versions, architecture, uptime, workers (`extract`, `index`, `search`, `zim`), queue depths, memory, connectivity, renderer reachable | S |
| GET | `/api/system/dashboard` | Admin dashboard: pages, sources, collections, index size, storage used and available, active, queued and failed jobs, last update, worker status | S |
| GET | `/api/system/events` | **SSE**: job progress, worker heartbeat, connectivity, thresholds (`Last-Event-ID` supported). Phase 2 adds `capture`: `{ downloadId, url, state, held, outcome, label, percent, stage?, pageId?, versionId?, failureMessage? }`, sent when a save is queued, as each pipeline stage starts, and when it ends | S |
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

History recording is a user setting (`privacy.history.enabled`, default on, local only); disabling stops recording, clearing deletes rows. `GET /api/history` returns `{ enabled, items }`; `DELETE /api/history` returns `{ deleted }`. Bookmarks add `referencePriority` (the value of `browser.bookmarkPriority` when the bookmark was made; Phase 6 uses it), `GET /api/bookmarks?url=` filters by address, and `POST /api/bookmarks` on an address that is already bookmarked returns the existing bookmark with 200. The archive reference is looked up by address each time a bookmark is listed, so a page saved after the bookmark was made is found.

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
