# Fixture websites

Deterministic local sites for NoConBrain integration and e2e tests (task F-13, fixture part). Plain Node ESM, built-in modules only (`node:http`, `node:zlib`, `node:crypto`), no dependencies, so they run with or without the pnpm workspace. No test may touch the real internet; these sites and fake providers stand in for it.

```js
import { startFixtures } from './tests/fixtures/sites/index.mjs';
const fx = await startFixtures({ edgeSlowMs: 200, wikiRps: 5 });
fx.urls.article;   // 'http://127.0.0.1:54321'  (random free port per site, bound to 127.0.0.1)
await fx.close();
```

CLI: `node tests/fixtures/sites/index.mjs` prints every URL and runs until Ctrl-C.
Self-test: `node tests/fixtures/sites/selftest.mjs` (exit 0 when green).

`startFixtures(opts)` returns `{ urls, sites, credentials, log(name), close() }`.
`urls` has `article, linkGraph, trap, robots, edge, ssrfBait, wikipediaLike, searxng, brave, mojeek, sitemapFeed` plus the robots variants `robots404, robots500, robotsRedirect, robotsTimeout`.
Options: `appApiUrl` (URL the malicious page tries to fetch, default `http://127.0.0.1:3000/api/evil-probe`), `edgeSlowMs` (default 2000), `wikiRps` (default 5), `robotsTimeoutMs` (default 30000).

## Common to every site

| Route | Purpose |
|---|---|
| `/__health` | `{"ok":true,"name":...}` |
| `/__log` | `{entries:[{n,method,url,ua,t,inFlight}], maxInFlight, total}`; `t` is ms since site start (assert politeness spacing and "never two in flight") |
| `/__log/reset` | clear the log and `maxInFlight` |

Determinism: bodies are generated from data tables and contain no clock values, except `Retry-After` HTTP dates when `?date=1` is asked for, and the rate window of `wikipediaLike`. Ports vary per run, so origin strings differ; everything else is stable.

## 1. article

A "Fixture Gazette" with 31 article pages (plus home, archive, about, dedup, malicious and online-only pages) (`/{slug}`, list at `/articles`; data in `articles-data.mjs`).
- Layout on every article: header, `<nav>`, sidebar `<aside>` (related links, an ad box), `<article>` with h1/h2, paragraphs, ul/ol, table with caption, `<pre><code>`, two `<figure>`s with captions, blockquote, references list, footer. Images use `srcset`, an inline `style` with `url()`, and a favicon.
- Metadata: `<link rel=canonical>`, OpenGraph, `article:published_time`, JSON-LD `Article` (`datePublished`, `dateModified`, author), `<meta description>`.
- Topics: `astronomy` (title "Astronomy", text on the solar system, black holes and planets), `solar-system`, `black-holes`, `planets`, `stars`, `galaxies`, `comets`, `telescopes`, `exoplanets`, `moon`, `mars`, `jupiter`; renewable energy: `renewable-energy`, `solar-power`, `wind-power`, `hydropower`, `geothermal-energy`, `biomass`, `energy-storage`, `power-grid`; unrelated: `bread-baking`, `coffee-brewing`, `urban-gardening`, `medieval-castles`, `tide-pools`.
- Near duplicates: `renewable-energy-copy` and `renewable-energy-print` (identical body, canonical to `renewable-energy`), `renewable-energy-v2` (two paragraphs lightly edited, no canonical), `solar-system-mirror` (identical body, no canonical), `astronomy-syndicated` (edited, canonical to `astronomy`).
- Language: `/fr/astronomie` has `<html lang="fr">`.
- Other pages: `/`, `/articles`, `/about`, `/online-only/1..5` (targets of the fake providers; not linked from anywhere, so they are "online, not archived").
- Assets: `/assets/site.css` (with `@import url(/assets/base.css)`, which imports `typography.css`; `@import ... print`; `@font-face` with `fixture.woff2` and `fixture.woff`; `url()` backgrounds), `/assets/site-copy.css` (byte-identical to `site.css`), `/assets/fonts/fixture.woff2|woff` (fake font bytes with the real magic numbers), `/img/hero.png`, `/img/hero-copy.png` (byte-identical), `/img/hero-480.png`, `/img/hero-960.png`, `/img/bg.png`, `/img/diagram.png`, `/img/gen/{w}x{h}-{rrggbb}.png`, `/favicon.ico`. Assets send ETag and `Cache-Control`; pages send ETag and honour `If-None-Match`.
- Asset dedup: every article shares `site.css`, `hero.png`, `diagram.png`; `/dedup/a` uses `site.css` + `hero.png`, `/dedup/b` uses `site-copy.css` + `hero-copy.png` (same bytes, different URLs).
- Script-built pages (renderer tests, C-16): `/js-only` serves an empty shell (`<div id="root"></div>`, a `<noscript>` note and one external script); `/js-only/app.js` fetches `/js-only/data.json` and inserts the article (title "Aurora survey", three paragraphs, marker phrase `lanternfish-migration-7731`). `/js-only/big` is the same behind a 28 KB bundle comment and an unrecognisable mount node, so only the "little text" trigger fires. `/js-only/heavy` builds a 30,000-row table from a 1.5 MB JSON payload (`/js-only/heavy.json`), for renderer memory measurements. Without scripts the pages hold no article text.
- `/malicious`: sets a `fixture_session` cookie and contains a script that fetches `appApiUrl` with credentials, reads `document.cookie` and beacons it, sets `top.location` to `evil.example.invalid`, posts a message to the parent, writes `localStorage`; a form posting to `http://127.0.0.1:9/steal`; a `javascript:` link; `onerror` handlers; a hidden iframe; a meta refresh; `/malicious.js`. Beacons from the page land on `/__beacon` and can be listed at `/__beacons`. A correctly isolated renderer produces none.

