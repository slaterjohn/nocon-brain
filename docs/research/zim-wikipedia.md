# ZIM files and Wikipedia for NoConBrain

Research date: 1 November 2026. Hands-on tests ran in native linux/arm64 containers on Apple Silicon (Docker Desktop 29.2.1). Facts that could not be verified are marked **(uncertain)**.

## Summary

- **libzim 9.8.2** (released 2026-08-13, GPL-2.0-or-later) and **@openzim/libzim 4.7.0** (npm, published 2026-10-05, GPL-3.0, Node `>=22 <27`) are current.
- The npm package has **no prebuilt Node binaries**. `npm install` downloads a prebuilt libzim and compiles the N-API wrapper with node-gyp. That works on `node:24-trixie-slim` arm64 once `python3 make g++` are installed (44 s). It builds on Alpine/musl but **fails at load time**, because the downloaded libzim is a glibc "manylinux" build. Use Debian/glibc images.
- Reading a ZIM in-process works well: opening is instant, article reads and Xapian search take milliseconds, memory stays under about 100 MB RSS on a 138 MB ZIM.
- The ZIM's built-in full-text search returns title, path, a 0 to 100 integer score, word count and an HTML snippet with `<b>` highlights. That is enough for federated search.
- Recommendation: read ZIMs **in-process with @openzim/libzim**, federate search via reciprocal rank fusion (RRF), and keep kiwix-serve as an optional fallback only. Licensing needs a decision before the AGPL choice is final (see section 2).
- For live Wikipedia, use the core REST endpoint `/w/rest.php/v1/page/{title}/html` (Parsoid HTML), serial requests, an identifying User-Agent, and a bounded breadth-first crawl.

---

## 1. ZIM format, libzim and the Node bindings

### Versions

| Item | Version | Source |
|---|---|---|
| libzim | 9.8.2 (2026-08-13) | https://github.com/openzim/libzim/releases |
| @openzim/libzim | 4.7.0 (modified 2026-10-05) | https://www.npmjs.com/package/@openzim/libzim |
| kiwix-tools / kiwix-serve | 3.8.2 (2026-03-02) | https://github.com/kiwix/kiwix-tools/releases |
| mwoffliner (producer of Wikipedia ZIMs) | 2.1.1 (seen in ZIM metadata) | ZIM `Scraper` metadata |

The ZIM format spec is at https://wiki.openzim.org/wiki/ZIM_file_format.

### Install and build test

Environment: `node:24-trixie-slim`, arm64, Node v24.22.2, glibc 2.41.

1. `npm i @openzim/libzim` on the bare image **fails**: the install script runs `npm run download && node-gyp rebuild -v && npm run bundle`, and node-gyp cannot find Python.
2. After `apt-get install python3 make g++` it succeeds. Total time was about 44 s, including downloading `libzim_linux-aarch64-manylinux-9.8.2-1.tar.gz` from `download.openzim.org` and the Node headers from nodejs.org.
3. Result: `node_modules/@openzim/libzim` is 53 MB. `build/Release/zim_binding.node` links to a bundled `libzim.so.9` using `$ORIGIN` rpath, so it is relocatable.
4. Only warnings were deprecation notices for `getIllustrationSizes()`.
5. npm 11 prints an "install-scripts not yet covered by allowScripts" warning. A CI or Dockerfile that uses `--ignore-scripts` will break the install, so allow-list this package explicitly.

**What this means for the Dockerfile:**

- Use a multi-stage build. Build stage has `python3 make g++`; runtime stage copies `node_modules`. The runtime still needs `libstdc++6` (already present in `node:*-slim`).
- The install needs network access to `download.openzim.org` and nodejs.org. For an offline or reproducible build, pre-fetch the tarball and set `LIBZIM_VERSION` (the script reads `process.env.LIBZIM_VERSION`; the exact mechanism for pinning it was not tested **(uncertain)**).
- The download script supports `x64`, `arm` (armhf) and `arm64` on Linux, plus macOS. amd64 was not tested here but the script path is the same.

### musl (Alpine)

