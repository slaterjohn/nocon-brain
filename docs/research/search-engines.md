# Search engine options for NoConBrain

Research date: 1 November 2026. Scope: local search for a self-hosted, offline-first web archiver that must run well on a Raspberry Pi 4/5 (ARM64, 4-8 GB RAM, USB SSD) and scale to AMD64 servers.

All benchmark scripts and raw JSON are in `docs/research/search-bench/` (see "Reproducing"). Anything marked "not verified" or "extrapolated" was not measured.

## 1. Recommendation (short version)

1. **Default engine on the Pi: SQLite FTS5**, through `better-sqlite3` for now. It was the only engine that indexed 50,000 pages and answered queries comfortably inside 512 MB. It needs no extra container, its index lives in the same file as the metadata (so `site:`, `type:`, `before:` and `after:` become ordinary `WHERE` clauses), and the index can be rebuilt from the stored content with a single statement.
2. **We have to build the typo and suggestion layer ourselves.** In the benchmark, a vocabulary table plus a trigram FTS5 table plus a small edit-distance step handled typos at about 4 ms p50 / 9 ms p95. Ranking after correction was weaker than in Meilisearch or Typesense (section 5), so expect tuning work.
3. **Yes, put a thin `SearchIndex` adapter interface in from day one**, but ship only the FTS5 implementation in v1. Add an optional heavier engine later, only if real users hit the limits below. If one is added, **Meilisearch is the better fit than Typesense** for the NoConBrain profile (mmap model, can exceed RAM, MIT licence). Neither is suitable for a Pi with 1 GB or less given the measured results.
4. **Untested risk that decides how long FTS5 stays the default:** nothing here was run at 1 million pages. Common-term queries cost more as the match set grows. Re-run the harness at 500k-1M documents on a real Pi before promising that scale.

## 2. Comparison table

Versions and dates come from the GitHub release API on 1 November 2026.

| | SQLite FTS5 (+ our typo layer) | Meilisearch | Typesense | Tantivy (library) | Manticore Search |
|---|---|---|---|---|---|
| Latest stable | SQLite 3.53.4 bundled in better-sqlite3 13.0.3 (MIT) | v1.56.0 (26 Oct 2026) | v30.2 (19 Apr 2026); Docker Hub also lists 31.0 RC tags | 0.26.1 (10 May 2026) | release-29.9.0 (11 Sep 2026) |
| Licence | SQLite public domain; better-sqlite3 MIT | MIT for Community Edition. Enterprise files under `enterprise_editions` are BUSL-1.1 (non-production only without a commercial agreement) | GPL-3.0 | MIT | GPL-3.0 |
| Shape | In-process library | Separate server | Separate server | Rust library, no server | Separate server (fuzzy search needs the Buddy helper process) |
| Official ARM64 | Native (compiled into the Node addon; we built a linux/arm64 image fine) | Yes, arm64 image pulled and run | Yes, arm64 image pulled and run; also publishes `arm64-lg-page16` tags for 16 KB-page kernels | n/a (build yourself) | Docker Hub tags list amd64 and arm64 |
| Memory model | Page cache, tunable; small | LMDB, memory-mapped; dataset may exceed RAM | Whole searchable index held in RAM | mmap segments | Not verified |
| Typo tolerance | Not native; vocab + trigram table (built, below) | Native, default on | Native, `num_typos` 0-2 | Fuzzy term query, Levenshtein automaton | Native via `fuzzy=1` + Buddy |
| Prefix / autocomplete | Native (`term*`, prefix indexes) | Native, last word by default | Native, last word by default; infix opt-in | Native | Via infix settings |
| Stemming | Porter (English only) built in; trigram for substring | **None** (not on the 2026 roadmap) | Snowball per field (`stem: true`, locale-based) | Snowball stemmers available | Yes (morphology) |
| Exact phrase | Native | Native (quotes) | Native by docs; **returned wrong results with `stem: true` in v30.2 (section 5)** | Native | Native |
| Excluded terms | `NOT` | `-word` per docs | `-word` per docs | Boolean must-not | Native |
| Synonyms | None native; query expansion table in our code | One-way and multi-way | One-way and multi-way | Not built in | Yes (wordforms) |
| Relevance | BM25, per-column numeric weights | Ordered ranking rules, no BM25 | Text-match score, numeric `query_by_weights` | BM25 | BM25 |
| Field priority | `bm25(fts, 10, 5, 3, 1)` | Order of `searchableAttributes` only | Numeric weights | Per-field boost | Per-field weights |
| Highlighted snippets | `snippet()`, `highlight()` | Highlight + crop | Highlight + snippet | Snippet generator | Yes |
| Duplicate suppression | Content-hash / simhash column, our code | `distinct` attribute | `group_by` | Our code | Our code |
| Facets / filters | SQL `WHERE` + `GROUP BY` | Native | Native | Native | Native |
| Language-aware | Weak out of the box (Porter is English; ICU not in default builds) | Good tokeniser coverage (Charabia), no stemming | Per-field locale, stemming | Good (tokenisers, stemmers) | Good |
| Did-you-mean | Build it from the vocab table | No dedicated endpoint found in docs read | No dedicated endpoint found in docs read | Build it | `CALL SUGGEST` |
| Extra container | No | Yes | Yes | Sidecar to write | Yes (+ Buddy) |