## 2. linkGraph

200 content nodes at `/n/{0..199}` (`/` is node 0) plus `/legal/terms` and `/legal/privacy`.
Depth 0: 1 node; depth 1: 6 (ids 1-6); depth 2: 30 (7-36); depth 3: 150 (37-186); depth 4: 13 (187-199).
Per page regions: `heading` (an `<h2>` link to the first child), `main` (links to the other children, every 17th node also a broken `/missing/{id}`, every 10th node an external link to another fixture origin), `related` (next sibling in an `<aside>`), `nav` (home and nodes 1-6), `footer` (`/legal/terms`, `/legal/privacy`, broken `/legal/old`, external link to the article site).
`/__graph.json` lists `nodes` (id, url, depth, parent, children), `edges` (from, to, region, broken, external), `countsByDepth`, `brokenTargets`, `maxDepth`. Depth is the shortest path from the root over all links; nav and footer links never shorten it.

## 3. trap

| Trap | Entry | Behaviour |
|---|---|---|
| calendar | `/cal/2026/11/01` | prev/next day, start of month, next year, forever |
| repeating segments | `/a`, `/a/b/a/b` | any path made only of `/a` and `/b` segments links one level deeper (absolute and relative) |
| session ids | `/sess/page?sid=s1`, `/sess/page;jsessionid=J1` | same content; each page links to a new `sid`/`PHPSESSID`/`jsessionid`; sets a cookie |
| infinite pagination | `/list?page=N` | no last page |
| facets | `/facets?sort=price&filter=a` | 96 combinations in two parameter orders plus one extra `x` param per hop; identical content |
| redirect loops | `/redirect/loop-a` -> `loop-b` -> `loop-a`; `/redirect/self` | 302 / 301 forever |
| tracking params | `/track/article?utm_source=...` | links to itself with new `utm_*`, `fbclid`, `gclid`, `ref` values; canonical is the clean URL |
| control | `/real/1`..`/real/3` | a finite legitimate section |

## 4. robots

`robots` serves the rules below. Other instances differ only in the `/robots.txt` status; they serve the same pages.

```
User-agent: *            Disallow: /private/  /search  /*.pdf$  /tmp*/    Allow: /private/public-note    Crawl-delay: 2
User-agent: NoConBrain   Disallow: /noconbrain-blocked/   Allow: /          Crawl-delay: 1
User-agent: BadBot       Disallow: /
User-agent: SlowBot      Crawl-delay: 100
Sitemap: <origin>/sitemap.xml
```

