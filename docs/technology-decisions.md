# Technology decisions

Each decision lists the options considered, the evidence, the decision and the Raspberry Pi considerations. Decisions marked **Owner** were made by the owner and coordinator before planning and are recorded here with the research rationale. Decisions marked **Plan** were made while writing these documents and should be reviewed.

Evidence comes from `docs/research/`. Benchmarks were run on an Apple Silicon Mac in native `linux/arm64` containers, not on a Raspberry Pi, and each configuration was run once ([search-engines.md](research/search-engines.md) section 3). Treat absolute times as optimistic and relative behaviour (what fits, what is killed) as more reliable.

## Summary

| Area | Decision | Source |
|---|---|---|
| Licence | AGPL-3.0, public repo `slaterjohn/nocon-brain` | Owner |
| Runtime | Node 24 on Debian trixie-slim (glibc) | Owner, research |
| Database | SQLite via `better-sqlite3` 13, WAL, single writer | Owner |
| ORM / migrations | Drizzle ORM 0.45.x, raw SQL for FTS5 and queue claims | Owner |
| Queue | Own `jobs` table with leases and `UPDATE … RETURNING` claims | Owner |
| Search engine | SQLite FTS5 in a separate `index.db`, behind `SearchIndex` | Owner |
| Typo layer | Vocabulary table + trigram FTS5 + edit distance | Owner |
| Crawler | Custom, on `undici` | Owner |
| Extraction | `linkedom` + `@mozilla/readability`; `defuddle` for metadata | Owner |
| Sanitising | Allowlist rewrite on `parse5`; CSS via `css-tree` | Owner |
| ZIM | `@openzim/libzim` in a worker thread; federated search | Owner |
| Rendering | Optional Playwright `chromium_headless_shell` container | Owner |
| Providers | SearXNG, Brave (transient), Mojeek | Owner |
| Capture format | Content-addressed blobs + SQLite manifests; WARC export later | Owner |
| Wikipedia | Core REST `page/{title}/html`, 1 req/s | Owner |

---

## Database

**Options:** SQLite (`better-sqlite3`), SQLite (`node:sqlite`), PostgreSQL, libSQL.

**Evidence**
- NoConMedia uses Postgres and Redis. For NoConBrain those two containers cost resident memory and operational surface on a Pi, and the search index wants to live next to the data ([search-engines.md](research/search-engines.md) section 5: FTS5 is "same transaction as the archive row", no dual write).
- `better-sqlite3` 13 ships prebuilt `linux-arm64` and `linux-x64` binaries inside the npm package; no compiler is needed. Claim-and-complete cost 1.48 ms per job against 1.57 ms for `node:sqlite` in the same benchmark; bulk insert of 50,000 rows 83 ms against 70 ms ([crawling-rendering.md](research/crawling-rendering.md) section 7.4).
- `node:sqlite` is Stability 1.2 (release candidate) and ships FTS5, Porter and trigram tokenisers ([search-engines.md](research/search-engines.md) section 2). `spellfix1` is not compiled into any standard build.
- SQLite 3.53.4 is bundled by `better-sqlite3` 13.0.3.

**Decision (Owner):** `better-sqlite3` with `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`, `STRICT` tables, one writer per file. A thin `Db` interface keeps `node:sqlite` or another database possible. Re-evaluate `node:sqlite` when it leaves release-candidate status.

**Pi considerations**
- WAL with `synchronous=NORMAL` can lose the last committed transactions on power loss but cannot corrupt the database. Jobs and captures are re-creatable. User data that cannot be recreated (bookmarks, collections, settings, sources) is small and lives in the same file, so the single writer connection switches to `PRAGMA synchronous=FULL` around the short transactions that write it and back to `NORMAL` afterwards (the research recommends `FULL` for such data; task F-03 confirms the cost on SD and SSD).
- Never place a database on NFS/SMB or an unsuitable Docker Desktop bind mount. Use a named volume on native Linux.
- Run `wal_checkpoint(TRUNCATE)` at idle and on shutdown; watch the WAL size (6 MB after 50,000 inserts in the queue test).

## ORM and migrations

**Options:** Drizzle 0.45.4, Drizzle 1.0 RC, Kysely, hand-written SQL.

