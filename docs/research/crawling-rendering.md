# Crawling, rendering, capture and safe replay: research for NoConBrain

Date of research: 1 November 2026. Target: Node.js/TypeScript, Next.js UI, Docker on Raspberry Pi 4/5 (ARM64) and AMD64.

How to read this: "Verified" means I ran it on this Mac (Apple silicon, Node 22.13.1, Docker Desktop running linux/arm64 containers with Node 24.22.2) or read it in the primary source. "Not verified" means it comes from docs or search results and was not tested. Nothing here was run on a real Pi, so Pi numbers are extrapolations from an arm64 Linux container on a fast machine. PoC scripts are in `docs/research/poc-archive-isolation/`.

## Summary of recommendations

| Topic | Recommendation |
|---|---|
| Crawler | Small custom crawler on our own SQLite queue. `undici` for HTTP, no Crawlee, no got. |
| Support libraries | `robots-parser` (plus our own RFC 9309 status handling), `fast-xml-parser` for sitemaps and feeds, WHATWG `URL` plus `normalize-url` with a custom tracking-parameter list, `ipaddr.js` for address checks. |
| Browser rendering | Optional, off by default. Playwright with `chromium_headless_shell` in a separate container (compose profile `render`), one page at a time on a 2 GB Pi. Trigger only on cheap "this page is an empty JS shell" heuristics. |
| Capture format | Own format: content-addressed blobs (SHA-256) plus a per-capture manifest in SQLite, links rewritten at serve time. Export to WARC/WACZ on demand with `warcio`. Not WARC as the primary store, not SingleFile, not monolith. |
| Extraction | `linkedom` plus `@mozilla/readability` as the main path (about 5 times faster and half the memory of jsdom). `defuddle` (with linkedom) as a second opinion and for metadata. Own metadata extractor over `<head>`, OpenGraph and JSON-LD. `franc-min` for language, with `<html lang>` first. |
| Safe replay | Archive origin on a second port, served by a separate listener, with `Content-Security-Policy: sandbox ...` as a header on every archive response, strict CSP, scripts stripped, all URLs rewritten, and the app embedding it in an iframe with `sandbox` (no `allow-same-origin`, no `allow-scripts`). Treat the second port as providing no cookie isolation at all. |
| SSRF | `undici` Agent with a validating `connect.lookup`, plus a separate pre-check for IP literals (the lookup hook is not called for them: verified). Manual redirects, re-validated each hop. Byte caps counted after decompression. |
| Queue | Own `jobs` table with leases, single writer process. About 1.5 ms per claim-and-complete (verified, 5,000 jobs). Do not adopt a queue library. |
| SQLite driver | `better-sqlite3` 13 (N-API, prebuilt `linux-arm64` ships inside the npm package). `node:sqlite` works and is a reasonable later move, but is still "release candidate" (Stability 1.2). |
| ORM | Drizzle works with both drivers, but `drizzle-orm` 1.0 is still on the `rc` tag. Decide before the first migration whether to start on 0.45.x or on 1.0 RC. |

Biggest findings that change the design:

1. **A second port is not a second cookie scope.** An HttpOnly session cookie set by `localhost:4000` was sent to `localhost:4001`, and script on `:4001` used it to read a privileged API on `:4000` (verified). Only the `sandbox` (opaque origin) or a different host name stopped this.
2. **`Content-Security-Policy: sandbox` as a response header protects the page even when someone opens the archive URL directly in a tab** (verified). This is the key control, because an iframe `sandbox` attribute only protects the framed case.
3. **`undici`'s `connect.lookup` is not called for IP literals** (`http://127.0.0.1/`, `http://2130706433/`, `http://[::ffff:127.0.0.1]/`): verified. DNS pinning alone does not stop SSRF; a literal-IP check is also required.
4. **`undici` 8 needs Node >= 22.19** (it crashed on Node 22.13.1 here with a zstd error). The Docker image should use Node 24.

---

## 1. HTTP crawling in Node

### 1.1 Options

| Option | Notes |
|---|---|
| `undici` 8.12.3 (Oct 2026) | The HTTP client inside Node. 2.1 MB unpacked, no heavy dependencies. Gives `Agent` with a custom `connect` (so we can validate DNS results), `fetch` and `request`, interceptors (redirect, decompress, cache). Needs Node >= 22.19.0 (`npm view undici@8.12.3 engines`). `undici` 7 supports Node >= 20.18.1. |
| `got` 16.2.0 | Friendly API with retries, hooks and cookies. Built on top of Node's `http`, not undici. Adds nothing we need for a polite archiver and makes the SSRF control point less obvious. |
| Crawlee 3.18.2 (`HttpCrawler`/`CheerioCrawler`) | A full framework: autoscaled pool, session pool, request queue, dataset and key-value store, proxy and fingerprint support. Installing only `@crawlee/http` gives 109 packages and 37 MB in `node_modules` (verified), versus 11 packages and 4.8 MB for `undici` + `robots-parser` + `normalize-url` + `fast-xml-parser` (verified). It uses `got-scraping` for HTTP, so our DNS and SSRF hooks would sit behind its abstractions. A 4.0 line exists (`rc` tag 4.0.0-rc.1, `v4` tag at beta.246) but the stable tag is still 3.18.2. |

### 1.2 Does Crawlee fit a SQLite queue we control?

Poorly. Crawlee's queue is part of its storage layer (`@crawlee/memory-storage`, which keeps data in memory and in files under `./storage`). A different backend means implementing its `StorageClient`, which is shaped like the Apify API. I found no documented JavaScript guide for doing that (searches returned only the Python `SqlStorageClient`), so treat the effort as unknown and possibly large. Even if it worked, our queue needs things Crawlee does not model: per-host concurrency of 1 with robots `Crawl-delay`, priorities from link classification, normalised-URL dedup in the same database as the app data, re-crawl scheduling and version history. We would be fighting the framework to get them.

### 1.3 robots.txt, sitemaps, feeds, URL handling