| URL key | `/robots.txt` |
|---|---|
| `robots` | 200 with the rules above |
| `robots404` | 404 (allow all) |
| `robots500` | 500 (disallow all, RFC 9309) |
| `robotsRedirect` | 301 to `/real-robots.txt` (200, same rules) |
| `robotsTimeout` | hangs for `robotsTimeoutMs` (30 s) before answering |

Pages: `/`, `/public/page-1`, `/public/page-2`, `/private/secret`, `/private/public-note`, `/search?q=x`, `/files/doc.pdf`, `/tmp1/scratch/`, `/noconbrain-blocked/page`, `/allowed/page` (any other path is a 200 stub). `/sitemap.xml` lists three of them.

## 5. edge

`/` lists the routes. State is changed through `/__control` (below).

| Route | Behaviour |
|---|---|
| `/slow` | waits `slowMs` (default `edgeSlowMs`, change with `/__control?slowMs=`) before answering |
| `/delay/{ms}` | waits `ms` (max 60000) before headers |
| `/slow-body?ms=200&chunks=5` | headers at once, then one chunk every `ms` |
| `/huge` | endless streaming HTML (until the client disconnects); `/huge?bytes=N` finite with honest `Content-Length` |
| `/huge-length` | `Content-Length: 5 GiB`, trickles 12 bytes then idles |
| `/bomb.gz?mb=100` | `Content-Encoding: gzip`; ~100 KB on the wire, `mb` MiB of zeros decoded (1-1000) |
| `/bomb-layers?n=7` | `n` nested gzip layers, `Content-Encoding: gzip, gzip, ...` |
| `/bomb.deflate` | 50 MiB of zeros, deflate |
| `/type/html-as-plain`, `/type/html-as-image`, `/type/png-as-html`, `/type/octet-html`, `/type/pdf-as-html`, `/type/json-as-html`, `/type/no-type` | content type disagrees with the bytes, or is absent |
| `/charset/latin1`, `/charset/meta-latin1`, `/charset/utf8-bom` | non-UTF-8 and BOM bodies |
| `/chunked`, `/chunked-slow` | `Transfer-Encoding: chunked` (slow: 300 ms between chunks) |
| `/cond/doc` | ETag + Last-Modified, 304 on `If-None-Match` or `If-Modified-Since` |
| `/cond/etag-only`, `/cond/lastmod-only`, `/cond/weak` | one validator only; weak ETag |
| `/cond/gone` | 200 until `/__control?gone=1`, then 404 |
| `/429?after=2` | 429 with `Retry-After: 2`; add `&date=1` for the HTTP-date form |
| `/429/once?key=k` | first request for `key` is 429, later ones 200 |
| `/flaky/{key}?fail=3&after=1` | 503 + `Retry-After` for the first `fail` requests per key, then 200 |
| `/status/{code}` | any status |
| `/redirect/{301,302,303,307,308}?to=URL` | single redirect (default `/final`) |
| `/redirect/chain/{n}[?code=301]` | `n` hops to `/final`; codes cycle 301, 302, 307, 308 unless `code` is fixed |
| `/redirect/cross/{key}` | 302 to another fixture origin (`article`, `trap`, `ssrfBait`, ...) |
| `/redirect/to?url=URL&code=302` | redirect to any URL |
| `/redirect/loop-a`, `/redirect/loop-b`, `/redirect/no-location`, `/redirect/relative` | loop, missing `Location`, relative `Location` |
| `/empty`, `/hang`, `/reset` | empty 200; never answers; destroys the socket |
| `/final`, `/` | 200 pages |

`/__control` query switches (returns the state as JSON): `cond_version=N` (content changes, new ETag and Last-Modified), `etag_salt=x` (new ETag, same body: "unchanged but new ETag"), `gone=1|0`, `slowMs=N`, `reset=1` (also clears flaky and once counters). State includes `condHits {total, notModified}`.

## 6. ssrfBait