**Evidence:** `drizzle-orm` latest stable is 0.45.4; the 1.0 line is on the `rc` tag with changing migration formats. The query builder does not cleanly express `UPDATE … RETURNING` with a subquery, FTS5 virtual tables or partial indexes ([crawling-rendering.md](research/crawling-rendering.md) section 7.5). Drizzle was not run during research.

**Decision (Owner):** Drizzle 0.45.x for schema and migrations; raw SQL (`sql` fragments or prepared statements) for FTS5, the queue claim and hand-written custom migrations (virtual tables, triggers). Migrations run at boot after a `VACUUM INTO` backup. A spike task (F-03) verifies `drizzle-kit generate` plus custom SQL migrations with `better-sqlite3` before the schema is relied on.

**Pi:** none specific. The Drizzle runtime is small; migrations run once at start.

## Job queue

**Options:** own `jobs` table; `liteque` 0.10.0; `bunqueue`; `better-queue-sqlite`; BullMQ (Redis); pg-boss (Postgres).

**Evidence:** no SQLite queue models per-host concurrency, crawl delay, priorities from link scoring or normalised-URL dedup in the claim query. `liteque` is generic and brings its own schema; BullMQ and pg-boss need extra services. Own table: 50,000 inserts in 83 ms, about 650 claim-and-complete cycles per second, about 1.5 ms each. Crawl rates are far below that ([crawling-rendering.md](research/crawling-rendering.md) section 7.2).

**Decision (Owner):** own `jobs` table, leases with heartbeat, claim by atomic `UPDATE … RETURNING` inside `BEGIN IMMEDIATE`, reaper for expired leases, backoff in `run_at`, dead-letter state. One in-flight request per host is enforced through `host_state.in_flight` updated in the same transaction as the claim.

**Pi:** the queue does not need tuning. Prune finished rows into daily counters to keep the table small.

## Search engine

**Options:** SQLite FTS5 plus our typo layer; Meilisearch 1.56; Typesense 30.2; Tantivy (library); Manticore Search.

**Evidence** (50,000 Simple English Wikipedia articles, mean body 2.1 KB, 230 queries, three measured passes):

| | FTS5 | Meilisearch | Typesense |
|---|---|---|---|
| Index time (unrestricted) | 11.2 s | 22.0 s | 19.3 s (stem on) |
| On-disk size | 333 MiB | 1,376 MiB | 246 MiB |
| Query p50 / p95 | 0.57 / 6.0 ms (in-process) | 3.6 / 7.6 ms (client, HTTP) | 2.9 / 21.7 ms |
| Typo p50 / p95 | 4.0 / 9.1 ms | 3.4 / 5.2 ms | 2.8 / 20.1 ms |
| 1 GB memory limit | OK | OOM-killed (also tuned) | OK (peak 505 MiB) |
| 512 MB memory limit | OK, 13.2 s | OOM-killed (also tuned) | OOM-killed at 50k |
| Index lives in RAM | no | no (LMDB mmap) | yes (about 440 MiB steady at 50k; about 9 GB linear extrapolation at 1M pages) |
| Stemming | Porter (English) | none | per field |
| Phrase search with stemming | works | works | wrong results (21 of 30 phrase queries empty) |
| Licence | public domain / MIT | MIT; Enterprise files BUSL-1.1 | GPL-3.0 |

([search-engines.md](research/search-engines.md) sections 2 and 3; raw JSON in `docs/research/search-bench/results/`.) Caveats from the research: each configuration ran once; SQLite is queried in-process while the others are over HTTP; Meilisearch and Typesense prefix-match the last word by default; **nothing was run at 500k to 1M documents**.

**Decision (Owner):** SQLite FTS5 as the only v1 engine, behind a `SearchIndex` interface (`upsert`, `remove`, `search`, `suggest`, `rebuild`, `stats`), in a **separate `index.db`** so it can be deleted and rebuilt from stored content. Features built by us on top of FTS5:

- BM25 column weights `bm25(fts, 10, 5, 3, 1)` for title, headings, URL, body (benchmark values; tuned in S-08).
- Porter plus `unicode61 remove_diacritics 2` tokenisers; one FTS table per language group.
- Vocabulary + trigram tables for typo tolerance and "did you mean".
- Prefix indexes 2/3/4 and a separate small title-only FTS table for autocomplete.
- OR fallback when an AND query returns nothing (the benchmark had 12 of 30 filtered queries return zero without it).
- Operator parser: `site:`, `type:`, `before:`, `after:`, `"phrase"`, `-exclude` becoming `WHERE` clauses and FTS5 expressions.
- Synonym table expanded at query time (never at index time, to avoid rebuilds).
- `snippet()` and `highlight()` for highlighting.

No Meilisearch or Typesense in v1. A Meilisearch adapter is a documented possible later addition: it is the better fit of the two (mmap model, MIT licence). Caveats to record if it is ever added: no stemming and no BM25 weights; 12x disk amplification (1.4 GB for 115 MB of text); indexing killed at 1 GB and 512 MB; the Enterprise Edition code is BUSL-1.1 and needs a legal read before bundling an image in a Compose file ([search-engines.md](research/search-engines.md) section 2, "Licensing notes").

**Pi considerations**
- FTS5 used about 125 MB of process memory for queries and ran the 512 MB case unaffected.
- The known quality gap: after typo correction, "astronamy" did not put the Astronomy article in the top five because the corrected-term group was scored like any query. Planned fixes (untried): rank candidates by edit distance then document frequency, keep only the top candidate when its frequency dominates, boost exact title matches, use the OR group only when the best single correction returns nothing. Task S-05 builds a quality suite from `queries.json` and the spot-check table to prove the fix.
- Common-term queries cost more as match sets grow. Mitigations: stop-word list, title-and-headings first pass, candidate cap, hot-query cache. Task S-13 measures 50k and 500k on a real Pi.

## Typo tolerance and suggestions

**Options:** `spellfix1`; vocabulary + trigram FTS5 (benchmarked); SymSpell in memory; external engine.

**Evidence:** vocab + trigram handled typos at 4.0 ms p50 / 9.1 ms p95 with 275,840 terms built in 0.7 s. `spellfix1` is a loadable extension absent from standard builds, so using it would mean shipping a native extension per platform ([search-engines.md](research/search-engines.md) sections 2 and 4).

**Decision (Owner):** vocabulary table (`term`, `df`) plus a trigram FTS5 table, an edit-distance filter in JS (max 1 for 4 to 6 letters, 2 for 7 and more), candidates ordered by distance then frequency. Prune terms with `df = 1` that look like numbers or junk. The did-you-mean text is a by-product.

**Pi:** vocabulary grows with the corpus; pruning and an upper bound on candidate OR terms (3) keep the typo path under about 10 ms in the benchmark.

## Crawler libraries

**Options:** custom on `undici`; Crawlee 3.18.2; `got` 16.2.0.

**Evidence:** `@crawlee/http` installs 109 packages and 37 MB; the custom set (`undici`, `robots-parser`, `normalize-url`, `fast-xml-parser`) is 11 packages and 4.8 MB. Crawlee's queue is part of its storage layer and a custom backend is undocumented for JavaScript. Our needs (per-host concurrency 1, `Crawl-delay`, scoring priorities, URL-key dedup in the app database, version history) do not map to it. `got` is built on `http` and obscures the SSRF control point ([crawling-rendering.md](research/crawling-rendering.md) section 1).

**Decision (Owner):** custom crawler of roughly 500 lines:

| Need | Library |
|---|---|
| HTTP | `undici` 8.x (requires Node 22.19 or newer; crashed on 22.13.1 in testing, so Node 24) |
| robots.txt | `robots-parser` 3.0.1 plus our RFC 9309 status handling (2xx parse; 4xx allow all; 5xx or network failure disallow temporarily; first 500 KiB; 24 h cache) |
| Sitemaps, feeds | `fast-xml-parser` 5.x with our own caps and a small RSS/Atom/RSS 1.0 normaliser |
| URL dedup key | WHATWG `URL` then `normalize-url` 10 with our options; key only, never the fetched URL |
| Registrable domain | `tldts` 7.x |
| IP classification | `ipaddr.js` 2.5.0, unicast-only |