On `node:24-alpine` (arm64), the install and node-gyp compile both succeed. Loading fails:

```
Error relocating libzim.so.9: __sprintf_chk: symbol not found
Error relocating libzim.so.9: getdirentries: symbol not found
Error relocating libzim.so.9: backtrace: symbol not found
```

The downloaded libzim is built for glibc. Building libzim from source against musl (with Meson) might work but was not tested. **Use Debian/trixie-slim images.** Raspberry Pi OS 64-bit is glibc, so bare-metal installs are fine.

### API shape (from `dist/index.d.ts`, ESM only)

```ts
import { Archive, Searcher, SuggestionSearcher, Query, OpenConfig } from "@openzim/libzim";

const a = new Archive(path, new OpenConfig().preloadXapianDb(false));
a.uuid; a.articleCount; a.entryCount; a.mediaCount; a.filesize;
a.hasFulltextIndex(); a.hasTitleIndex();
a.metadataKeys; a.getMetadata("Title");            // strings
a.mainEntry;                                         // entry, usually a redirect
a.getEntryByPath("Aromaticity");                     // throws "Cannot find entry" if missing
a.hasEntryByPath(p);
const item = entry.getItem(true);                    // true = follow redirects
item.mimetype; item.size; item.data.toString();      // item.data is a Blob (has .data Buffer)
a.iterEfficient(); a.iterByPath(); a.iterByTitle();  // iterables of Entry
a.randomEntry;

new SuggestionSearcher(a).suggest("benz").getResults(0, 5)
   // -> { title, path, snippet, hasSnippet, entry }; estimatedMatches
new Searcher(a /* or Archive[] */).search("aromatic ring").getResults(0, 10)
   // -> { title, path, score, wordCount, snippet, zimId, fileIndex, entry }; estimatedMatches
```

Notes from testing:

- The API is **synchronous** (blocking the event loop). Calls were very fast on the test ZIMs, but a cold search on a 100 GB ZIM could block for noticeably longer **(uncertain, not tested)**. Run libzim in a `worker_threads` worker so the main server stays responsive.
- `Searcher` accepts an array of archives, so libzim itself can search several ZIMs and merge results (using Xapian scores). I federated per ZIM in the design below because scores from different indexes are not comparable.
- There are cluster cache and dirent cache controls (`setClusterCacheMaxSize`, `setDirentCacheMaxSize`) for tuning memory on a Pi.
- A `Creator` class exists, so NoConBrain could in theory write its own ZIMs (an export feature). Not explored.
- Missing-entry errors are a thrown `Error("Cannot find entry")`. Check with `hasEntryByPath` first.
- Pre-existing paths are **plain article titles with underscores** (`Aromaticity`, `Resonance_(chemistry)`), not `A/Aromaticity` (new namespace scheme: `hasNewNamespaceScheme` was `true`). Older ZIMs use `A/` prefixes; the library handles both through `getEntryByPath`, but link rewriting needs to know which scheme applies.

### Test results