`/__targets` lists every bait target as JSON. `/redirect/{name}` answers 302 (or `?code=`) to it. `/page/links` links to all of them, `/page/assets` references them from `img`, `script`, `link`, `iframe`, `srcset`; `/page/meta-refresh` and `/page/css` (`@import`, `url()`, `@font-face`) do the same.

| name | URL |
|---|---|
| `loopback` | `http://127.0.0.1:{port}/canary` |
| `loopbackNoPort` | `http://127.0.0.1/` |
| `ipv6Loopback` | `http://[::1]:{port}/canary` |
| `metadata` | `http://169.254.169.254/latest/meta-data/` |
| `private10`, `private172`, `private192` | `http://10.0.0.1/`, `172.16.0.1`, `192.168.1.1` |
| `cgnat` | `http://100.64.0.1/` |
| `decimal` | `http://2130706433:{port}/canary` |
| `hex`, `hexFull`, `octal` | `http://0x7f.1:...`, `http://0x7f000001:...`, `http://0177.0.0.1:...` |
| `ipv4Mapped`, `ipv4MappedHex` | `http://[::ffff:127.0.0.1]:...`, `http://[::ffff:7f00:1]:...` |
| `unspecified` | `http://0.0.0.0:{port}/canary` |
| `localhost` | `http://localhost:{port}/canary` |
| `userinfoTrick` | `http://example.com@127.0.0.1:{port}/canary` |
| `localtestMe`, `nipIo` | `http://fixture.localtest.me:{port}/canary`, `http://127.0.0.1.nip.io:...` (**optional: need real DNS**; offline tests should use a stub resolver that maps a hostname to 127.0.0.1) |
| `fileScheme`, `ftpScheme`, `gopher`, `oddPort` | non-HTTP schemes and port 22 |

Targets with `hitsCanary: true` really reach this server if the guard fails: `/canary` increments a counter, read it at `/__canary` (reset: `/__canary/reset`). A passing guard test asserts `hits == 0`. Also `/redirect/via-public` (redirect that lands on `/redirect/loopback`, for per-hop revalidation) and `/redirect/to-public-ok` -> `/ok`.

## 7. wikipediaLike

Twenty interlinked articles: Astronomy, Black_hole, Solar_System, Planet, Sun, Earth, Moon, Mars, Jupiter, Saturn, Star, Galaxy, Milky_Way, Big_Bang, Universe, Comet, Asteroid, Exoplanet, Telescope, Supernova. Redirects: `Blackhole`, `Black_Hole` -> Black_hole, `Solar_system` -> Solar_System, `Sol` -> Sun.

| Route | Response |
|---|---|
| `/w/rest.php/v1/page/{title}/with_html` | JSON `{id,key,title,latest:{id,timestamp},content_model,license:{url,title},html}` |
| `/w/rest.php/v1/page/{title}/html` | Parsoid-style HTML, `Content-Language`, `ETag`, `Last-Modified`, `X-Revision-Id`, `Cache-Control: max-age=5`; 304 on `If-None-Match` |
| `/w/rest.php/v1/page/{title}` | metadata JSON with `source` |
| redirect titles | 307 to the canonical title; unknown title: 404 JSON `errorKey: rest-nonexistent-title` |
| `/w/api.php?action=query&prop=links&titles=A\|B&plnamespace=0&format=json[&formatversion=2]` | links (namespaces 0, 6, 10, 14 unless filtered) |
| `/w/api.php?action=query&prop=imageinfo&iiprop=extmetadata\|url&titles=File:{Title}_illustration.png` | `imageinfo[0]` with `url`, `descriptionurl`, `extmetadata` (`LicenseShortName`, `LicenseUrl`, `UsageTerms`, `Artist`, `Credit`, `ImageDescription`, `Copyrighted`, `AttributionRequired`, `NonFree`). Sun is public domain; Black_hole is fair use; the rest are CC BY-SA 4.0 |
| `prop=info` | `lastrevid`, `touched`, `length` |
| `&maxlag=5` | when the simulated lag is above `maxlag`: `{"error":{"code":"maxlag",...}}` with `Retry-After: 5` |
| `/images/{Title}_illustration.png` | generated PNG (no UA or rate rules) |
| `/wiki/{title}` | same HTML in a browser |