`normalize-url` options (from verified behaviour): custom tracking list `[/^utm_/i, 'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid', '_ga', 'igshid', 'ref_', 'PHPSESSID', 'sid']`, `stripWWW: false`, `removeTrailingSlash: false`. It would otherwise merge `www` with the apex and change what the server returns.

Notes: `undici.request()` does not decompress (returned 101,935 gzip bytes), so use `fetch()` or the decompress interceptor and count decoded bytes ourselves; `maxResponseSize` on an Agent gave `UND_ERR_INVALID_ARG` with `fetch()`.

**SSRF guard (Owner):** a validating `connect.lookup` that returns only unicast addresses, plus a **separate IP-literal check** because `connect.lookup` is not called for IP literals (verified for `127.0.0.1`, `[::1]`, `2130706433`, `0x7f.1`, `[::ffff:127.0.0.1]`, `169.254.169.254`, `100.64.0.1`); manual redirects, at most 5 hops, the full guard at each hop; `http:`/`https:` only; ports 80 and 443 plus an allowlist; no credentials in URLs; connect 10 s, headers 15 s, body 30 s and a wall-clock deadline; decoded-size counter cap (a 100 MB zero body compressed to 101,941 bytes was cut at 2,015,232 decoded bytes in testing); content-type allowlist plus sniffing.

**Pi:** concurrency defaults (global 2, per host 1) are chosen for slow cores and storage; politeness bugs are the main reputational risk, hence the database invariant.

## Content extraction

**Options:** `linkedom` + `@mozilla/readability`; `jsdom` + Readability; `defuddle`; `trafilatura` (Python); `@postlight/parser`; `metascraper`.

**Evidence** (Apple Silicon, mean of 3, about 1.2 MB pages):

| Page | linkedom + Readability | jsdom + Readability | defuddle + jsdom | defuddle + linkedom |
|---|---|---|---|---|
| Wikipedia "Raspberry Pi" | 177 ms | 633 ms | 7,701 ms | 760 ms |
| Node `fs` docs | 294 ms | 1,633 ms | 13,509 ms | 874 ms |

Peak RSS on the largest page: linkedom 321 MB, jsdom 661 MB. On the Node docs page, linkedom's Readability result had an empty title. A Pi is estimated at 5 to 10 times slower per parse (estimate, not measured) ([crawling-rendering.md](research/crawling-rendering.md) section 4).

**Decision (Owner):** `linkedom` + `@mozilla/readability` as the main path; `defuddle` (with linkedom only) as a second opinion and for metadata; our own code for title, OpenGraph and JSON-LD with the precedence in the research (title: `og:title`, JSON-LD `headline`, cleaned `<title>`, first `<h1>`); `franc-min` 6.2.0 for language after `<html lang>` and `Content-Language`; dates stored with source and confidence, never the fetch date as publication date. Extraction runs in a worker thread with `resourceLimits`, a 5 MB parse cap and node-count and depth caps.

**Pi:** extraction is the main CPU cost; one worker by default. Expect 1 to 3 s for a 1 MB page on a Pi (estimate; measured in H-04).

## Sanitising and rewriting

**Options:** strip `<script>` only; DOMPurify; `sanitize-html`; allowlist rewrite on `parse5`.

**Evidence:** stripping scripts leaves `on*` handlers, `javascript:` URLs, `<iframe srcdoc>`, `<object>`, `<embed>`, `<meta refresh>`, `<base>`, SVG scripts and prefetch hints. DOMPurify targets jsdom (660 MB peak). `sanitize-html` uses htmlparser2, which is not a spec-compliant HTML5 parser. `parse5` parsed and serialised 1.1 to 1.3 MB pages in 49 to 71 ms with a 160 MB peak ([crawling-rendering.md](research/crawling-rendering.md) section 5.4).

**Decision (Owner):** allowlist rewrite on `parse5` (parse, walk, drop everything not on an element/attribute allowlist, rewrite URLs, serialise), CSS and inline styles through `css-tree` (never regexes). Sanitising is defence in depth; the CSP sandbox header is the primary control. Reader content is built from Readability output and sanitised the same way.