Sources: [Meilisearch v1.56.0](https://github.com/meilisearch/meilisearch/releases/tag/v1.56.0), [Meilisearch README, editions and licensing](https://github.com/meilisearch/meilisearch), [LICENSE-EE](https://github.com/meilisearch/meilisearch/blob/main/LICENSE-EE), [Meilisearch roadmap](https://meilisearch.com/roadmap), [Meilisearch ranking rules](https://www.meilisearch.com/docs/learn/relevancy/ranking_rules), [Meilisearch synonyms](https://www.meilisearch.com/docs/learn/relevancy/synonyms), [Typesense v30.2](https://github.com/typesense/typesense/releases/tag/v30.2), [Typesense search parameters](https://typesense.org/docs/30.1/api/search.html), [Typesense stemming](https://typesense.org/docs/30.1/api/stemming.html), [Typesense synonyms](https://typesense.org/docs/30.1/api/synonyms.html), [Typesense Docker tags](https://hub.docker.com/r/typesense/typesense/tags), [Tantivy 0.26.1](https://github.com/quickwit-oss/tantivy/releases/tag/0.26.1), [Manticore fuzzy search and suggestions](https://manual.manticoresearch.com/Searching/Spell_correction), [Manticore 29.9.0](https://github.com/manticoresoftware/manticoresearch/releases/tag/release-29.9.0), [Node.js SQLite docs](https://nodejs.org/api/sqlite.html), [SQLite spellfix1](https://www.sqlite.org/spellfix1.html).

Cells for Meilisearch typo defaults, Manticore memory model and the Tantivy/Manticore feature rows come from documentation or general knowledge and were not exercised here. The FTS5 column was tested directly.

### Licensing notes for an AGPL project

- **Meilisearch:** the engine is MIT, so no problem. The catch is the Enterprise Edition code, which is BUSL-1.1 and "not allowed in production without a commercial agreement". The README lists sharding, S3-streaming snapshots and search-rule previews as EE. I could not verify whether the official Docker image's binary contains EE code paths that are disabled by default. Recommendation: run the unmodified upstream image as a separate container, do not enable or advertise EE features, and do not rebuild or re-publish our own Meilisearch image without a legal read.
- **Typesense and Manticore (GPL-3.0):** GPLv3 and AGPLv3 explicitly allow being combined, and talking to a separate server over HTTP does not make our code a derivative of it. If we ever *redistribute* a Docker image containing the GPL binary, we take on the source-offer obligations; pulling the upstream image at install time avoids that. This is not legal advice.
- **SQLite, better-sqlite3, Tantivy:** public domain or MIT. No friction.
- `node:sqlite` is documented as Stability 1.2 (release candidate), flag-free since Node 22.13. In Node 22.23.4 it still prints an "ExperimentalWarning". I checked that it ships FTS5, the Porter and trigram tokenisers and `fts5vocab`. `spellfix1` is **not** compiled in (it is a loadable extension and is not part of any standard build), so a spellfix approach would mean shipping a native extension per platform. That is another reason to prefer the trigram approach.

## 3. Benchmark

### What this is, and is not

This is **not a Raspberry Pi**. It is an Apple Silicon Mac (12 CPUs, Docker Desktop VM with 7.65 GiB RAM) running native `linux/arm64` containers. That makes the instruction set and the container images realistic. It does not reproduce a Pi's slower cores, 4 cores, SD/USB-SSD I/O, or thermal throttling. Memory-limit runs (`--memory` with swap disabled) simulate a RAM ceiling only. Absolute times on a Pi will be worse by an amount I did not measure. Relative behaviour (what fits, what is OOM-killed) is more trustworthy than the milliseconds.

Other things that limit trust:

- Each configuration was run **once**. Variance is unknown.
- Other unrelated containers were running on the Mac during the runs.
- Meilisearch and Typesense are queried over HTTP from the host (through Docker port forwarding); SQLite is queried in-process. SQLite latencies are therefore **not directly comparable**. Meilisearch reports 2 ms (p50) server-side against 3.6 ms measured by the client, which suggests roughly 1.5 ms of HTTP overhead. A SQLite service would pay a similar cost.
- Meilisearch and Typesense apply prefix matching to the last word of every query by default; the SQLite code only does so for the "prefix" query type.

### Corpus and queries

- **Corpus:** 50,000 articles sampled with a fixed seed from the Simple English Wikipedia XML dump (`simplewiki-latest-pages-articles.xml.bz2`, 358 MB), wikitext stripped to plain text. Only about 22k articles had 2 KB+ of body text, so to reach 50k the minimum was lowered to 900 characters. **Mean body is 2.1 KB** (median 1.6 KB, max 5 KB), plus title and on average 5.7 headings. That is the low end of the requested 2-5 KB. The JSONL is 115 MB.
- Fields: `title`, `url`, `headings`, `body`, plus `domain`, `collection`, `content_type`, `language`, `date`. **Domain, collection and content type are synthetic** (hash-assigned; 24 domains, one holds a third of the documents) so that filters can be exercised.
- **Queries:** 230 generated with a fixed seed: 40 single term, 60 multi-term (co-occurring words), 40 typos (including "astronamy"; random deletion, transposition or substitution of a real word), 30 exact phrases (including "solar system"), 30 prefixes of 3-5 letters, 30 domain-filtered. One warm-up pass, then 3 measured passes (690 samples per run).
- **Result size:** top 10 with highlighted snippet from `body`.

### Engine configuration

| | Configuration |
|---|---|
| FTS5 | `better-sqlite3` 13.0.3, SQLite 3.53.4, WAL, 64 MiB page cache. `docs` table holds all fields; external-content FTS5 table over `title, headings, url, body` with `porter unicode61 remove_diacritics 2`, prefix indexes 2/3/4, ranking `bm25(fts, 10, 5, 3, 1)`. Separate `vocab(term, df)` table plus trigram FTS5 table for typo candidates; edit-distance filter in JS (max 1 for 4-6 letter words, 2 for 7+); up to 3 corrections OR-ed together. Terms that are not in the vocabulary are corrected; the last word of a prefix query is not. |
| Meilisearch | v1.56.0, `searchableAttributes` = title, headings, url, body; filterable domain/collection/content_type/language/date. Defaults otherwise. Batches of 1000 documents. |
| Typesense | v30.2, `query_by` title, headings, url, body with weights 10, 5, 3, 1. Title/headings/body with `stem: true` (also run with it off). Batches of 1000 via JSONL import. |

Each run: fresh container and volume, idle RSS, index, restart the container (this is the state after a reboot of the Pi), then query. "RSS" for the servers is `docker stats` (cgroup usage minus inactive file cache); I also read `memory.stat` and `memory.peak`. The cgroup peak includes reclaimable page cache and overstates what is needed. For SQLite I report the Node process RSS from inside the container.

### Results: unrestricted memory

| | SQLite FTS5 | Meilisearch 1.56 | Typesense 30.2 (stem on) | Typesense 30.2 (stem off) |
|---|---|---|---|---|
| Index time, 50k docs | 11.2 s (docs 3.1 s, FTS 6.2 s, optimise 1.1 s, vocab 0.7 s) | 22.0 s | 19.3 s | 9.3 s |
| On-disk size | 333 MiB | 1,376 MiB | 246 MiB | 246 MiB |
| Idle RSS, fresh | 0.6 MiB (container only, no process) | 53 MiB | 95 MiB | 96 MiB |
| Peak RSS while indexing | 219 MiB (Node process); 188 MiB (container) | 1,673 MiB | 519 MiB | 544 MiB |
| RSS after restart, idle | n/a (opened on demand) | 38 MiB | 410 MiB | 466 MiB |
| Peak RSS while querying | 125 MiB (Node process) | 96 MiB | 498 MiB | 419 MiB |
| Restart to ready | n/a | 1.4 s | 5.3 s (reloads index into RAM) | 4.9 s |
| Query p50 / p95, all 690 | 0.57 / 6.0 ms (in-process) | 3.6 / 7.6 ms (client) | 2.9 / 21.7 ms | 1.9 / 5.6 ms |

The raw corpus is 115 MB. Meilisearch's own stats report `indexSize` 1.44 GB with 1.05 GB used and 186 MB of raw documents, so the size is mostly its many internal databases.

Per query type, p50 / p95 in ms:

| Type | SQLite FTS5 | Meilisearch | Typesense (stem on) | Typesense (stem off) |
|---|---|---|---|---|
| Single term | 0.44 / 1.2 | 3.5 / 5.5 | 2.7 / 20.0 | 1.5 / 2.3 |
| Multi-term | 0.54 / 1.6 | 4.4 / 7.3 | 3.4 / 26.5 | 2.1 / 3.6 |
| Typo | 4.0 / 9.1 | 3.4 / 5.2 | 2.8 / 20.1 | 1.9 / 3.0 |
| Phrase | 0.29 / 0.68 | 2.3 / 43.6 | 1.1 / 14.2 (**wrong results**) | 1.2 / 2.0 |
| Prefix | 1.3 / 4.0 | 3.3 / 5.7 | 3.2 / 15.9 | 2.2 / 3.6 |
| Domain-filtered | 0.24 / 2.5 | 4.0 / 44.0 | 4.0 / 24.4 | 2.5 / 11.0 |

Zero-result queries in the first measured pass (of 30 per type): FTS5 had 1 phrase, 1 prefix and **12 of 30 filtered**; Meilisearch 5 phrase, 1 filtered; Typesense (stem on) **21 phrase**; Typesense (stem off) 1 phrase. The FTS5 filtered zeros are because it requires all terms; the other two engines drop terms when nothing matches. An FTS5 implementation needs a fallback to an OR query.

Meilisearch's first five queries after a restart took 19.7, 5.7, 3.7, 3.6 and 3.5 ms; Typesense (stem on) 7.6-15.9 ms.

### Results: constrained memory (Docker `--memory` with swap off)

| Limit | SQLite FTS5 | Meilisearch (defaults) | Meilisearch (tuned) | Typesense (stem on) |
|---|---|---|---|---|
| **1 GB** | Full 50k OK. Index 11.2 s. Query p50/p95 0.59 / 6.3 ms | **OOM-killed during indexing** | **Still OOM-killed** at 50k with `MEILI_MAX_INDEXING_MEMORY`=512 MiB, 2 threads, sequential 1000-doc batches. A diagnostic run (500-doc batches, 256 MiB indexing memory) reached about 20k documents with 510 MiB anonymous memory and died before 25k. 15k docs OK: 19 s, 914 MiB disk, p50/p95 3.4 / 44 ms | Full 50k OK. Index 20.2 s, peak 505 MiB, 445 MiB idle after restart. p50/p95 2.8 / 18.4 ms |
| **512 MB** | Full 50k OK. Index 13.2 s (slightly slower). Query p50/p95 0.61 / 6.6 ms | **OOM-killed during indexing** | **Still OOM-killed** at 50k (192 MiB indexing memory, 2 threads). 7k docs OK: 8 s, 452 MiB disk, p50/p95 3.7 / 45 ms | **OOM-killed** at 50k (also with stemming off). 25k docs OK: peak 436 MiB, 131 MiB disk, p50/p95 2.4 / 4.9 ms |

Extra data points:

- Meilisearch with a 2 GB limit, tuned (768 MiB indexing memory, 2 threads, sequential 1000-doc batches) indexed all 50k, but took **96 s** (against 22 s with batches queued freely and no limit) and used **2,488 MiB of disk**. Waiting for each batch before sending the next stopped it merging everything into one batch, and it also appears to leave far more free space in the LMDB file. Queries were unaffected (3.6 / 7.2 ms).
- Meilisearch's default indexing memory is two thirds of "available RAM" per the [configuration reference](https://www.meilisearch.com/docs/resources/self_hosting/configuration/reference), and that page does not mention cgroup limits. I did not establish *why* the default runs died, only that they did. The likely cause is that it sized itself against the 7.65 GiB VM rather than the container limit, but I did not confirm that.
- The p95 of about 44 ms in the reduced-document Meilisearch runs comes from the phrase and filtered query types, as in the unrestricted run (about 44 ms there too). I did not find the cause.

### Quality spot-checks

Judged by me from the top five titles; one corpus; subjective. The corpus has no article titled "Solar System" (checked), so no engine can be expected to put one first.

| Query | FTS5 + our layer | Meilisearch | Typesense (stem on) |
|---|---|---|---|
| `astronamy` | Corrected to "astronomy" (reported as did-you-mean). Top five: Jane Rigby, European plaice, Mae Jemison, International Astronautical Congress, Astronaut. **The Astronomy article is missing from the top five.** | Astronomy, Magnitude (astronomy), First light (astronomy), Australian Aboriginal astronomy, History of astronomy. Good | Same as Meilisearch. Good |
| `plenets` | Top results matched "plenty" as well as "planets"; mixed | List of planets, The Planets, Sunlight, ... Good | List of planets, Giant planet, Ice planet, ... Good |
| `"solar system"` | Snippet shows "Solar System" highlighted as a phrase: List of planets, Laplace, Impact crater, Sunlight, Grand tack hypothesis | 198 hits. Solar wind, Heliosphere, List of planets, Sunlight, Future of the Earth. Plausible | 198 hits. Impact crater, Sky, List of planets, Age of Earth, Water. Plausible, but see the stemming bug below |
| `discovering planets` | Matched "discovered" through Porter; good | No stemming. Top hit was "Star Wars". Poor | Matched "discovered"; good |
| `planet -mars` | Works via `NOT` | Not checked that Mars is excluded | Not checked that Mars is excluded |
| `solar sys` | Prefix on last word, sensible | Sensible | Sensible |

**Why FTS5 ranked "astronamy" badly.** The corrected term group `(a OR b OR c)` was ranked by BM25 like any other query, so a short article containing a rare candidate beat the Astronomy article. Fixes that should help, none tried: rank candidates by edit distance then document frequency and only keep the top one when its frequency is far higher; boost exact title matches; fall back to the OR group only when the single best correction returns nothing.

**Typesense phrase search with stemming is wrong in v30.2.** With `stem: true` on title, headings and body, 21 of the 30 generated phrase queries returned nothing, although 17 of those 21 phrases appear verbatim in the corpus (checked by substring search). With stemming off, 29 of 30 returned results and the remaining one is not in the corpus. The "solar system" check is not affected, which is why it can look fine. Diagnostic script: `probe-ts-phrase.mjs`. I could not tell whether this is a bug or a documented limitation; it needs an upstream check before adopting Typesense with both stemming and phrase search. Typesense's stemming docs also warn of "unintended side effects" for proper nouns.

## 4. Feature gaps and how to fill them

### SQLite FTS5

| Gap | How to fill it |
|---|---|
| Typo tolerance | Implemented in the benchmark: `vocab` table (every distinct term with document frequency, built while indexing) plus an FTS5 `trigram` table over the terms. A term not in the vocab (length 4+) gets candidates by OR-ing its trigrams, filtered by edit distance, sorted by distance then frequency. 275,840 terms built in 0.7 s. Typo queries cost about 4 ms p50 / 9 ms p95, against about 0.5 ms for normal ones. Note that numbers and junk tokens inflate the vocabulary; prune terms that appear once. |
| Spelling suggestions ("did you mean") | Free by-product of the above: return the substituted terms. `spellfix1` would work but is not in standard builds, so we would ship a native extension for each platform. Not recommended. |
| Autocomplete | `term*` with prefix indexes (2, 3, 4 characters) costs extra disk but gave 1.3 ms p50. For title autocomplete, a separate small FTS5 table over titles only is cheaper and ranks better. |
| Stemming and language | Porter is English only. Other languages need a different tokeniser table per language, or an ICU/custom tokeniser that is not in default builds. Store the language per document and keep one FTS table per language group. |
| Synonyms | Nothing native. Keep a `synonyms(term, expansion)` table and expand query terms into OR groups in the query builder. Cheap for query-time expansion; avoid index-time expansion because it forces rebuilds. |
| Duplicate suppression | Store a content hash (exact duplicates) and optionally a simhash (near duplicates) in `docs`; collapse in SQL with `GROUP BY` or a window function. Not benchmarked. |
| Field weighting | Native: `bm25(fts, 10, 5, 3, 1)` for title > headings > URL > body. |
| Filters and facets | Plain SQL on `docs` columns with indexes. Facet counts are `GROUP BY` over the match set and get slower as match sets grow. For huge sets, cap or sample. |
| Operators | `site:`, `type:`, `before:`, `after:` become `WHERE` clauses from our own query parser. Phrases and `-excluded` map to FTS5 phrases and `NOT`. The parser in `sqlite-bench.mjs` handles phrases, exclusions and words. |
| Zero results on AND queries | Fall back to an OR query, or drop the rarest term, when AND returns nothing. Meilisearch and Typesense do this for you. |
| Large result sets | `bm25` ordering visits every match. Not measured beyond 50k documents. Mitigations: stop-word list, a title-and-headings-only first pass, a hard cap on candidates, and caching hot queries. |

### Meilisearch

- **No BM25 knobs.** Relevance is a list of ranking rules applied in order as tie-breakers, not a score. Default order: `words`, `typo`, `proximity`, `attributeRank`, `sort`, `wordPosition`, `exactness`. The first rule has the most effect. The old combined `attribute` rule is split into `attributeRank` (which field) and `wordPosition` (where in the field); the two can be placed apart. Custom rules such as `date:desc` go at the end as tie-breakers. "Title > headings > URL > body" is expressed only by the **order** of `searchableAttributes`. There are no numeric weights, so title strictly beats headings even when the body match is far better.
- **No stemming.** Workaround: stem at our end. Store a pre-stemmed copy of the text in an extra searchable attribute and stem the query terms before sending. This costs index size and gives up Meilisearch's own highlighting for stemmed matches. Not tested.
- **Operators** (`site:` etc.) turn into `filter` expressions in our query builder; filterable attributes must be declared up front.
- **Dedupe:** `distinct` attribute. We would store a content hash.
- **Did-you-mean:** no dedicated endpoint found in the docs read; it would need our own vocabulary logic anyway.
- **Disk:** 1.4 GB for 115 MB of text here (12x), 2.5 GB after sequential batches. Deleted documents do not return space to the OS, per the [storage page](https://www.meilisearch.com/docs/learn/engine/storage). Disk grows over time and there is no compaction.

### Typesense

- **Entire searchable index lives in RAM** (docs: "stores the entire search index in-memory and a copy of the raw data on disk"; rule of thumb 2-3x the size of the searched fields). Measured: about 440 MB steady for 50k pages of 2 KB. Linear extrapolation to 1 million pages of this size is about 9 GB, which does not fit a Pi and makes ZIM-scale content impossible.
- **Startup reloads the index:** 5 s for 50k pages here; much longer at scale. Not measured beyond that.
- **Stemming plus phrase bug** (section 3).
- **Dedupe:** `group_by` with `group_limit=1`.
- **No BM25**, but numeric field weights and a text-match score. Closest to the requested field weighting.

### Tantivy and Manticore (not benchmarked)

- **Tantivy** is the closest to "Lucene in Rust": BM25, fuzzy term queries, phrase queries, facets, snippets and Snowball stemmers, with segments memory-mapped from disk. It is a library, not a server. Using it means a Rust sidecar or a Node binding. The only npm package I saw named `tantivy` is version 0.1.0 and I did not assess it. This would be our biggest engineering cost for the best expected scaling. Quickwit (Apache-2.0, v0.9.3, Tantivy-based) is a server, but it is aimed at log and object-storage search, which is heavier than we need.
- **Manticore Search** has arm64 images, BM25, stemming, suggestions and fuzzy search, but fuzzy search needs the Buddy helper (another process) and the licence is GPL-3.0. Worth a bake-off only if FTS5 hits a wall.

## 5. Operational complexity

| | FTS5 | Meilisearch | Typesense |
|---|---|---|---|
| Extra container | None; same process and DB file | One more container, HTTP API, API key to manage (a master key is required outside development mode) | One more container, API key |
| Backups | Part of the SQLite backup (`VACUUM INTO` or the online backup API) | Dump or snapshot API, or copy the LMDB volume while stopped. Another thing to schedule and restore | Snapshot API or copy the data dir. Another thing to schedule and restore |
| Rebuild from stored content | `INSERT INTO fts(fts) VALUES('rebuild')` (the benchmark used a bulk `INSERT ... SELECT` instead; the `rebuild` command itself was not timed) plus a vocab rebuild. Here: about 8 s for 50k pages | Drop index, re-post every document. 22 s here unthrottled, 96 s paced | Drop collection, re-import. 19 s here |
| Consistency with metadata | Same transaction as the archive row | Dual-write; needs a sync/outbox and a way to detect drift | Dual-write; same issue |
| Upgrades | Library bump | Meilisearch has needed a dump/import between some versions (check the release notes each time) | Check release notes; 31.0 is in RC |
| Failure on small hardware | Degrades gracefully; page cache shrinks | Indexing OOM-killed at 1 GB and 512 MB | Indexing OOM-killed at 512 MB; at 1 GB it just fits for 50k pages |
| Raspberry Pi 5 specifics | Not applicable | Not verified (16 KB kernel pages) | The vendor ships `arm64-lg-page16` tags; check which one matches the Pi 5 kernel |

Two federation notes. ZIM files such as Wikipedia normally carry their own full-text index (Xapian, from general knowledge; **not verified here**), so a federated search can ask the ZIM reader at query time and merge results by rank or by source, rather than importing those pages into our index. Whatever engine we use, the merge step (normalising scores across sources) is our code.

## 6. What this means for the decision

- On the metrics that matter for a Pi, FTS5 wins clearly: it ran the 512 MB case without noticing, used about 125 MB of process memory for queries, and kept the index in one file at 333 MiB. Both servers were killed at 512 MB.
- Meilisearch gives the best out-of-the-box search behaviour (typos, prefix, phrase and filters work without code), and its mmap design avoids Typesense's "everything in RAM" ceiling. Its costs are disk size, indexing memory that does not respect small container limits, and no stemming.
- Typesense has the richest ranking controls and stemming, but its RAM-resident index is wrong for a Pi at the target scale, and its phrase search failed under stemming in this version.
- Because the three engines have such different shapes, a thin adapter interface is worth defining now, with methods roughly `upsert(docs)`, `remove(ids)`, `search(parsedQuery) -> {hits, facets, didYouMean}`, `suggest(prefix)`, `rebuild(source)` and `stats()`. A conformance test suite built from `queries.json` and the spot-check cases above keeps a second implementation honest. Do **not** build the second implementation until there is evidence it is needed.

### Open questions that need real-hardware work

1. FTS5 at 500k-1M documents on a real Pi 4 and Pi 5 with a USB SSD: index time, common-term latency, DB size, and `optimize` time. This is the main untested risk.
2. Whether FTS5 ranking after typo correction can match the engines' results with the fixes listed in section 3.
3. Meilisearch memory on a 16 KB-page Pi 5 kernel, and whether any indexing setting makes 1 GB viable.
4. Whether the Typesense phrase/stemming failure is a bug in v30.2 (and fixed in 31.x).
5. Legal read of the Meilisearch EE/BUSL boundary for the official Docker image, if we plan to bundle it in a Compose file.

## 7. Reproducing

Everything is in `docs/research/search-bench/` (the corpus and downloaded dump are git-ignored under `data/`).

```
cd docs/research/search-bench
curl -o data/simplewiki.xml.bz2 https://dumps.wikimedia.org/simplewiki/latest/simplewiki-latest-pages-articles.xml.bz2
MINLEN=900 python3 -I build_corpus.py data/simplewiki.xml.bz2 data/corpus.jsonl 50000
node gen_queries.mjs                            # writes queries.json (committed)
docker compose -p brainbench --profile sqlite build
node run.mjs sqlite 0        # engine: sqlite | meili | typesense;  memory: 0 (none), 1g, 512m
TUNED=1 SEQ=1 MEILI_IDX_MEM=805306368 node run.mjs meili 2g    # tuned Meilisearch
STEM=0 node run.mjs typesense 0                                 # Typesense without stemming
LIMIT=25000 node run.mjs typesense 512m                         # reduced corpus
```

Files:

- `build_corpus.py`, `gen_queries.mjs`, `queries.json`: corpus and query generation.
- `docker-compose.yml`, `docker-compose.tuned.yml`, `Dockerfile.sqlite`: containers (compose project name `brainbench`; each run tears its project down with `down -v`).
- `run.mjs`: orchestrator and the Meilisearch/Typesense adapters. `sqlite-bench.mjs`: the FTS5 implementation and benchmark, run inside the container.
- `probe-meili.mjs`, `probe-ts-phrase.mjs`: the two diagnostics described above.
- `results/*.json`: raw results per engine and memory limit (file names carry `tuned`, `seq`, `nostem` and `NNNNdocs` suffixes). `results/failed-first-attempts/` holds the first, non-sequential tuned Meilisearch attempts, which also died.

All benchmark containers and volumes were removed afterwards. The pulled images (`getmeili/meilisearch:v1.56.0`, `typesense/typesense:30.2`, and the locally built `brainbench-sqlite:local`) were left on the Docker host.