Parsoid HTML contains `rel="mw:WikiLink"` links in namespace 0, links to `Category:`, `Template:`, `File:`, a red link (`class="new"`, `redlink=1`), an anchor link, an external link (`mw:ExtLink`), figures with `mw:File/Thumb`.
Policies: a User-Agent without a URL or email gets 403; more than `rps` requests in any sliding second get 429 with `Retry-After: 1` (`/__log` shows timestamps). `/__control?rps=N&lag=S&bump=Astronomy&reset=1`: set the limit, simulate database lag, bump a page's revision (new id, timestamp and `(updated)` text, for refresh tests).

## 8. searxng, brave, mojeek

All three return the same deterministic ranking over a catalogue of article pages, link-graph nodes (`/n/0`, `/n/1`, `/n/2`, `/n/7`, `/n/37`, `/n/100`) and online-only pages (`{article}/online-only/1..5`). Ranking: query-term hits (title x3, snippet, URL), ties by catalogue order; an unmatched query returns the first five catalogue entries. The query `astronomy` puts `{article}/astronomy` first.

| Provider | Request | Response shape |
|---|---|---|
| searxng | `GET /search?q=&format=json[&pageno=]` | `query, number_of_results, results[{url,title,content,engine,engines,positions,score,category,publishedDate,thumbnail,img_src,template,parsed_url,priority}], answers, corrections, infoboxes, suggestions, unresponsive_engines`. Without `format` an HTML stub; any other format returns 403 (like a default install) |
| brave | `GET /res/v1/web/search?q=&count=&offset=` with header `X-Subscription-Token: fixture-brave-token` | `{type:"search", query{...}, mixed{...}, web{type, results[{title,url,description,page_age,profile,language,family_friendly,type,subtype,is_live,meta_url,age,extra_snippets}]}}` plus `X-RateLimit-*` headers. Wrong token: 401 `SUBSCRIPTION_TOKEN_INVALID`; missing `q`: 422 |
| mojeek | `GET /search?q=&fmt=json&api_key=fixture-mojeek-key&t=&s=` | `{response:{status:"OK", head{query,results,return,start,next,...}, results[{url,title,desc,size,date,rank}]}}`; wrong key: 403 `{"response":{"status":"Invalid API key"}}`. The exact field names are best-effort from the public API page; adjust here when the adapter is checked against real responses |

Failure switches, per provider. Persistent: `GET /__control?mode=<mode>[&slowMs=N][&retryAfter=S]` (`reset=1` restores defaults; the response shows the state including `requests`). Per request: `?__mode=<mode>` on the search URL, or an `X-Fixture-Mode` header.

| mode | effect |
|---|---|
| `ok` | normal |
| `slow` | waits `slowMs` (default 3000) then answers normally |
| `error500` | 500 JSON |
| `timeout` | never answers |
| `rate429` | 429 with `Retry-After: retryAfter` (default 2) |
| `malformed` | 200 with truncated JSON |
| `auth` | 401 (brave) / 403 (searxng, mojeek) |
| `empty` | valid response, zero results |
| `xss` | three hostile results first: script in the title, `onerror` in the snippet, `javascript:` / `data:` / `169.254.169.254` URLs |
| `partial` | searxng only: `unresponsive_engines` lists two engines |

## 9. sitemapFeed

Points at the article site. Dates come from the article table (`published` every 5 days from 2025-01-06; `modified` a fixed offset later).
`/sitemap.xml` (all 30 non-French articles with `lastmod`, `changefreq`, `priority`), `/sitemap-index.xml` (-> `/sitemap-1.xml` and `/sitemap-2.xml.gz`), `/sitemap-2.xml`, `/sitemap-2.xml.gz` (gzipped urlset), `/rss.xml` (RSS 2.0, 15 items with `pubDate`, `guid`, `dc:creator`), `/atom.xml` (Atom, `published` and `updated`), `/robots.txt` (two `Sitemap:` lines).