**Pi:** rewriting happens at serve time. Add a small LRU of rewritten HTML (bounded in bytes) if serve latency needs it (measured in A-13).

## ZIM reading

**Options:** `@openzim/libzim` in a worker thread; kiwix-serve sidecar.

**Evidence:**
- `@openzim/libzim` 4.7.0 (GPL-3.0, Node >=22 <27) has no prebuilt binaries; it downloads a prebuilt libzim 9.8.2 and compiles the N-API wrapper with node-gyp. On `node:24-trixie-slim` arm64 with `python3 make g++` it built in about 44 s and produced 53 MB. On Alpine it builds but fails at load (glibc-built libzim) ([zim-wikipedia.md](research/zim-wikipedia.md) section 1).
- On a 132 MB ZIM: open 9.4 ms, article read under 1 ms, full-text first page 10 ms, process RSS 91 MB. Pi numbers are unmeasured.
- The API is synchronous; a cold search on a 100 GB ZIM may block noticeably (untested), so reads go to a worker. A libzim crash kills the process that hosts it.
- kiwix-serve: official multi-arch image (88 MB), 62 MiB resident after a few requests; isolated crashes, but HTTP and XML parsing, an extra container and rewriting from its URL scheme.

**Decision (Owner):** in-process `@openzim/libzim` in a dedicated `zim` worker; a small `ZimSource` interface (open, get, suggest, search) so kiwix-serve could be added as an optional profile later. Federated search: each enabled ZIM is queried through its internal Xapian index, in parallel, with an 800 ms budget; hits are merged by **rank**, not score (scores are 0 to 100 and relative to the best hit of each query). Snippets are sanitised to `<b>` only. Pre-fetch and pin `LIBZIM_VERSION` for reproducible builds and allow-list the package's install scripts (npm 11 warns; `--ignore-scripts` breaks the install).

**Licence:** GPL-3.0 section 13 permits combining GPL-3.0 and AGPL-3.0 code, and libzim is GPL-2.0-or-later (usable under GPL-3.0), so linking into an AGPL-3.0 server is compatible. This is a reading of the licences, not legal advice; the research flags it for review before release ([zim-wikipedia.md](research/zim-wikipedia.md) section 2). Wikipedia text inside ZIMs is CC BY-SA 4.0; attribution is stored per package.

**Pi:** use `mini` (13 GB), topic subsets or Simple English on a Pi; `nopic` (49 GB) needs a spare 64 GB; `maxi` is 119 GB. Tune `setClusterCacheMaxSize` and `setDirentCacheMaxSize` (`NCB_ZIM_CACHE_MB`). Cold first touch on SD or USB disk is expected to be much slower than the 10 ms measured; to be measured in Z-02.

## Rendering approach

**Options:** HTTP only; Playwright `chromium_headless_shell` in a separate container; `jsdom` with scripts; Debian `chromium`; read framework JSON first.

**Evidence:** Playwright 1.64.1 runs on arm64 Debian/Ubuntu (not Alpine). A minimal image was 1.32 GB uncompressed (browser 276 MB, apt layer about 630 MB), too heavy for the main image. Memory: 129 MB idle, about 80 MB for the first simple page above that, 75 to 80 MB per further simple page. `jsdom` with `runScripts` would execute untrusted code in our process ([crawling-rendering.md](research/crawling-rendering.md) section 2).

**Decision (Owner):** HTTP crawling by default. Optional `renderer` compose profile with concurrency 1, a hard memory limit and a fresh context per page, triggered only by deterministic heuristics after a normal fetch (extracted text under about 200 characters while raw HTML exceeds 20 KB with script tags, an empty mount node, framework markers with an empty shell, Readability null, or a per-site flag; never for non-HTML, error statuses, robots-blocked pages or a never-render host list). Cheap alternatives are tried first: embedded JSON (`__NEXT_DATA__`, JSON-LD) and site feeds. Egress control is described in D-4 below.

**Pi:** on a 2 GB Pi the profile is not recommended; on 4 GB set a 1 GB limit. Output is not byte-identical between runs, so versions of dynamic sites will show noise; `only when changed` versioning compares extracted text, not raw HTML.