| Need | Choice | Notes |
|---|---|---|
| robots.txt | `robots-parser` 3.0.1 | Last published Feb 2023, so stable rather than active. Handles Allow/Disallow with wildcards, `Crawl-delay`, `Sitemap`. We must add the parts of RFC 9309 that sit around parsing: 2xx parse; 4xx treat as "no rules" (allow all); 5xx or network failure treat as "disallow all" for a while and retry; parse only the first 500 KiB; cache for at most 24 hours (https://www.rfc-editor.org/rfc/rfc9309; I could not fetch the RFC text this session, these points are from memory of the RFC and should be re-checked when implementing). Use our own `User-Agent` token (for example `NoConBrain`). |
| Sitemaps | `fast-xml-parser` 5.11.2 with our own fetch and caps; or `sitemapper` 4.1.6 (maintained, May 2026) | Handle `sitemapindex`, gzip, and the 50,000 URLs / 50 MB limits. Cap recursion depth and total URLs. Sitemap URLs go through the same SSRF guard as any other fetch. |
| RSS/Atom | `fast-xml-parser` with a small normaliser (RSS 2.0, Atom, RSS 1.0) | `rss-parser` 3.13.0 was last published April 2023, `feedparser-promised` in 2022. A normaliser is around 80 lines and avoids stale dependencies. Newer feed libraries exist; I did not evaluate them. |
| Normalisation | WHATWG `URL`, then `normalize-url` 10.0.0 (Oct 2026) with options | See the verified behaviour below. |
| Registrable domain | `tldts` 7.x | For "same site" decisions and per-host grouping. |
| Canonical detection | Our code | Read `<link rel="canonical">` and `og:url`; accept it only if same registrable domain, https or same scheme as fetched, and it resolves (no redirect loop). Store both `requested_url` and `canonical_url`; dedup on canonical only after the page has been fetched at least once. Also honour HTTP `Link: <...>; rel="canonical"`. |

Verified `normalize-url` 10 behaviour (default options):

- Strips `utm_*` but **not** `fbclid`, `gclid`, `ref_` or `PHPSESSID`. We need our own list: `removeQueryParameters: [/^utm_/i, 'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid', '_ga', 'igshid', 'ref_', 'PHPSESSID', 'sid']`.
- Strips `www.` by default (`stripWWW: true`). On the rare site where `www` and the apex differ, this merges them. Set `stripWWW: false` and handle www/apex equivalence via redirects and canonicals instead.
- Collapses `a//b` to `a/b`, drops the trailing `?`, and removes trailing slashes. All three can change what a server returns. Set `removeTrailingSlash: false`, and treat the output as a **dedup key**, not as the URL we fetch. Fetch the URL as discovered (after fragment removal); use the normalised form for `UNIQUE(url_key)`.
- IDN is converted to punycode and paths are percent-encoded consistently.

### 1.4 Recommendation

Write a small custom crawler. The shape is about 500 lines: a worker loop that claims a job from SQLite, checks robots and politeness, fetches through the guarded `undici` Agent, stores the body, extracts links, and enqueues. The framework's value (autoscaling, fingerprinting, proxies) is aimed at large scraping fleets, not a polite single-user archiver on a Pi.

Risks:

- Re-implementing HTTP edge cases (charset detection from headers, BOM and `<meta charset>`; use `iconv-lite` or `TextDecoder`, which Node ships).
- `undici.request()` does not decompress bodies (verified: it returned the 101,935 gzip bytes). Use `fetch()`, or the decompress interceptor that ships in undici 8 (`lib/interceptor/decompress.js`, seen in a stack trace; I did not test it).
- Politeness bugs are the main reputational risk. Make "one in-flight request per host" a database invariant (see section 7), not a convention.

---

## 2. Optional browser rendering

### 2.1 Playwright Chromium on ARM64 Linux

- Official support: yes. The Playwright intro page lists Debian 12 and 13 and Ubuntu 22.04, 24.04 and 26.04 as "x86-64 or arm64" (https://playwright.dev/docs/intro). Alpine/musl is not supported (https://playwright.dev/docs/docker), so use a Debian or Ubuntu base.
- Playwright 1.64.1 installed `chromium_headless_shell` (Chromium 156) on linux/arm64 and ran (verified).
- The official image `mcr.microsoft.com/playwright:v1.64.1-noble` is large; a Docker Hub mirror lists about 860-895 MB compressed for arm64 (https://hub.docker.com/r/limesoda/playwright/tags), and I did not confirm the official figure.
- My own minimal image (verified, arm64): `node:24-bookworm-slim` is 352 MB; adding `playwright` plus `npx playwright install --with-deps --only-shell chromium` brought it to **1.32 GB** uncompressed. The browser itself is 276 MB (`chromium_headless_shell-1248`), and the `--with-deps` apt layer is about 630 MB. That is too heavy to put in the main app image, which supports the separate-container design below.
- Docker flags from the Playwright docs: `--init` (avoids zombie processes), `--ipc=host` (otherwise Chromium can run out of shared memory and crash), and for untrusted sites a non-root user with a seccomp profile so the Chromium sandbox works (https://playwright.dev/docs/docker). Running as root disables the Chromium sandbox. For a Pi, prefer the seccomp approach over `--no-sandbox`, because we are loading hostile pages.

### 2.2 Memory

Measured inside an arm64 Linux container (Docker Desktop VM, 12 CPUs, so timing is optimistic; memory is more transferable):

| State | cgroup memory | Sum of process RSS (over-counts shared pages) |
|---|---|---|
| Browser launched, no page | 129 MB | 195 MB |
| 1 page (1.2 MB Wikipedia HTML, file URL) | 209 MB | 458 MB |
| 4 pages (1 + 3 heavy 1 MB pages) | 439 MB | 959 MB |

So about 80 MB for the first page above the idle browser, and about 75-80 MB for each extra simple page, with real-world script-heavy pages likely 150-300 MB. A web search found one older report of Chromium on a 2 GB Pi 4 and rough "1-2 GB per Chromium instance" guidance for VPSs (https://github.com/microsoft/playwright/issues/5067, https://use-apify.com/blog/run-playwright-scrapers-vps); neither is current Pi data. **Plan for a render container with a hard memory limit (for example 1 GB on a 4 GB Pi, 700 MB on a 2 GB Pi), concurrency 1, a fresh browser context per page, and a restart of the browser after N pages.**

### 2.3 Lighter fallbacks

| Option | Verdict |
|---|---|
| jsdom with `runScripts: "dangerously"` | Not a real browser (no layout, partial APIs) and it would execute untrusted code inside our Node process. Do not use. |
| Firefox via Playwright | Also has arm64 Linux builds, but is no lighter in practice. Not worth a second engine. |
| `chromium` from Debian (`apt`) | Smaller to maintain on Debian; Docker's hardened Playwright image does this. Version drift against Playwright's protocol expectations is a risk. Not recommended for v1. |
| Reading framework data (JSON in `__NEXT_DATA__`, `application/ld+json`, `window.__INITIAL_STATE__`) | Cheap and often enough. Do this before launching a browser. |
| Site-provided APIs and feeds | If a feed exists, use it. |

### 2.4 When to trigger rendering (heuristics, all deterministic)

Run after a normal fetch and extraction, and only if the browser container is enabled:

1. Extracted main text is under about 200 characters (or under 100 words) while the raw HTML is over about 20 KB and contains `<script src>` tags.
2. The body is dominated by a single empty mount node: `<div id="root"></div>`, `<div id="app"></div>`, `<div id="__next"></div>` with no children, or `<noscript>` text such as "You need to enable JavaScript".
3. Known framework markers with an empty shell: `data-reactroot` absent but `/_next/static/` or `/static/js/main.` present and no text; Angular `<app-root></app-root>` empty.
4. Readability returns null or a score far below the visible-text length of the `<body>`.
5. A user flag on the site or the capture ("always render this one").
6. Never trigger for: non-HTML, error statuses, pages blocked by robots, or hosts in a "never render" list.

Rendering should be a **second job type** (`render`) in the same queue, enqueued from the normal fetch result, so the main crawler never depends on the browser container being present.

### 2.5 Keeping it optional

- Separate service in `docker-compose.yml` under `profiles: ["render"]`, with its own image (`noconbrain-render`), `mem_limit`, `pids_limit`, `read_only: true` root, a tmpfs for `/tmp`, and a network that can reach only the internet (never the app, database or LAN).
- The render worker talks to the app only through the queue (it needs a way to read jobs and write results). Simplest is an HTTP endpoint on the render container that the crawler calls (`POST /render {url}` returning the DOM and the sub-resources list). That keeps the SQLite single-writer rule: only the app process writes.
- The render container must apply the same SSRF rules. Chromium does its own DNS, so the guard has to be network-level: run it on a Docker network with egress firewall rules that drop RFC 1918, link-local, loopback and metadata ranges, and also use Playwright request interception (`page.route('**/*')`) to refuse private hosts. DNS rebinding means interception alone is not enough; the firewall is the real control.
- Capture result is the post-render DOM (`page.content()`) plus the responses seen (`page.on('response')`) for assets, stored the same way as plain captures.

Risks: browser memory spikes on a 2 GB Pi; Chromium CVEs (pin the Playwright version and rebuild regularly); render output is not byte-identical between runs, so version history will show noise for dynamic sites.

---

## 3. Capture format

### 3.1 Comparison

| | Raw HTML + content-addressed assets, rewrite at serve time | WARC (`warcio`, wabac.js, replayweb.page) | SingleFile (CLI) | monolith |
|---|---|---|---|---|
| Fidelity of the original bytes | High: store exactly what was received | Highest: full request/response records with headers | Medium: a DOM serialisation, assets inlined as data URIs, scripts removed | Medium: static HTML with inlined assets; no JS |
| Fidelity of appearance | Good for static pages; depends on our rewriter | Best: replays JS-heavy pages through a service worker | Good for the rendered state at capture time | Good for static pages only |
| Dedup of shared assets | **Native** (one blob per SHA-256, refcount in DB) | WARC has `revisit` records but within one file; cross-capture dedup needs extra indexing (WARC 1.1 spec) | **None**: every file embeds its own copy (base64 adds about 33 %) | None, same as SingleFile |
| Version history | Easy: a capture is a manifest row pointing at blobs | Possible: one WARC per capture, dedup is weak | Poor: whole file per version | Poor |
| Offline replay | Our own server, under our CSP | Service worker replay: needs a secure context (HTTPS or localhost) | Open the file, or serve it | Open the file |
| Search/extraction | We keep the HTML, so we can re-extract | Need to read the WARC back first | Must parse a huge HTML file | Same |
| Pi cost | Low: plain files plus SQLite | Medium: replay is in the browser; capture needs a browser or a proxy | High for capture: needs a Chrome/Chromium; the `single-file` standalone binary for linux-aarch64 is 107 MB and still drives a browser | Low: Rust binary, 7.3 MB (`monolith-cli-linux-aarch64`, v2.11.7, 29 Oct 2026; verified from release assets) |
| Interop | Export needed | Industry standard | Common among hobbyists | Niche |

Sources: warcio.js supports reading and writing WARCs and gzip, in Node 18+, with a Node-specific serialiser that buffers large payloads to disk; it lacks Brotli payload decoding and URL canonicalisation (https://github.com/webrecorder/warcio.js). wabac.js is "designed to be run as service worker (or web worker)" (https://github.com/webrecorder/wabac.js). SingleFile CLI needs Chrome/Chromium (or Firefox via WebDriver BiDi) (https://github.com/gildas-lormeau/single-file-cli). Service workers require HTTPS apart from `localhost` (https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers).

### 3.2 Why not WARC as the primary store

- **The Pi is usually opened over plain HTTP on a LAN IP** (for example `http://192.168.1.20:3000`). That is not a secure context, so wabac.js/replayweb.page service workers will not register there. Replay would only work on `localhost` or behind HTTPS.
- Replay injects `wombat.js` and runs the archived page's own JavaScript. That directly contradicts "no scripts by default" for untrusted content.
- Dedup across captures is a spec requirement. WARC files do not give it for free.
- The service worker would have to live on the archive origin, which makes the isolation design more complicated, not simpler.

### 3.3 Why not SingleFile or monolith as the primary store

Both inline assets into each page, so shared CSS, fonts and images are duplicated per capture. That makes content-addressed dedup and reference counting impossible. SingleFile also needs a browser for every capture. They are good **optional exports** or an "also save as single file" action, not the store.

### 3.4 Recommendation: own format, WARC export on demand

Store:

- `blob` files at `data/blobs/ab/cd/<sha256>` (zstd-compressed for text types; Node 24's zlib has zstd and `undici` 8 depends on it), written to a temp file and renamed. `blobs` table: `sha256 PK, size, stored_size, mime, refcount, created_at`.
- `captures`: `id, url_id, fetched_at, status, final_url, canonical_url, render_mode (plain|browser), main_blob, headers_json (an allowlist: content-type, last-modified, etag, link, content-language), extractor_version`.
- `capture_resources`: `capture_id, url, blob_sha256, kind (html|css|img|font|js|other), status, content_type, discovered_from`. This table is what the serve-time rewriter looks up. Reference counts change in the same transaction as insert/delete of capture resources; garbage collection deletes blobs whose refcount has been 0 for a grace period.
- Extracted reader content and metadata as separate rows (and an FTS5 index), so search never has to parse archived HTML.

Serve time: the archive server reads the main HTML blob, rewrites it (section 5), and serves it. Because the original bytes are kept, improving the rewriter later fixes all old captures.

Export: write a WARC from the manifest using `warcio` (one `response` record per resource, plus `resource`/`metadata` records for extraction), for interoperability and backups. This is a feature to add later, with no impact on the core design.

Risks: our rewriter is now product-critical (CSS `url()`, `srcset`, `@import`, inline styles, `<base>`, SVG `href`); JS-driven pages lose behaviour (accepted: reader view and static view are the product, scripts are off); loose hash trust (verify the SHA-256 on read in a background scrub job, not on every request).

---

## 4. Content extraction

### 4.1 Libraries

| Library | Version | Notes |
|---|---|---|
| `@mozilla/readability` | 0.6.0 (Mar 2025) | The reference algorithm. 188 KB installed. README says it does not sanitise output and to use DOMPurify or CSP for untrusted content; `isProbablyReaderable()` is a quick pre-check (https://github.com/mozilla/readability). The README example uses jsdom; linkedom also works (verified below). |
| `linkedom` | 0.18.15 | Lightweight DOM, 2.8 MB installed. Not a full browser DOM but sufficient for Readability. |
| `jsdom` | 30.1.3 | Full DOM, 8.3 MB installed, much heavier at runtime. Keep script execution off (default). |
| `defuddle` | 0.19.6 (Oct 2026) | Newer extractor that also returns title, language, published date, site name and word count. Accepts any DOM (linkedom, jsdom, happy-dom). With jsdom it was very slow in my test (7-14 s); with linkedom it took 0.8-0.9 s, so use it with linkedom only. |
| `trafilatura` (Python) | Mature | Strong benchmark results for boilerplate removal, but adds a Python runtime and process boundary to a Node/Docker image. An npm package named `trafilatura` 0.2.0 exists; I did not evaluate it. Not recommended for v1. |
| `@postlight/parser` | 2.2.3 (2024) | Unmaintained since 2024. Skip. |
| `metascraper` | 5.58.5 | Metadata scraping with plugins; heavier than a few hundred lines of our own code. Optional. |

### 4.2 Measured: Readability with different DOMs

Single-threaded on this Mac, mean of 3 parses, ~1.1-1.3 MB HTML pages (Wikipedia articles and the Node.js `fs` docs). Peak memory is for the whole process including Node's baseline of about 40 MB.

| Page | linkedom + Readability | jsdom + Readability | defuddle + jsdom | defuddle + linkedom |
|---|---|---|---|---|
| Wikipedia "Raspberry Pi" (1.3 MB) | 177 ms | 633 ms | 7,701 ms | 760 ms |
| Wikipedia TLD list (1.2 MB) | 238 ms | 1,006 ms | 9,756 ms | 790 ms |
| Node `fs` docs (1.1 MB) | 294 ms | 1,633 ms | 13,509 ms | 874 ms |

Peak RSS on the largest page: linkedom 321 MB, jsdom 661 MB. Both extracted nearly the same amount of text from the same page. One difference: on the Node docs page linkedom's Readability result had an empty title (jsdom and defuddle found "File system | Node.js v26.13.0"), so take the title from our own `<title>`/OpenGraph code, not from Readability.

These are Apple-silicon timings; a Pi 4 will be roughly 5-10 times slower per parse (estimate, not measured). That still keeps linkedom at around 1-3 seconds for a 1 MB page, whereas jsdom could reach 10+ seconds and 600 MB. **Use linkedom.** Guard with a maximum HTML size to parse (for example 5 MB) and run extraction in a worker thread with a memory limit (`resourceLimits`) so one pathological page cannot take down the process.

parse5 (the spec-compliant parser used by jsdom) parsed and serialised 1.1-1.3 MB pages in 49-71 ms, with a 160 MB peak process (verified). That makes it a good basis for the rewriter in section 5.

### 4.3 Metadata extraction

Write one function `extractMetadata(document, url)` over `<head>` and JSON-LD, with this precedence:

- **Title**: `og:title` > JSON-LD `headline` > `<title>` cleaned of site suffix > first `<h1>`.
- **Description**: `og:description` > `<meta name=description>` > JSON-LD `description` > first paragraph of reader text.
- **Site name, image, type, author**: `og:*`, `article:author`, `<meta name=author>`, JSON-LD `author`.
- **Dates**: `article:published_time`, JSON-LD `datePublished`/`dateModified`, `<time datetime>` inside `<article>`, `<meta name=date>`, then URL patterns like `/2026/10/31/`. Store the source of the date and a confidence flag. Never use the fetch date as a publication date.
- **JSON-LD**: parse every `script[type="application/ld+json"]`, tolerate invalid JSON, flatten `@graph`, cap size. Safe to do because it is data and never executed.
- **Language**: `<html lang>` and `Content-Language` first. If missing or `und`, run `franc-min` (6.2.0, 127 KB, supports about 82 languages) on the first 2,000 characters of reader text; below about 50 characters, report unknown. `tinyld` 1.3.4 is accurate but 12 MB; `cld` 2.10.1 is a 109 MB native module and a poor fit for ARM images. Both are alternatives, not recommendations.
- **Headings and sections**: from the Readability output, walk `h1`-`h6` in order and build a section list with `{level, text, anchor id, start offset, text}`. Index each section as its own FTS row so search can return "page > section".
- **Reader content**: store the sanitised Readability HTML (images remapped to blob URLs) and plain text.

### 4.4 Main-content link classification (deterministic)

For each `<a href>` found in the parsed DOM, compute features and a score from 0 to 1, used to set the crawl priority:

1. **Region**: inside `<main>`, `<article>`, `[role=main]`, or the Readability-selected node = "content" (+). Inside `<nav>`, `<header>`, `<footer>`, `<aside>`, `[role=navigation|banner|contentinfo|complementary]`, or an element whose id/class matches `nav|menu|footer|sidebar|cookie|comment|share|social|breadcrumb` = "chrome" (-).
2. **Link density of the container**: for each ancestor block, `link_text_chars / total_text_chars`. Above about 0.6 with many links = a list or menu (-). Low density with long text = prose (+).
3. **Anchor text**: empty, "click here", "read more", or a single icon = weak; 3 to 12 words = strong.
4. **Position**: later links in the document after the main content (footer) are weaker; links within the first N paragraphs of the article are stronger.
5. **Same site vs external**, `rel` attribute (`nofollow`, `sponsored`, `ugc` = (-)), and `download` attributes.
6. **URL shape**: login, logout, cart, share, tag/archive/page/N pagination patterns, and query-heavy URLs get (-). Same path prefix as the current page gets (+).

Priority is `base(depth) + content_score*weight`. Content-region links on same-site pages are fetched first; chrome links are fetched last or never (configurable). All of this runs on the DOM we already parsed, no ML.

Risks: sites with no semantic landmarks (only `div`s) fall back to link density only; keep the weights configurable and log the score components so poor crawls can be debugged.

---

## 5. Safe offline rendering

### 5.1 Threat model

An archived page is arbitrary attacker-controlled HTML, CSS and (if kept) JavaScript. Threats: script reading app data or cookies; script calling the app's APIs with the user's cookies (CSRF or authenticated read); data exfiltration to the live web; tracking pixels and live requests when "offline"; the page navigating the whole browser tab away (phishing); clickjacking; popups; form posts to attacker sites.

### 5.2 What I tested

PoC (`docs/research/poc-archive-isolation/matrix.mjs`): three local servers on `localhost`: app (:4000, sets an HttpOnly `sid` cookie and a readable `theme` cookie, has a privileged `/api/secret`), archive (:4001, serves a "malicious" page) and a stand-in for the live web (:4002, logs every request). The malicious script tries: read `document.cookie`; read `top.location` and `parent.document`; navigate `top`; use `localStorage`; `fetch` the app API with credentials; `fetch` and `sendBeacon` to the web; `window.open`; submit a form; and the HTML also loads a tracking image and a remote stylesheet. Chromium 156 (Playwright 1.64.1).

| # | Setup | Result (verified) |
|---|---|---|
| A | iframe, **no sandbox, no CSP**, archive on `localhost:4001`, app on `localhost:4000` | Script saw the non-HttpOnly cookie (`theme=dark`). The HttpOnly `sid` was **sent by the browser** on its `fetch` to the app, and the app returned `TOP-SECRET`. Also reached the web (fetch, image, stylesheet), opened a popup and submitted a form. Reading `top.location`, `parent.document` and assigning `top.location` were blocked (cross-origin, `SecurityError`). The `sid` cookie was also sent with plain asset requests to the archive port. |
| B | iframe `sandbox="allow-scripts"`, **no CSP** | Opaque origin: `document.cookie` and `localStorage` threw `SecurityError`; top navigation blocked. The app request carried **no cookie** (`Origin: null`, cross-site) but the app still returned the data because my test app reflects any origin with CORS credentials. Without CSP the page still reached the live web (fetch, tracking image, stylesheet). Popup and form submission were blocked by the sandbox. |
| C | iframe `sandbox="allow-scripts"` + CSP `default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'` | Everything blocked: no cookie, no storage, `fetch` to app and to web blocked by `connect-src`, no tracker image, no remote CSS (only `img-src 'self'` allowed), popup and form blocked. The server logs showed only requests to the archive origin. |
| D | iframe `sandbox=""` (no scripts) + strict CSP | Script blocked by the sandbox ("Blocked script execution ... allow-scripts permission is not set"); no external requests. |
| E | No sandbox + strict CSP, no scripts allowed | No scripts ran and no external requests happened, but the **HttpOnly app cookie was still sent** with the asset request to the archive port. |
| F | Archive on `127.0.0.1:4001`, app on `localhost:4000`, no sandbox, no CSP | `document.cookie` was empty and the request to the app carried no cookie. Different host name = different cookie jar. Everything else (web access, popup, form) still worked. |
| G | `<a target=_top>` clicked by the user | Unsandboxed cross-origin iframe: top frame navigated away. `sandbox=""` and `sandbox="allow-scripts"` and `allow-popups`: top frame stayed. `allow-top-navigation-by-user-activation`: top navigated. |
| H | `<a target=_blank>` to a live site inside a sandboxed iframe | `sandbox=""`: nothing opens. `allow-popups`: a popup opens but **inherits the sandbox** (scripts blocked, so the live site looks broken). `allow-popups allow-popups-to-escape-sandbox`: the live site opens normally. |
| I | Archive URL opened **directly in a tab** (no iframe) | Plain page: script read the cookie jar (HttpOnly not visible, but the credentialed `fetch` to the app returned `SECRET-DATA` and carried the `sid` cookie). With response header `Content-Security-Policy: sandbox allow-scripts; ...`: `document.cookie` and `fetch` both blocked, and the app saw no request. |

Cookie facts confirmed: the browser sends cookies for `localhost` to every port on `localhost`, and `SameSite` does not help because `localhost:4000` and `localhost:4001` are the **same site**. The app saw `Sec-Fetch-Site: same-site` for the request from `:4001` (verified in test I), while the sandboxed case is `cross-site`. RFC 6265 states that cookies do not isolate by port (section 8.5; I could not fetch it this session, the behaviour above is the evidence).

### 5.3 Why a separate port is not a separate cookie scope

Cookies are scoped by host and path (and `Secure`), not by port. If the app is at `http://192.168.1.20:3000` and the archive at `http://192.168.1.20:3001`:

- Every cookie the app sets for `192.168.1.20` is sent to `:3001` too, including HttpOnly ones. Script on the archive port cannot read HttpOnly cookies, but it can make credentialed requests to `:3000` that carry them.
- `localhost`, `127.0.0.1`, `[::1]` and `192.168.1.20` are four different hosts with four different cookie jars, but the user may reach the app through any of them, and the archive link is generated relative to the host the user used. Generating `http://<same-host>:3001` always yields a shared jar.
- Cookies set by the archive origin (for example by an archived page's script, or by `Set-Cookie` in a captured response if we mistakenly pass it through) are sent to the app. This is cookie tossing: an attacker can try to overwrite the app's cookies.
- Path scoping of the app cookie (`Path=/app`) helps only if the archive server never answers on that path; it does not stop the browser sending the cookie to `:3001/app/...`, and the app on `:3000` still accepts credentialed requests that originate from script on `:3001`.
- `SameSite=Strict` does not help: same-site includes any port. The `__Host-` cookie prefix requires `Secure` (HTTPS), so it is unavailable on a plain-HTTP LAN deployment.

Consequences (design rules):

1. The sandbox, not the port, is the isolation. The archive port is a convenience that keeps archive responses on a different origin from the app, so the sandboxed frame cannot be same-origin with the app even if the sandbox attribute is missing by mistake.
2. The session cookie: `HttpOnly; SameSite=Lax; Path=/; Secure` when HTTPS is available. Do not rely on `Path`. Do not use a cookie name the archive server could ever read, and **the archive server must not parse cookies, must ignore them and must never `Set-Cookie`.**
3. App endpoints that change or return private data must check `Sec-Fetch-Site`: accept `same-origin` (and `none` for direct navigation), reject `same-site` and `cross-site`. Also check `Origin` against an allowlist and require a custom header (for example `X-NCB-CSRF`) on state-changing requests, so a credentialed request from script on the archive port fails. I verified that the header takes the value `same-site` in this situation. This is the control that protects the app if script ever does run on the archive origin.
4. The archive server process should be a **separate listener and route table** that has read-only access to the blob store and manifests, serves nothing else, and shares no auth middleware. It does not know about sessions. Authorisation for archive URLs is by unguessable capability token in the URL path (for example `/a/<token>/<capture_id>/...`) minted by the app for the logged-in user, short-lived, so the archive port does not need cookies at all.
5. Every archive response carries `Content-Security-Policy: sandbox ...` as a header, so that even a direct visit or a missing iframe attribute is sandboxed (test I).

### 5.4 Concrete design

**Origins**

- App: `http://host:3000` (Next.js).
- Archive: `http://host:3001` (small Node server, same container or a sibling container sharing the data volume). On a single-port Docker deployment, the archive listener is started in the same container with a second `EXPOSE`/`ports` mapping; one process can bind two ports. If only one port may be exposed (reverse proxy), use a second hostname at the proxy (`archive.example.lan` vs `app.example.lan`), which gives a true separate cookie scope and is preferable when available. On plain `ip:port`, document that port-only separation depends on the sandbox and the checks in 5.3.
- Archive URL form: `/a/<token>/<capture>/<kind>/<encoded-original-url>`, where the token is HMAC-signed with an expiry. Every rewritten link in a page is an absolute-path URL on this origin, so nothing is ever relative to the live site.

**Response headers on every archive response**

```
Content-Security-Policy: sandbox allow-popups allow-popups-to-escape-sandbox;
  default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline';
  font-src 'self'; media-src 'self'; frame-src 'none'; connect-src 'none';
  form-action 'none'; base-uri 'none'; object-src 'none';
  frame-ancestors http://<app-origin>
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Resource-Policy: same-site   (see note)
Cache-Control: private, max-age=0 for HTML; immutable for content-addressed blobs
```

Notes:

- `sandbox` in the CSP header (without `allow-scripts` and without `allow-same-origin`) gives an opaque origin even on direct navigation. `allow-popups` plus `allow-popups-to-escape-sandbox` is there only so the "open live site" link on the interstitial can open a normal tab (test H). Omit these two if you prefer to handle that link in the app shell.
- `frame-ancestors` should list the app origin as the user reached it; compute it from the request's `Referer`/signed token (the app mints the token for the host the user is on), not from a fixed host.
- `Cross-Origin-Resource-Policy` is only useful for archived sub-resources loaded in the frame. Because the framed document has an opaque origin, its sub-resource requests are cross-origin; use `cross-origin` for those or drop the header. Test this when building; I did not.
- A `script-src` is intentionally absent, so `default-src 'none'` blocks all scripts, and the HTML rewriter has already removed them.
- `img-src 'self' data:` covers images stored as blobs. Inline `style` attributes need `style-src 'unsafe-inline'`, accepted because CSS cannot run code, but CSS can still request URLs: that is why the CSS rewriter (below) matters and why `img-src`/`font-src` are limited to `'self'`.

**Iframe in the app shell**

```html
<iframe src="http://host:3001/a/<token>/..."
        sandbox=""            <!-- default: no scripts, no forms, no popups, no top-navigation -->
        referrerpolicy="no-referrer" loading="lazy" credentialless></iframe>
```

- Default `sandbox=""`; add `allow-popups allow-popups-to-escape-sandbox` only if the shell wants live-link tabs. Never add `allow-same-origin` together with `allow-scripts` (that combination lets the framed page remove its own sandbox). Test G and H show the effect of each flag.
- A per-capture opt-in "run scripts" mode (for example for an interactive chart) is possible as a separate, explicit, warned action: `sandbox="allow-scripts"` and a CSP with `script-src 'self'` plus `connect-src 'none'`. Test C shows this stays contained: no cookies, no storage, no network. `credentialless` is a newer attribute; I did not test it, so treat it as optional.
- The shell shows a browser-chrome bar: capture date, version selector, "open original", "open live in new tab".

**Preventing top-frame navigation**: no `allow-top-navigation*` flags (verified: blocked for `""`, `allow-scripts`, `allow-popups`). The CSP `sandbox` header gives the same protection for direct visits (framing is then irrelevant). Also strip `target="_top"`/`_parent`, `<base>` and `<meta http-equiv=refresh>` in the rewriter.

**Sanitisation versus strip-only**

| Option | Verdict |
|---|---|
| Strip `<script>` only | Not enough: `on*` handlers, `javascript:` URLs, `<iframe srcdoc>`, `<object>`, `<embed>`, `<meta refresh>`, `<base>`, SVG scripts and `<link rel=prefetch|preload|modulepreload|dns-prefetch|preconnect>` all remain. |
| DOMPurify server-side | Strong browser-grade sanitiser, but it officially targets jsdom, which we have chosen not to load for every page (660 MB peak). It also removes things we want to keep for fidelity (`<style>`, forms, `<link>` stylesheets). Best used on the **reader content** only, where fidelity matters less. |
| `sanitize-html` 2.18.1 (htmlparser2) | Allowlist-based, small. htmlparser2 is not a spec-compliant HTML5 parser, so its tree can differ from the browser's (mutation XSS class of bugs). Acceptable for reader content because of the CSP backstop. |
| Allowlist rewrite on **parse5** (recommended for full-page replay) | Parse with parse5 (spec-compliant, 49-71 ms per ~1 MB), walk the tree, drop everything not on an element/attribute allowlist, rewrite URLs, serialise. The browser then re-parses output that came from a spec-compliant serialiser, which avoids most mutation XSS. 160 MB peak in my test. |

Design: sanitiser/rewriter is defence in depth; **the CSP sandbox header is the primary control.** If the sanitiser has a bug, the page still cannot run scripts, read cookies or reach the network.

**URL rewriting (so nothing hits the live web)**

Rewrite, using the capture's `capture_resources` table to decide the target:

- HTML: `a[href]`, `area[href]`, `img[src|srcset]`, `source[src|srcset]`, `picture`, `video[src|poster]`, `audio[src]`, `track[src]`, `link[rel=stylesheet|icon][href]`, `form[action]` (set to the interstitial or remove), SVG `href`/`xlink:href`, `image`, `use`. Resolve each against the page's final URL and `<base href>` first (then drop `<base>`). Drop `srcset` candidates that were not archived.
- Inline `style` attributes and `<style>` blocks: parse with `css-tree` (3.2.1) or `postcss` (8.5.32) and rewrite every `url(...)` and `@import`. Do not use regexes for CSS.
- CSS files: same parser; `@font-face` `src`, `@import`, `image-set()`, `cursor`, `background`.
- `<meta property="og:image">` and similar head URLs: leave as data only (not requested by the browser), but strip prefetch hints.
- `data:` and `blob:` URLs: allow `data:` images up to a size cap; drop `blob:`.
- Anything not found in the manifest: link `href` goes to the interstitial; sub-resource `src` becomes a 1x1 transparent placeholder or is removed. Never leave the original URL in place.

**Uncached links**

`<a href>` to a page that is not archived is rewritten to `/a/<token>/missing?u=<encoded-original-url>` on the archive origin. That route returns a static page (no script) saying "This page is not in your archive", with buttons: "Open the live site" (`<a href=... target=_blank rel="noopener noreferrer">`; requires the popups flags above), "Save this page" (a link to an app route that queues a crawl, requiring the user's own session), and "Back". The URL is shown as text and only used in the link if its scheme is `http` or `https`. Because it is a normal archive response, it carries the same CSP.

Note on offline mode: when the user's server is offline, the interstitial still works; the "live" link simply fails in the new tab, which is the correct behaviour.

**Live websites inside the app**

Most sites forbid framing. A quick `curl -I` of eight popular sites (verified, 1 Nov 2026): GitHub (`X-Frame-Options: deny`, `frame-ancestors 'none'`), BBC (`frame-ancestors 'none'`, `X-Frame-Options: DENY`), MDN (`X-Frame-Options: DENY`) and Reddit (`X-Frame-Options: SAMEORIGIN`) cannot be framed by a third party. Hacker News, nodejs.org and example.com returned neither header, and Wikipedia's CSP was truncated in my output so its `frame-ancestors` is unknown. Reference: `X-Frame-Options` and CSP `frame-ancestors` (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Frame-Options). Do not try to proxy-strip these headers: that makes the app a general-purpose open proxy (SSRF and credential risks).

Recommendation: the default for live content is a prominent "Open original" link (`target="_blank" rel="noopener noreferrer"`). An optional "preview in frame" can be attempted with a sandboxed iframe (`sandbox="allow-scripts allow-forms allow-popups"`, no `allow-same-origin`, `referrerpolicy="no-referrer"`), accepting that many sites will show a blank frame; there is no reliable way to detect a refused frame from the parent, so offer it as a manual toggle with a visible "Open in new tab" button next to it.

### 5.5 Single-port Docker deployment

- The simplest working setup is one container, one Node process tree, two listeners: Next.js on 3000 and the archive server on 3001 (both published). Include both in the Compose file; document how to change them. A reverse proxy (Caddy, Traefik) can add hostnames and HTTPS later; with hostnames the archive gets a real separate cookie scope and `Secure` cookies.
- If a user can publish only one port, offer a fallback mode: serve the archive under `/archive/` on the same origin, **only** with the CSP `sandbox` header and the iframe `sandbox` attribute (opaque origin). This is verified to be safe against cookie and storage access (tests B, C, I) because the CSP sandbox makes the document's origin opaque even when it comes from the same host and port. It is a weaker design because a missing header on any archive route would leave a same-origin page, so add an integration test that fetches every archive route class and asserts the header. Prefer two ports.
- Next.js should not render archive HTML itself; keep it in the plain Node listener so no app middleware, session or cookie handling can touch it.

### 5.6 Residual risks

- A rewriter bug that forgets one URL-bearing attribute: contained by `default-src 'none'` and `img-src 'self'` (tests C, D).
- Browser or Chromium sandbox escapes: out of scope; keep browsers updated.
- Large archived media and decompression: handled at capture time (section 6).
- User disables scripts-off default and opens a hostile page: contained by test C, but warn.
- I did not test Firefox or Safari. `CSP: sandbox` and iframe `sandbox` are baseline features, but run the same PoC against `firefox` and `webkit` (Playwright can install both; WebKit was already cached on this Mac) before release.

---

## 6. SSRF and crawler safety

### 6.1 Controls and what I verified

1. **Resolve once, connect to that IP.** Use an `undici` `Agent` with `connect: { lookup }` where `lookup` resolves with `dns.lookup(host, {all: true})`, filters out disallowed addresses, and returns only allowed ones. The TCP connection uses the address we return, so there is no gap between check and use. With this, `http://localhost:9/` failed with my `ESSRF` error (verified), and the lookup also covers hostnames that point at private addresses.
2. **IP literals bypass `lookup`** (verified): `127.0.0.1`, `[::1]`, `2130706433`, `0x7f.1`, `[::ffff:127.0.0.1]`, `169.254.169.254` and `100.64.0.1` never called `lookup` and went straight to connect. In every case undici attempted a real connection (connection refused or connect timeout, rather than a block). So the crawler must also check `new URL(u).hostname` before dispatch. WHATWG `URL` normalises `2130706433` and `0x7f.1` to `127.0.0.1` (verified), and `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, which `ipaddr.js` classifies as `ipv4Mapped`. Use `ipaddr.js` 2.5.0: allow only `range() === 'unicast'` after unwrapping IPv4-mapped addresses (verified results: loopback, linkLocal, private, carrierGradeNat, uniqueLocal and ipv4Mapped are all blocked; public IPv4/IPv6 are allowed). That one rule covers loopback, private (RFC 1918), link-local (including 169.254.169.254 cloud metadata), CGNAT (100.64.0.0/10), ULA, multicast, reserved and unspecified. Add `fd00:ec2::254` (AWS IPv6 metadata) and any Docker bridge ranges explicitly if they are not covered by the above, and allow an operator allowlist for intentional LAN crawling (default off).
3. **Redirects**: use `redirect: 'manual'`, cap at about 5 hops, and run the full guard (scheme, host literal check, `robots.txt`, politeness) for each hop. A redirect to a different host is a new fetch with its own robots check and rate limit. Only `http:` and `https:` schemes; reject `file:`, `ftp:`, `gopher:` etc. Reject URLs containing credentials (`user:pass@`). Allow ports 80 and 443 plus an optional per-site allowlist.
4. **Timeouts**: connect (about 10 s), headers (`headersTimeout`, 15 s), body (`bodyTimeout`, 30 s) and an overall wall-clock deadline per request via `AbortSignal.timeout`. I used `headersTimeout` and `bodyTimeout` on the Agent without error.
5. **Size caps**: `Content-Length` pre-check, plus a streaming counter on **decoded** bytes. Verified decompression-bomb case: a 100 MB zero-filled body compresses to 101,941 bytes; reading through `fetch()` with a manual reader stopped at 2,015,232 decoded bytes and cancelled (verified). A `maxResponseSize` setting passed to an Agent used with `fetch()` produced `UND_ERR_INVALID_ARG` in my test, so do not rely on it for `fetch`; count bytes yourself. Typical caps: HTML 5 MB, CSS 2 MB, images 15 MB, other 25 MB, configurable; also limit `Content-Encoding` layers (undici rejects more than 5) and total bytes per capture.
6. **Content-type allowlist**: HTML/XHTML (`text/html`, `application/xhtml+xml`), CSS, common images (`image/png|jpeg|gif|webp|avif|svg+xml`), fonts, `application/pdf`, plain text, XML/JSON for feeds and sitemaps. Sniff the first bytes; never trust the header alone. Treat SVG as active content on replay (it can contain script): serve with the same CSP, and strip scripts when rewriting.
7. **Decoded text cost**: cap the number of DOM nodes and depth before extraction; run parsing in a worker thread with `resourceLimits`.

### 6.2 Crawl-trap detection

All rule-based, with counters kept in the database:

- **Repeating path segments**: reject when a segment sequence repeats three or more times (`/a/b/a/b/a/b`) or the same segment appears more than N times.
- **Depth limits**: maximum path depth (for example 12) and maximum crawl depth from the seed.
- **Calendar and date traps**: URL patterns with dates (`/2026/10/31`, `?month=`, `?date=`, `/calendar/`) beyond a window from the seed, or sequential next/previous chains with no content change (compare content hash to the previous page).
- **Session IDs in URLs**: strip known parameters (`PHPSESSID`, `jsessionid`, `sid`, `sessionid`, `s=` of 32 hex characters); skip URLs whose parameter value looks like a random token and differs every visit.
- **Infinite query-parameter space**: a per-host-and-path budget of distinct query strings (for example 50 distinct normalised query variants per path); sort and drop parameters unused by the page; ignore sort/filter/view parameters by default (`sort`, `order`, `view`, `filter`, `page_size`).
- **Duplicate content**: hash the extracted main text (simhash or SHA-256 of normalised text); if N consecutive fetches in a path prefix produce hashes already seen, stop expanding that prefix.
- **Per-host budgets**: maximum pages per host per crawl, per day, and total bytes, with clear UI feedback when exceeded.

### 6.3 Politeness

- One in-flight request per host (database invariant, section 7). Default minimum delay of 1-2 seconds per host; honour `Crawl-delay` from robots.txt (cap at about 30 s to avoid stalls) and `429`/`503` with `Retry-After`; exponential backoff per host with jitter.
- Global concurrency modest (4-8 on a Pi), independent of per-host limits.
- Identify with a real User-Agent and a contact URL. Respect `robots.txt` for automated crawl; for a manually saved single page, the product decision is whether to ignore robots (many archivers do for a user-initiated save). Make that an explicit setting and log it.
- Conditional requests (`If-None-Match`, `If-Modified-Since`) for re-crawls to save bandwidth and avoid new versions when nothing changed.

Risks: DNS rebinding is closed by pinning only if every connection goes through the guarded Agent (HTTP clients inside other libraries and the browser are separate; see 2.5). IPv6 and happy-eyeballs behaviour: `autoSelectFamily` can try more than one address; since `lookup` returns only allowed addresses, this stays safe.

---

## 7. Persistent job queue on SQLite

### 7.1 Options

| Option | Notes |
|---|---|
| Own `jobs` table with leases | Full control of per-host invariants, priorities, dedup, backoff. About 100 lines. |
| `liteque` 0.10.0 (Oct 2026) | SQLite queue for Node (from the Karakeep/Hoarder project), uses Drizzle. Type-safe and simple, but a generic queue: no per-host concurrency, no priorities from our scoring, brings its own schema. |
| `bunqueue` 2.9.21 | "High-performance job queue for Bun" with SQLite; targets Bun. Not suitable for Node on a Pi. |
| `better-queue` + `better-queue-sqlite` | Last published 2022. Skip. |
| BullMQ 6.5.3 / pg-boss 12.38.0 | Need Redis or Postgres. Not "SQLite" and add services to a Pi. |

There is no graphile-worker equivalent for SQLite that fits our needs; a custom table is the right answer because the domain rules are in the claim query.

### 7.2 Schema and claim (verified in the benchmark)

```sql
CREATE TABLE jobs(
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, host TEXT NOT NULL, url TEXT NOT NULL,
  url_key TEXT NOT NULL UNIQUE,              -- normalised URL: dedup
  priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'queued',      -- queued | running | done | failed | dead
  attempts INTEGER NOT NULL DEFAULT 0, run_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER, worker TEXT, last_error TEXT);
CREATE INDEX jobs_ready ON jobs(state, run_at, priority DESC, id);
CREATE INDEX jobs_lease ON jobs(lease_until) WHERE state='running';

-- claim one job atomically
UPDATE jobs SET state='running', lease_until=?, worker=?, attempts=attempts+1
WHERE id = (SELECT id FROM jobs WHERE state='queued' AND run_at<=? ORDER BY priority DESC, id LIMIT 1)
RETURNING id, url;
```

Extend the subquery with `AND host NOT IN (SELECT host FROM jobs WHERE state='running')` and a `host_state(host, next_allowed_at)` table to enforce one in-flight request per host and crawl delay. Keep leases short (for example 2 minutes) and extend them with a heartbeat; a reaper query returns expired `running` rows to `queued` (cost 0.1 ms on 50,000 rows). Retry with `run_at = now + backoff`; after N attempts set `dead`.

Benchmark (Node 24.22.2 on linux/arm64 in Docker on this Mac, `bind mount` on macOS storage, so not Pi or SD-card numbers): 50,000 inserts in one transaction took 83 ms (`better-sqlite3`) and 70 ms (`node:sqlite`). 5,000 claim-then-complete cycles, each its own autocommit statement pair, took about 1.5 ms per job (7.4 s and 7.9 s total, i.e. about 650 jobs per second). Crawl rates will be far below that, so the queue will not be the bottleneck. Both drivers behaved the same.

### 7.3 SQLite operational notes for a Pi

- `PRAGMA journal_mode=WAL; synchronous=NORMAL; busy_timeout=5000; foreign_keys=ON;`. WAL with `synchronous=NORMAL` can lose the last committed transactions on power failure but cannot corrupt the database; acceptable because jobs are re-creatable and captures are re-checkable. Use `synchronous=FULL` for the small table of user data you cannot recreate (notes, tags) if they live in the same file, or put them in a second database file.
- **One writer process.** Only the app/worker process writes. If the render container needs to report back, it calls an HTTP endpoint instead of opening the database. WAL needs shared memory between connections, so never put the database on a network filesystem (NFS/SMB) and be careful with Docker bind mounts on Docker Desktop (bind mount performance and locking differ from native Linux). Use a named volume or local path on the Pi.
- Short write transactions: batch link enqueueing in one transaction per page, never hold a transaction across a network call.
- `PRAGMA wal_autocheckpoint` default (1000 pages) is fine; run `PRAGMA wal_checkpoint(TRUNCATE)` at idle and on shutdown; watch the WAL size (6 MB after my 50,000-row test).
- **SD-card wear**: put the database and blob store on SSD/USB storage if at all possible (a Pi 4/5 can boot from or at least mount USB SSDs). If SD is the only option: keep WAL on, avoid frequent `VACUUM`, run `optimize` rather than `ANALYZE` on all tables, batch writes, write blobs once (content-addressed so re-captures write nothing), keep logs on tmpfs or Docker's local driver with rotation, and set `PRAGMA mmap_size`/`cache_size` modestly (for example 32-64 MB) so memory is not wasted. Measure with `iostat`/`/proc/<pid>/io` before and after.
- Backups: use `VACUUM INTO` or the SQLite backup API while running, not copying the `.db` file alone (WAL).
- Use `STRICT` tables and `PRAGMA integrity_check` in a nightly job.

### 7.4 `node:sqlite` versus `better-sqlite3` on Node 24 ARM64

| | `better-sqlite3` 13.0.3 | `node:sqlite` |
|---|---|---|
| Status | Mature, widely used. v13 (2026) moved to N-API; `engines.node >= 22`. | Stability 1.2, "Release candidate" in the current docs (since v25.7.0, v24.15.0 per mirrored changelog); no flag needed since v22.13.0/v23.4.0 (https://nodejs.org/api/sqlite.html). The `defensive` option arrived in v24.12.0 and is on by default from v24.14.0. |
| ARM64 install | v13 ships prebuilt `linux-arm64`, `linux-x64`, `linuxmusl-*`, `darwin-*` and `win32-*` binaries **inside the npm package** (verified by listing `prebuilds/`; `npm i` on arm64 Linux with Node 24 worked in Docker). v12 and earlier downloaded prebuilds from GitHub releases; the v13 GitHub releases carry no assets. No compiler needed. Package is 26 MB unpacked. | Built into Node. No native module, no install step, smaller image. |
| API | Synchronous, `db.transaction(fn)` helper, `pragma()`, user-defined functions, backups. | Synchronous `DatabaseSync`, prepared statements; transactions via manual `BEGIN`/`COMMIT` (no helper documented in the section I read). Docs list `sqlite.backup()`. |
| Speed | Same in my queue benchmark (1.48 vs 1.57 ms per claim and complete; inserts 83 vs 70 ms). | |
| SQLite version | Bundled by the package. | Bundled with Node (3.53.4 on Node 24.22.2). |
| FTS5 | Enabled in the bundled build (standard in better-sqlite3 builds; I used FTS only in design, not tested). | Check availability of FTS5 and JSON functions in the Node build before relying on it; I did not test. |

Recommendation: start on `better-sqlite3` 13 for the transaction helper and a stable API, wrap it behind a thin `Db` interface so moving to `node:sqlite` later is a small change, and re-evaluate when `node:sqlite` leaves "release candidate". Pin Node to 24 LTS in the Dockerfile.

### 7.5 Drizzle ORM and migrations

- `drizzle-orm` latest is 0.45.4 (Oct 2026). The 1.0 line is on the `rc` tag (`1.0.0-rc.5`), and the docs now install `drizzle-orm@rc` / `drizzle-kit@rc` and say they have "native support for SQLite connections with the `libsql`, `node:sqlite` and `better-sqlite3` drivers" (https://orm.drizzle.team/docs/get-started/sqlite-new). There are `node-sqlite` and `kit/node-sqlite` dist-tags, consistent with `node:sqlite` support arriving in the 1.0 beta line. I did not run Drizzle in this session.
- Migrations: `drizzle-kit generate` produces SQL migration files and `migrate()` applies them at startup; for an offline appliance, apply migrations in the app at boot inside a transaction, taking a backup first.
- Drizzle's query builder does not express `UPDATE ... RETURNING` with a subquery cleanly, FTS5 virtual tables, partial indexes with `WHERE`, or the queue claim above. Use `sql` template fragments or raw prepared statements for the queue and FTS, and Drizzle for the ordinary tables. Keep hand-written SQL migrations (Drizzle supports custom migrations) for FTS5 triggers and virtual tables.
- Decision for the project: Drizzle 0.45.4 plus `better-sqlite3` is the conservative combination. 1.0 RC is likely fine for a new project but means following release-candidate migration-format changes.

Risks: single-writer discipline broken by a second container opening the same file; WAL on unsuitable volumes; an unbounded `jobs` table (prune `done` rows into a daily summary); lease durations shorter than a slow download (heartbeat or per-type lease).

---

## Open questions and things not verified

1. Real Pi 4/5 numbers: Chromium memory and extraction timings; run the benchmark scripts on the target hardware.
2. Firefox and Safari behaviour of the isolation PoC (only Chromium 156 was run).
3. RFC 9309 and RFC 6265 text could not be fetched this session (timeouts); the cookie behaviour is evidenced by my PoC, the robots.txt status-code rules should be checked against the RFC when coding.
4. Whether a custom `StorageClient` for Crawlee 3/4 in JavaScript is practical (no documentation found).
5. Drizzle with `node:sqlite` and with `drizzle-kit` (not run).
6. The `credentialless` iframe attribute, `Cross-Origin-Resource-Policy` on archive sub-resources, and `undici`'s decompress interceptor (not tested).

## Sources

- Playwright system requirements and Docker guidance: https://playwright.dev/docs/intro, https://playwright.dev/docs/docker
- Node SQLite docs: https://nodejs.org/api/sqlite.html
- better-sqlite3 v13 release notes: https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0
- Drizzle SQLite guide: https://orm.drizzle.team/docs/get-started/sqlite-new
- monolith releases: https://github.com/Y2Z/monolith/releases
- SingleFile CLI: https://github.com/gildas-lormeau/single-file-cli
- warcio.js: https://github.com/webrecorder/warcio.js; wabac.js: https://github.com/webrecorder/wabac.js
- Service Workers and secure contexts (MDN): https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers
- Mozilla Readability: https://github.com/mozilla/readability
- Robots Exclusion Protocol: https://www.rfc-editor.org/rfc/rfc9309; HTTP State Management (cookies): https://www.rfc-editor.org/rfc/rfc6265
- npm registry metadata (versions, sizes, engines) fetched 1 November 2026 via `npm view`; GitHub release assets via `gh api`.