ZIMs used (downloaded from https://download.kiwix.org/zim/wikipedia/):

- `wikipedia_en_chemistry_mini_2026-10.zim`, 22 MB
- `wikipedia_en_chemistry_nopic_2026-10.zim`, 132 MB

| Measure | mini | nopic |
|---|---|---|
| Open time | 8.3 ms | 9.4 ms |
| Entries / articles / media | 44,573 / 43,239 / 1,253 | 71,776 / 57,915 / 13,777 |
| Full-text index (`_ftindex:yes`) | yes | yes |
| Iterate 20,000 entries | 37 ms | 47 ms |
| Read one article by path | under 1 ms | under 1 ms |
| Title suggestion "benz" | 0.2 ms | 0.2 ms |
| Full-text search "aromatic ring", first page | 8 ms (est. 200 matches) | 10 ms (est. 900 matches) |
| 10 further searches (first 10 results each) | 2.5 ms total | 6 ms total |
| Process RSS | 48 MB at start (Node), 95 MB at end | 48 MB, 91 MB |

These are warm-ish numbers on an M-series Mac under Docker Desktop's Linux VM. A Pi 4 reading from an SD card or USB disk will be much slower on first touch, because every read pages from storage. Measure on real hardware before promising latency. **(uncertain for Pi)**

Search result example (nopic, query "aromatic ring"):

```
Simple aromatic ring   Simple_aromatic_ring   score 100   words 627
  "...<b>ring</b> Simple aromatic rings, also known as simple arenes ..."
Aromatic ring current  Aromatic_ring_current  score 99    words 2541
```

- `score` is an **integer from 0 to 100**, relative to the best hit of that query (the top result is always 100). It is a normalised Xapian weight, not comparable across indexes. Use rank, not score, for fusion.
- `snippet` is HTML with `<b>` around matched terms. It is **not** HTML-escaped beyond that, so sanitise it (allow only `<b>`) before display.
- `estimatedMatches` is capped for broad queries (the search stopped at 200 for mini and 900 to 1400 for nopic in several queries; treat it as an estimate).
- Suggestions are title-prefix and word matching; they return the title and path, and the snippet is empty for plain path suggestions.
- Metadata keys present: `Counter`, `Creator`, `Date`, `Description`, `Flavour`, `Illustration_48x48@1` (PNG bytes), `Language`, `Name`, `Publisher`, `Scraper`, `Source`, `Tags`, `Title`. The `Tags` value includes `_ftindex:yes` and `_pictures:no`. `getMetadata` on the illustration key returns binary as a string, so use `getIllustrationItem(48)` instead.

---

## 2. In-process libzim versus kiwix-serve sidecar

### kiwix-serve test

- Image `ghcr.io/kiwix/kiwix-serve:latest` is multi-arch: **linux/amd64, arm64, arm/v7, arm/v6** (checked with `docker buildx imagetools inspect`). Image size 88 MB.
- Started with one ZIM mounted read-only: `kiwix-serve --port=8080 <file>.zim`. Resident memory 62 MiB right after a few requests (3.9 MiB at idle just after start).
- Useful endpoints (all worked):
  - `/catalog/v2/entries` (OPDS catalogue, Atom XML)
  - `/content/<name>/<path>` (article; 3.6 ms for one read)
  - `/search?content=<name>&pattern=...&format=xml&pageLength=N` (RSS-style XML with `opensearch:totalResults`; 58 ms for a full-text query via HTTP)
  - `/suggest?content=<name>&term=benz&count=3` (JSON, with HTML-escaped `label` highlights and `path`)
- Kiwix also serves its own reader UI and handles all link, CSS and JS routing itself.

### Comparison

| Aspect | In-process `@openzim/libzim` | kiwix-serve sidecar |
|---|---|---|
| Complexity | Native build step in Dockerfile; ESM only; sync API needs a worker thread | Extra container, extra port, HTTP and XML/JSON parsing, health checks, config for each ZIM |
| Control over output | Full: sanitise, rewrite links, inject NoConBrain chrome, extract text | Must proxy and rewrite HTML from a URL scheme (`/content/<name>/...`) |
| Search | Direct, typed results, can fuse with rank | `format=xml` search results, then parse; fewer fields |
| Memory | Shared with the Node process (about 40 MB extra seen) | Separate process (about 60 MB seen) plus Node |
| ARM64 | Works on glibc; fails on musl | Official arm64 image, no build needed |
| Hot-adding ZIMs | `new Archive()` at runtime | Needs restart, or `--monitorLibrary` with a library XML **(uncertain, not tested)** |
| Failure isolation | A libzim crash or segfault kills the Node process | Crash is isolated |
| Licence impact | libzim is linked into the NoConBrain process (GPL) | Separate program, talked to over HTTP (arms-length) |

### Licensing

| Component | Licence (verified) |
|---|---|
| libzim | GPL-2.0-or-later (source header says "version 2 ... or (at your option) any later version"), repo licence shown as GPL-2.0 |
| @openzim/libzim (node-libzim) | GPL-3.0 |
| kiwix-tools (kiwix-serve) | GPL-3.0 |
| libkiwix | GPL-3.0 |
| zim-tools | GPL-3.0 |

Sources: GitHub licence metadata for each repo, plus the header in https://github.com/openzim/libzim/blob/main/src/archive.cpp.

**AGPL-3.0 compatibility.** GPL-3.0 section 13 explicitly permits combining GPL-3.0 code with AGPL-3.0 code; the combined work is under AGPL-3.0 for the AGPL parts, and the GPL parts keep their terms. So linking `@openzim/libzim` (GPL-3.0) into an AGPL-3.0 NoConBrain is compatible. libzim itself is GPL-2.0-or-later, which can be used under GPL-3.0, so that is also fine. Caveats:

- If NoConBrain ends up under a licence that is **not** GPL-compatible (MIT with a proprietary add-on, for example), in-process linking would not be allowed, and the sidecar route becomes the safe option.
- This is a reading of the licences, not legal advice. **(uncertain, take legal advice before release)**
- A sidecar kiwix-serve container does not change the picture much for an AGPL project, but it does give a cleaner boundary if NoConBrain later offers a differently licensed distribution.
- ZIM *content* licences are separate: Wikipedia text is CC BY-SA 4.0; other ZIMs vary per `Source`/`License` metadata. NoConBrain should show attribution per ZIM (see section 5).

### Recommendation

Use in-process libzim in a worker thread as the default. Offer kiwix-serve as an optional compose profile only if the Human wants a sandboxed reader or finds the native build awkward. Keep the `ZimSource` interface small (open, get, suggest, search) so both implementations fit behind it.

---

## 3. Search integration: federate or copy?

**Recommendation: federate.** Do not copy ZIM text into the main index.

Reasons:

- A full English Wikipedia ZIM is large (see section 4). Re-indexing its text into another engine would roughly duplicate the storage and take many hours on a Pi.
- Each ZIM already has a Xapian full-text index (flag `_ftindex:yes`; `hasFulltextIndex()`), and queries return in single-digit milliseconds on the test ZIMs.
- Updating a ZIM (monthly releases) just means swapping the file; no re-index in NoConBrain.

What the built-in index gives (verified above):

- Ranked hits with a 0 to 100 normalised score, word count, and an HTML snippet with `<b>` highlights.
- Paging via `getResults(start, max)` and an estimated total.
- Language stemming is applied at index time using the ZIM's language; the search syntax supports plain terms and phrases. Boolean operators and field queries are limited **(uncertain, not tested)**.
- No per-hit field for last-modified or URL, only `path`. NoConBrain builds the URL from the ZIM id plus path.

Limits:

- Scores are normalised per query, so they cannot be compared across ZIMs or against the main index. **Use ranks with RRF.**
- Some ZIMs have no full-text index (`hasFulltextIndex() === false`). For those, fall back to the title suggestion search or skip the ZIM in full-text queries.
- Snippets are plain-ish HTML, so strip tags except `<b>`.

**Suggested flow:**

1. For each enabled ZIM, run `search(query).getResults(0, 20)` in the worker, in parallel across ZIMs, with a time budget (for example 800 ms on a Pi).
2. Map each hit to `{source: "zim:<zim-name>", url: "/zim/<name>/<path>", title, snippet, rank}`.
3. Merge with local-index results and online-provider results using weighted RRF (`score = Σ w_source / (k + rank)`, k=60). Details are in `search-providers.md`.
4. Cap the number of ZIMs queried per search (for instance only the ones the Human has enabled, and the ones whose language matches the query), because each extra ZIM costs I/O on slow disks.
5. Use `SuggestionSearcher` for the as-you-type title box, and run it on its own, since it is far cheaper than full-text search.

---

## 4. Rendering ZIM content offline

### HTML structure (checked in the nopic ZIM)

- Articles are Parsoid-based full pages from mwoffliner (HTML 2.x with Vector 2022 skin classes).
- Internal links are **relative bare paths**: `<a rel="mw:WikiLink" href="Covalent_bond" title="Covalent bond">`. Because articles sit at the ZIM root, a browser resolves them against the current URL.
- In-page anchors stay as `#History` and citation links `#cite_note-2`.
- Links to pages that are not in the ZIM (for example the subset has no "Benzene") remain internal-looking `href="Benzene"`, but `getEntryByPath` will throw. Links outside Wikipedia are absolute `https://` URLs.
- Static assets are under `_mw_/` (for example `_mw_/skins.vector.styles.css`, `_mw_/startup.js` at 70 KB) and `_res_/` (`vector-2022.css`, `footer.css`, `script.js` at 888 bytes, `favicon.png`). All are referenced as `./_mw_/...` and are stored as ZIM entries, so they can be served from the same route.
- Images in the "nopic" flavour are replaced by inline SVG placeholders (`data:image/svg+xml...` with alt-text). The mini flavour has no images at all (a few counted SVG/PNG are UI icons). In the maxi flavour images are separate entries; this was not downloaded for the test, so image path format is **(uncertain)**.
- The license is stated in the HTML footer ("Creative Commons Attribution-Share Alike 4.0") and the ZIM `Creator`/`Source` metadata.

### Serving design

Mount a route such as `GET /zim/:zimName/*path`:

1. Look up the entry with `archive.getEntryByPath(path)` (decode percent-encoding first). Follow redirects with `entry.getItem(true)`; send an HTTP 302 to the redirect target's path so relative links keep working.
2. Return `item.data` with `item.mimetype`. Use `Cache-Control: public, max-age=…` and `ETag` from the ZIM uuid (plus path), since ZIM content is immutable.
3. For `text/html`, either serve as-is inside a sandboxed iframe, or parse it and:
   - keep relative links as they are (they resolve under `/zim/:zimName/`),
   - rewrite absolute `https://en.wikipedia.org/wiki/X` links to `/zim/:zimName/X` when `hasEntryByPath("X")`, otherwise mark as "not in this ZIM" and optionally offer a live fetch (section 5),
   - drop or keep `startup.js` and `script.js`. The scripts are needed only for collapsible sections and the table of contents. Serving them from the ZIM works; the safer choice is a strict Content-Security-Policy (`script-src 'self'`) with the ZIM served from a **separate origin or sandboxed iframe** so ZIM scripts can't touch NoConBrain's UI.
4. Mark external links `rel="noopener noreferrer"` and show them as external.

Security point: ZIM files are untrusted input. Serve them with `Content-Security-Policy: sandbox allow-scripts` (or no scripts), and treat snippets as untrusted HTML.

### Wikipedia flavours and current English sizes

Directory listing at https://download.kiwix.org/zim/wikipedia/ on 2026-11-01:

| Flavour | Contents | Latest English "all" file | Size |
|---|---|---|---|
| `maxi` | Full articles with images | `wikipedia_en_all_maxi_2026-08.zim` (2026-09-08) | **119 GB** |
| `nopic` | Full articles, no images | `wikipedia_en_all_nopic_2026-06.zim` (2026-06-26) | **49 GB** |
| `mini` | Intro section only, no images | `wikipedia_en_all_mini_2026-09.zim` (2026-09-17) | **13 GB** |
| Simple English `nopic` | Simple English Wikipedia | `wikipedia_en-simple_all_nopic_2026-09.zim` | 1.0 GB |
| Simple English `mini` | | `wikipedia_en-simple_all_mini_2026-09.zim` | 506 MB |
| "Top 100" | 100 most-read articles | `wikipedia_en_100_2026-08.zim` | 318 MB |

Topic subsets also exist (for example chemistry: maxi 366 MB, nopic 132 MB, mini 22 MB; also astronomy, baseball, climate-change, computer and others).

Note that "nopic" is now much larger than the old "nopic = small" memory suggests (49 GB), because it includes all article text and detail. Recommendation by device:

- Pi 4/5 with limited storage: **mini** (13 GB) for English, or topic subsets, or Simple English.
- Home server with a spare 64 GB: **nopic** (49 GB).
- Full fidelity: maxi, only on a large disk (119 GB+).

Files are released roughly every 1 to 3 months; the version suffix changes. NoConBrain should keep the catalogue URL configurable and check the Kiwix OPDS library (`https://library.kiwix.org/catalog/v2/entries`) for updates when online. **(uncertain: OPDS URL not tested)** Downloads support HTTP range requests and have `.torrent`/`.sha256` companions (usual Kiwix practice, **uncertain** for each file).

---

## 5. Live Wikipedia archiving

### Endpoints tested (2026-11-01, en.wikipedia.org, page "Benzene")

| Endpoint | Status | Notes |
|---|---|---|
| `GET /w/rest.php/v1/page/{title}/html` (core MediaWiki REST) | 200, 117 KB, about 1 s | Parsoid HTML, `Content-Type` profile `Specs/HTML/2.8.0`, `cache-control: max-age=5`, `content-language`, ETag with revision id |
| `GET /api/rest_v1/page/html/{title}` (RESTBase) | 200, same body | Same HTML. RESTBase is slated for retirement (see below) |
| `GET /w/rest.php/v1/page/{title}` | 200 | JSON: `id`, `key`, `title`, `latest {id, timestamp}`, `license {url, title}` ("Creative Commons Attribution-Share Alike 4.0"), `source` (wikitext) |
| `GET /w/rest.php/v1/page/{title}/with_html` | 200, JSON | Metadata plus rendered HTML in one response |
| `GET /api/rest_v1/page/mobile-html/{title}` | 200, 63 KB | Mobile-optimised HTML, no Vector chrome, long cache (`s-maxage` 14 days) |
| `GET /api/rest_v1/page/summary/{title}` | 200, 770 B | Extract, thumbnail, description. Good for result previews |
| `GET /api/rest_v1/page/media-list/{title}` | 200, 1.5 KB | Media used in the page |
| `GET /w/rest.php/v1/page/{title}/links/media` | 200, 2.9 KB | Core equivalent of media list |
| `GET /w/api.php?action=query&prop=links&pllimit=max&plnamespace=0` | 200, 3.4 KB | Outgoing links, namespace 0 only, paged with `plcontinue` |
| `GET /w/api.php?action=parse&page=…&prop=links\|text` | 200 | HTML and link list in one call. `prop=license` is not valid (API warned) |
| `GET /w/api.php?action=query&list=search&srsearch=…` | 200 | Search with snippets, total hits |

(`curl` with an identifying User-Agent, gzip accepted; times from a home connection.)

### Status of the REST APIs (from the official changelog)

Source: https://www.mediawiki.org/wiki/Wikimedia_APIs/Changelog

- Jan 2026: RESTBase interactive docs (`/api/rest_v1/`) now redirect to the REST Sandbox special page. The endpoints still respond.
- Jan 2026: trailing-slash *Transform* endpoints removed from the core REST API.
- Aug 2026: Math API deprecated, full sunset by end of September 2026.
- Mar to Apr 2026: new **API rate limiting** phases enforced (see below). Jun 2026: API Portal (`api.wikimedia.org`) sunset.
- The changelog has **no notice** that `page/html` or `mobile-html` is being removed. A search found mentions that RESTBase is planned for deprecation and `data-parsoid` was blocked in 2025 (Phabricator T393557). **Prefer the core REST routes (`/w/rest.php/v1/...`) where an equivalent exists**, as they are the supported future. `mobile-html`, `summary` and `media-list` currently exist only under RESTBase, so wrap them behind an adapter that can fall back to the Action API (`action=parse`, `prop=text`, `exintro` extracts) if they vanish.
- `api.wikimedia.org` URLs are gone or going; do not use them.

### Rate limits and etiquette

Official sources:

- https://www.mediawiki.org/wiki/API:Etiquette
- https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits (new in 2026, may change)
- https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy

Rules that matter:

| Rule | Detail |
|---|---|
| User-Agent | Mandatory. Format `clientname/version (contact info) library/version`, for example `NoConBrain/0.1 (https://github.com/<repo>; <email>)`. No browser UA, no `curl`/`python-urllib`. Missing or generic UA can lead to HTTP 403 or a block. Browser JS should send `Api-User-Agent`. |
| Concurrency | "Requests in series, not in parallel." Rate-limit page suggests **at most 3 concurrent** as best practice. |
| Rate limits (per user, requests/min) | Unidentified clients: **10**. Unauthenticated bots with a compliant User-Agent: **200**. Authenticated new users: 200; established editors: 2000; bot-flagged and Cloud Services: exempt. These cover the Action and REST APIs. |
| 429 handling | Respect `Retry-After`. If absent wait at least 5 s, then exponential backoff. 503 means overload. |
| `maxlag` | Add `maxlag=5` to Action API calls for background jobs. |
| Compression | Send `Accept-Encoding: gzip`. |
| Batching | Join up to 50 titles with `\|` and use generators instead of one request per page. |
| Caching | Use conditional requests (`If-None-Match` with the ETag) and keep revision ids. Prefer `oldid` over `revid`. |

For a personal tool the **200 requests per minute** (3.3 per second) tier for identified bots is plenty. Design for a self-imposed ceiling well below that: **1 request per second, 1 in flight**. The default NoConBrain UA must contain a contact value that the Human sets in config (Wikimedia can then reach the operator). Do not ship a hard-coded generic address.

### Licensing obligations

Source: https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use (section 7) and the API's own licence field.

- Text is **CC BY-SA 4.0** (the REST page endpoint returns the licence URL; older text may also be dual-licensed with GFDL).
- When you store and display or redistribute, you must give attribution by: (a) a hyperlink or URL to the article, (b) a link to a stable copy that credits the authors, or (c) a list of all authors. A link to the article (whose history lists contributors) is the usual choice.
- Indicate changes if you modified the text, and apply a licence notice that names CC BY-SA 4.0 and links to it. Derivative text must stay CC BY-SA 4.0 or later (share-alike).
- Preserve any extra attribution notices.
- **Images** are not covered by the article licence. Each file on Commons or Wikipedia has its own licence (CC BY, CC BY-SA, public domain, some non-free fair-use files only on Wikipedia). Fetch `action=query&prop=imageinfo&iiprop=extmetadata|url` for each stored image to get the author, licence short name and licence URL, and store them next to the image.
- Practical: NoConBrain should store, per archived page, `source_url`, `revision_id`, `retrieved_at`, `license_name`, `license_url`, and a link to the page history (`/w/index.php?title=X&action=history`). Display a footer: "Text from Wikipedia, CC BY-SA 4.0, [article link], [history link]. Archived on <date>, revision <id>." Exporting an archive should include these footers.
- Archives for personal use are low-risk; redistribution (sharing the archive, publishing) triggers the obligations above. AGPL for the code does not change the licence of archived content.

### Images

- Parsoid HTML references thumbnails at `//thumb.wikimedia.org/wikipedia/commons/thumb/d/da/Benzol.svg/250px-Benzol.svg.png?utm_source=…`, with a 2x `srcset` (330px). Original files live on `upload.wikimedia.org`.
- To make the archive offline: parse `<img src>` and `srcset`, download the 1x (and optionally 2x) variant, store content-addressed (SHA-256) and rewrite `src` to the local route. Strip the `utm_*` query string.
- Use the exact thumbnail widths the HTML already uses. Wikimedia restricts arbitrary thumbnail sizes to a fixed set of "steps" (roughly 20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840 px); other widths may return errors. **(uncertain: from memory, not verified against current docs)**
- Fetch images with the same UA and the same 1-at-a-time politeness, deduplicate by URL, and skip images over a size cap. SVG thumbnails come back as PNG; original SVG can be fetched from `upload.wikimedia.org` if wanted.
- Math is rendered as images or MathML depending on config; the Math REST endpoints are being sunset, so rely on MathML in the Parsoid HTML (`<math>` elements), not the Math API.

### Recommended approach: archive an article and expand its links to depth N

**Fetch layer.** One `WikipediaClient` with: fixed UA from config, token-bucket limiter (1 request/s, burst 3, 1 concurrent), retry with `Retry-After` and exponential backoff plus jitter on 429/503, `maxlag=5` on Action API calls, a timeout of 20 s, conditional GET (`If-None-Match`) for refreshes, and a circuit breaker (pause 5 min after repeated 429/403).

**Per-page procedure:**

1. Normalise the title (underscores, first letter capital, `redirect` followed). Use `GET /w/rest.php/v1/page/{title}/with_html`: one call returns the HTML, revision id, timestamp and licence. If the response is a redirect, store the redirect mapping so later links resolve to the canonical key.
2. Extract links from the **HTML** (`a[rel="mw:WikiLink"]`, `href="./Title"`), not from the Action API, so that the links match the stored revision exactly (Benzene had 1532 such anchors including repeats). Keep only namespace 0 (drop `File:`, `Category:`, `Template:`, `Special:`, `Help:`, `Wikipedia:`), strip `#fragment`, de-duplicate. Cite `rel="mw:ExtLink"` separately; do not follow external links by default.
3. Rewrite links: archived targets become `/archive/wikipedia/<lang>/<title>`; others stay as live links (greyed or with "not archived").
4. Download images (and imageinfo attribution) and rewrite `src`.
5. Store HTML, metadata and link edges in the database, then index text for local search.

**Crawl policy for depth N:**

- Breadth-first from the seed with a persistent queue (survives restart), depth as an attribute, and a visited set keyed by canonical title.
- **Never default to depth over 1 or 2.** One article links to hundreds or about 1500 targets (Benzene had 1532 link anchors), so depth 2 can mean tens of thousands of fetches. At 1 request per second, 2,000 pages take about 35 minutes plus images.
- Hard caps: max pages per job (default 200), max total bytes, max depth (default 1, UI cap 3), max links followed per page.
- Ranking inside a level so the cap keeps the best pages: prefer links from the lead section, links that appear more than once, and links whose targets are already in the local ZIM or the archive. Skip disambiguation pages, lists, and year/date pages unless asked.
- Prefer ZIM first: if the target exists in an enabled Wikipedia ZIM, offer to link to the ZIM copy instead of fetching live. That cuts both load on Wikimedia and storage, and works offline.
- Show a preview before crawling: the count of candidate links per level, estimated time, and size.
- Persist progress so the job is pausable/resumable; surface a "polite mode" setting (requests per second).
- Batch metadata lookups (for example `prop=info|pageprops` with up to 50 titles) to check existence and redirects before fetching HTML.

**Refresh:** re-request with `If-None-Match`; a 304 costs little. Keep old revisions only if the Human wants history (store `revision_id` per snapshot).

**Alternative for very large jobs:** if the Human wants hundreds of articles, steer them to downloading a ZIM or a topic subset (for example the chemistry ZIM, 132 MB) rather than crawling. Wikimedia's own guidance is that bulk downloads via the API are inefficient and other data services exist (dumps at https://dumps.wikimedia.org, Enterprise HTML dumps).

---

## 6. Open points to settle

1. Licence decision for NoConBrain (AGPL-3.0 is compatible with the GPL-3.0 node-libzim, per the analysis above).
2. Whether to ship the libzim build in the main image or as a separate "zim" image variant, because it adds the build toolchain and 53 MB.
3. Test on real Pi 4 and Pi 5 hardware, using the 13 GB mini and 49 GB nopic ZIMs on SD, USB SSD and NVMe, for cold-search latency and RSS.
4. Re-test the Wikimedia endpoints before launch; RESTBase retirement and the 2026 rate-limit rollout are moving.
5. Verify the Wikimedia thumbnail size steps and the maxi ZIM image path format.

## Sources

- https://github.com/openzim/node-libzim and https://www.npmjs.com/package/@openzim/libzim
- https://github.com/openzim/libzim
- https://github.com/kiwix/kiwix-tools
- https://download.kiwix.org/zim/wikipedia/
- https://wiki.openzim.org/wiki/ZIM_file_format
- https://www.mediawiki.org/wiki/API:Etiquette
- https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits
- https://www.mediawiki.org/wiki/Wikimedia_APIs/Changelog
- https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy
- https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use