## Search providers

**Options:** SearXNG, Brave Search API, Mojeek, Marginalia, Kagi, Exa, Tavily, Google Custom Search, Bing.

**Evidence** ([search-providers.md](research/search-providers.md)):

| Provider | Status (1 Nov 2026) | Storage terms | Decision |
|---|---|---|---|
| SearXNG | Active, self-hosted, amd64/arm64/arm-v7 image, about 100 to 130 MB RAM; JSON must be enabled (403 otherwise) | No SearXNG limit; upstream engine terms are the operator's | Build; optional compose profile |
| Brave | $5 per 1,000 requests, $5 monthly credit, 50 QPS; terms forbid storing or caching results except transient storage | **Transient only** | Build; never persist results |
| Mojeek | £2 per 1,000 (Startup), 5 QPS; cache 1 hour on Startup, indefinite on Business | `ttl` | Build |
| Marginalia, Kagi, Exa, Tavily | Active; storage terms unconfirmed or unknown | Unknown | Not built in v1; documented |
| Google Custom Search | Closed to new customers; ends 1 Jan 2027 | n/a | **Not built** |
| Bing Web Search | Retired 11 Aug 2025; replacement returns LLM-grounded answers | n/a | **Not built** |

**Decision (Owner):** adapter architecture with SearXNG, Brave (transient only: results are never stored; saving a result archives the page itself from the original site) and Mojeek. Each adapter declares `storagePolicy` (`none`, `ttl:<seconds>` or `unrestricted`); the result cache and the index writer enforce it, and a database trigger rejects cache rows for providers whose policy is `none`. The runner, not the adapters, owns timeouts (4 s), at most one retry for retryable errors, token buckets, circuit breakers after 429, monthly request caps, offline skipping and privacy rules. Google CSE and Bing are documented as not built. A generic JSON provider (URL template plus JSONPath) is deferred; see O-12.

Open items from the research that block shipping specific adapters: confirm Brave's live pricing and storage-rights plan; read Mojeek's full terms; test SearXNG over several days from a home IP for CAPTCHAs.

**Pi:** providers are network calls with small payloads; the SearXNG profile adds about 130 MB resident and should be off on a 2 GB Pi.

## Capture format

**Options:** raw HTML plus content-addressed assets with serve-time rewriting; WARC (`warcio`, `wabac.js`); SingleFile; monolith.

**Evidence:**

| | Own format | WARC + wabac.js | SingleFile | monolith |
|---|---|---|---|---|
| Cross-capture asset dedup | native (SHA-256, refcount) | weak | none | none |
| Version history | manifest row per capture | whole file per version | whole file per version | whole file per version |
| Replay on plain-HTTP LAN IP | our server | service worker needs a secure context (HTTPS or localhost) | open file | open file |
| Runs archived JS | no | yes (`wombat.js`) | no | no |
| Capture needs a browser | no (optional) | yes or a proxy | yes (Chromium) | no |

([crawling-rendering.md](research/crawling-rendering.md) section 3.) The Pi is typically opened at `http://<lan-ip>:3000`, where service workers will not register.

