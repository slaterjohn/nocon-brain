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
  | "provider_error" | "not_implemented" | "internal" | "unavailable";
```

`unavailable` (HTTP 503) is used when a part of the server that normally works cannot answer right now, for example a knowledge package whose reader has crashed and is restarting (Phase 8). The body carries `details.zimCode`.

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
  prefer?: "archive" | "live" | "reader" | "zim";   // archived/live switching, reader mode, the package copy of a Wikipedia article
  versionId?: string;                  // open a specific version
  frame?: { appOrigin: string };       // used to mint the token; checked against NCB_APP_URL
}

type Resolution =
  | { kind: "search"; query: string }                              // not a URL: go to /search
  | { kind: "archive"; page: PageSummary; version: VersionSummary; mode: "original" | "reader"; frame: FrameInfo }
  | { kind: "cache"; page: PageSummary; version: VersionSummary; mode: "original" | "reader"; frame: FrameInfo }  // browsing-cache only (P4)
  | { kind: "zim"; zim: ZimSummary; path: string; title: string; frame: FrameInfo }   // ZimSummary = { id, title, language }
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

- `resolve` answers `{ kind: "search" }` for text that is not an address (the shell then opens `/search?q=`), and 400 for other schemes (`javascript:`, `data:`, `file:`) and for addresses with credentials. A bare host (`example.org`) gets `https://`; an IP address, `localhost` or `host:port` gets `http://`. `prefer: "live"` returns the live resolution when the connection is not known to be down. The user setting `browser.preferCached` (default on) decides which wins when both exist and the request does not say. `frame.url` is built from `NCB_ARCHIVE_PUBLIC_URL`, or the request host (trusted only from the web proxy) plus `NCB_ARCHIVE_PORT`. The `cache` resolution is not produced yet. The `zim` resolution is produced for Wikipedia addresses (Phase 8, task Z-06, below). `live` and `offline` carry `queued: { downloadId }` when the address is already waiting to be saved. Live frames are not offered: `frameable` stays `"unknown"` in `resolve`; `live-check` reports it.
- `frame-state` returns `{ frameId, url, title?, state, pageId?, versionId?, zimId?, zimPath?, reader?, interstitial?, at, seq }`. `seq` rises with every document the listener serves to the frame, so the shell applies only newer ones. A `?hl=` response is not recorded (same document). `interstitial: true` means the listener showed its notice for an address that is not saved; `url` is that address and `state` its link state. Reading it records one history visit per document when history is on. A history visit for a saved page is written by the server when the archive listener serves the document to a frame (for the signed-in user the frame was granted to), not when the shell next reads `frame-state`; reading it later records nothing twice.
- `live-check` returns `{ url, reachable, status?, finalUrl?, frameable, reason? }` and 403 `blocked` for private hosts; it needs the connection (409 `offline` otherwise).
- `save` and `POST /api/archive/capture` take `{ url, priority?: "P1".."P4", queue?: boolean }` and answer 202 `{ downloadId, url, state: "queued", held, priority }`. The default priority is the setting `browser.quickSavePriority` (3). There is no `sources` table before Phase 3, so the priority is stored on the download job, and `pages.effective_priority` takes it when the capture finishes. Offline, `queue: true` is needed (409 `offline` with `canQueue: true` otherwise); the capture is held and released when the server is no longer known to be offline. `Idempotency-Key` is honoured for 24 hours (in memory; a restart forgets it).
- `GET /api/browser/offline-page?url=` returns `{ url, reason, canQueue, archived, queued?, connectivity }`.

**Wikipedia addresses and knowledge packages (Phase 8, task Z-06).**

