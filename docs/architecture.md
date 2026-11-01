# Architecture

Status: planning. Nothing in this document has been built. Numbers marked "to be measured" are targets, not results. Numbers taken from the research are cited by file.

NoConBrain is a self-hosted, offline-first knowledge archiver, crawler and search engine. It archives web pages to local storage, lets the user browse and search them with no internet connection, and can blend in results from online search providers when a connection exists. It targets Docker Compose on Raspberry Pi 4/5 (ARM64) and AMD64.

Licence: AGPL-3.0, public repository `slaterjohn/nocon-brain`. Why AGPL is compatible with the GPL-3.0 `@openzim/libzim` that the server links is in [technology-decisions.md](technology-decisions.md#zim-reading).

## 1. Principles

1. **Offline is the normal state.** Every screen except "fetch something new" works with no internet. No external fonts, scripts, analytics or telemetry. Online search is off until the Human configures a provider.
2. **Our own capture format.** Content-addressed blobs, manifests in SQLite, links rewritten when a page is served. The original bytes are kept, so an improved rewriter or extractor fixes old captures ([research/crawling-rendering.md](research/crawling-rendering.md) section 3).
3. **The sandbox is the isolation, not the port.** Cookies cross ports. Every archive response carries `Content-Security-Policy: sandbox` ([section 8](#8-security-boundaries)).
4. **One SQLite writer.** One Node process owns each database file. No Postgres, no Redis.
5. **Derived data is rebuildable.** The search index can be deleted and rebuilt from stored content. Cached counters are hints; destructive operations re-derive from references.
6. **Small and measurable.** Defaults are conservative for a 4 GB Pi. Performance claims wait for measurements on real hardware.

## 2. Service boundaries

```
 Browser (user)                          LAN / host
 +--------------------------------------------------------------------+
 |  :3000  web      Next.js standalone, browser-chrome UI             |
 |  :3002  archive  archived content only (served by `server`)        |
 +---------+--------------------------------------+-------------------+
           | /api/* proxy (internal network)      | iframe src (sandboxed)
           v                                      v
 +--------------------------------------------------------------------+
 | server  (one Node 24 process, the only writer of main.db/index.db)  |
 |                                                                    |
 |  main thread                                                       |
 |   - Fastify API              :3001 (internal; not published)       |
 |   - Archive listener         :3002 (separate http.Server,          |
 |                                      read-only, no sessions)       |
 |   - Job runner, scheduler, connectivity monitor                    |
 |   - Main DB writer (better-sqlite3, WAL)                           |
 |                                                                    |
 |  worker_threads                                                    |
 |   - extract  x1..2  linkedom, Readability, parse5, css-tree        |
 |   - index    x1     sole writer of index.db (FTS5)                 |
 |   - search   x1     read-only index.db connection                  |
 |   - zim      x1     @openzim/libzim reads (crash-isolated by      |
 |                     restart policy, see risk R-17)                 |
 +-------+--------------------+----------------------+----------------+
         |                    |                      |
   /data (named volume)   /volumes/* (storage     optional containers
   main.db, index.db,       volumes: blobs, ZIMs)  `renderer` (profile)
   secrets, tmp                                    `searxng`  (profile)
```

### Containers

| Container | Required | Role | Notes |
|---|---|---|---|
| `web` | yes | Next.js 16 standalone. Browser chrome, Library, Downloads, Search, Storage and settings. Proxies `/api/*` to `server`. | No access to data volumes. Stamps the peer IP and proxy secret as in NoConMedia ([security.md](../../NoConMedia/docs/security.md)). |
| `server` | yes | One Node 24 process: Fastify API, archive listener on its own port, job runner, `worker_threads`. Sole writer of both SQLite files. | `node:24-trixie-slim`, Debian/glibc (libzim does not load on musl: [research/zim-wikipedia.md](research/zim-wikipedia.md) section 1). |
| `renderer` | no (`--profile renderer`) | Playwright `chromium_headless_shell`, one page at a time, hard memory limit. | Internal network only. All its traffic goes through the server's guarded proxy ([section 7](#7-optional-containers)). |
| `searxng` | no (`--profile searxng`) | Self-hosted metasearch for the SearXNG provider adapter. | Official multi-arch image, JSON format enabled via mounted `settings.yml`. |

There is no Postgres, no Redis and no external queue.

### Why one `server` process with threads

- The single-writer rule is simple to enforce: the main thread holds the only writer connection to `main.db`; the `index` worker holds the only writer connection to `index.db`. Extraction workers return results by message and the main thread commits them.
- `worker_threads` give isolation from CPU-heavy or pathological pages (`resourceLimits` per worker) without a second process boundary.
- `better-sqlite3` is synchronous. Anything that can take more than a few milliseconds (full-text search, ZIM reads, extraction, indexing) stays off the main thread. This adds one worker kind (`search`) to the owner's list (extraction, indexing, ZIM reads); see decision D-2 in [technology-decisions.md](technology-decisions.md#d-2-search-reads-in-their-own-worker).

### Planned repository layout (copying NoConMedia patterns, importing nothing from it)

```
apps/web                 Next.js 16 App Router, Tailwind 4, shadcn/ui
apps/server              Fastify entry, listener entry, runner entry, worker entry points
packages/shared          config (zod), ids, errors, path safety, clocks, redaction, enums
packages/db              Db interface, better-sqlite3 adapter, Drizzle schema, migrations, SQL helpers
packages/archive-core    url normalisation, SSRF guard, fetcher, robots, pipeline stages, rewriter
packages/crawler         frontier, scope, scoring, traps, host politeness
packages/search-index    SearchIndex interface, FTS5 implementation, query parser, ranking
packages/search-providers adapter interface, runner, SearXNG/Brave/Mojeek adapters, merger
packages/storage-planner pure planner: priority, retention, eligibility, eviction ordering
packages/zim             ZimSource interface, libzim worker, Wikipedia client
tests/fixtures           local fixture websites (no real network in any test)
docker/                  server, web, renderer Dockerfiles; searxng settings.yml
```

## 3. The five areas and where they live

| Area | What it contains | Main API resources |
|---|---|---|
| Browser | Tabs, address bar (URL or search), back/forward, reload, find-in-page, bookmarks, history, reader mode, original-site mode, archived/live switch, save actions, offline indicators | `/api/browser/*`, `/api/bookmarks`, `/api/history`, archive listener |
| Library | Pages, versions, sources, collections, saved searches, ZIM packages | `/api/archive/*`, `/api/sources`, `/api/collections`, `/api/zim/*` |
| Downloads | Queue, schedules, windows, resource limits, discovery candidates | `/api/downloads`, `/api/schedules`, `/api/discovery/*` |
| Search | Homepage, combined results, filters, coverage, "improve offline coverage" | `/api/search/*` |
| Storage and settings | Volumes, usage, forecast, eviction, index status, providers, privacy, resource profile, admin dashboard, logs, maintenance | `/api/storage/*`, `/api/index/*`, `/api/settings`, `/api/system/*` |

The admin dashboard (pages, sources, collections, index size, storage used and available, active, queued and failed jobs, last update, worker status) is a page in Storage and settings backed by `GET /api/system/dashboard`.

## 4. Data flow

### 4.1 Capture and processing pipeline

A user action, schedule, crawl or discovery run creates a **download job** (user-visible) which creates **jobs** (internal). Each fetched document runs through the 15-stage pipeline. Each stage is a retryable unit whose state is stored in `pipeline_stage_runs`.

```
 trigger (UI / schedule / crawl frontier / discovery / search "save")
        |
        v
 download_jobs (queued) --> crawl_jobs (explore/mirror only) --> jobs[type=fetch] frontier
        |
        v   claim (lease, per-host invariant, robots, politeness, SSRF guard)
 FETCH (undici, manual redirects, decoded-size cap)
        |
        v   jobs[type=process, version_id]   -- stages persist; failure resumes at the stage
 1 validate          content-type allowlist + sniff, size, status
 2 store original    blob (sha256, zstd for text) -> temp file -> fsync -> rename
 3 assets            discover sub-resources, enqueue asset fetches, dedupe by sha256
 4 metadata          title, OpenGraph, JSON-LD, dates (+source, +confidence), language
 5 readable content  linkedom + Readability (worker), defuddle as second opinion
 6 headings/sections outline with anchors
 7 links             extract, classify region/density, normalise, score
 8 normalise         canonical URL, redirects, alias rows
 9 dedup             canonical, content hash, exact duplicates (near-dup optional)
10 reader content    sanitised reader HTML + plain text blobs
11 safe rendering prep  allowlist-checked document + resource table for serve-time rewrite
12 index             index_outbox row -> index worker upserts into index.db
13 link graph        links rows; resolve to_page_id; update inbound counts
14 candidates        passive discovery candidates from links (if enabled)
15 status            page_versions.status = ready | partial; page.latest_version_id; priority recompute
        |
        v
 events: SSE /api/system/events (job progress), activity_log
```

Atomic finalisation: stages 1 to 14 write only to the new `page_versions` row (status `capturing`) and to blobs. Stage 15 flips the version to `ready` or `partial` and moves `pages.latest_version_id` in one transaction. A crash before stage 15 leaves a `capturing` version that recovery resumes or discards; readers never see it.

### 4.2 Browsing: URL flow and the archive listener

```
 address bar input
      |
      v   POST /api/browser/resolve
 looks like URL? --no--> treat as search (-> section 4.3)
      | yes
 normalise (WHATWG URL, tracking strip, fragment strip) -> url_key
      |
      +-> 1 archive  : page with ready/partial version, any non-cache source
      +-> 2 zim      : URL maps to an enabled ZIM entry (e.g. Wikipedia)
      +-> 3 cache    : page held only by the "Browsing cache" system source (P4)
      +-> 4 live     : connectivity online -> "Open live" (new tab) or optional frame
      +-> 5 offline  : static offline page; offer "Queue for download"
      |
      v   response: { resolution, frame: { url: http://host:3002/a/<token>/p/<pageId>, frameId } }

 shell sets iframe.src = frame.url
      iframe sandbox="allow-popups allow-popups-to-escape-sandbox"  (no allow-scripts, no allow-same-origin)

 archive listener (:3002), per request:
      verify HMAC token (path) -> look up version -> read blob(s)
      HTML: parse5 allowlist -> rewrite every URL via resource table + links table
      CSS : css-tree rewrite url()/@import
      headers: CSP sandbox + default-src 'none' ..., nosniff, no-referrer, never Set-Cookie
      never fetches from the network; never reads cookies; serves no API
```

Link states in rewritten pages:

| State | Meaning | Rewritten `href` |
|---|---|---|
| cached | Target page has a `ready` version | `/a/<token>/p/<pageId>` |
| partial | Target has a `partial` version (assets missing, truncated, or reader-only) | same URL; `data-ncb-link="partial"` |
| queued | A download job for the target is queued or running | `/a/<token>/m?u=<url>` (interstitial shows progress) |
| live-only | Not archived, never requested, connectivity online | `/a/<token>/m?u=<url>` (interstitial: open live, save, back) |
| unavailable | Not archived and offline, evicted, or permanently failed | `/a/<token>/m?u=<url>` (interstitial explains why) |

`data-ncb-link` is a styling hook; the listener injects a small `<style>` block (allowed by `style-src 'unsafe-inline'`) so states are visible without script. Archived pages never contain a raw external `href`. The full URL scheme is in [api.md](api.md#5-archive-listener-url-scheme).

### 4.3 Combined search

```
 query -> POST /api/search
      |
      +-- parse operators (site: type: before: after: "phrase" -exclude)
      +-- local: search worker -> FTS5 (BM25) + typo/did-you-mean + filters   (ms)
      +-- zim  : zim worker -> each enabled ZIM's Xapian index, 800 ms budget  (ms-100s ms)
      |
      v  response 1 (immediate): local+zim fused by weighted RRF, searchId, coverage so far
      |
      +-- online (only if enabled, online, query allowed): provider runner
              searxng | brave | mojeek, in parallel, 4 s timeout each
              each result -> canonical URL, dedup, provenance, storagePolicy applied
      |
      v  SSE /api/search/{searchId}/events : provider results arrive as events
 client applies APPEND-ONLY rule; ordering FROZEN once the user interacts
```

Local results never wait for providers. A provider failure produces a `provider` event with an error code and never changes local results.

### 4.4 Storage pressure and eviction

```
 admission (before download)           maintenance tick / low-space event
      |                                        |
 reserve bytes on volume ---fails---> plan eviction (pure planner, dry-run capable)
      |                                        |
      |                  0 throttle P4 downloads
      |                  1 delete unreferenced blobs past grace
      |                  2 surplus/superseded versions (not retained by any ref)
      |                  3 P4 versions, then P3, then P2 only if permitted; never P1
      v                                        |
 run download                         execute: mark version `evicting` + refcounts (one txn)
                                      -> remove from index (outbox) -> delete blob files later
                                      -> interrupted? recovery finishes from the `evicting` marker
```

Rules are specified exactly in [data-model.md](data-model.md#5-effective-priority-and-eviction-eligibility).

## 5. Database

- **Two SQLite files.** `main.db` (everything authoritative) and `index.db` (the derived full-text index). Both WAL, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`, `STRICT` tables, modest `cache_size`.
- **Single writer per file.** `main.db`: main thread. `index.db`: `index` worker. A lock file in `/data` refuses a second `server` instance. Never on NFS/SMB; use a named volume on Linux.
- **Thin interface.** All access goes through a `Db` interface (`prepare`, `transaction`, `pragma`, `backup`) so `node:sqlite` or another engine remains possible. Drizzle 0.45.x defines schema and migrations; raw SQL is used for FTS5, partial indexes and queue claims.
- **Migrations** run at boot inside a transaction after a `VACUUM INTO` backup of `main.db`, forward-only. The index carries its own `schema_version`; an incompatible index is rebuilt, never migrated.
- **Cross-database consistency.** `main.db` writes an `index_outbox` row in the same transaction as the change; the `index` worker applies it to `index.db` and records the last applied id. Drift is detectable (`main` knows the expected document count) and repairable by rebuild.
- **Backups** use `VACUUM INTO` or the online backup API, never a raw file copy of a live WAL database.

Full schema: [data-model.md](data-model.md).

## 6. Search, crawling, storage

### Search

- `SearchIndex` interface (`upsert`, `remove`, `search`, `suggest`, `rebuild`, `stats`) with one implementation in v1: SQLite FTS5 in its own file. A Meilisearch or Typesense adapter is a documented possibility, not planned work ([technology-decisions.md](technology-decisions.md#search-engine)).
- Ranking is BM25 with column weights plus freshness, link-graph, preference and a modest cached-content boost, composed in application code ([data-model.md](data-model.md#6-search-index-database-indexdb)).
- Merging uses weighted RRF (k=60, local weight 1.5), canonical URL dedup, provider attribution and an append-only progressive protocol.

### Crawling

- Small custom crawler on `undici` and the `jobs` table. The frontier is the set of `jobs` rows of type `fetch` for a crawl. One in-flight request per host is a database invariant (`host_state.in_flight`), not a convention.
- The SSRF guard: validating `connect.lookup`, a separate IP-literal check, manual redirects re-validated at every hop, decoded-size counter cap, port and scheme allowlists.
- Deterministic link prioritisation (main article, headings, related, navigation, footer), crawl-trap rules and profile presets (Focused, Balanced, Comprehensive, Custom).

### Storage

- Content-addressed blobs on one or more **volumes**, reference-counted through `asset_references`. Priorities are P1 Protected, P2 Important, P3 Standard, P4 Opportunistic. The planner is a pure function, as in NoConMedia, with exhaustive tests. Note the numbering differs from NoConMedia (P0 to P3 there).

## 7. Optional containers

### Renderer

- Off by default. Triggered only by cheap deterministic heuristics (empty JS shell) after a normal fetch, as a second job type `render` ([research/crawling-rendering.md](research/crawling-rendering.md) section 2.4).
- Chromium does its own DNS, so application-level SSRF checks are not enough. The renderer sits on an **internal-only** Docker network and is launched with `--proxy-server` pointing at a **guarded forward proxy** listener inside `server` (CONNECT and HTTP, same lookup validation and IP-literal checks, internal port, not published). The renderer has no route to the LAN or the internet except through that proxy. This is a design choice made in this plan beyond the owner's "egress-firewalled" requirement; a host `DOCKER-USER` firewall script is the documented fallback.
- Limits: `mem_limit` 700 MB to 1 GB, `pids_limit`, read-only root, tmpfs `/tmp`, `--init`, seccomp profile instead of `--no-sandbox`, concurrency 1, fresh browser context per page, browser restart every N pages. Evidence: [research/crawling-rendering.md](research/crawling-rendering.md) section 2.2 (about 80 MB per extra simple page above a 129 MB idle browser; script-heavy pages likely 150 to 300 MB).
- Control plane: `server` calls `POST http://renderer:8080/render`; the renderer never touches the database.

### SearXNG

- Official image (amd64, arm64, arm/v7), about 100 to 130 MB resident ([research/search-providers.md](research/search-providers.md) section 1). Config mounted at `/etc/searxng/settings.yml` with `search.formats: [html, json]`. Limiter off on the private network; documented warning if the port is published.

## 8. Security boundaries

### Origins and trust zones

| Zone | Origin | Trust | What runs there |
|---|---|---|---|
| App | `http://host:3000` | Trusted | `web` (Next.js). Session cookie. |
| API | `server:3001` (internal) | Trusted | Fastify. Cookie auth, CSRF, `Sec-Fetch-Site` gate. |
| Archive | `http://host:3002` | **Untrusted content** | Archive listener. No auth, no cookies, no API. |
| Live web | anywhere | Untrusted | Only reached by explicit user action (new tab) or the guarded fetcher. |
| Renderer | internal network | Untrusted code execution | Chromium; reaches the web only via the guarded proxy. |

### The cookie finding, and what follows

The research verified that an HttpOnly session cookie set by `localhost:4000` is sent to `localhost:4001`, and that script on `:4001` used it to read a privileged API on `:4000` ([research/crawling-rendering.md](research/crawling-rendering.md) section 5.2, tests A, E, I). `SameSite` does not help (same site, different port), and the `__Host-` prefix needs HTTPS. Therefore:

1. **The sandbox, not the port, is the isolation.** The separate port keeps archive responses off the app's origin; it provides no cookie isolation.
2. Every archive response carries `Content-Security-Policy: sandbox` as a **header**. This protects the page when someone opens the archive URL directly in a tab (test I) as well as when it is framed.
3. The iframe has `sandbox` with neither `allow-scripts` nor `allow-same-origin`. The pair together would let the page remove its own sandbox.
4. The archive listener is a separate `http.Server` and route table. It ignores `Cookie` headers, never sets cookies, has no auth middleware and no API routes. Authorisation is an HMAC-signed, expiring token in the path, minted by the API for a logged-in user.
5. The API rejects any request whose `Sec-Fetch-Site` is `same-site` or `cross-site` unless it carries the CSRF header and a matching `Origin`. `same-origin` and `none` (direct navigation) pass. This protects the app even if script were to run on the archive origin.
6. The session cookie is `ncb_session` (not `nocon_session`) so two NoCon apps on one host do not overwrite each other's cookies.

### Archive response headers (all route classes)

```
Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:;
  style-src 'self' 'unsafe-inline'; font-src 'self'; media-src 'self';
  frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none';
  object-src 'none'; frame-ancestors <app origin from token>
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: private, no-store           (HTML)  |  private, max-age=31536000, immutable  (versioned resources)
```

- Only the interstitial route `/m` adds `allow-popups allow-popups-to-escape-sandbox` to the CSP `sandbox` directive, so "Open the live site" works while ordinary archived pages cannot open windows. The iframe attribute includes the same two flags; the more restrictive of header and attribute applies per document.
- No `script-src`: `default-src 'none'` blocks all scripts, and the rewriter has already removed them.
- `Cross-Origin-Resource-Policy` is omitted until tested (the research did not test it).
- An integration test fetches **every route class** and asserts the header set (task A-13, H-03).

### Content handling rules

- Sanitisation is defence in depth: allowlist rewrite on parse5. The CSP sandbox is the primary control.
- `<script>`, event handlers, `javascript:` URLs, `<iframe>`, `<object>`, `<embed>`, `<base>`, `<meta http-equiv=refresh>`, `target=_top|_parent`, prefetch hints and form actions are removed or neutralised. SVG is treated as active content.
- ZIM content is untrusted too: same listener, same headers, scripts from the ZIM dropped (collapsible sections and table of contents degrade; accepted).
- ZIM search snippets: HTML with only `<b>` allowed.

### Live sites

Default is a prominent "Open original" link (`target=_blank rel="noopener noreferrer"`). An optional framed preview is attempted only when all hold: online, `https`, the host passes the SSRF guard, and a server-side `HEAD` probe through the guard shows no `X-Frame-Options` and no restrictive `frame-ancestors`. The frame uses `sandbox="allow-scripts allow-forms allow-popups"`, no `allow-same-origin`, `referrerpolicy="no-referrer"`. Otherwise the external-tab fallback is used. The app never strips framing headers or proxies live pages. The web app's `frame-src` is `'self'` plus the archive origin, and `https:` only when live frames are enabled in settings. Many large sites forbid framing (research: GitHub, BBC, MDN, Reddit).

### Authentication and API hygiene

Copied from NoConMedia ([security.md](../../NoConMedia/docs/security.md)) unless stated:

- Admin setup (only while no admin exists), `scrypt` (N=2^15, r=8, p=1) with `timingSafeEqual`, minimum length 10, at most 2 concurrent hashes.
- Sessions: 32 random bytes, SHA-256 stored, cookie `ncb_session` (`HttpOnly`, `SameSite=Lax`, `Secure` when `NCB_COOKIE_SECURE=true`), 30-day sliding expiry with 90-day absolute cap, revocable.
- CSRF: `X-NoCon-CSRF: 1` on every state-changing request plus `Origin`/`Referer` match.
- Login throttle (5/min/IP, 20/hour/username, recorded before hashing); global API rate limit.
- Client IP: `NCB_PROXY_SECRET` shared by `web` and `server`; `web` drops client-supplied forwarding headers and stamps the real peer address.
- Optional **trusted-LAN mode** (off by default): requests from configured private CIDRs get read-only access to browse and search. It never grants mutation, settings or admin access, refuses to start without an admin account, and refuses non-private CIDRs. Users and roles are modelled (`users.role`) so multiple users can be added later; enterprise RBAC is out of scope.
- Provider credentials are encrypted at rest with `NCB_SECRET_KEY` and never returned by the API (`hasCredentials` only).
- Path safety: `resolveInside(root, rel)` with realpath checks, as in NoConMedia `packages/shared/src/paths.ts`. Volume roots must be under `NCB_VOLUMES_ALLOWED_ROOTS`. Blob paths derive from the SHA-256, never from user input.
- Containers: UID 1000, `no-new-privileges`, `cap_drop: [ALL]`, read-only root for `web` and `server` (writable `/data`, `/volumes`, tmpfs `/tmp`).

## 9. Offline behaviour

| Capability | Offline | How |
|---|---|---|
| UI shell, themes, fonts | Yes | Next.js standalone, self-hosted fonts, no CDN, no telemetry |
| Local search, autocomplete, filters, did-you-mean | Yes | `search` worker over `index.db` |
| Cached browsing, reader mode, find-in-page | Yes | Archive listener, serve-time rewriting |
| Bookmarks, history, collections | Yes | `main.db` |
| Storage and queue inspection | Yes | API |
| Fetching, online search, Wikipedia | No | Queue offers "download when online" |

**Connectivity detection without telemetry.** The `server` derives state from the outcome of its own outbound requests (passive) and from an optional probe URL the Human configures (`NCB_CONNECTIVITY_PROBE_URL`, empty by default). The initial state is `unknown`, treated as online for user-initiated fetches that fail fast. A "work offline" switch forces offline: no provider calls, no crawling, no discovery. The state is shown in the chrome and returned by `GET /api/system/connectivity`. Archived pages and interstitials never trigger external requests whatever the state.

## 10. Raspberry Pi profile

Targets: Pi 5 (4/8 GB) primary, Pi 4 (4/8 GB) secondary, ARM64 Linux and AMD64. 32-bit OS is not supported. SSD over USB is recommended; an SD card works but is not recommended for `/data` and volumes.

| Setting | `pi-lite` (default on ARM64) | `standard` | Status |
|---|---|---|---|
| Global fetch concurrency | 2 | 6 | proposed, to be measured |
| Per-host concurrency | 1 | 1 | fixed default |
| Per-host delay | 1500 ms | 1000 ms | proposed |
| Extraction workers | 1 | 2 | proposed |
| Extraction `resourceLimits` | 256 MB heap | 512 MB heap | proposed |
| Max parsed HTML | 5 MB | 10 MB | from research (5 MB) |
| Renderer concurrency | 1 (if profile on) | 1 | from research |
| SQLite `cache_size` main / index | 32 MB / 64 MB | 64 MB / 256 MB | research: 32 to 64 MB advised for SD |
| Disk free floor | 10% or 5 GiB | 5% or 5 GiB | proposed |
| Bandwidth cap | none | none | optional setting |
| Index `optimize` | idle only | idle only | |

SD-card care: WAL on, no routine `VACUUM`, batched writes, content-addressed writes (a re-capture of unchanged content writes no blob), logs through Docker `json-file` with rotation, `PRAGMA optimize` not `ANALYZE` on all tables ([research/crawling-rendering.md](research/crawling-rendering.md) section 7.3).

The engine choice was benchmark-led: FTS5 completed 50,000 pages inside a 512 MB container; Meilisearch and Typesense were killed at 512 MB ([research/search-engines.md](research/search-engines.md) section 3). Those runs were on an Apple Silicon Mac, not a Pi; Pi numbers are to be measured ([implementation-plan.md](implementation-plan.md#11-performance-targets-to-be-measured)).

## 11. Docker Compose deployment

### Services, networks, volumes

```
networks
  frontend : web, server (published ports 3000 and 3002)
  backend  : internal, web <-> server API (3001 never published by default)
  egress   : default bridge; server (and searxng) reach the internet through it
  render   : internal, server <-> renderer; renderer has no other route

volumes
  ncb-data   -> /data     (main.db, index.db, secrets/, tmp/)    named volume, local disk
  ${NCB_VOLUME_PATH} -> /volumes/default   (blobs, ZIMs)         bind mount, ideally SSD
```

Each service has a `healthcheck`, `restart: unless-stopped`, `mem_limit`, `pids_limit`, `cap_drop: [ALL]`, `no-new-privileges`, json-file log rotation, and `linux/arm64` + `linux/amd64` images built with `docker buildx`. `web` waits for `server` to be healthy; `server` runs migrations on boot before reporting healthy.

Healthchecks: `server` `GET /api/system/health` (database writable, index openable, worker heartbeat fresh, free space above the hard floor; minimal unauthenticated body); `web` `GET /healthz`; `renderer` `GET /health`; archive listener `GET /healthz` on 3002.

Graceful shutdown (`SIGTERM`): stop claiming jobs, stop accepting new requests, wait up to `NCB_SHUTDOWN_GRACE_SECONDS` (default 25; compose `stop_grace_period: 30s`) for running stages to reach a checkpoint or release their leases, flush the index outbox, `wal_checkpoint(TRUNCATE)` on both databases, close.

### Environment variables (to become `.env.example`)

| Group | Variable | Default | Purpose |
|---|---|---|---|
| App | `NCB_APP_URL` | `http://localhost:3000` | Public app URL; used for CSRF `Origin` checks and absolute links |
| | `NCB_WEB_PORT` / `NCB_ARCHIVE_PORT` / `NCB_API_PORT` | 3000 / 3002 / 3001 | Host and container ports; API not published unless `NCB_API_BIND` set |
| | `NCB_ARCHIVE_PUBLIC_URL` | derived from request host + archive port | Override when behind a reverse proxy with a separate hostname |
| Auth | `NCB_PROXY_SECRET` | required | Shared by `web` and `server` (`openssl rand -hex 32`) |
| | `NCB_SECRET_KEY` | generated into `/data/secrets` if absent | Encrypts provider credentials; signs archive tokens |
| | `NCB_COOKIE_SECURE` | `false` | Set `true` behind HTTPS |
| | `NCB_TRUST_PROXY`, `NCB_TRUSTED_PROXY_CIDRS` | `false`, empty | As NoConMedia |
| | `NCB_AUTH_MODE`, `NCB_TRUSTED_LAN_CIDRS` | `password`, empty | Optional read-only LAN mode |
| Database | `NCB_DATA_DIR` | `/data` | Holds `db/main.db`, `index/index.db`, `secrets/`, `tmp/` |
| Storage | `NCB_VOLUMES_ALLOWED_ROOTS` | `/volumes` | Only these roots may be registered as storage volumes |
| | `NCB_VOLUME_PATH` | `./volume` | Host path mounted at `/volumes/default` |
| | `NCB_MIN_FREE_DISK_GB` | 5 | Hard floor; downloads pause below it |
| Resources | `NCB_RESOURCE_PROFILE` | `pi-lite` on ARM64, else `standard` | Preset for the next group |
| | `NCB_MAX_FETCH_CONCURRENCY`, `NCB_PER_HOST_CONCURRENCY`, `NCB_EXTRACT_WORKERS`, `NCB_WORKER_MEMORY_MB`, `NCB_BANDWIDTH_LIMIT_KBPS` | profile | Overrides |
| | `NCB_SERVER_MEMORY`, `NCB_WEB_MEMORY`, `NCB_SERVER_CPUS` | profile | Compose limits |
| Crawl | `NCB_CONTACT` | required for Wikipedia and polite UA | Contact string in the User-Agent (`NoConBrain/<ver> (+<repo>; <contact>)`) |
| | `NCB_CRAWL_DEFAULT_DELAY_MS`, `NCB_CRAWL_MAX_PAGES`, `NCB_CRAWL_MAX_DEPTH`, `NCB_CRAWL_MAX_BYTES_PER_CAPTURE`, `NCB_RESPECT_ROBOTS` | profile | Defaults for new sources |
| | `NCB_PRIVATE_NETWORK_ALLOWLIST` | empty | Operator allowlist for intentional LAN crawling; off by default |
| Providers | `NCB_SEARXNG_URL`, `NCB_BRAVE_API_KEY`, `NCB_MOJEEK_API_KEY` | empty | Seed provider rows on first start only; the app works with none |
| Search | `NCB_INDEX_CACHE_MB`, `NCB_SEARCH_WORKERS`, `NCB_RRF_K`, `NCB_RRF_LOCAL_WEIGHT` | profile, 1, 60, 1.5 | |
| ZIM | `NCB_ZIM_CACHE_MB`, `NCB_ZIM_SEARCH_BUDGET_MS` | 16, 800 | libzim cache sizes, per-search time budget |
| Offline | `NCB_CONNECTIVITY_PROBE_URL` | empty | Optional active probe |
| Logging | `NCB_LOG_LEVEL`, `NCB_LOG_FORMAT`, `NCB_ACTIVITY_LOG_RETENTION_DAYS` | `info`, `json`, 30 | |
| Schedules | `NCB_TZ`, `NCB_SCHEDULER_ENABLED`, `NCB_DOWNLOAD_WINDOW`, `NCB_MAINTENANCE_CRON`, `NCB_BACKUP_CRON` | `UTC`, `true`, empty, `0 3 * * *`, empty | |
| Profiles | `COMPOSE_PROFILES` | empty | `renderer`, `searxng` |

### First-run setup

The wizard (UI over `/api/setup/*`) runs while no admin exists: 1) create the admin; 2) choose and validate the storage volume (marker file, free space, writability, allowed root); 3) choose the resource profile; 4) optionally configure online providers (skippable; the app is fully usable with none); 5) create the first source (default suggestion: a single page or a small section, with a preview and estimate); 6) start archiving. Steps 4 to 6 can be skipped and done later.

## 12. Observability

- Structured logs (pino) with URL credential redaction and `/a/<token>` redaction. Detailed logs per download job and per pipeline stage in `activity_log`, shown on admin screens with filters. Retention is configurable.
- Live status through `GET /api/system/events` (SSE): job progress, worker heartbeat, connectivity, storage thresholds.
- Metrics for benchmarking only (in-process counters exposed on `GET /api/system/metrics` to admins); no external telemetry.

## 13. Extension points (not built)

Notes, highlights, tags, knowledge graph, local AI, semantic search, portable collections and sync are out of scope. Hooks that keep them cheap later: stable public IDs on every entity; `user_id` on user-owned tables; a `SearchIndex` interface (a vector or hybrid adapter can implement it); `page_versions.content_hash` and stored plain text; reserved table-name prefixes `note_`, `highlight_`, `tag_`, `embedding_`; a `jobs.type` registry that accepts new job kinds; WARC/ZIM export planned as job types.