**Decision (Owner):** own format: blobs at `blobs/ab/cd/<sha256>` (zstd for text types, using Node 24's built-in zstd), temp file then rename, a per-capture manifest in SQLite (`page_versions`, `assets`, `asset_references`), reference counts maintained in the same transaction, link rewriting at serve time. WARC export via `warcio` in a later phase (task Z-10); monolith single-file export optional later. The rewriter becomes product-critical (CSS `url()`, `srcset`, `@import`, inline styles, `<base>`, SVG `href`), hence the corpus-based tests in A-12.

**Pi:** one blob write per unique content; re-capturing an unchanged asset writes nothing. Verify SHA-256 in a background scrub, not on every request.

## Web, API and tooling

Copied from NoConMedia (patterns copied, no package imports): pnpm 10 monorepo, TypeScript 5.9, Fastify 5, zod 4, Next.js 16 App Router (standalone), Tailwind 4, shadcn/ui, lucide-react, Vitest, Playwright with axe, `tsup` for server bundles, `cron-parser` for schedule computation, `pino` for logs. UI copy and docs in UK English. Acceptance status is recorded honestly in `docs/acceptance.md` once code exists.

UI additions for this project: self-hosted fonts only; design tokens as CSS variables for light and dark themes; WCAG 2.2 AA with axe in CI plus manual keyboard and screen-reader passes (H-05).

---

## Additional decisions made in this plan

These are not in the owner's list. Review them before Phase 1 starts.

### D-1: Archive URL scheme

Chosen: `/a/{token}/…` on the archive port, with route classes `p` (latest version of a page), `v` (a specific version, with sub-resources and reader), `m` (interstitial), `z` (ZIM entry). Full definition in [api.md](api.md#5-archive-listener-url-scheme).

Rejected: `/r/{encodedUrl}`. It puts full URLs (with query strings and personal terms) into paths, logs and `Referer` chains; it needs fragile double-encoding; it couples links to URLs rather than stable IDs; it leaves open which version is shown. Capture-ID-only paths (`/a/{captureId}/{path}`) were also rejected because a rewritten link would have to name one version and would go stale when a page is re-captured.

### D-2: Search reads in their own worker

A `search` worker holds a read-only connection to `index.db` so a slow common-term query or an OR fallback cannot block the API's event loop, and so search is not queued behind an `index` worker rebuild (WAL allows concurrent reader and writer). This adds a worker kind to the owner's list (extraction, indexing, ZIM reads). Cost: one extra thread; memory is mostly shared page cache.

### D-3: Progressive search uses Server-Sent Events

Chosen: `POST /api/search` returns local results and a `searchId`; `GET /api/search/{searchId}/events` streams provider results as SSE. A polling endpoint `GET /api/search/{searchId}?after=<cursor>` is a documented fallback.

Why SSE over polling: one-way server push, native browser reconnect with `Last-Event-ID`, no polling interval to tune (polling adds latency or wasted requests), trivial in Fastify, and negligible cost on a Pi. Why not WebSockets: bidirectional features are not needed and they complicate the proxy. Risk: buffering proxies and the Next.js proxy route; mitigated by `X-Accel-Buffering: no`, a heartbeat comment every 15 s, a streaming-passthrough test (task F-09), and the polling fallback for environments where SSE is buffered.

### D-4: Renderer egress through a guarded proxy

The renderer is on an internal-only network and uses the server's guarded forward proxy (same lookup and IP-literal validation) for every request, rather than relying on host firewall rules. Chromium does its own DNS, so the guard must sit at the network boundary; making the proxy the only route achieves that inside Compose. HTTPS goes through `CONNECT` tunnels (host validated, content not inspected), so per-response byte caps apply to the rendered DOM and recorded resources, not to tunnel bytes; a per-page wall-clock and total-byte budget is enforced by the renderer. Fallback: `scripts/renderer-firewall.sh` for `DOCKER-USER` rules.

**As built (C-16).** The proxy (`apps/server/src/renderer/proxy.ts`) uses `@ncb/fetch`'s `createSsrfGuard` for the URL checks and its `lookup` as the only way a name becomes an address. It answers plain `http://` requests in absolute form and `CONNECT host:port`, requires the shared secret (so other containers on `backend` or `egress` cannot use it), allows at most 6 connections per host with 50 ms between new ones, cuts any tunnel or response at 100 MiB, makes no connection while the server works offline, and does not follow redirects (the browser does, so every hop is a new request and is checked again). On top of that the browser is started with `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE <proxy host>` and `<-loopback>`, so any lookup or loopback request that bypassed the proxy would fail rather than succeed. The Docker test shows the renderer container cannot open a connection to the internet, the LAN or the Docker host, and can reach only the proxy. The `DOCKER-USER` script was not needed and was not written.

### D-5: Address-bar sync via server-side frame state

A sandboxed iframe without scripts cannot report its URL. The token carries a `frameId`; the listener records the last top-level document it served per `frameId` (only for `Sec-Fetch-Dest: iframe` or `document` HTML responses). On the iframe `load` event the shell calls `GET /api/browser/frame-state?frameId=…` and updates the tab's address, title and state. The shell keeps its own history stack and re-creates the iframe for shell-initiated navigation to avoid polluting joint session history. In-frame link clicks and native Back are observed through `load`. A spike (A-14) verifies Chromium, Firefox and WebKit behaviour: Chromium and Firefox pass, WebKit is still to be run (see the result in [implementation-plan.md](implementation-plan.md#3-phase-2-core-archiving)). Fallback needing owner approval: a fixed, hash-pinned first-party script with `allow-scripts` that only `postMessage`s the location; this would contradict "no allow-scripts" and is not planned.

### D-6: Find-in-page by server-side highlighting

The custom find bar cannot read a cross-origin sandboxed frame. The shell calls `GET /api/archive/versions/{id}/find?q=` for the match count; navigation uses the listener's `?hl=<term>` parameter, which wraps matches in `<mark id="ncb-hit-N">`, and next/previous sets the iframe `src` fragment (`#ncb-hit-3`), which scrolls without reloading. The browser's native Ctrl/Cmd+F still works inside the frame. The parent moves the frame with `contentWindow.location.replace(url)`, so no history entry is added. Spike result (Chromium and Firefox pass, no request and no `load` event for a hit change) is in the implementation plan. Fallback if a browser cannot drive the frame: set `iframe.src` with the fragment (reloads), then native find only.

### D-7: Cookie and header names

Session cookie `ncb_session`; CSRF header `X-NoCon-CSRF: 1` (family convention). A distinct cookie name avoids collisions with NoConMedia on the same host, since cookies are not port-scoped.

### D-8: Connectivity detection without telemetry

Passive observation of real outbound outcomes plus an optional, empty-by-default probe URL; a manual "work offline" switch. See [architecture.md](architecture.md#9-offline-behaviour). Alternatives rejected: a default probe to a third-party host (a telemetry-like call every minute, contradicting "no telemetry"); `navigator.onLine` alone (reports the browser's connectivity, not the server's).

### D-9: Identifiers

Every table has an internal `INTEGER PRIMARY KEY`; exposed entities also have `public_id TEXT UNIQUE` (prefixed ULID, e.g. `pg_01J…`). Foreign keys use the integer; the API and URLs use the public ID. IDs are never derived from paths and never reused. Reason: compact indexes on the large tables (`links`, `asset_references`, `jobs`), FTS5 needs integer rowids, and stable opaque IDs satisfy "not coupled to file paths".

### D-10: Retention, eviction and the `automaticEviction` flag

Retention decides which versions a reference retains (and therefore protects at that reference's priority). Eviction decides what may be removed under pressure or as surplus. `automaticEviction=false` on any referencing source makes the whole page immune to automatic eviction; P1 is absolute regardless of the flag. Precise rules: [data-model.md](data-model.md#5-effective-priority-and-eviction-eligibility).

### D-11: Index consistency through an outbox

`main.db` and `index.db` are separate files and cannot share a transaction. Changes that affect the index write an `index_outbox` row in the same `main.db` transaction; the `index` worker applies them in order and records the last applied id. Rebuild is the repair for any drift.

### D-12: Derived text lives in blobs

Readable text, reader HTML and the section outline are stored as content-addressed blobs (kinds `text`, `reader`, `json`), not as columns in `main.db`. This keeps `main.db` small (backup and `VACUUM INTO` cost) and gives free dedup of identical text. Cost: many small files; ext4 with two-level sharding copes, and a packing scheme is a later option if measurements at 500k pages show a problem (risk R-12).

### D-13: Wikipedia endpoint

Decision: use the core REST route `/w/rest.php/v1/page/{title}/with_html`. It returns the Parsoid HTML together with the revision id, timestamp and licence in one call, which halves requests at the 1 request per second budget and stores attribution with each capture. The plain `/html` route stays available behind the `WikipediaClient` interface as a fallback if `with_html` changes. Parsoid HTML, `maxlag=5` on Action API calls, `If-None-Match` on refresh, `Retry-After` handling and a circuit breaker after repeated 429/403 are as in the research.

### D-14: "Knowledge package" means ZIM in v1

Phase 8 "Knowledge packages" is delivered as ZIM import, browse, search and safe removal. A NoConBrain-native portable package and WARC export are extension points (Z-10, post-v1).