- `resolve` maps a Wikipedia article address to the same article in an **enabled** Wikipedia package (`enabledForSearch`, state `ready` or `degraded`) of the same language. A package counts as a Wikipedia package when its name, title or source says Wikipedia, or its creator or publisher says Wikipedia or Wikimedia. The mapping accepts any language subdomain (`en`, `de`, `simple`, `zh-yue` and so on), the mobile host (`en.m.wikipedia.org`), `/wiki/Title` and `/w/index.php?title=Title` (also `/index.php?title=`), a fragment (dropped), lower-case first letters, spaces or underscores and percent-encoding. It does not map other namespaces (`Category:`, `File:`, `Special:`, `Talk:` and so on), `?action=`, `?oldid=` or `diff` addresses, another site, or a language that has no package. The package path is the title with underscores (`Black_hole`), which is how Kiwix Wikipedia builds key their articles; redirects inside the package are followed by the listener.
- Order of resolution: archive, then package, then live or offline. An archived copy of the same article is preferred (it is the Human's explicit save, with its own revision), and the response then lists `"zim"` in `alternatives`; `prefer: "zim"` opens the package copy instead. With no archived copy the package copy wins over the live site, online and offline; `prefer: "live"`, or `browser.preferCached` off, still gets the live resolution when the connection allows. A package that is switched off for search is ignored. Nothing is fetched.
- The `zim` resolution carries `{ zim: { id, title, language }, path, title, frame }`. Opening `frame.url` serves the entry through the listener (sanitised, links rewritten, see section 5). `frame-state` for it reports `state: "zim"`, `zimId`, `zimPath` and `url` set to the **Wikipedia address** of the entry (`https://en.wikipedia.org/wiki/Benzene`) when the package is a Wikipedia package, so the address bar shows the address the Human typed; other packages report `zim://<zimId>/<path>`.
- **History.** A visit to a package entry is recorded when the listener serves it to a frame (history on, a signed-in user), once per document, with `servedFrom: "zim"`. `GET /api/history` items gain `zim?: { zimId, path }`. The entry is stored under its Wikipedia address (so the same page found in the archive and in the package is one address in History) or, for other packages, under `zim://<zimId>/<path>`.
- **Link rewriting.** In an archived page, a link to a Wikipedia article that is not archived but is in an enabled package opens `/a/{token}/z/{zimId}/{path}` (state `cached`); a link to an archived article opens the archived page (archive wins). Inside a package page, a link to a Wikipedia address that is archived opens the archived page; one that is neither archived nor in the package goes to the notice page (`live-only` or `unavailable`). A package page never links to the live site on its own.

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
| POST | `/api/archive/frame-grants` | Mint a token for a page, a version or a knowledge-package entry without resolving: `{ pageId \| versionId, mode }` or `{ zimId, zimPath? }` (Phase 8) | S+C |

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

**Attribution footer (Phase 8, task Z-08).** A version that has a `page_attributions` row (every saved Wikipedia article) is served with a static footer at the end of `<body>` (and of the reader view): "Text from Wikipedia, licensed under CC BY-SA 4.0 (link). Article: <address>. Authors: see the article history (link). Archived on <date>, revision <id>.", then a collapsed "Image credits (n)" list with the file page, author and licence of each saved image. Its links open in a new tab. The same facts are on `GET /api/archive/versions/{id}` as `attribution: { licenseName, licenseUrl, sourceUrl, revisionId, historyUrl, creditText, retrievedAt, images[] }`. Package pages carry the package's own bar (title and licence).

**Partial pages.** A `partial` version is served with a banner element (static HTML) that states what is missing ("3 images not saved") and offers "Download the rest" (opens an app tab). **Uncached links** never cause an external request: the listener has no outbound code path. The interstitial (`/m`) shows the URL as text, the link state, and actions: "Open the live site" (`target=_blank rel="noopener noreferrer"`, only if `http`/`https` and connectivity is not offline), "Save for offline" and "Queue" (links to app routes opened in a new tab so the Human's session is used), "Back". Offline, the "open live" action is disabled and the page explains how to queue the URL for when the connection returns.

**Non-HTML documents.** Images are served as-is with the headers above. PDFs: Chromium's PDF viewer does not run inside a sandboxed document, so the listener serves PDFs with `Content-Disposition: attachment` through an app "Download" action, and shows the extracted text via reader view (risk R-24, task C-14). SVG is rewritten to remove scripts and external references.

**ZIM entries.** `z/{zimId}/{path}` calls the `zim` worker for the entry, follows redirects with a 302 to the target path, sets `ETag` from the ZIM UUID plus path (content is immutable), sanitises HTML (scripts removed, links rewritten to the same scheme or to the interstitial for entries that do not exist or external URLs) and serves with the same headers. Both new (`Aromaticity`) and old (`A/Aromaticity`) namespace schemes are handled via `hasNewNamespaceScheme`.

## 6. Search

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | `/api/search` | Start a search; returns local and ZIM results immediately plus a `searchId`. **Phase 4: local archive only** (see 6.1) | S+C, G |
| GET | `/api/search/{searchId}/events` | **SSE** stream of online results and updates (6.2) | S/G |
| GET | `/api/search/{searchId}` | Snapshot of the search (the stored `SearchResponse`, kept 30 minutes in memory); `?after=<seq>` returns events after a sequence number (6.2). Back-navigation restore | S/G |
| POST | `/api/search/{searchId}/more` | Next page from providers (`{ providerId? }`) (6.2) | S+C |
| GET | `/api/search/favicon/{pageId}` | The archived favicon of a page (image bytes, `nosniff`, sandboxed CSP, immutable cache); 404 when none was archived | S/G |
| GET | `/api/search/suggestions` | `?q=&limit=8`: local autocomplete (titles, queries, domains) and did-you-mean; never calls providers. Shape in 6.1 | S/G |
| POST | `/api/search/coverage/plan` | "Improve offline coverage": estimate for selected results (6.2) | S+C |
| POST | `/api/search/coverage/queue` | Queue the plan, optionally as a collection | S+C |
| GET/POST | `/api/search/providers` | List / create providers (6.2) | S / S+C |
| GET/PATCH/DELETE | `/api/search/providers/{id}` | Read / update / delete | S / S+C |
| POST | `/api/search/providers/{id}/test` | Health check and a small test query; returns latency and error code | S+C |
| GET | `/api/search/providers/{id}/usage` | Request counts against caps | S |
| GET/POST | `/api/search/saved` | List / create saved searches | S / S+C |
| GET/PATCH/DELETE | `/api/search/saved/{id}` | Read / update / delete | S / S+C |
| POST | `/api/search/saved/{id}/run` | Run it; returns a `SearchResponse`; updates `lastRunAt` and `lastResultCount` | S+C |
| POST | `/api/search/{searchId}/results/{key}/save` | Save an online result for offline use: archives the page itself, links the result to the page (6.2) | S+C |
| POST | `/api/search/saved/{id}/source` | Make a saved search a source (scheduled online run, candidates or downloads) (6.2) | S+C |
| GET | `/api/search/saved/{id}/candidates` | Candidates of a saved-search source, including in-memory (transient) ones | S |
| POST | `/api/search/saved/{id}/candidates/approve`, `/dismiss` | Queue or dismiss candidates `{ ids }` | S+C |
| GET/DELETE | `/api/search/history` | Search history (only written if `privacy.searchHistory.enabled`); `DELETE` clears all; `DELETE /api/search/history/{id}` removes one | S / S+C |

**Progressive results: SSE chosen (D-3).** Local and ZIM results return in the `POST` response within tens of milliseconds. Online providers answer in 300 ms to a few seconds, or never. The client opens `GET /api/search/{searchId}/events` and appends. SSE was chosen over polling for server push without an interval, native reconnection with `Last-Event-ID`, and low cost. The server keeps each search session in memory for 30 minutes (ring buffer of events, URLs and titles only; snippets from providers whose `storagePolicy` is `none` stay in memory and are never written to disk), so `GET /api/search/{id}` restores the exact list for back navigation and serves as the polling fallback for environments that buffer SSE. Heartbeat comment every 15 s; `X-Accel-Buffering: no`.

```ts
interface SearchRequest {
  query: string;
  scope?: "all" | "offline" | "online" | "images" | "documents" | "zim";   // "offline" = local + ZIM; "online" = providers only; "zim" = knowledge packages only (Phase 8)
  zim?: "unified" | "federated" | "off";                            // Phase 8: how package hits join the results; default "unified" (see "Knowledge packages in search")
  zimIds?: string[];                                                 // Phase 8: search only these packages
  filters?: SearchFilters;
  online?: "auto" | "off" | "on";                                   // auto = per settings and connectivity
  providers?: string[];                                              // subset of enabled provider IDs
  page?: number; pageSize?: number;                                  // 1-based; default 20, max 50
  // Phase 4 additions (all optional):
  typo?: boolean;                                                    // typo tolerance and "did you mean"; default true
  synonyms?: boolean;                                                // query-time synonym expansion; default true
  facets?: boolean;                                                  // compute facet counts; default true on page 1, false on later pages
  group?: boolean;                                                   // collapse duplicates ("also at"); default true
  record?: boolean;                                                  // write to search history when that setting is on; default true for page 1 only
  debug?: boolean;                                                   // include `explain` on every result and `plan` on the response
}
interface SearchFilters {
  sources?: string[]; collections?: string[]; domains?: string[]; types?: DocType[];
  downloadedFrom?: Iso; downloadedTo?: Iso; publishedFrom?: Iso; publishedTo?: Iso;
  availability?: ("cached" | "partial" | "queued" | "online_only")[]; languages?: string[];
}
// DocType = "html" | "pdf" | "image" | "text" | "other"   (pages.content_type; imported Markdown and text are "text")
// Phase 4 notes: `sources` and `collections` take public ids (`src_...`, `col_...`); a collection filter includes pages in its
// sub-collections; `domains` match the host or any subdomain; `languages` take ISO 639-1 codes ("en"); `availability`
// accepts "cached" (archived) and "partial"; "queued" and "online_only" match nothing locally. Dates are ISO-8601 instants
// (a bare date is the start of that day, UTC; `*To` as a bare date is the end of that day).
// Operators in `query`: site:example.org  type:pdf  before:2026-01-01  after:2025-06-30  "exact phrase"  -excluded
// before:/after: use the publication date, falling back to the capture date when none is known.

interface SearchResponse {
  searchId: string;
  parsed: { terms: string[]; phrases: string[]; excluded: string[]; operators: Record<string, string>; warnings: string[] };
  results: SearchResult[];
  didYouMean?: { text: string; corrected: { from: string; to: string }[]; appliedAutomatically: boolean };
  coverage: Coverage;
  facets?: Facets;                     // local counts only; see 6.1
  total: number; totalCapped: boolean; // matches in the local index (exact up to the candidate cap of 2000)
  page: number; pageSize: number;
  index?: { state: "ok" | "building" | "rebuilding" | "missing" | "error" };   // Phase 4: anything but "ok" means results may be missing; `warnings` then says so
  warnings?: string[];
  online: { state: "disabled" | "offline" | "pending" | "done"; pending: string[] /* provider IDs */; disclosure: string };
  tookMs: { local: number; zim: number };
  nextCursor?: string;                 // the next page number as a string; absent on the last page
  plan?: unknown;                      // debug: FTS expressions run, groups queried, fallback used
}
interface SearchResult {
  key: string;                         // stable within the search: canonical-URL based
  url: string; canonicalUrl: string; title: string;
  faviconUrl?: string | null;          // same-origin path `/api/search/favicon/{pageId}` when an icon was archived with the page, else null; never fetched from the web at query time
  sourceName?: string | null;          // name of the page's first source
  collections?: { id: string; name: string }[];   // collections the page belongs to directly
  titleHtml?: string;                  // the title with matches in <mark>; same sanitiser as `snippet` (Phase 4)
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
  // Phase 4 additions:
  alsoAt?: { pageId: string; url: string; title: string }[];   // near-identical or same-content pages collapsed into this result
  explain?: ScoreExplanation;          // only when `debug: true`
}
interface ScoreExplanation {
  total: number; bm25: number;         // bm25 is the FTS5 value, lower (more negative) = better
  components: { name: "relevance" | "exactTitle" | "freshness" | "linkGraph" | "preference" | "cached"; weight: number; value: number; contribution: number }[];
  matchedBy: "and" | "or" | "corrected" | "exact_title";
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

### 6.1 Local search (Phase 4, as built)

This is the contract of the tasks S-01 to S-15. Phase 5 adds the online half on top of it (6.2); everything below describes the local half, which is unchanged. `POST /api/search` answers from the local `index.db` only: `origin` is always `"archive"`, `zim` is `0` in `tookMs`, `online` is `{ state: "disabled", pending: [], disclosure: "" }` (or `"offline"` when forced offline) and `coverage` counts the local matches (`basis: "local_exact"`). Reads need a session or trusted-LAN guest; `POST`, `PUT`, `PATCH` and `DELETE` need a session and the CSRF header.

**`POST /api/search`.**

- `scope`: `all` and `offline` search the whole index; `images` forces `types = ["image"]`; `documents` forces `types = ["pdf", "text"]`; `online` returns no local results (`results: []`, `total: 0`). An explicit `filters.types` narrows within the scope (the intersection; empty means no results).
- An empty or whitespace query with no filters is a 400 (`details.fields[0].path = "query"`). A query that is only operators (`site:example.org`) is allowed and lists the matching pages newest first. A query longer than 500 characters is a 400. Anything else never errors: unbalanced quotes, stray `-`, `site:` with no value, and FTS5 punctuation are recovered and reported in `parsed.warnings` (plain English, for example `Ignored "before:" because it needs a date such as before:2026-01-01`).
- **Operators.** `site:example.org` (host or any subdomain; repeated `site:` is OR), `type:pdf` (`html`, `pdf`, `image`, `text`; `markdown`, `md` and `txt` mean `text`; `document` means `pdf` or `text`; repeated is OR), `before:2026-01-01` and `after:2025-06-30` (a date `YYYY`, `YYYY-MM` or `YYYY-MM-DD`; the publication date, falling back to the capture date when none is known; exact rules below), `"exact phrase"`, `-excluded` and `-"excluded phrase"`. Operator names are case-insensitive. `parsed.operators` echoes them as `{ site: "a.org,b.org", type: "pdf", before: "2026-01-01" }` (repeats comma-joined). Operators in the query combine with `filters` by AND.
- **`before:` and `after:` precisely.** `before:D` matches pages dated strictly before 00:00 UTC on D. `after:D` matches pages dated on or after 00:00 UTC on D. (So `after:2025-06-30 before:2025-07-01` is exactly 30 June.)
- **Matching.** Bare terms are ANDed. When the AND query returns nothing, the server retries with OR over the terms (best match first) and sets `plan.fallback = "or"` in debug mode; `-excluded` terms and filters still apply. A bare term ending in `*` (`astro*`) is a prefix term; it also matches the full words that start with it, since the English index holds stems. Terms are matched with English stemming (`discovering` finds `discovered`) in the English group and exactly (after case and accent folding) in the default group. Stop words are dropped from bare terms when other terms remain (never from phrases). Synonyms (6.1.3) expand at query time only.
- **Very common terms.** When a term occurs in 5,000 or more pages, the words are first matched in the title, headings and URL; if at least 30 pages match there, only those pages are ranked (the body-only matches are not candidates, though `total` and the facets still count them). Identical searches are answered from a small cache that any index change empties. (Mitigations from S-13.)
- **Typo tolerance.** A bare term of 4 or more characters that is not in the vocabulary is replaced by its single best correction (smallest edit distance, then highest document frequency; at most 1 edit for 4 to 6 characters, 2 for longer). The response then has `didYouMean = { text, corrected: [{ from, to }], appliedAutomatically: true }`. If the corrected query finds nothing, the next two candidates are tried as an OR group. When the typed query itself found results but a term is rare and a far more frequent near neighbour exists, `didYouMean` is returned with `appliedAutomatically: false` and the results are the typed query's. A page whose title equals the corrected or typed query ranks first (`exact_title`).
- **Ranking.** Candidates are the best 300 by BM25 with weights title 10, headings 5, URL 3, body 1, then re-scored: `score = relevance + exactTitle + freshness + linkGraph + preference + cached`, where relevance is the candidate's BM25 divided by the best BM25 of the set (0 to 1), freshness is `exp(-ageDays / 365)` of `date_for_ranking`, linkGraph is `min(1, log(1 + inlinks) / log(101))`, preference is the boost for the page's domain or source (-1 to 1), cached is 1 for `archived` and 0.5 for `partial`. Default weights `{ relevance: 1, exactTitle: 0.6, freshness: 0.08, linkGraph: 0.06, preference: 0.1, cached: 0.03 }`; change them with `PUT /api/index/ranking`. Ties break by score, then newer `date_for_ranking`, then lower page id, so the order is stable between runs. `fusedRank` is the 1-based rank and `fusedScore` the score.
- **Highlighting.** `snippet` (about 24 words around the best match) and `titleHtml` contain the page's own text with every character HTML-escaped (`&lt;`, `&gt;`, `&amp;`, `&quot;`, `&#39;`) and `<mark>` and `</mark>` as the only markup. Page text that looks like HTML is escaped, never passed on.
- **Grouping.** With `group` (default) pages with the same content hash, or whose text fingerprints differ in at most 3 of 64 bits, collapse into the best-ranked one. The others are listed in `alsoAt`. `total` counts matches before grouping; a page's `alsoAt` pages do not appear separately in the same response.
- **Paging.** `page` and `pageSize` (default 20, max 50). The ranked candidate list is capped at 300 pages, so `page * pageSize` beyond 300 returns an empty page. `nextCursor` is the next page number while more candidates remain.
- **Facets** (`facets`, computed for page 1 by default, over at most 2000 matches; `totalCapped` says the cap was hit). Each dimension is counted over the matches that pass all the other filters but not its own, so the counts of the chosen value stay visible:
  ```ts
  interface Facet { value: string; label: string; count: number }         // `value` is what to send back in `filters`
  interface Facets {
    sources: Facet[]; collections: Facet[]; domains: Facet[]; types: Facet[]; languages: Facet[];
    availability: Facet[];                                                  // value "cached" | "partial"
    downloaded: Facet[]; published: Facet[];                                // value = bucket start: "last_day" | "last_week" | "last_month" | "last_year" | "older" ("unknown" for published)
    approximate: boolean;
  }
  ```
  Facets are sorted by count (descending), then label; each list has at most 20 entries. Source and collection labels are their names.
- While the index is `building` (no file yet) the response is 200 with `results: []`, `index.state = "building"` and a warning; the UI shows "search index is rebuilding". While it is `rebuilding` (an existing index is being replaced) results come from the old file.
- `searchId` is `sch_` plus a ULID. The response is kept in memory for 30 minutes for `GET /api/search/{searchId}`.
- **History.** On page 1 with `record !== false`, when `privacy.searchHistory.enabled` is true, a row is written (`query`, `scope`, `localCount`). When the setting is off nothing is written, and rows written earlier stay until cleared.

**`GET /api/search/suggestions?q=&limit=8`** returns `{ q, items: Suggestion[], didYouMean?: DidYouMean }` in under 50 ms on 50,000 pages (informational on CI). It never calls a provider. `limit` is 1 to 20. An empty `q` returns the recent queries only (if history is on) and the most visited domains.
```ts
type Suggestion =
  | { kind: "title"; text: string; url: string; pageId: string; domain: string }   // page titles starting with, or containing a word starting with, the last typed word (title-only FTS)
  | { kind: "query"; text: string }                                                // earlier queries (history on) that start with `q`
  | { kind: "domain"; text: string; count: number }                                // archived hosts starting with `q`, or after `site:`
  | { kind: "term"; text: string }                                                 // vocabulary completion of the last word, most frequent first
```
Order: title, query, domain, term, each group at most half of `limit`, and a group never repeats a text. `didYouMean` has the same shape as in `SearchResponse` with `appliedAutomatically: false`.

**Saved searches** (`ss_` ids). `POST /api/search/saved` takes `{ name, query, filters?, scope?, includeOnline? }` (name 1 to 120 characters; the query must parse; stored locally in `main.db`) and returns 201 with
```ts
interface SavedSearch { id: string; name: string; query: string; filters: SearchFilters; scope: SearchRequest["scope"]; includeOnline: boolean;
  createdAt: Iso; lastRunAt?: Iso; lastResultCount?: number; collectionId?: string /* the saved-search collection built on it */;
  sourceId: string | null /* the saved_search source made from it (6.2), else null */ }
```
`GET /api/search/saved` returns `{ items }`, newest first. `PATCH` takes any of `name`, `query`, `filters`, `scope`, `includeOnline`. `DELETE` returns 204 and refuses with 409 while a saved-search collection uses it (delete the collection first). `POST /api/search/saved/{id}/run` takes `{ page?, pageSize? }` and returns a `SearchResponse` (it is not written to the history).

**History.** `GET /api/search/history?limit=50&cursor=` returns `{ enabled: boolean, items: { id: string, query: string, scope: string, at: Iso, localCount: number }[], nextCursor?: string }` newest first (an empty list when the setting is off). `DELETE /api/search/history` clears everything and returns `{ removed }`; `DELETE /api/search/history/{id}` removes one (404 when unknown).

**Saved search as a collection.** `POST /api/collections` with `{ kind: "saved_search", name, savedSearchId }` (the id of an existing saved search; 400 on `savedSearchId` when missing or unknown) creates a collection whose members are the pages that the saved search currently finds in the local index (up to 2000). The members are stored (`added_by = 'rule'`) and refreshed when the collection is created, on `POST /api/collections/{id}/rebuild` (returns `{ added, removed }`) and within a couple of seconds after the index applies a change; `GET /items` reads the stored members in the usual shape. `POST /items` on it is 409. `rule` in the collection output holds `{ savedSearchId }`.

#### 6.1.1 Index endpoints (section 11) in brief

`GET /api/index/status` returns
```ts
interface IndexStatus {
  state: "ok" | "building" | "missing" | "rebuilding" | "error";   // missing = no usable index.db yet; the server rebuilds it by itself
  engine: "fts5"; generationId: number; schemaVersion: number; builtAt?: Iso;
  docs: number; expectedDocs: number; drift: number;                // drift = expectedDocs - docs (pages that should be indexed minus indexed)
  sizeBytes: number;
  outbox: { pending: number; oldestAgeMs: number | null; lastAppliedId: number };
  rebuild?: { jobId: number; state: "queued" | "running" | "failed" | "done"; docsDone: number; docsTotal: number; startedAt: Iso; resumable: boolean; error?: string };
  lastOptimizeAt?: Iso; lastCheck?: { at: Iso; ok: boolean; sampled: number; mismatches: number; countMismatch: number };
  vocabTerms: number; groups: { en: number; default: number };
}
```
`POST /api/index/rebuild` (body `{ reason? }`) answers 202 `{ jobId, state }` (409 when one is already running). `POST /api/index/optimize` runs FTS5 `optimize`, a vocabulary rebuild and `ANALYZE`; returns `{ ok, tookMs }`. `POST /api/index/check` runs the sampled consistency check (counts plus up to 200 sampled documents compared with `main.db`) and returns `{ ok, expected, indexed, sampled, mismatches: { pageId, field }[], missing: number, extra: number, repaired: number }`; with `?repair=true` it queues the pages that differ (and a rebuild when the counts differ by more than 1%). `GET /api/index/jobs` returns `{ items }` (the `indexing_jobs` rows, newest first, 50). `GET|PUT /api/index/synonyms` and `GET|PUT /api/index/ranking` are in 6.1.3 and 6.1.4.

**Synonyms (6.1.3).** `GET` returns `{ enabled: boolean, items: { term: string, expansions: string[], kind: "twoway" | "oneway" }[] }`. `PUT` replaces the whole list with the same body (`enabled` is optional; each term and expansion is 1 to 60 characters of letters, digits, spaces, hyphens; at most 500 entries; invalid input is a 400 with field paths). A `twoway` entry means the term and every expansion are interchangeable. A `oneway` entry expands the term only. Expansion happens when the query runs, only for bare terms and never for phrases or exclusions, and `synonyms: false` in the request turns it off. Changing synonyms never rebuilds the index.

**Ranking weights (6.1.4).** `GET` returns `{ weights: RankingWeights, defaults: RankingWeights, bm25: { title: 10, headings: 5, url: 3, body: 1 }, preferences: { domains: Record<string, number>, sources: Record<string, number> } }`; `PUT` takes `{ weights?: Partial<RankingWeights>, preferences?: ... }` (each weight is 0 to 5, each preference -1 to 1; unknown keys are a 400) and returns the same shape. `RankingWeights = { relevance, exactTitle, freshness, linkGraph, preference, cached }`. The BM25 column weights are fixed in Phase 4. Changes apply to the next query.

**Documents and Images categories.** `scope: "documents"` lists PDF, text and Markdown pages by page type (`pages.content_type` `pdf` or `text`, set from the imported file's kind; the synthetic import URL is never consulted); `scope: "images"` lists pages whose `type` is `image`. No image pages are produced by the capture pipeline yet (it refuses non-HTML responses), so the category is empty until image pages exist; the filter and the facet work today. Per-`<img>` sub-documents are post-v1.


### 6.2 Combined search (Phase 5, as built)

This is the contract of tasks O-01 to O-05, O-07 to O-11 (server side). It extends 6.1: the response of `POST /api/search` is the same shape, the local part is unchanged and never waits for a provider, and online results arrive afterwards on the event stream. Reads need a session or trusted-LAN guest; writes need a session and the CSRF header. Adapters shipped: `searxng`, `brave`, `mojeek`. Everything below that says "provider" is an enabled row of `search_providers`.

**When the server goes online.** A search starts an online run only when all of these hold: `scope` is `all` or `online`; `online` is not `"off"`; `privacy.onlineSearch.enabled` is true and `privacy.onlineSearch.acknowledgedAt` is set; at least one provider is enabled (and in `providers`, when that list is given); the server is not offline (`offline.forced`, or connectivity observed as offline). When any condition fails the response has `online.state = "disabled"` (setting off, no provider, `online: "off"`, scope without the web) or `"offline"`, the process makes **no provider connection at all** (not even a cache read), and nothing errors. `online: "on"` behaves like `"auto"`: it cannot override the master switch. `scope: "online"` returns no local results (`results: []`) and an online run.

```ts
// POST /api/search response additions (all other fields as in 6.1)
online: {
  state: "disabled" | "offline" | "pending" | "done";   // "pending" from the POST when a run started; "done" only on snapshots/polls
  pending: string[];                                    // provider ids still to answer
  disclosure: string;                                   // the privacy text, non-empty whenever state is pending or done
  providers?: { id: string; name: string; adapter: string; state: "pending" | "ok" | "error" | "skipped"; count: number; hasMore: boolean; error?: { code: SearchErrorCode; message: string; retryAfterMs?: number } }[];
};
lastSeq: number;   // 0 on the POST; the highest event sequence number on snapshots. Open the stream with Last-Event-ID = lastSeq
```

**`GET /api/search/{searchId}/events`: SSE.** Headers as `GET /api/system/events` (`text/event-stream`, `no-cache, no-transform`, `X-Accel-Buffering: no`). Starts with `retry: 3000`. A comment line `: heartbeat` every 15 s (`sseHeartbeatMs`). Every frame is `id: <seq>\nevent: <type>\ndata: <json>\n\n`; the JSON always repeats `type`, plus `seq` and `at`. Use `addEventListener(<type>)` for each type (named events do not reach `onmessage`). `seq` starts at 1 per search and only goes up. **Resume**: send `Last-Event-ID: <seq>` (the web proxy forwards it) or `?after=<seq>`; the server replays every retained event after it and then follows live. The server retains every event of a search for 30 minutes. **End**: after `done` the server closes the stream. A client that reconnects with a `Last-Event-ID` at or after the final `done` while nothing new happened gets **204**, which stops `EventSource` from reconnecting. Unknown or expired search: 404. A search without an online run (`state` is `disabled` or `offline`) has exactly one event, `done` with `reason: "no_providers"`.

```ts
type SearchEvent = { seq: number; at: Iso } & (
  | { type: "provider_started"; providerId: string; name: string; adapter: string; page: number; fallbackFor?: string }
  | { type: "provider_results"; providerId: string; page: number; hasMore: boolean; tookMs: number; cached: boolean;
      partial?: { failedEngines: string[] };            // SearXNG unresponsive_engines
      dropped: number;                                  // results discarded because their URL was not http(s) or was malformed
      append: SearchResult[];                           // new online-only results, in fused order among themselves
      update: { key: string; alsoOnline?: true; addAttribution?: SearchResult["attribution"][number]; snippetExtra?: string /* escaped, <mark> only */ }[] }
  | { type: "provider_error"; providerId: string; code: SearchErrorCode; message: string; retryAfterMs?: number; fallbackProviderId?: string }
  | { type: "coverage"; coverage: Coverage }
  | { type: "reorder_available"; fusedOrder: string[] }   // result keys of the whole list (local page + online), best first, by weighted RRF
  | { type: "done"; reason: "all_providers_answered" | "deadline" | "cancelled" | "no_providers" }
);
```

Event order for one run: per provider `provider_started` then `provider_results` or `provider_error` (a failing provider with a fallback emits `provider_error`, then `provider_started` with `fallbackFor`, then the fallback's result or error); after each provider answer a `coverage`; `reorder_available` after a `provider_results` that changes the fused order of items already in the list (never otherwise); finally one `done`. The server keeps appending until every provider answered or `search.onlineDeadlineMs` (default 10000) passes; the 2 s display time box is the client's job (late events are applied only through "Load more from the web"). `POST /more` starts a new round on the same stream: new events with higher `seq`, ending in another `done` (a client that saw the first `done` reopens the stream with `Last-Event-ID`).

**Result shape for online hits** (`SearchResult` of 6.1 with these values): `origin: "online"`; `availability: "online_only"` (or `"cached"`/`"partial"` when the page is already archived: `pageId` is then set and `actions.open` is the library route); `storage: "transient"` when the provider's storage policy is `none` (Brave), else `"persist"` (meaning storing is allowed, nothing is stored by the search itself); `title` is plain text and `titleHtml`/`snippet` are escaped with `<mark>` as the only markup, so provider HTML never reaches the client as markup; `url` is always http or https with no credentials; `faviconUrl` is always `null` (icons are never fetched from the web); `actions.saveForOffline` is true while the page is not archived. `attribution` lists `{ kind: "provider", id, name, rank }` per provider that returned it and `{ kind: "local", ... }` when the archive has it too.

**Merging.** Weighted reciprocal rank fusion, `score(d) = Σ w_i / (k + rank_i(d))` over the top `search.onlineTopN` (default 30) of each list, `k = search.rrfK` (60). Weights: local list `search.rrfLocalWeight` (1.5); ZIM `search.rrfZimWeight` (1.0 per package; Phase 8 supplies the lists, see "Knowledge packages in search"); each provider list `provider.weight` (default 1.0), multiplied by `search.rrfSecondaryProviderWeight` (0.7) for a provider that overlaps an earlier one (order: `priority`, then id) in at least half of the smaller list. Dedup key: the canonical URL (`normaliseUrl` key with tracking parameters stripped; `*.wikipedia.org/wiki/<Title>` becomes `wikipedia:<lang>:<Title>`, so a ZIM or archived copy merges with the live hit and the offline copy wins). Ties: has a local source first, higher fused score, smaller best provider rank, then the canonical URL string. `fusedRank` and `fusedScore` on every result and `attribution[].rank` carry the numbers. Local results keep their position in the response; the fused order is only offered through `reorder_available` and the snapshot (`?order=fused`).

**`GET /api/search/{searchId}`: snapshot and polling fallback.** Without parameters: the stored `SearchResponse` with `results` = local results followed by the online results appended so far (with updates applied, `availability` re-read from the archive so a page saved meanwhile shows as cached), a recomputed `coverage`, `online` (with `providers`) and `lastSeq`. `?order=fused` returns the same list in fused order. With `?after=<seq>` it returns `{ searchId, lastSeq, done: boolean, online, events: SearchEvent[] }` (events after `seq`, at most 200; call again with the new `lastSeq` until `done`). Kept 30 minutes; 404 after.

**`POST /api/search/{searchId}/more`**, body `{ providerId?: string }` (session, CSRF). Asks each provider (or the one named) that reported `hasMore` for its next page. Answers 202 `{ searchId, started: string[], skipped: { providerId: string; reason: "no_more" | "disabled" | "offline" | "circuit_open" | "cap_reached" | "running" }[], lastSeq }` and the results arrive as events as above. Offline or online search off: 409 `offline` / `conflict`; nothing is sent.

**Coverage.** `Coverage` counts only (no field is a share of "the internet"): `cachedMatches` (local matches in the archive), `onlineMatches` (distinct online results returned so far), `onlineNotArchived` (online results not archived and not queued), `queued` (online results with a save or download queued), `partial` (partial pages among local matches and online results), `basis` (`"local_exact"` until an online result exists, then `"online_page_estimate"`). Returned on the search response, in the `coverage` event and in snapshots.

**Improve offline coverage.**
- `POST /api/search/coverage/plan`, body `CoveragePlanRequest` of section 6 (`resultKeys` of online results not archived, or `"all_uncached"`; `strategy`, `depth` 0 to 3 (capture ignores it), `priority`, `retention`, optional `asCollection`). Answers `CoveragePlanResponse` `{ planId, urls, estimate, warnings, expiresAt }`. `estimate.estimate` is always `true`; `basis` says what it rests on ("average of 14 archived pages from these domains" or "default of 600 KiB per page: no archived pages from these domains yet"); `pages`, `bytes` and `durationSeconds` are `{ low, high }` and bounded by the resource profile's crawl ceilings; at most 200 URLs per plan (more: 400). Already-archived and non-http(s) URLs are skipped and counted in `warnings`. Plans live 30 minutes in memory. `estimate.confidence` is `low` for `explore`/`mirror` and for fewer than 10 archived pages to learn from, `medium` from 10, `high` from 50.
- `POST /api/search/coverage/queue`, body `{ planId, name? }` (session, CSRF). Creates a source "Search: <query>" (or `name`) with the plan's priority and retention, an optional collection (`asCollection`; an existing `collectionId` or a new `{ name, icon? }`) attached to that source, and queues the work: `capture` queues one download per URL (`requested_by = 'search'`); `explore`/`mirror` start one crawl with all the URLs as seeds. Answers 202 `{ planId, queued: number, downloadIds: string[], sourceId: string, collectionId?: string }`; the chosen results then count as `queued` in the session's coverage. `capture` makes a `single_page` source with one download per URL; `explore` a `linked_collection` source and `mirror` a `website` source, each with one crawl (`explore`/`mirror` download) over all the URLs as seeds. A plan can be queued once (409 afterwards); an expired or unknown plan is 404. Offline: the captures wait, held, as for any save.

**Save for offline.** `POST /api/search/{searchId}/results/{key}/save`, body `{ priority?: Priority, queue?: boolean }` (session, CSRF). Archives **the page itself** through the normal capture pipeline (fetched from the site, SSRF-guarded, robots rules as for any user save), into the Quick saves source. Nothing from the provider (title, snippet, URL as returned) is written anywhere: only the address of the page the Human chose to save goes into the download job. Answers 202 `{ downloadId, url, state: "queued", held: boolean, priority, key }`. The result is linked to the page afterwards by address: once the capture finishes, snapshots show that result as `cached` with its `pageId`, and the next search finds it locally. Offline without `queue: true`: 409 `offline` with `details.canQueue`. A key that is not in the session or that is already archived: 404 / 409.

**Providers** (`prv_` ids). All provider routes need a session; none is readable by a guest. The credential is write-only: responses carry `hasCredentials` and never the key.
```ts
interface Provider {
  id: string; adapter: "searxng" | "brave" | "mojeek"; name: string; enabled: boolean;
  priority: number;                      // 1 first; orders runs, ties and the overlap rule. Default: next free number
  baseUrl: string | null;                // searxng: required (for example http://searxng:8080); brave/mojeek: optional override (tests, proxies)
  hasCredentials: boolean;               // brave, mojeek: required before enabling
  timeoutMs: number;                     // 500 to 30000, default 4000
  rateLimitPerSec: number;               // client-side token bucket, default 1 (searxng 5)
  monthlyCap: number | null; dailyCap: number | null;        // requests, UTC periods; null = no cap
  fallbackProviderId: string | null;     // answers for this provider when it fails with any error except `disabled` (including a reached cap)
  language: string | null; region: string | null; safeSearch: "off" | "moderate" | "strict";
  weight: number;                        // RRF weight, default 1.0
  storage: { policy: "none" | "ttl" | "unrestricted"; ttlSeconds: number | null; adapterPolicy: "none" | "ttl" | "unrestricted"; maxTtlSeconds: number | null; note: string };
  health: { state: "unknown" | "ok" | "degraded" | "down"; lastOkAt?: Iso; lastErrorCode?: SearchErrorCode; circuitOpenUntil?: Iso };
  usage: { month: { period: string; requests: number; cap: number | null }; day: { period: string; requests: number; cap: number | null } };
  createdAt: Iso; updatedAt: Iso;
}
```
- `GET /api/search/providers` returns `{ items: Provider[], online: { enabled: boolean; acknowledgedAt: Iso | null; disclosure: string; state: "off" | "offline" | "ready" } }` (ordered by `priority`).
- `POST /api/search/providers`, body `{ adapter, name, enabled?, priority?, baseUrl?, apiKey?, timeoutMs?, rateLimitPerSec?, monthlyCap?, dailyCap?, fallbackProviderId?, language?, region?, safeSearch?, weight?, storage?: { policy?, ttlSeconds? }, acknowledged?: true }`; 201 with the `Provider`. `PATCH /api/search/providers/{id}` takes any of those (`apiKey: null` removes the credential); `DELETE` returns 204 (and removes its cache rows and counters; a provider that is another's fallback is just unlinked).
- **Disclosure.** Enabling a provider (`enabled: true` on create or patch) needs `privacy.onlineSearch.acknowledgedAt`. Without it the call is a 400 with `details.fields[0].path = "acknowledged"` and `details.disclosure`; with `acknowledged: true` in the same body the server records the acknowledgement (`privacy.onlineSearch.acknowledgedAt`, the same field the settings PATCH sets). A search goes online only when the master switch `privacy.onlineSearch.enabled` is also on (settings PATCH with `acknowledged: true` the first time).
- Validation (400 with field paths): `searxng` needs an http(s) `baseUrl`; `brave` and `mojeek` need `apiKey` before `enabled: true`; `storage.policy` cannot be looser than the adapter allows (Brave: `none` only; Mojeek: `none` or `ttl` with `ttlSeconds` up to 3600; SearXNG: `unrestricted` by default but nothing is cached unless `ttlSeconds` > 0); a provider cannot be its own fallback.
- Provider requests use the SSRF-guarded fetcher with the provider's own host (and port) as the only private-network exception, so a SearXNG at `http://searxng:8080` works and no other private address does. Custom headers are never forwarded to other hosts after a redirect.
- `POST /api/search/providers/{id}/test` (session, CSRF): one small query now (counts as a request against the caps; ignores the circuit and the cache; refused offline with 409). Returns `{ ok: boolean, latencyMs: number, resultCount?: number, errorCode?: SearchErrorCode, message?: string, partial?: { failedEngines: string[] } }` and updates `health`. SearXNG answering 403 gives `errorCode: "bad_request"` and a message naming `search.formats: [html, json]`.
- `GET /api/search/providers/{id}/usage` returns `{ month: {...}, day: {...}, history: { period: string; requests: number }[] }` (the last 12 months).
- Errors: `SearchErrorCode` values as in section 6 with these meanings. `timeout` (no answer in `timeoutMs`), `rate_limited` (HTTP 429 or the local bucket; `retryAfterMs`; the circuit opens for that long, default 60 s), `auth` (401/403 from Brave/Mojeek), `quota_exhausted` (local cap, or 402/quota answers), `bad_request` (400, SearXNG JSON disabled, malformed JSON), `upstream` (5xx, malformed answer), `network` (connection failure), `disabled` (switched off), `unsupported`. One retry, with 100 to 300 ms of jitter, for `network` and `upstream` only. Never for `auth`, `quota_exhausted`, `rate_limited`, `bad_request`.
- Result cache: only for `ttl`/`unrestricted` providers with `ttlSeconds` > 0 (Mojeek 3600 at most). A repeat of the same query and page within the TTL is answered from the cache without a request or a count (`cached: true` on the event); after the TTL it is fetched again. Rows can only hold normalised results (URL, title, snippet). A database trigger refuses any cache row for a `none` provider and any row that outlives its TTL.
- **Brave is transient only.** No Brave title, snippet or URL is stored in any table: no cache rows (trigger), no history, no activity log, no candidate rows. Saving a Brave result archives the page itself and copies nothing from Brave.

**Saved search as a source (O-11).** `POST /api/search/saved/{id}/source` (session, CSRF), body `{ onResult?: "candidates" | "downloads", maxResults?: 1..50, priority?: Priority, schedule?: ScheduleInput of section 8, enabled?: boolean }` creates a `saved_search` source for that saved search (`saved_searches.source_id`; 409 when it already has one) and returns the `Source` of section 7. From then on every saved-search payload (`GET /api/search/saved`, `GET`, `POST` and `PATCH /api/search/saved/{id}`) carries `sourceId`: the public id of that source, or `null` when the saved search is not a source (or the source was deleted). The web app uses it to offer "Run the search now" after a reload. Running the source (`POST /api/sources/{id}/run`, or its schedule) runs the saved search online with the enabled providers and: `downloads` queues a capture of each new result URL (requested by `search`); `candidates` records each new URL as a discovery candidate. A scheduled or manual run needs online search to be on and the server online: otherwise the run is refused (409 `conflict` or `offline` for a manual run; `lastStatus` becomes `failed` for a scheduled one). URLs already archived or already seen by this source are skipped. For a provider whose storage policy is `none` (Brave) candidates are **not stored**, in either mode (`downloads` then also waits for approval and the run reports a warning): they are held in memory until the next run, approval, dismissal or 24 hours, and only the URLs the Human approves are written, with no title and no snippet. A candidate from a time-limited provider (Mojeek) has no title and expires after the provider's cache time; one from SearXNG keeps the title. Candidates are created with provenance `saved_search` and never carry a snippet.
- `GET /api/search/saved/{id}/candidates` returns `{ items: { id: string; url: string; title: string | null; state: "new" | "approved" | "queued" | "archived" | "dismissed"; transient: boolean; seenAt: Iso }[] }`; `transient` items have `id` = `tmp_...` and `title: null`.
- `POST /api/search/saved/{id}/candidates/approve`, body `{ ids: string[], priority? }` queues a capture for each and answers 202 `{ queued: number, downloadIds: string[] }`. `POST .../candidates/dismiss` with `{ ids }` marks them dismissed (transient ones are forgotten).

**Settings keys used by combined search.** `privacy.onlineSearch.enabled` / `.acknowledgedAt` (master switch and acknowledgement; PATCH `/api/settings` with `{ privacy: { onlineSearch: { enabled: true, acknowledged: true } } }` the first time), `privacy.searchHistory.enabled` (history also records `online_providers_json` ids only), `offline.forced` (work offline), `search.rrfK` (60), `search.rrfLocalWeight` (1.5), `search.rrfProviderWeight` (1.0, the default `weight` given to new providers), `search.rrfZimWeight` (1.0), `search.rrfSecondaryProviderWeight` (0.7), `search.onlineTopN` (30, 5 to 100), `search.onlineDeadlineMs` (10000, 1000 to 60000), `search.zimSearchBudgetMs` (unchanged).

**Privacy guarantees (tested).** With online search off, no enabled provider, forced offline, or connectivity offline, no socket is opened to any provider. No telemetry. Remote favicons are never fetched. The search log (`activity_log`) never contains result URLs, titles or snippets; provider errors are logged by provider id and code. Provider credentials are AES-256-GCM encrypted at rest and never returned.


### 6.3 Knowledge packages in search (Phase 8, as built, task Z-05)

`POST /api/search` also asks the enabled knowledge packages (ZIM files, section 15) when `scope` is `all`, `offline` or `zim`, the query has words in it, and `page` is 1 and `zim` is not `"off"`. The local index and the packages are queried at the same time; the package half never delays the rest by more than its budget.

- **Per package.** Each package is queried in its own reader with a time budget (`search.zimSearchBudgetMs`, default 800 ms, env `NCB_ZIM_SEARCH_BUDGET_MS`). A package with a full-text index is searched with it (`mode: "fulltext"`); one without falls back to title suggestions (`mode: "titles"`, with a message saying so). Only the bare words and quoted phrases of the query are sent; operators such as `site:` or `-word` do not apply. A package that is slow, stuck or broken is reported (`state: "timeout"` or `"error"`) and the others answer as normal; a package that runs out of time part way reports what it found (`state: "partial"`).
- **Which packages.** Only those with `enabledForSearch`, not `missing` or `importing`. `filters.languages` keeps those whose language matches (a two-letter code matches the three-letter code a ZIM states: `en` matches `eng`). `zimIds` restricts to named packages. At most `search.zimMaxPackagesPerSearch` (5) are asked, higher priority first, then oldest; the rest are listed in `zim.skipped` with the reason `cap`, `language`, `disabled` or `unavailable`. Each package contributes its top `search.zimHitsPerPackage` (20).
- **Fusion by rank.** Each package gives a list in its own order. Xapian scores are normalised per query (the best hit is always 100) and cannot be compared between packages or with the local index, so scores are never used: the lists go through the weighted reciprocal rank fusion of 6.2 (`k = search.rrfK`, local list 1.5, each package list `search.rrfZimWeight` = 1.0). In `unified` mode the fused order is `results`: all local results of the page, with at most `ceil(pageSize / 2)` (at least 3) package hits among them. `fusedRank`, `fusedScore` and `attribution` (`kind: "zim"`, the package's rank) are set. A later provider fusion (6.2) includes the package lists. Package hits have no canonical web address, so they are not de-duplicated against online results. **Archived copies of the same article (task Z-06):** a hit of a Wikipedia package whose article is also archived (a saved page at `https://<lang>.wikipedia.org/wiki/<Title>`, same language) is marked `archivedAs: "<pageId>"` in `zim.groups[].hits[]`, and in a mixed list (`scope` other than `zim`) it is left out of the fusion and of `results`, so the archived copy stands for it. The package-only view (`scope: "zim"`) keeps every hit. The check is one indexed lookup per hit of a Wikipedia package and does nothing when there is none.
- **Modes.** `zim: "unified"` (default) is above. `"federated"` leaves `results` exactly as the local index returned them and reports every package apart in `zim.groups`. `"off"` skips packages (no `zim` block, `tookMs.zim: 0`). `scope: "zim"` searches the packages only: `results` is the fusion of the package lists (up to `pageSize`), `total` is its length, no local search runs (`tookMs.local: 0`) and no provider is called.
- **Result shape.** `origin: "zim"`, `availability: "zim"`, `zimId`, `zimPath`, `url` and `actions.open` are `zim://{zimId}/{path}` (open it with `POST /api/archive/frame-grants { zimId, zimPath }`), `domain` is the package title, `sourceName` the package title, `faviconUrl` its icon route, `language` the package language. `title` is plain text; `titleHtml` is escaped with the query's words in `<b>`; `snippet` is HTML in which **only `<b>` and `</b>`** survive (no attributes; every other tag is dropped, `<script>` and `<style>` content with it; stray `<`, `>` and `&` are escaped; unbalanced `<b>` is balanced; at most 400 characters of text). Package hits use `<b>` where archive hits use `<mark>`: the markup is whatever the package produced.

```ts
interface ZimSearchBlock {                 // `zim` on the response; absent with zim: "off" or when the search did not ask packages
  state: "ok" | "none";                    // none: no package could be asked (none enabled, language filter, only operators)
  mode: "unified" | "federated";
  scope: "mixed" | "zim";
  budgetMs: number; tookMs: number;
  shown: number;                           // package hits among `results`
  groups: {
    zimId: string; title: string; language: string | null; flavour: string | null;
    mode: "fulltext" | "titles";
    state: "ok" | "partial" | "timeout" | "error";
    message?: string;                      // plain words: why the list is short, or that only titles were searched
    estimatedMatches: number; tookMs: number;
    hits: SearchResult[];                  // the package's own order; fusedRank and fusedScore set in unified mode
  }[];
  skipped: { zimId: string; title: string; reason: "cap" | "language" | "disabled" | "unavailable" }[];
}
```

The settings are in the `search` group: `zimSearchBudgetMs` (100 to 10000), `zimMaxPackagesPerSearch` (1 to 20), `zimHitsPerPackage` (1 to 50), `rrfZimWeight` (0 to 10). `GET /api/search/{searchId}` returns the stored response with the `zim` block.

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

- **Source types.** `single_page`, `website`, `section`, `linked_collection`, `sitemap`, `feed` and `imported_documents` work. `saved_search` (the source type, scheduled searches) is refused at create with a 400 field error on `type` that names the phase that brings it. `knowledge_package` is created with `zimId` (Phase 8, section 15.1) and not through the web-source rules. `adapter: "http"` is accepted (and `"import"` for `imported_documents`). For the web types `startUrl` is required, must be `http(s)` and may not carry a username or password. An `imported_documents` source takes no `startUrl` (400 if one is sent); it holds uploaded files (`POST /api/archive/import?sourceId=`), and `POST /api/sources/{id}/run` on it answers 409 (nothing to run).
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
- **Collections.** `kind: "saved_search"` needs `savedSearchId` (a `ss_` id) and fills from that search, see 6.1; `kind: "auto"` needs `rule: { match: "all"|"any", conditions: ({ field: "domain"|"source"|"title", value })[] }`. `icon` must be one of `GET /api/collections/icons` (lucide names). `parentId` is a public id or null; a cycle or more than 8 levels is a 400 with a field message (and the database refuses it too). `priorityFloor` is `"P1".."P4"` or null. `GET /api/collections` returns `{ items }` (a nested `children` tree with `?tree=true`) with `itemCount` per collection. A Favourites collection (`kind: "favourites"`) exists from the first start; it cannot be deleted. `DELETE` returns `{ reparented, membershipsRemoved }`: children move up to the parent, pages stay in the archive. `GET /items` takes `limit`, `cursor`, `recursive` and returns `{ items: { pageId, url, host, title, availability, effectivePriority, addedBy, addedAt }[], nextCursor?, total }`. `POST /items` returns `{ added, alreadyMember, removed, notFound }`; it is refused with 409 on an auto collection (change the rule) and with 501 for ZIM items until ZIM support exists. `POST /rebuild` returns `{ added, removed }` and is 409 for a manual collection. Pages join collections by hand (`added_by: user`), through a rule (`rule`) or because the source feeds the collection (`source`). `priority_floor` raises the cached `pages.effective_priority` for members at once; the full reference rules are in data-model.md 5.1.

**Wikipedia sources (Phase 8, task Z-08).** `adapter: "wikipedia"` with `type: "linked_collection"` (or `website`) is a topic crawl of Wikipedia articles. `startUrl` must be an article address (any language host, mobile host, `/wiki/` or `index.php?title=`); the language is taken from it and replaces `config.wikipedia.language`. `config.wikipedia` is `{ language, images (default true), linkedExpansionDepth (0 to 3), preferZim (default true), skipDisambiguation, skipLists, skipYears (all default true) }`; `linkedExpansionDepth` and `config.depth` are one number (default 1). Hard limits whatever the profile: depth at most 3 and `maxPages` at most 2,000 (default 200), each a 400 field error that says to use a Wikipedia package for more. A Wikipedia source needs `NCB_CONTACT` at create and at run (400 `bad_request` with a plain message otherwise; nothing is queued and no request is made). `POST /api/sources/preview` refuses it (409) and points at `POST /api/wikipedia/preview`. Runs go through the ordinary crawl engine as an `explore` download with the Wikipedia adapter (15.2), so pause, resume, cancel, priority, schedules, windows, retention and storage accounting all work as for any source. Every saved article is a normal page with `origin: "wikipedia"`, linked to the source in `page_sources`.

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
  wait?: { reason: "throttled"; message: string };   // queued or running but held back: "throttled" is a background P4 download waiting above the soft storage threshold (not a pause: no state change, no attempt used, it retries every 30 s)
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
  connectivity: "online" | "offline" | "unknown"; storageThrottle: { downloads: number } /* how many downloads wait with wait.reason "throttled" */; nextScheduled?: { scheduleId: string; sourceId: string; sourceName: string; at: Iso } }
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

## 9. Discovery (Phase 7, as built)

Discovery suggests pages worth saving next (**candidates**), explains why, and, only if the Human allows it, downloads some of them inside hard limits. **Everything is off by default**: with the defaults nothing collects, scores new candidates, downloads or auto-caches, and no discovery code uses the network except the downloads the Human has allowed.

All routes need a signed-in session; writes also need the CSRF header. Errors use the common envelope (`bad_request` with `details.fields`, `not_found`, `conflict`). Candidate IDs are `cand_...`; source, collection and download IDs are the public IDs used elsewhere. Priorities travel as `"P1"` to `"P4"` (the number 1 to 4 is accepted). Sizes are bytes; instants are ISO 8601 strings; a "day" is a UTC calendar day (`YYYY-MM-DD`) and the daily budgets reset at 00:00 UTC.

Terms. A **candidate** is an address that is not saved yet. **Provenance** is the list of reasons it exists (a link on a saved page, a bookmark, a visit, a "not saved yet" page that was shown, a saved-search result, a search result). **Depth** is the number of discovery hops from a page the Human saved (a link on such a page is depth 1; a link on a page that discovery downloaded at depth `d` is `d + 1`). A **request** in the budgets is one page capture: the page plus at most 40 sub-resources. **Lane**: `active` candidates (links, visits, bookmarks, missing links, saved searches) are downloaded by the active runner; `background` candidates (search results and nothing else) and auto-cached pages use the background budget and are filed in the Browsing cache source at P4.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/discovery` | Overview: switches, candidate counts by state, kill-switch state, budget used and remaining today and used this month, runner state |
| GET | `/api/discovery/candidates` | List, filter and sort (below) |
| GET | `/api/discovery/candidates/{id}` | Detail: the candidate, score components, a plain-language "why suggested" list and provenance |
| GET | `/api/discovery/candidates/{id}/explain` | The explanation alone (the explain API) |
| POST | `/api/discovery/candidates/{id}/approve` | Approve (`{ sourceId?, collectionId? }`): the runner may download it, within the limits |
| POST | `/api/discovery/candidates/{id}/dismiss` | Dismiss: it is never suggested again |
| POST | `/api/discovery/candidates/{id}/queue` | Download now (`{ priority?, sourceId?, collectionId? }`), 202. Not counted in the daily budgets |
| POST | `/api/discovery/candidates/bulk` | `{ ids (1 to 200), action: "approve" \| "dismiss" \| "queue", priority?, sourceId?, collectionId? }` |
| GET, PUT | `/api/discovery/settings` | Every setting, the limits that are really in force, and the profile maximums |
| GET | `/api/discovery/budget` | Budget meters |
| GET | `/api/discovery/ledger` | What each discovery download set aside and used |
| GET | `/api/discovery/runner` | Runner status and the last pass |
| POST | `/api/discovery/run` | Do one pass now (it obeys every limit; useful to test settings) |
| POST | `/api/discovery/pause`, `/resume` | The kill switch |

### Candidates

```ts
type CandidateState = "new" | "approved" | "queued" | "archived" | "dismissed" | "expired";
type ProvenanceKind = "link" | "search_result" | "saved_search" | "visit" | "bookmark" | "missing_link" | "manual";

interface Candidate {
  id: string; url: string; host: string; title?: string;          // title only when a source that allows storing it supplied one
  state: CandidateState; score: number; depth: number;
  lane: "active" | "background";
  estimatedBytes?: number; attempts: number;                       // a candidate whose downloads failed twice expires
  provenanceKinds: ProvenanceKind[]; provenanceCount: number;
  suggestedSource?: { id: string; name: string }; suggestedCollectionId?: string;
  firstSeenAt: Iso; lastSeenAt: Iso; expiresAt?: Iso; decidedBy?: "user" | "runner"; decidedAt?: Iso;
  downloadId?: string;                                             // the download started for it
}
interface CandidateDetail extends Candidate {
  scoreComponents: ScoreComponent[]; scoreStored: boolean; why: string[]; provenance: Provenance[];
}
interface ScoreComponent { name: WeightName; label: string; raw: number; weight: number; contribution: number; explanation: string }
interface Provenance { kind: ProvenanceKind; detail?: string; weight?: number; pageId?: string; pageTitle?: string; pageUrl?: string; sourceId?: string; sourceName?: string; at: Iso }
```

`GET /api/discovery/candidates` query (all optional): `state` (comma list), `sourceId` (candidates suggested for, or linked from pages of, that source), `minScore`, `maxScore`, `provenance` (comma list of kinds), `q` (substring of the address or title), `host`, `sort` (`score` best first, default; `-score`; `recent` last seen first; `oldest`; `cost` cheapest first; `depth` shallowest first), `limit` (1 to 200, default 50), `cursor`, `includeHidden=true`. Response `{ items: Candidate[], total, counts: Record<CandidateState, number>, nextCursor? }`; `counts` ignores the `state` filter so the UI can show tabs. **Visibility.** A candidate is listed only while at least one of its reasons comes from a collector that is currently switched on (the master switch included): switching a collector off hides what it brought without deleting it, and switching it back on shows it again. `includeHidden=true` lists everything.

**Decisions.** `approve` moves `new`, `expired` or `dismissed` to `approved` and records `sourceId` / `collectionId` as the suggested source and collection (the page joins that collection once it is saved). Approving a `queued` or `archived` candidate changes nothing. `dismiss` answers 409 for a `queued` or `archived` candidate. `queue` saves the page now through the normal capture path (admission control, robots and per-host politeness still apply; offline, the capture is held until the connection returns) and answers 202 with the candidate plus `held`. `bulk` answers `{ results: { id, ok, error? }[], done, failed }` and never stops at the first failure.

### Scoring and "why suggested"

The score is a transparent weighted sum, with no AI: `score = sum over the eight components of raw x weight`. `raw` is a number from 0 to 1 worked out from facts in the database; `weight` is the setting (negative for cost and storage); `contribution = raw x weight`, rounded to six decimals, and `score` is the sum of the rounded contributions, so the components shown always add up to the score.

| Component | `raw` (0 to 1) |
|---|---|
| `inboundArchivedLinks` | `n / (n + 3)` for `n` distinct saved pages that link to it |
| `collectionRelevance` | share of those linking pages that are in a collection |
| `searchFrequency` | `d / (d + 3)` for `d` days it appeared in search results; 0 unless `searchesInfluenceDiscovery` and `prioritiseFrequentTopics` are both on |
| `bookmarks` | `b / (b + 1)` for bookmarks of it or of a page that links to it |
| `recentActivity` | halves every 7 days since it was last seen |
| `sourcePriority` | best source behind it: P1 = 1, P2 = 0.75, P3 = 0.5, P4 = 0.25, none = 0 |
| `estimatedCost` | estimated bytes / 5 MiB, at most 1 |
| `storageHeadroom` | how full the emptiest online volume is (0 empty, 1 full) |

`GET /api/discovery/candidates/{id}/explain` answers `{ id, url, score, scoreStored, components: ScoreComponent[], summary: string[], provenance: Provenance[], weights }`. It is always worked out from the current settings; `scoreStored` says whether the same components are also stored on the candidate row (`false` for a candidate from a search provider whose storage policy allows no components to be kept: those are recomputed on demand). `summary` has one plain sentence per contributing component, largest first. Provenance never carries text from a search provider; a `link` reason names the page and the region of the page the link was in.

### Settings

`GET /api/discovery/settings` answers `{ settings: DiscoverySettings, effective: EffectiveLimits, profile, profileMaximums }`. `PUT` takes any part of `DiscoverySettings` (nested objects merge), validates the whole result and answers the same shape. The same group is `discovery` in `/api/settings`. Errors name the field (`active.maxDepth`, `ceilings.maxBytesPerDay`, ...).

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. While off nothing collects, scores new candidates, runs or auto-caches |
| `passive.fromLinks` | `false` | Links on saved pages become candidates (pipeline stage 14; at most `pool.maxLinksPerPage` per page; navigation and footer links, `nofollow` links and addresses that look like logins, resets or tokens are skipped) |
| `passive.fromVisits` | `false` | Pages opened live that are not saved become candidates. Needs `privacy.history.enabled`; with history off no visit candidate is ever created |
| `passive.fromBookmarks` | `false` | A bookmark of an address with no saved copy becomes a candidate |
| `passive.fromMissingLinks` | `false` | An address for which the "not saved yet" page was shown becomes a candidate |
| `passive.fromSavedSearches` | `false` | Results of saved-search sources show in the discovery list and may be downloaded by the runner |
| `searchDriven.searchesInfluenceDiscovery` | `false` | Online results that are not saved become candidates (providers that allow no storage, such as Brave, are skipped) and search frequency counts towards the score. No search text is stored: only the address and a count of days |
| `searchDriven.autoCacheOpenedOnlinePages` | `false` | A page the Human opens live is kept in the Browsing cache (P4). Only that page: nothing it links to |
| `searchDriven.prioritiseFrequentTopics` | `false` | Search frequency counts in the score |
| `searchDriven.requireApproval` | `true` | Search-driven candidates are downloaded only after the Human approves them |
| `searchDriven.backgroundBudget.maxRequestsPerDay` | `50` | Requests a day shared by search-driven downloads and the auto-cache |
| `searchDriven.backgroundBudget.maxBytesPerDay` | `104857600` (100 MiB) | Bytes a day, same budget |
| `active.mode` | `"off"` | `off`: the runner downloads nothing. `approval`: only candidates the Human approved. `automatic`: also new candidates that are in scope and score at least `minScore`. Switching to `automatic` needs `"acknowledged": true` in the request |
| `active.allowedSourceIds` | `[]` | Sources whose pages' links automatic mode may follow (at most 50). Empty means none. Approval mode ignores it: approving is the decision |
| `active.maxCandidatesPerRun` | `10` | Downloads started per pass |
| `active.maxDepth` | `1` | Deepest candidate that is created or downloaded (1 or more) |
| `active.maxQueued` | `20` | Discovery downloads queued or running at once |
| `active.maxRequestsPerDay` | `50` | Requests a day for the active runner |
| `active.maxBytesPerDay` | `104857600` | Bytes a day for the active runner |
| `active.perSiteDailyCap` | `10` | Discovery downloads per site a day, all lanes together |
| `active.respectSchedule` | `true` | Discovery downloads only while the global download windows are open |
| `active.onlyWhenOnline` | `true` | Fixed. Nothing is downloaded while the server is working offline or cannot reach the internet |
| `active.minScore` | `10` | Automatic (and unapproved search-driven) downloads need at least this score |
| `active.automaticAcknowledgedAt` | `null` | Set by the server when `automatic` was confirmed |
| `pool.maxCandidates` | `500` | New and approved candidates kept at once; a full pool refuses newcomers |
| `pool.expireAfterDays` | `30` | An unused candidate expires after this |
| `pool.maxLinksPerPage` | `25` | Most links one saved page may add |
| `ceilings.maxDepth` | `3` | The global ceiling for depth |
| `ceilings.maxQueued` | `100` | The global ceiling for queue length (also bounds `maxCandidatesPerRun`) |
| `ceilings.maxRequestsPerDay` | `200` | The global ceiling for requests a day (also bounds the per-site cap and the background budget) |
| `ceilings.maxBytesPerDay` | `536870912` (512 MiB) | The global ceiling for bytes a day |
| `weights.inboundArchivedLinks` | `30` | Each weight is -100 to 100 |
| `weights.collectionRelevance` | `20` | |
| `weights.searchFrequency` | `10` | |
| `weights.bookmarks` | `25` | |
| `weights.recentActivity` | `10` | |
| `weights.sourcePriority` | `10` | |
| `weights.estimatedCost` | `-10` | Negative: a bigger download scores lower |
| `weights.storageHeadroom` | `-15` | Negative: the fuller the storage, the lower the score |

**The global ceiling.** `ceilings.*` cannot be set above the resource profile's maximum, which is the crawl engine's hard ceiling (`HARD_CEILINGS` in `packages/crawl/src/profiles.ts`): depth is `maxDepth` (pi-lite 10, standard 20), queue length and the candidate pool are `maxFrontier` (50,000 / 200,000), requests a day are `maxPages` (10,000 / 100,000) and bytes a day are `maxBytes` (2 GiB / 20 GiB). Everything under the ceiling (`active.*`, `searchDriven.backgroundBudget.*`) cannot exceed the ceiling. A request that breaks either rule answers 400 and nothing is saved. `effective` is what is really in force, the smallest of the setting, the ceiling and the profile maximum, so a later change to `resources.profile` lowers the limits at once: `{ maxDepth, maxQueued, maxCandidatesPerRun, maxCandidates, active: { maxRequestsPerDay, maxBytesPerDay }, background: { maxRequestsPerDay, maxBytesPerDay }, perSiteDailyCap }`.

### Budget meters and ledger

`GET /api/discovery/budget`:

```ts
{ day: string; resetsAt: Iso;
  active: Lane; background: Lane;                       // background = search-driven downloads + auto-cache
  month: { requests: number; bytes: number };            // used this calendar month, no limit
  perSite: { cap: number; top: { host: string; requests: number }[] };
  queue: { inFlight: number; limit: number }; pool: { candidates: number; limit: number } }
type Lane = { requests: { used; limit; remaining }; bytes: { used; limit; remaining } }
```

`bytes.used` is the bytes finished downloads really took plus the allotments of running ones. Before a download starts the runner sets aside a byte **allotment** (about twice the estimate, between 512 KiB and 20 MiB, never more than what is left today, in the volume, or in the source's storage budget) and hands the same number to the capture as its size cap, so a discovery download cannot take more than it was given. When the download ends the entry is settled with the real bytes. A download cancelled before it started gives its request back.

`GET /api/discovery/ledger` (`day`, `lane`, `limit` 1 to 200 default 50, `cursor`) answers `{ items, nextCursor? }`, newest first, each `{ id, at, day, lane: "active" | "background" | "auto_cache", host, requests, reservedBytes, bytes?, state: "reserved" | "settled", outcome?: "archived" | "unchanged" | "failed" | "cancelled", candidateId?, downloadId?, settledAt? }`. Entries older than 90 days are removed.

### Kill switch and runner status

`POST /api/discovery/pause` answers `{ paused: true, cancelled }`: no discovery download starts after it returns, discovery downloads still waiting are cancelled, and one that is already running finishes (so discovery stops within one job). It covers both lanes and the auto-cache and survives a restart. `POST /api/discovery/resume` answers `{ paused: false }`.

`GET /api/discovery/runner` answers:

```ts
{ state: "off" | "idle" | "blocked" | "paused"; mode: "off" | "approval" | "automatic";
  blockedBy: ("disabled" | "kill_switch" | "offline" | "window_closed" | "resources")[];
  killSwitch: { paused: boolean; since?: Iso; by?: string };
  inFlight: number; timerSeconds: number;
  gates: { enabled; online; windowOpen; resourcesOk; storageRoomBytes };
  lastPass?: { at: Iso; trigger: "timer" | "manual";
               active: PassLane; background: PassLane } }
type PassLane = { eligible: number; started: number; skipped: Partial<Record<"depth" | "run_cap" | "queue_full" | "requests" | "bytes" | "site_cap" | "storage" | "source_budget" | "archived" | "in_progress", number>>;
                  blockedBy: ("disabled" | "mode_off" | "kill_switch" | "offline" | "window_closed" | "resources" | "storage_full" | "search_driven_off")[] }
```

`POST /api/discovery/run` does one pass now and answers the pass report (`{ at, trigger, active: PassLane, background: PassLane }`). A pass runs every `timerSeconds` seconds (30 by default), and only while no gate blocks it.

### Rules the server keeps

- **Limits, each applied on its own.** A pass starts nothing when any gate is shut (switched off, `mode` off, kill switch, offline or unreachable, schedule window closed, disk guard paused). Otherwise it picks eligible candidates best first and starts at most: `maxCandidatesPerRun`; as many as keep queued plus running within `maxQueued`; the requests left today; as many bytes as are left today (allotments); `perSiteDailyCap` per host a day; those whose depth is within `maxDepth`; those that fit the free room in the best volume and the source's storage budget. The arithmetic is a pure function (`apps/server/src/discovery/planner.ts`) with property tests.
- **Approval mode downloads nothing without approval. Offline mode downloads nothing**, and neither does an expired or dismissed candidate. A candidate that is already saved, being downloaded, or excluded (`url_exclusions`) is never downloaded again.
- **Downloads are ordinary captures** (priority P4, `requestedBy: "discovery"`): storage admission control, robots.txt, per-host politeness and the download windows all apply. Remote favicons are never fetched.
- **Privacy.** Passive collectors use no network. With `privacy.history.enabled` off no visit candidate is created. No search text is stored by discovery in any case: candidates keep an address and counts, never a query. A candidate from a search provider whose storage policy is `none` (Brave) is stored only after the Human approves it, with no title and no components, and is forgotten if dismissed (the rules of section 6.2 stand).
- **Auto-cache** keeps only an address the Human opened live (`POST /api/browser/resolve` answered `live`), inside the background budget, never an address that looks like a login or carries a token, and never anything that page links to.
- **Collectors.** Pipeline stage 14 (`candidates`) is recorded as `skipped` while link collection is off.

## 10. Storage (Phase 6, as built)

All routes need a signed-in session unless marked `G` (a trusted-LAN guest may read). Writes also need the CSRF header. Errors use the common envelope (`{ error, message, details? }`); the codes used here are `bad_request` (400, with `details.fields`), `not_found` (404), `conflict` (409) and `not_implemented` (501). Priorities travel as `"P1"` to `"P4"`; a request may also send the number 1 to 4. Sizes are bytes. Instants are ISO 8601 strings.

Terms. **Protected (P1)** content is never removed automatically, whatever any flag says. **Eviction** is the automatic removal of saved copies to make room; **deletion** is the Human removing something on purpose (`DELETE /api/archive/pages/{id}`), which is recorded separately. **Exclusive bytes** are bytes that would actually be freed: a file shared with content that stays is not counted. A **surplus** copy is one that no source's retention rule, collection floor, pin or bookmark keeps any more; it counts as Opportunistic (P4) and goes first.

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/storage` | Overview: volumes, totals, usage by priority and by source, forecast, policy, eviction and maintenance state | S/G |
| GET, POST | `/api/storage/volumes` | List (`{ items: Volume[] }`) / register a volume | S , S+C |
| GET, PATCH, DELETE | `/api/storage/volumes/{id}` | Detail with reservations and blob count / change / remove (refused while it holds blobs) | S , S+C |
| POST | `/api/storage/volumes/{id}/verify` | Marker, write test and a scan of blob rows against files (report only) | S+C |
| POST | `/api/storage/volumes/{id}/migrate` | **501 `not_implemented`.** Volume-to-volume migration is post-v1 (design note in data-model.md 5.6) | S+C |
| GET | `/api/storage/usage` | `?by=priority\|source\|kind\|volume`, optional `&volumeId=` | S/G |
| GET | `/api/storage/forecast` | Estimate, optional `?sourceId=` and `&horizonDays=` (7 to 365) | S/G |
| GET, PUT | `/api/storage/policy` | Global policy, including the P2 permit | S , S+C |
| POST | `/api/storage/eviction/plan` | Dry run: nothing changes; returns a stored plan with reasons | S+C |
| POST | `/api/storage/eviction/run` | Execute a stored plan (`{ planId }`) or run a maintenance pass (`{ maintenance: true }`) | S+C |
| GET | `/api/storage/eviction/runs` | History of executor runs (`?limit=`, default 20) | S |
| GET | `/api/storage/pages/{pageId}` | "Why was this kept or evicted?" for a page | S |
| PUT, DELETE | `/api/storage/pages/{pageId}/pin` | Keep a page at a priority / stop keeping it | S+C |
| GET | `/api/storage/audit` | The record of every eviction and explicit deletion | S |
| POST | `/api/storage/maintenance/verify` | Verify-and-repair; same as `/api/system/maintenance/verify` | S+C |

```ts
type Priority = "P1" | "P2" | "P3" | "P4";   // Protected, Important, Standard, Opportunistic

interface Volume {
  id: string; name: string; rootPath: string;
  state: "online" | "offline" | "readonly" | "draining" | "disabled"; isDefault: boolean;
  capacityBytes: number;            // the drive
  quotaBytes?: number;              // optional limit below the drive; percentages use it when set
  usedBytes: number;                // stored bytes of the blobs on this volume
  availableBytes: number;           // free above the reserve, within the quota (reservations are not subtracted here)
  reservedBytes: number;            // promised to running downloads
  reserveFreeBytes: number;         // the hard floor of free space
  thresholds: { softPct: number; evictStartPct: number; evictTargetPct: number };   // defaults 85, 90, 80
  usageByPriority: Record<Priority, number>;   // bytes by the blob's effective priority; unreferenced bytes count under P4
}
// GET /api/storage/volumes/{id} adds:
//   reservations: { downloadJobId: string; reservedBytes: number; writtenBytes: number; expiresAt: Iso }[]; blobCount: number
```

The threshold percentages are shares of the room NoConBrain has on the volume: its quota when one is set, otherwise its own stored bytes plus the free space (other data on the same disk does not make the volume "full"; the free-space reserve guards that). `state: "offline"` means the volume's marker file is missing or does not match (a drive was unplugged). Its rows are kept, its files cannot be read (the archive answers "unavailable" for those copies), nothing on it is evicted, and it comes back by itself when the marker returns. A new file goes to the source's preferred volume (`Source.preferredVolumeId`) when that has room, otherwise to the writable volume with the most room.

### 10.1 Overview

`GET /api/storage` returns:

```ts
interface StorageOverview {
  volumes: Volume[];
  totals: { capacityBytes: number; usedBytes: number; availableBytes: number; reservedBytes: number; unreferencedBytes: number };
  usageByPriority: UsageRow[];      // keys "P1".."P4" and "unreferenced"
  usageBySource: UsageRow[];        // up to 20
  forecast: StorageForecast;
  policy: StoragePolicy;
  eviction: {
    autoEviction: boolean; throttling: boolean;           // throttling: P4 downloads are slowed now
    overThreshold: string[];                              // ids of volumes above their eviction-start threshold
    lastRun?: { id: string; trigger: EvictionTrigger; state: "running" | "done" | "failed" | "interrupted"; versionsEvicted: number; bytesFreed: number; startedAt: Iso };
  };
  maintenance: { lastRun?: { id: string; kind: "verify" | "repair"; dryRun: boolean; startedAt: Iso } };
  computedAt: Iso;
}
```

### 10.2 Usage

`GET /api/storage/usage?by=priority|source|kind|volume[&volumeId=vol_...]`

```ts
interface UsageReport {
  by: "priority" | "source" | "kind" | "volume"; volumeId?: string;
  totalBytes: number;          // every blob counted once: compare this with the disk
  blobCount: number;
  unreferencedBytes: number;   // part of totalBytes: files nothing uses, waiting for garbage collection
  items: UsageRow[]; computedAt: Iso;
}
interface UsageRow {
  key: string;                 // "P1".."P4" and "unreferenced"; a source id (or "unassigned"); a blob kind; a volume id
  label?: string;              // source or volume name
  exclusiveBytes: number;      // used only by this group: removing the group frees them
  sharedBytes: number;         // also used by another group (counted under each group that uses them)
  blobCount: number;
}
```

For `by=priority` a blob has one class, its effective priority (the lowest number among the copies that use it); `sharedBytes` there means the blob is used by content of more than one class. For `by=source` a blob used by pages of two sources is shared under both. `by=kind` and `by=volume` have no sharing. The per-volume, per-dimension totals are also kept in `storage_usage_cache` (refreshed by the storage pass).

### 10.3 Policy and the P2 permit

`GET /api/storage/policy` and `PUT /api/storage/policy` (any subset of the fields):

```ts
interface StoragePolicy {
  permitImportantEviction: boolean;    // default false. Lets automatic eviction reclaim Important (P2) content, last.
  permitAcknowledgedAt: Iso | null;    // when the Human confirmed the warning; cleared when the permit is turned off
  throttleOpportunistic: boolean;      // default true. Slow P4 background downloads above a volume's soft threshold.
  pruneSurplusVersions: boolean;       // default true. The maintenance pass removes copies nothing keeps any more.
  orphanGraceSeconds: number;          // default 86400 (0 to 31536000). How long an unused file is kept before deletion.
  autoEviction: boolean;               // default true. The storage pass evicts when a volume passes its eviction-start threshold.
  maxEvictionBatchBytes: number | null;// default null. Most bytes one tidy-up (prune) run removes; does not limit space-pressure runs.
  forecastHorizonDays: number;         // default 30 (7 to 365)
  scrubMegabytesPerRun: number;        // default 64 (0 to 4096; 0 turns the checksum scrub off)
  protectedNeverEvicted: true;         // always true. A reminder for the UI: no setting changes it.
  warnings: { permitImportantEviction: string };   // the text to show before the permit is turned on
  volumeThresholds: { volumeId: string; name: string; softPct: number; evictStartPct: number; evictTargetPct: number }[];
}
```

PUT body: the eight writable fields above (`permitImportantEviction` to `scrubMegabytesPerRun`; not `permitAcknowledgedAt`, `protectedNeverEvicted`, `warnings` or `volumeThresholds`), plus `acknowledged?: boolean`. **Turning `permitImportantEviction` on needs `acknowledged: true` in the same request**; without it the answer is 400 with `details.fields[0].path = "storage.acknowledged"`. The permit does not make Protected (P1) content evictable and does not touch pages that a source or pin forbids evicting. Thresholds belong to volumes: change them with `PATCH /api/storage/volumes/{id}` (`softPct <= evictStartPct`, `evictTargetPct < evictStartPct`). The same keys are the settings group `storage` (see 10.9).

### 10.4 Eviction: dry run, plan explanations, run

`POST /api/storage/eviction/plan` body (all optional): `{ bytesNeeded?: number; incomingPriority?: Priority; volumeId?: string; mode?: "pressure" | "prune" }`.

- `mode: "pressure"` (default) plans the removal of enough content to free `bytesNeeded` for an incoming download of `incomingPriority` (default `P1`, which lets every eligible class through). With no `bytesNeeded` it plans what the volume (default: the default volume) needs to fall to its eviction-target percentage.
- `mode: "prune"` plans only surplus copies and unused files (what the maintenance pass does).
- **A plan changes nothing.** It is kept for 30 minutes (`expiresAt`) so it can be run.

```ts
interface EvictionPlan {
  planId: string; createdAt: Iso; expiresAt: Iso;
  mode: "pressure" | "prune"; incomingPriority: Priority; bytesNeeded: number; volumeId?: string;
  reclaimableBytes: number;          // exclusive bytes the plan frees (shared files are counted once, or not at all if content stays)
  sufficient: boolean; insufficient: boolean;   // insufficient === !sufficient. An insufficient plan cannot be run: nothing would be removed.
  throttleOpportunistic: boolean;    // step 0: P4 downloads are being slowed (nothing is deleted for it)
  steps: { step: "throttle_p4" | "unreferenced_blobs" | "surplus_versions" | "p4" | "p3" | "p2"; versions: number; exclusiveBytes: number }[];
  itemsTotal: number;
  items: {                            // in the order they would go; the first 200
    versionId: string; pageId: string; pageUrl: string; versionNo: number;
    priority: Priority; surplus: boolean;      // surplus copies are listed as P4
    step: "surplus_versions" | "p4" | "p3" | "p2";
    reason: string;                   // a sentence for the Human
    exclusiveBytes: number; lastAccessedAt?: Iso;
  }[];
  unreferencedBlobs: { count: number; bytes: number };   // unused files past the grace period; removed first, no content is lost
  skipped: { versionId: string; pageId: string; pageUrl: string; reason: SkipReason }[];   // the first 200
  skippedCounts: Partial<Record<SkipReason, number>>;
  summary: string;
}
type SkipReason =
  | "p1"                        // Protected: never
  | "source_auto_eviction_off"  // a source (or pin) that references the page forbids automatic eviction; this vetoes the whole page
  | "p2_not_permitted"          // Important content and the permit is off
  | "priority_gate"             // an incoming download may only reclaim content less important than itself (P4 reclaims P4, P3 reclaims P3 and P4, P2 and P1 reclaim P3 and P4, and P2 when permitted, P1 only for P1)
  | "in_use"                    // a download is writing to the page, or the copy is not complete
  | "retained"                  // prune mode: the copy is still kept by something
  | "no_reclaim"                // all of its bytes are shared with content that stays
  | "not_on_volume";            // nothing it holds is on the volume being freed
```

Order of removal: unused files, then surplus copies (older first), then P4, then P3, then P2 only if permitted; within a class older copies before the current one, never-opened before opened, larger first. Execution stops when the need is covered.

`POST /api/storage/eviction/run`:
- `{ planId }` runs a stored plan. 404 when it has expired or was already run; 409 `conflict` with `details.kind = "plan_insufficient"` when the plan is insufficient (nothing is removed). **The executor re-derives every decision from the references at the moment it removes each copy**, so a plan that went stale removes less, never more: copies that became Protected, pinned, retained or busy are reported in `skipped`.
- `{ maintenance: true }` runs the storage pass's eviction: each volume above its eviction-start threshold is brought to its target, then surplus copies are pruned (if `pruneSurplusVersions`).

```ts
// planId run:
interface EvictionResult {
  runId: string; planned: number; evicted: number; bytesFreed: number; blobsDeleted: number;
  evictedVersionIds: string[];
  skipped: { versionId: string; reason: SkipReason | "changed" }[];     // "changed": no longer a live copy
}
// maintenance run: { runs: EvictionResult[]; notes: string[] }   // notes say, for example, that a volume is over its threshold but nothing eligible would free enough
```

`GET /api/storage/eviction/runs` returns `{ items: { id, trigger: "admission" | "threshold" | "prune" | "manual" | "recovery", state: "running" | "done" | "failed" | "interrupted", incomingPriority: Priority, bytesNeeded, versionsPlanned, versionsEvicted, versionsSkipped, bytesFreed, blobsDeleted, error?, startedAt: Iso, finishedAt?: Iso }[] }`. A run left `running` by a crash becomes `interrupted` at the next start, after recovery finishes its clean-up.

### 10.5 Why was this kept, why was this evicted

`GET /api/storage/pages/{pageId}`:

```ts
interface PageStorageExplanation {
  page: { id: string; url: string; availability: string; effectivePriority: Priority; cachedPriority: Priority | null };   // effective: from the references now; cached: the column the library shows
  pin: { priority: Priority; reason: string | null } | null;
  references: ReferenceSummary[];                 // of the current copy
  versions: (VersionExplanation & { versionNo: number; fetchedAt: Iso; evictedAt?: Iso; audit?: AuditRecord })[];   // newest first
  history: AuditRecord[];                         // every eviction and deletion recorded for the page (up to 100)
}
interface VersionExplanation {
  versionId: string; status: string; isLatest: boolean;
  priority: Priority; surplus: boolean;
  decision: "kept" | "evictable";                 // kept: automatic eviction cannot remove it now; evictable: it can be reclaimed when space is needed
  skipReason?: SkipReason;                        // why it is kept
  references: ReferenceSummary[];
  reasons: string[];                              // sentences, most important first. For an evicted copy: when and why it was removed.
}
interface ReferenceSummary { kind: "source" | "collection" | "pin" | "bookmark"; id: string; label?: string; priority: Priority; autoEvict: boolean; retains: boolean }
```

**As built:** `versions[].priority` and `references[].priority` in this response are the numbers 1 to 4, not `"P1"` to `"P4"` (the other priority fields here are codes). The web app reads both.

`PUT /api/storage/pages/{pageId}/pin` body `{ priority?: Priority (default "P1"), reason?: string (300) }` keeps the page (its current copy) at that priority; a P1 pin forbids automatic eviction of every copy of the page. `DELETE` removes the pin. Both answer with the explanation. Bookmarks (priority from `browser.bookmarkPriority` when made, default P2) and collection floors are references too and appear in `references`.

`GET /api/storage/audit?pageId=&kind=evicted|deleted&limit=&cursor=` returns `{ items: AuditRecord[]; nextCursor? }`, newest first. The audit trail is not subject to the activity-log retention window.

```ts
interface AuditRecord {
  id: number; kind: "evicted" | "deleted"; at: Iso;
  pageId: string | null;            // null when the page has since been deleted
  pageUrl: string; versionId: string | null; versionNo: number | null;
  priority: Priority | null;        // the class the copy was in when it went
  surplus: boolean; step: string | null; reason: string;
  trigger: "admission" | "threshold" | "prune" | "manual" | "recovery" | "explicit" | null;
  exclusiveBytes: number; references: ReferenceSummary[];
  confirmedProtected: boolean;      // deleted kind only: the Human confirmed deleting protected content
  runId?: string;
}
```

Every eviction also writes an `activity_log` entry (area `storage`, with `versionId`) and queues the search index update through the index outbox. Explicit deletion (`DELETE /api/archive/pages/{id}`) writes `kind: "deleted"` records and never an `evicted` one.

### 10.6 Forecast

`GET /api/storage/forecast[?sourceId=src_...][&horizonDays=7..365]`. **Always an estimate**: `estimate` is `true`, every figure is a low and high band, and `assumptions` says what it rests on. The UI must label it as an estimate and must not show a single-point figure.

```ts
interface StorageForecast {
  estimate: true; horizonDays: number; sourceId?: string;
  projectedUsedBytes: { low: number; high: number };          // used bytes at the end of the period
  growthBytesPerDay: { low: number; high: number };
  projectedFullAt?: { earliest: Iso; latest?: Iso };          // absent when it would not fill within ten years; latest absent when the low growth is zero
  perSource: { sourceId: string; name: string; observedPages: number; bytesPerPage: { low: number; high: number }; plannedPages: number; plannedBytes: { low: number; high: number } }[];
  confidence: "low" | "medium";                               // low with fewer than three whole days of history
  assumptions: string[];
}
```

Method: the average of recent whole days of new bytes plus or minus one standard deviation, plus planned pages (the remainder of each source's page limit) priced at the source's observed bytes per page (70% to 150%), spread evenly. Eviction and deletion in the meantime are not subtracted.

### 10.7 Admission control

Before a download writes anything it reserves room (task T-07). Reservations are listed in the volume detail and counted in `reservedBytes`; a download that ends gives its reservation back, and a restart clears them all.

1. A source over `storageBudgetBytes` is refused: a crawl stops with `stopReason: "source_budget"`, a single save fails with `failure.code: "limit_reached"`.
2. A background Opportunistic (P4) download waits (retrying every 30 seconds, using no attempt) while every volume is above its soft threshold and `throttleOpportunistic` is on. Downloads started by the Human are never throttled. While it waits, the download carries `wait: { reason: "throttled", message }` in `GET /api/downloads`, `GET /api/downloads/{id}` and the `download.update` event, and `GET /api/downloads/queue` (and the `download.queue` event) counts such downloads in `storageThrottle.downloads`. The reason is cleared when the job is admitted, ends, or has not been re-checked for 90 seconds.
3. When there is not enough room, the planner is asked what can go for a download of this priority (rule: a P1 download may reclaim P2 if permitted, P3 and P4; P2 and P3 downloads reclaim lower classes; P4 reclaims only P4). If that covers the need it is removed first; otherwise the download fails with `failure.code: "disk_full"` (a crawl stops with `volume_full`) and **nothing is deleted**.
4. Below a volume's free-space reserve, background downloads are paused by the disk guard (`pause.reason: "volume_full"`) and resume by themselves.

### 10.8 Maintenance: verify and repair

`POST /api/system/maintenance/verify` (also `POST /api/storage/maintenance/verify`), body `{ repair?: boolean (default false), checks?: string[] }`. **The default is a dry run: it reports and changes nothing in the archive.** With `repair: true` each finding is fixed. `checks` limits the run to some of `I-1` to `I-13` and `REF`. `GET /api/system/maintenance/runs` lists runs (`?limit=`) and `GET /api/system/maintenance/runs/{id}` returns one report. `POST /api/system/maintenance/backup` writes a `VACUUM INTO` copy of `main.db` to the data volume (`{ file, sizeBytes }`).

```ts
interface MaintenanceRun {
  id: string; kind: "verify" | "repair" | "integrity_check" | "scrub"; dryRun: boolean;
  state: "running" | "done" | "failed"; startedAt: Iso; finishedAt?: Iso;
  findings: { invariant: "I-1" | ... | "I-13" | "REF"; title: string; count: number; examples: string[]; repaired?: number; note?: string }[];   // no finding means nothing was wrong
  checked: Record<string, number>;     // how much was looked at: blobs, files, blobCounts, scrubbed
  skipped: { invariant: string; reason: string }[];   // for example an offline volume
}
```

| Id | What is checked | Repair |
|---|---|---|
| I-1 | every ready blob has a file of the expected size | mark `missing`; copies that use it become `partial` |
| I-2 | every file on a volume has a row | move to the volume's `quarantine/` folder (never deleted) |
| I-3 | `refcount` equals the references and `zero_since` is set exactly at 0 | recount |
| I-4 | no reference points at a missing parent | delete the dangling rows |
| I-5 | a `capturing` copy has a job or is younger than 10 minutes | mark `failed`, release its references |
| I-6 | `pages.latest_version_id` is a ready or partial copy of that page | point at the newest usable copy, else mark the page evicted |
| I-7 | `host_state.in_flight` equals running jobs | reset |
| I-8 | no reservation for a finished download | delete |
| I-9 | no temporary file older than 24 hours | delete |
| I-10 | the search index matches the archive | rebuild or repair the index |
| I-11 | a sample of stored files matches their SHA-256 | move aside to `quarantine/`, mark `missing` |
| I-12 | `PRAGMA quick_check` | report only (restore from a backup) |
| I-13 | no Protected copy was evicted, and every eviction has a record | report only, logged at error level |
| REF | pages that nothing references (counted as P4) | report only |

The storage pass (every five minutes) also runs `quick_check` once a day (kind `integrity_check`) and a hash scrub of up to `scrubMegabytesPerRun` per pass; a mismatch is logged at error level and left alone until a repair is run.

### 10.9 Settings keys (group `storage`)

Read and written with `GET/PATCH /api/settings` as well as the policy endpoint.

| Key | Type, default | Meaning |
|---|---|---|
| `permitImportantEviction` | boolean, `false` | The P2 permit. Turning it on through `PATCH /api/settings` also needs `storage.acknowledged: true` in the same patch, and the response then carries `warning`. |
| `permitAcknowledgedAt` | ISO string or null | Set by the server when the permit is confirmed. |
| `throttleOpportunistic` | boolean, `true` | Slow P4 background downloads above the soft threshold. |
| `pruneSurplusVersions` | boolean, `true` | The maintenance pass removes surplus copies. |
| `orphanGraceSeconds` | integer, `86400` | Grace before an unused file is deleted. |
| `autoEviction` | boolean, `true` | Evict when a volume passes its eviction-start threshold. |
| `maxEvictionBatchBytes` | integer or null, `null` | Cap on one prune run. |
| `forecastHorizonDays` | integer 7 to 365, `30` | Forecast period. |
| `scrubMegabytesPerRun` | integer 0 to 4096, `64` | Checksum scrub budget per pass. |

Per-source storage fields are on `Source` (section 7): `priority`, `retention`, `automaticEviction`, `storageBudgetBytes`, `preferredVolumeId`. Changing a source's priority, retention or `automaticEviction` refreshes the cached priority of its pages at once.

### 10.10 Dashboard

`GET /api/system/dashboard` now fills `pages`, `sources`, `collections` and `storage.byPriority` from the archive (bytes by effective priority, unreferenced bytes under P4).

## 11. Index

Shapes and behaviour of these endpoints are in [6.1.1](#611-index-endpoints-section-11-in-brief). Writes need a session and the CSRF header.

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

Response shapes (server): `GET /api/settings` returns the groups as `{ general: {...}, resources: {...}, ... }`; secret fields are replaced by a `has<Field>` flag (for example `offline.hasProbeToken`). `PATCH /api/settings` takes a partial of any groups, validates the merged group, returns the same map and, when online search was just enabled, a top-level `disclosure` string. Enabling `privacy.onlineSearch.enabled` requires `privacy.onlineSearch.acknowledged: true` in the same patch (otherwise a field error on that path), which stores `acknowledgedAt`. Invalid values return 400 with `details.fields[].path` such as `offline.probeUrl`. `GET /api/settings/user` and `PATCH` use `{ theme, density, tabRestore, shortcuts, search }` where `search = { homepageSections: { recentSearches, bookmarks, favourites, libraryStats }, resultsPerPage }`: the four section flags are booleans (default all `false`), `resultsPerPage` is an integer 1 to 50 (default 10).

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
| POST | `/api/system/maintenance/verify` | Verify-and-repair, dry run by default. `{ repair?: false, checks?: string[] }` returns a `MaintenanceRun` (section 10.8) | S+C |
| GET | `/api/system/maintenance/runs`, `/api/system/maintenance/runs/{id}` | History and reports | S |
| POST | `/api/system/maintenance/backup` | `VACUUM INTO` backup of `main.db` into `backups/` in the data volume; `{ file, sizeBytes }` | S+C |
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
// MaintenanceRun: see section 10.8.
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
interface HistoryEntry { id: string; url: string; title: string; visitedAt: Iso; servedFrom: "archive" | "cache" | "zim" | "live" | "offline"; pageId?: string; zim?: { zimId: string; path: string } }
```

History recording is a user setting (`privacy.history.enabled`, default on, local only); disabling stops recording, clearing deletes rows. `GET /api/history` returns `{ enabled, items }`; `DELETE /api/history` returns `{ deleted }`. Bookmarks add `referencePriority` (the value of `browser.bookmarkPriority` when the bookmark was made; Phase 6 uses it), `GET /api/bookmarks?url=` filters by address, and `POST /api/bookmarks` on an address that is already bookmarked returns the existing bookmark with 200. The archive reference is looked up by address each time a bookmark is listed, so a page saved after the bookmark was made is found.

**Package entries (Phase 8, task Z-06).** `POST /api/bookmarks` takes `{ url }` or `{ zimId, zimPath, title? }` (400 if neither). A Wikipedia address that an enabled Wikipedia package holds is bookmarked with the package entry as well (`zim: { zimId, path }` in the response), so it opens offline whether or not the page is archived; the bookmark keeps the Wikipedia address as `originalUrl`. An entry of any other package is bookmarked by `zimId` and `zimPath` and gets `originalUrl: "zim://<zimId>/<path>"` (and the same bookmark again returns the existing one with 200; `GET /api/bookmarks?url=zim://...` finds it). An unknown `zimId` is 404. Removing a package with `confirm=true` deletes the bookmarks that only pointed at it (section 15.1). The bookmark's `zim` reference is stored when it is made; a package installed later does not add one, but `resolve` still opens the package copy of the bookmarked address.

## 15. ZIM packages and Wikipedia

Knowledge packages (ZIM files) and Wikipedia are built in Phase 8, tasks Z-01 to Z-09. **Phase 8 as built** is 15.1 (packages) and 15.2 (Wikipedia: client, topic crawl, attribution); `resolve` for Wikipedia addresses is in section 3.

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/zim/packages` | List with metadata and state. `?language=en` (639-1 or 639-3), `?enabledForSearch=`, `?state=` | S/G |
| POST | `/api/zim/packages/import` | Registers a `.zim` file already under an allowed root (see below). 201, or 202 for `copy` with `async: true` | S+C |
| GET | `/api/zim/packages/{id}` | Detail incl. attribution and licence | S/G |
| PATCH | `/api/zim/packages/{id}` | `{ enabledForSearch?, priority?, licenseName?, licenseUrl?, attribution? }` | S+C |
| DELETE | `/api/zim/packages/{id}` | Safe removal: `?dryRun=true` lists what refers to the package and changes nothing; without `confirm=true` it answers 409 with the same list when anything refers to it; `?confirm=true` removes the references and the package | S+C |
| GET | `/api/zim/packages/{id}/references` | The dry-run list as a plain GET | S+C |
| POST | `/api/zim/packages/{id}/verify` | `{ deep?: boolean }` checks the file is there with its size, then the structure (`deep` also the embedded checksum). `{ ok, checks[], package }` | S+C |
| GET | `/api/zim/packages/{id}/search` | `?q=&limit=` search inside one package (full text, or titles when it has no full-text index) | S/G |
| GET | `/api/zim/packages/{id}/suggest` | `?q=&limit=` title suggestions | S/G |
| GET | `/api/zim/packages/{id}/entries` | `?limit=&cursor=` the articles by title (the cursor is the last title shown) | S/G |
| GET | `/api/zim/packages/{id}/entry` | `?path=` entry metadata (exists, redirect target, mime type, size) | S/G |
| GET | `/api/zim/packages/{id}/illustration` | The package's 48 px icon, when it has one | S/G |
| GET | `/api/zim/status` | Reader processes, restarts, crashes, hangs, package counts by state, usage | S/G |
| GET | `/api/zim/catalogue` | **Later (task Z-11)**: browse the Kiwix library when online | S |
| POST | `/api/wikipedia/preview` | `{ title \| url, language?, depth?, images?, preferZim?, maxPages?, skip... }`: candidate counts per level, estimated requests, time (at the client's pace, 1 request/s), bytes (estimates) and package coverage. Makes 2 to 4 requests to Wikipedia and saves nothing (15.2) | S+C |
| POST | `/api/wikipedia/crawl` | Same body plus `name?`, `priority?`: creates a Wikipedia source and runs it. 202 `{ source, downloadIds }` (15.2) | S+C |
| GET | `/api/wikipedia/status` | Contact configured, the User-Agent, pace, request counts, circuit-breaker state | S |
| POST | `/api/wikipedia/reset` | Closes the circuit breaker and forgets any wait ("try again now"). Returns the status | S+C |

Browsing a ZIM entry is through the listener (`/a/{token}/z/{zimId}/{path}`), with a token from `POST /api/archive/frame-grants` (below). Searching across archive, ZIM and online is `POST /api/search` (section 6.1, "Knowledge packages in search"); `GET /api/zim/packages/{id}/search` is the single-package form.

### 15.1 Phase 8 as built

**Package object (`ZimPackage`).**

```ts
interface ZimPackage {
  id: string;                      // zim_...
  name: string; title: string; description: string | null;
  language: string | null;         // ISO 639-3 as the file states it ("eng"), possibly several ("eng,fra")
  creator: string | null; publisher: string | null; date: string | null; flavour: string | null; tags: string[];
  uuid: string;                    // the file's identity; one package per UUID
  state: "importing" | "ready" | "degraded" | "missing" | "removing";
  stateDetail: string | null;      // plain-words reason for degraded or missing
  storageMode: "in_place" | "copied";
  path: string;                    // absolute path of the file that is read
  volumeId: string | null;         // the volume the file sits on or was copied to
  sizeBytes: number;
  checksum: { sha256: string | null; state: "pending" | "done" | "failed" };
  counts: { articles: number; media: number; entries: number };
  hasFulltextIndex: boolean; hasTitleIndex: boolean; newNamespaceScheme: boolean;
  mainPath: string | null; illustrationUrl: string | null;
  license: { name: string | null; url: string | null; known: boolean };
  attribution: string | null;      // credit line to show with the content
  sourceUrl: string | null;
  priority: "P1" | "P2" | "P3" | "P4";   // default P1
  neverAutoEvicted: true;
  enabledForSearch: boolean;
  sourceId: string | null;         // the knowledge_package source bound to it
  importedAt: string; lastVerifiedAt: string | null;
}
```

**Import.** `POST /api/zim/packages/import` takes `{ path, copy?, volumeId?, priority?, enabledForSearch?, licenseName?, licenseUrl?, attribution?, createSource?, async? }`.

- `path` must be absolute, end in `.zim`, be a regular file and, after symbolic links are followed, sit under one of `NCB_VOLUMES_ALLOWED_ROOTS`. Anything else is 400 with a field error on `path`. Split files (`.zimaa`) are not supported.
- `copy: false` (default) reads the file where it is. Registering writes nothing but database rows; the SHA-256 is computed afterwards by reading the file once (`checksum.state` goes `pending` to `done`). `copy: true` copies the file to `<volume>/zim/` (streamed, hashed, `fsync`ed, then renamed; the volume must be writable and have room, otherwise 507 `insufficient_storage`) and reads the copy. A copy counts in the volume's used bytes and in the usage figures; the original is left alone. `async: true` answers 202 with `state: "importing"` and finishes in the background.
- The file is opened in a reader process before anything is stored, so a damaged file is a 400 ("not a valid ZIM package") and never harms the server. A package whose UUID is already registered is 409 `conflict` with `details.existing`. The same path twice is 409.
- Licence and attribution come from the file's `License`, `Creator`, `Publisher` and `Source` metadata; a Wikipedia/Wikimedia package without a `License` key is recorded as CC BY-SA 4.0. `license.known: false` means the file did not say; the Human can set it with `PATCH`.
- `createSource` (default true) creates the package's `knowledge_package` source (below).
- Deviation from the table above: no `zim_import` download job is created; the call itself does the work and the activity log (area `zim`) records it.

**Removal.** `DELETE ?dryRun=true` returns `{ removed: false, plan }` with `plan = { package, deletesFile, fileBytes, references: { bookmarks, collections, sources, history }, needsConfirmation }`. Each reference group has `count` and up to 50 `items`. With references and no `confirm=true` the call is 409 `conflict` and `details` is the same plan. Confirmed removal deletes ZIM-only bookmarks and collection memberships, clears the ZIM reference from bookmarks that also point at an archived page and from history rows, retires the bound source, and deletes the package. The file is deleted only when NoConBrain made it (`storageMode: "copied"`); a file the Human placed is left in place. A removal a crash interrupted is finished at the next start.

**Never evicted.** Packages have a priority (default P1) and count in the storage figures, but no part of the storage system removes one: the eviction planner works on page versions and blobs only, and a package's source cannot have automatic eviction. `GET /api/storage/usage` gains `knowledgePackages: { count, copiedBytes, inPlaceBytes, neverAutoEvicted: true }`. Copied packages are included in `totalBytes`, in the `P1` to `P4` rows (by the package's priority), in the `volume` rows, under kind `zim`, and in a volume's `usedBytes`; files left in place sit outside the volumes and are only counted in `inPlaceBytes`. A volume that holds a package cannot be removed (409).

**Knowledge-package sources.** `POST /api/sources` with `{ type: "knowledge_package", zimId, name?, description?, priority? }` creates the source of an existing package (409 if it already has one; a package imported with `createSource: true` has one already). The source has `adapter: "zim"`, retention `all`, `automaticEviction: false`, and a `knowledgePackage: { id, title, state, sizeBytes }` object. `GET /api/sources/{id}/pages` lists the package's articles by title (items `{ kind: "zim", zimId, path, title, open }`, `total` is the article count, `cursor` the last title); `GET /api/sources/{id}/stats` reports articles and bytes. `PATCH` accepts `name`, `description`, `priority` (shared with the package) and `enabled` (the package's `enabledForSearch`); `automaticEviction: true` is 400. `run` and `refresh` are 409: nothing is downloaded. Deleting the source leaves the package in place.

**Reader processes.** Each open package is read by its own forked child process (`apps/server/src/zim/zim-worker.ts`), started on first use and stopped after five idle minutes. A child process rather than a `worker_threads` thread, because libzim reports a damaged file as an uncaught C++ exception, which aborts the whole process it runs in; the integration suite shows an invalid file killing a thread-based reader's host. A reader that crashes or stops answering (the call's time budget plus a 2 s grace) is killed and restarted; the package is `degraded` meanwhile (activity log entry, `stateDetail`) and returns to `ready` after the next good answer. Searches have a soft time budget (`search.zimSearchBudgetMs`, default 800 ms): the reader checks it between small chunks and returns what it has with `partial: true`. `GET /api/system/status` lists the `zim` worker as `idle`, `down` (a package is degraded) or `disabled` (no packages).

**Listener.** `POST /api/archive/frame-grants` also takes `{ zimId, zimPath? }` and answers the same `FrameInfo` for `/a/{token}/z/{zimId}/{path}` (404 for an unknown package, 503 `unavailable` for a missing or still-importing one). `GET /api/browser/frame-state` reports a package entry as `state: "zim"` with `zimId` and `zimPath`.

### 15.2 Wikipedia (Phase 8 as built, tasks Z-07 and Z-08)

**The rules of use.** All traffic to Wikipedia and Wikimedia goes through one `WikipediaClient` (`apps/server/src/wikipedia/client.ts`), which keeps the Wikimedia User-Agent policy and API etiquette (docs/research/zim-wikipedia.md section 5):

- **Contact required.** `NCB_CONTACT` must be a web address (`https://...`) or an email address. The client sends `NoConBrain/<version> (<contact>; https://github.com/slaterjohn/nocon-brain)` on every request. Without a usable contact it makes no request at all: the preview, the crawl and a Wikipedia source answer 400 `bad_request` ("Set NCB_CONTACT ..."), and a plain save of a Wikipedia article fails with the same message.
- **One at a time, one a second.** A token bucket with no burst: at most one request starts per second (`1000 ms` plus up to 25 ms of margin, so a server that measures arrival times never sees two inside a second) and never two in flight; redirect hops and retries count as requests.
- **429 and 503.** `Retry-After` is obeyed. Without it the wait is 5 s, doubling per try. After 4 tries, or when the wait is longer than 2 minutes, the request fails with `rate_limited` carrying `retryAfterMs`, and the job queue retries later (a crawl page is retried with that delay). 403 fails at once (check `NCB_CONTACT`).
- **maxlag.** Action API calls carry `maxlag=5`; a `maxlag` answer is waited out the same way.
- **Circuit breaker.** Five 429, 403 or 503 answers in a row pause all Wikipedia requests for 5 minutes (`unavailable`, `details.reason: "circuit_open"`, `retryAfterMs`). After the pause one request decides: a good answer closes the breaker, a refusal reopens it. `POST /api/wikipedia/reset` closes it by hand.
- **Only Wikimedia hosts.** `*.wikipedia.org`, `*.wikimedia.org`, `*.wikidata.org`, `*.mediawiki.org` over https, or the replacement origin below. A redirect to any other host is refused. Offline (work offline on, or no connection), nothing is sent: 409 `offline`.
- Requests are counted in `usage_counters` (`wikipedia_requests`, subject `global`, per day, with bytes). The `NCB_WIKIPEDIA_ORIGIN` setting (default empty) replaces `https://<language>.wikipedia.org` for every language, for a mirror or the test suite's fake server; addresses on it are read as articles of the source's language.

**How a page is fetched.** The capture pipeline's fetcher sends an article address (`https://<lang>.wikipedia.org/wiki/<Title>` and its other forms) to the core REST route `GET /w/rest.php/v1/page/{title}/html` (Parsoid HTML) instead of scraping the reading page, follows its redirect to the real title and stores the page under the reading address `https://<lang>.wikipedia.org/wiki/<Real_title>`. A refresh sends the stored `ETag` (`If-None-Match`); a 304 costs one small request. Images, stylesheets and other files on Wikimedia hosts go through the same client and limiter. The licence is CC BY-SA 4.0, as Wikimedia's Terms of Use fix it for all text; the revision id is `X-Revision-Id`, else the number at the start of the `ETag` (`W/"<revision>/<uuid>/view+lang:und"` on the real service), else the document's own revision. robots.txt is not consulted for these API requests (the API etiquette governs them, not the crawler rules of the reading pages).

**Attribution, per version.** When a Wikipedia version has been captured, `page_attributions` gets `{ license_name: "CC BY-SA 4.0", license_url, source_url (the article), revision_id, history_url (/w/index.php?title=...&action=history), credit_text }`, the page's `origin` becomes `wikipedia` and its `language` is set. A `wikipedia_fetch` job then reads the licence details of the saved images with `prop=imageinfo&iiprop=url|extmetadata` (50 files a request, `maxlag=5`) and stores `asset_attributions` (`author`, `license_name`, `license_url`, `source_page_url`); a non-free file keeps the licence the file page states ("Fair use") so it can be told from the free ones. A file that lives on Commons is reported by the wiki as `missing` with its `imageinfo` present; the client accepts that shape. The listener footer and `GET /api/archive/versions/{id}` show all of it (section 5).

**Link extraction.** From the stored Parsoid HTML: `a[rel="mw:WikiLink"]`, `href="./Title"`, namespace 0 only (a prefix such as `Category:`, `File:`, `Template:`, `Special:`, `Help:`, `Wikipedia:`, `Talk:` is another namespace; `Star Trek: Voyager` is an article), fragment removed, red links (`class="new"`, `?action=edit&redlink=1`) and external links left out, repeats merged.

**`POST /api/wikipedia/preview`** body: `{ title?, url?, language = "en", depth = 1 (0 to 3), maxPages = 200 (1 to 2000), images = true, preferZim = true, skipDisambiguation = true, skipLists = true, skipYears = true }` (give `title` with `language`, or `url`). It reads the article (1 request) and asks Wikipedia which of the first candidate titles exist and are disambiguation pages (`prop=info|pageprops`, 50 titles a request, at most 3 requests), then applies the rules. 200:

```ts
interface WikipediaPreview {
  estimate: true;                                   // every figure is an estimate
  article: { title: string; language: string; url: string; revisionId: string | null; bytes: number; redirectedFrom: string | null };
  caps: { depth: number; maxPages: number; maxDepth: 3; maxPagesCeiling: 2000 };
  options: { images: boolean; preferZim: boolean; skipDisambiguation: boolean; skipLists: boolean; skipYears: boolean };
  levels: { depth: number; candidates: number; willFetch: number; inKnowledgePackage: number;
            skipped: { disambiguation: number; lists: number; years: number; missing: number }; estimated: boolean }[];  // level 0 is the article; level 1 is counted; deeper levels are estimated (estimated: true)
  totals: { pages: number; images: number; requests: number; seconds: number; bytes: number };   // seconds = requests at the client's pace
  knowledgePackages: { checked: number; present: number; packages: { id: string; title: string }[] };
  sample: { title: string; lead: boolean; count: number; inKnowledgePackage: boolean }[];         // the first links the crawl would follow
  requestsMade: number;                             // requests the preview itself made
  pace: { requestsPerSecond: number };
  warnings: string[];                               // plain sentences: a large crawl, no package installed, deeper levels are guesses
}
```

Errors: 400 for a bad body, a depth over 3 or a page limit over 2,000 (field messages that point to a package for more) and for no contact; 404 when Wikipedia has no such article; 409 `offline`; 429 `rate_limited` or 503 `unavailable` with `retryAfterMs` when Wikipedia asks for a pause.

**`POST /api/wikipedia/crawl`** takes the preview's body plus `name?` and `priority?` (`P1` to `P4`, default P3). It creates the source (`type: "linked_collection"`, `adapter: "wikipedia"`, named "Wikipedia: <Title>", profile `custom`) and runs it: 202 `{ source: Source, downloadIds: string[] }`. Watch it as any crawl (`GET /api/downloads/{id}`, the `crawl` and `download` events); run it again from the source for a refresh. The crawl is the ordinary engine with these rules:

- **Caps.** `maxPages` counts the first article; depth 1 means the article and the articles it links to. The queue is best first, so a cap keeps the best pages of each level. The stop reason is the engine's (`max_pages`, `max_depth`, `max_bytes`, `deadline`, `cancelled`, `completed`). Default size limit 512 MiB, time limit as the profile.
- **Ranking within a level.** A link in the lead section (before the first heading, Parsoid `data-mw-section-id="0"`, infobox included) scores +40, a link that appears more than once +5 per repeat (up to +20), then document order. These are added to the engine's own link score.
- **Skipped.** Each skipped link counts in the download's `pagesSkipped` and, by reason, in `crawl_skips` (and `CrawlService.get().skips`; no API route lists the reasons yet): `wikipedia:not_article` (other namespaces, red links, queries, special pages), `wikipedia:other_language`, `wikipedia:disambiguation` (titles ending `_(disambiguation)`), `wikipedia:list` (`List_of_...`, `Lists_of_...`, `Index_of_...`, `Outline_of_...`, `Glossary_of_...`, `Timeline_of_...`), `wikipedia:year` (years, decades, centuries, dates such as `July_20`, `1969_in_science`, `Deaths_in_2020`), and `wikipedia:in_zim`.
- **ZIM first.** With `preferZim`, a target that an enabled Wikipedia package of the language holds is not fetched (`wikipedia:in_zim`); the saved page links to the package copy when it is served (section 5), and the preview counts it under `inKnowledgePackage`. Fewer requests to Wikipedia, less storage, and the link works offline.
- **Images.** `images: false` saves text only (images are recorded as skipped and do not make a page `partial`). With images, each saved image gets its credit row (above).
- **Offline link rewriting.** The listener rewrites links between saved articles to the saved copies and links to articles held by a package to the package; anything else goes to the notice page. Nothing links to the live site on its own.
- Wikipedia text is CC BY-SA 4.0: exporting or sharing an archive needs the footer. `NCB_CONTACT` and the pace apply to refreshes too.

**Pace of a crawl.** At one request a second a 200-page crawl with images is about 200 article requests, about 200 x (images per article) file requests and a few Action API batches, so several minutes to well over an hour; the preview says how many. Deep or wide crawls are better served by a Wikipedia package (the research note suggests the 132 MB chemistry package as an example).
