# Benchmarks

Numbers are measured, on the hardware named in each entry. Nothing here is a claim about a Raspberry Pi unless the entry says so. Reproduce with the command given. Results are JSON from the script, copied as-is.

## Template

| Field | Value |
|---|---|
| Date | |
| Hardware | CPU, cores, RAM, storage |
| Software | OS, Node, SQLite version |
| Command | |
| Dataset | |
| Runs | |
| Result | |
| Pi? | "not a Pi" unless run on one |

## Job queue (F-04)

| Field | Value |
|---|---|
| Date | 2026-11-01 |
| Hardware | Apple M4 Pro, 12 cores, 24 GiB RAM, internal NVMe. **Not a Pi.** |
| Software | macOS (Darwin 25.0.0) arm64, Node 24.22.2, SQLite 3.53.4 (better-sqlite3 13.0.3) |
| Command | `pnpm bench:queue` (`scripts/bench-queue.ts`) |
| Dataset | 50,000 `fetch` jobs, 500 hosts, priorities 0 to 4; the claim honours the per-host limit of 1 |
| Runs | 1 run of 50,000 cycles (the 12 ms figure below came from a 5,000-cycle run) |
| Pragmas | WAL, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON` |

Result:

| Measure | Value |
|---|---|
| Bulk insert, 50,000 rows in one transaction | 452 ms (9 us per job) |
| Claim + complete, 50,000 cycles, each its own transaction | 2,672 ms, **0.053 ms per cycle**, about 18,700 cycles per second |
| WAL size after the run | 10.4 MB |

Against the research figure (about 1.5 ms per cycle, [crawling-rendering.md](research/crawling-rendering.md) section 7): this is far faster, because both statements here run inside `BEGIN IMMEDIATE` transactions under `synchronous=NORMAL` (no fsync per commit) on a fast NVMe, and the research timed autocommit statements. Expect a large gap on an SD card or a Pi 4; re-run there before relying on it.

Finding: with the index as first drafted in data-model.md (`queue, state, run_at, priority DESC, score DESC, id`) the same claim took **12 ms per cycle** at 50,000 queued rows, because SQLite sorted every due row on every claim. The shipped index is `(queue, state, priority DESC, score DESC, id)`. The ordered scan stops at the first runnable row. Worst case remains a linear skip over rows blocked by a busy host.

## Job queue in the arm64 server image under memory limits (F-14)

Method: `scripts/bench/run.sh` builds the `bench` target of `docker/server/Dockerfile` (the production server image plus `scripts/bench-queue.ts` bundled into one file). It starts a container per run with `--memory` and `--memory-swap` set to the same value (no swap), a read-only root, all capabilities dropped and a disk-backed `/tmp` (an anonymous Docker volume, so the database file is not held in RAM). The benchmark is the one above: 50,000 jobs, 500 hosts, claim and complete in separate transactions. The script runs 3 runs at 512 MB and 3 at 1 GB, reads `memory.peak` from the container's cgroup, and writes one JSON file (`bench-results/queue-<platform>-<timestamp>.json`, git-ignored) that holds the host details and every run. A run killed for lack of memory is recorded with `oom: true`.

Host details come from `scripts/bench/host.mjs`: CPU, cores, architecture, OS, memory, Docker version and VM size. The `pi` field says "not a Pi" unless `/proc/device-tree/model` names a Raspberry Pi.

| Field | Value |
|---|---|
| Date | 2026-11-01 |
| Hardware | Apple M4 Pro, 12 cores, 24 GiB RAM. Docker Desktop VM: 12 CPUs, 7.7 GiB. **Not a Pi.** |
| Software | macOS (Darwin 25.0.0), Docker 29.2.1, container `linux/arm64` (kernel 6.12.69-linuxkit), Node 24.22.2, SQLite 3.53.4 (better-sqlite3 13.0.3) |
| Command | `scripts/bench/run.sh` (defaults: `--platform arm64 --limits "512m 1g" --runs 3`) |
| Dataset | 50,000 `fetch` jobs, 500 hosts, priorities 0 to 4 |
| Runs | 3 per limit |

| Memory limit | Claim + complete, ms per cycle (3 runs) | Cycles per second | Bulk insert, 50,000 rows | Peak memory (cgroup) | Out of memory |
|---|---|---|---|---|---|
| 512 MB | 0.044, 0.046, 0.043 | 22,957 / 21,973 / 23,039 | 387 / 405 / 379 ms | 83 MiB | no |
| 1 GB | 0.042, 0.042, 0.042 | 23,826 / 23,772 / 23,952 | 379 / 365 / 366 ms | 114 MiB | no |

What this shows: the queue stays far below both limits, so the limits did not change the result. The small gap between the two rows comes from the kernel's page cache, which counts towards `memory.peak` and grows when more memory is allowed; it is not heap use. The figures are a little faster than the 0.053 ms in the first entry, which ran on the host with a single run; the cause was not investigated. They say nothing about a Pi. Run `scripts/bench/run.sh` on the Pi (it works the same with `--platform arm64`) and add an entry with its hardware, ideally on both an SSD and an SD card.

Not covered: memory use of the full server under load (needs the Phase 2 pipeline), and the `amd64` image, which would run under emulation here and so would not be meaningful.

## Renderer image and memory per page (C-16)

| Field | Value |
|---|---|
| Date | 2 November 2026 |
| Hardware | Apple M4 Pro, 12 cores, 24 GiB RAM. Docker Desktop VM. **Not a Pi.** |
| Software | Docker 29.2.1, container `linux/arm64` (kernel 6.12.69-linuxkit), `node:24-trixie-slim` (Debian 13, Node 24.22.2), `playwright-core` 1.64.1 with `chromium_headless_shell-1248` (Chromium 156) |
| Command | `NCB_DOCKER_TESTS=1 pnpm vitest run --project integration tests/integration/renderer/docker` (writes `test-results/renderer-docker.json`) |
| Setup | The image from `docker/renderer/Dockerfile`; container limits as in `compose.yml`: `--memory 1g --memory-swap 1g --pids-limit 256 --shm-size 256m`, read-only root, tmpfs `/tmp`, `--cap-drop ALL --cap-add SYS_CHROOT`, Playwright's seccomp profile, Chromium's sandbox on. On an internal-only network; the page is fetched through the forward proxy in a second container |
| Dataset | Fixture pages from `tests/fixtures/sites/article.mjs`: `/js-only` (an empty shell, article inserted by script after a `fetch`), `/js-only/big` (the same behind a 28 KB bundle comment) and `/js-only/heavy` (30,000 table rows built by script from a 1.5 MB JSON payload, a 1.9 MB DOM) |
| Runs | 1 per row, measured from the cgroup (`memory.current`, `memory.peak`) so Chromium's child processes count |

| Measure | Value |
|---|---|
| Image size on disk (`docker images`) | **1.26 GB** (337 MB of compressed layers). The Chromium headless shell is about 280 MB of it; the rest is the system libraries `playwright-core install --with-deps` adds. The research figure for the same recipe on Debian 12 was 1.32 GB |
| Build time | 32 s for a cold build on this machine and connection (the `node:24-trixie-slim` base was already present; it includes the apt and Chromium downloads) |
| Renderer container before the first page (Node server only, no browser) | 82 MiB, 8 processes |
| After the first small page (browser started) | **155 MB** |
| Small pages 2 to 5 (about 2 KB of HTML each, fresh context each) | 157, 162, 162, 165 MB: about **+3 to +5 MB** per extra page once the browser is up; peak 166 MB |
| Script-heavy page (30,000 rows, 1.9 MB DOM) | 551 MB after, **558 MB peak**; the same container then rendered the next page normally |
| Time per page | 1.3 s for a small script-built page (includes starting the browser on the first one); 1.4 s for the heavy page. Fixture pages are on the local machine, so there is no network time. The renderer waits for network idle (at most 8 s) and scrolls four screens |

What this shows: a 1 GB limit holds an idle browser (about 130 to 150 MB), small pages and a deliberately heavy page with room to spare. A real script-heavy site will sit between the two rows (the research measured about 80 MB per extra page of 1 MB of HTML in a different build). On a 2 GB Pi use `NCB_RENDERER_MEMORY=700m`: the heavy fixture would not fit, which would show up as a render failure (the container is restarted by Docker and the plain capture stays). Not measured: a real Pi, the `amd64` image, and long-running leak behaviour (the browser is restarted after 50 pages as a precaution).

Network isolation, same run: the renderer container cannot open a TCP connection to 1.1.1.1:443, 8.8.8.8:53, 93.184.216.34:80, the machine's LAN address, or `host.docker.internal`, and name lookups fail; it can reach only `server:3128`. Nine private or loopback pages given to the renderer (10.0.0.1, 192.168.1.1, 169.254.169.254, 127.0.0.1, `[::1]`, `2130706433`, the SSRF-bait canary by two names, the LAN address) all failed, none reached the target, and the canary stayed at 0.


## Local search: 50,000 and 500,000 pages in the arm64 image under memory limits (S-13)

**Not a Pi.** These numbers come from a Mac running Docker Desktop (a Linux VM) and say nothing about a Raspberry Pi. **Outstanding: Pi 4 (PT-03), Pi 5 (PT-01, PT-02, PT-04, PT-12, PT-13) and amd64.** Run `scripts/bench/search.sh` on each (it works the same on a Pi) and add an entry; the Pi 4 and Pi 5 should be run on SSD and, if supported, on an SD card, with `--limits "1g 2g"` or the profile's real limit.

| Field | Value |
|---|---|
| Date | 2 November 2026 |
| Hardware | Apple M4 Pro, 12 cores, 24 GiB RAM. Docker Desktop VM: 12 CPUs, 7.7 GiB. Internal NVMe. **Not a Pi.** |
| Software | Container `linux/arm64`, `node:24-trixie-slim`, Node 24.22.2, better-sqlite3 13.0.3 (SQLite 3.53.x), `scripts/search/bench.ts` bundled into the `bench` target of `docker/server/Dockerfile` |
| Command | `scripts/bench/search.sh --sizes "50000 500000" --limits "512m 1g" --runs 1` (container: `--memory` = `--memory-swap`, read-only root, disk-backed `/tmp`). The 500,000-page run at 512 MB was repeated by hand with the same image and a bundle built on the host, because the image could not be rebuilt (the registry was unreachable) |
| Dataset | 50,000 pages: the Simple English Wikipedia corpus of the research (`docs/research/search-bench/data/corpus.jsonl`, 99 MiB of text, test-only, gitignored). 500,000 pages: the same 50,000 plus 450,000 synthetic pages made deterministically (seed 424242): sentences drawn from two real pages each, so vocabulary and frequencies stay realistic; titles are a real title plus a word of another. |
| Queries | `docs/research/search-bench/queries.json` (230: single, multi, typo, phrase, prefix, filtered), one warm-up pass then 3 measured passes with the hot-query cache bypassed; 40 common words (document frequency up to 24,000 at 50k), alone and in pairs; 15 bare stop words; three-letter autocomplete prefixes; 200 incremental upserts. Warm cache except the "cold" column (first five queries after opening the file) |
| Runs | 1 per row (no variance is claimed) |

Latency in milliseconds, p50 / p95:

| | 50k, 512 MB | 50k, 1 GB | 500k, 512 MB | 500k, 1 GB |
|---|---|---|---|---|
| All 690 queries | 3.9 / 13.5 | 3.6 / 13.0 | 43 / 326 | 12 / 33 |
| Single word | 8.3 / 10.7 | 8.0 / 10.4 | 64 / 558 | 13 / 39 |
| Two words | 1.8 / 10.6 | 1.7 / 9.9 | 25 / 243 | 11 / 33 |
| Phrase | 0.4 / 3.2 | 0.4 / 3.0 | 9 / 48 | 3 / 14 |
| Domain-filtered | 1.0 / 9.4 | 0.9 / 9.0 | 50 / 378 | 4 / 27 |
| Typo (with correction) | 9.8 / 17.2 | 9.5 / 16.6 | 63 / 456 | 16 / 33 |
| Prefix (`term*`) | 10.8 / 15.0 | 10.2 / 14.2 | 68 / 178 | 18 / 45 |
| Common word (PT-02 "common-term") | 9.3 / 14.6 | 8.7 / 13.7 | 60 / 1,328 | 18 / 69 |
| Two common words | 12.2 / 15.5 | 11.3 / 14.4 | 896 / 1,538 | 50 / 90 |
| Bare stop word | 9.5 / 17.9 | 9.0 / 16.9 | 54 / 1,093 | 23 / 75 |
| Autocomplete, 3-letter prefix | 0.15 / 0.42 | 0.13 / 0.35 | 0.26 / 4.6 | 0.18 / 0.75 |
| Same query again (hot cache) | 0.00 / 0.01 | 0.00 / 0.01 | n/a | 0.00 / 0.01 |
| First five queries after open | 28, 3, 2, 3, 6 | 15, 2, 2, 2, 6 | 157, 77, 52, 52, 94 | 214, 116, 80, 68, 126 |
| Incremental upsert of one page | 0.19 / 0.67 | 0.19 / 1.6 | 0.23 / 2.9 | 0.19 / 0.93 |

Build and size:

| | 50k, 512 MB | 50k, 1 GB | 500k, 512 MB | 500k, 1 GB |
|---|---|---|---|---|
| Build (insert, vocabulary, optimise) | 21.6 s | 20.4 s | 310 s | 364 s |
| `index.db` size | 370 MiB (3.7x the 99 MiB of text) | 370 MiB | 3,550 MiB (3.5x) | 3,556 MiB |
| Node peak RSS | 212 MiB | 245 MiB | 229 MiB | 266 MiB |
| Container memory peak (cgroup, includes page cache) | 512 MiB | 867 MiB | 512 MiB | 1,024 MiB |
| Killed for memory | no | no | no (after the fix below) | no |

What this shows, against the targets (all to be re-measured on a Pi; the targets are for Pi hardware, so passing here proves little):

- PT-01/PT-02 (p95 at 50k and 500k): at 1 GB, 13 ms at 50k and 33 ms at 500k, with common words at 69 ms. At 512 MB and 500,000 pages the 3.5 GB index no longer fits in the page cache (the container's 512 MB includes it), so most queries read from disk: overall p95 326 ms, common words 1.3 s, two common words 1.5 s. A Pi at that size needs more than 512 MB of free memory for the page cache or an SSD; this is the number to watch on real hardware.
- PT-04 (typo p95, autocomplete p95): typo 17 ms at 50k and 33 ms at 500k (1 GB); autocomplete under 1 ms at both sizes (1 GB), 4.6 ms at 500k with 512 MB.
- PT-12 (index build): 21 s per 50,000 pages and about 6 minutes per 500,000 pages here; incremental upsert 0.2 ms p50. PT-13 (size over raw text): 3.5x to 3.7x against the 3.5x target at 500k and a miss by 0.2 at 50k (the research measured 2.9x without the title table, the own-content body copy and the trigram vocabulary).
- Cold start: the first query after opening a 3.5 GB file costs 100 to 210 ms.

Findings and mitigations applied (S-13 asks for mitigations if common terms are slow):

1. **First run (before any mitigation), 500k at 1 GB:** overall p95 133 ms, common word p95 178 ms, two common words 135 ms, bare stop word 317 ms, autocomplete p95 61 ms; a 512 MB limit killed the build. Saved as `bench-results/search-arm64-before-mitigation.json` (not committed).
2. **The cause of most of that was not FTS5.** Every search asked "does the index hold any default-group documents?" with `SELECT 1 FROM docs WHERE fts_group = 'default' LIMIT 1`; with no such documents that scanned all 500,000 rows (about 45 ms) on every query and every suggestion. An index `docs_group_idx` fixed it: single-word p50 68 to 13 ms, phrase p50 56 to 3 ms, autocomplete p95 61 to 0.8 ms at 500k.
3. Mitigations kept, each measured in the second and third runs: a **title-first pass** (a term in 5,000 or more pages is first matched in title, headings and URL; at least 30 hits there and only those are ranked; common-word p95 178 to 69 ms), **stop words** dropped from multi-word queries, the **candidate cap** (300) on the bm25 ordering, a **hot-query cache** (200 entries, emptied by any commit to the index file; 0.01 ms on a repeat), and an **unranked title lookup** for autocomplete (taking the first 120 matches in index order and ordering them in code).
4. **Build memory:** at 512 MB the 500,000-page build was killed after the last document was inserted, in the optimise step: one FTS5 `optimize` of a 3.5 GB index is a single transaction of 3.5 GB. Large indexes (over 100,000 pages) are now merged with `merge` in 500-page steps and the log is truncated between tables; the build then finished under the 512 MB limit with a Node peak of 229 MiB. (The harness also had to stop holding the 99 MiB corpus as JavaScript strings.)

Reproduce: `scripts/bench/search.sh --sizes "50000 500000" --limits "512m 1g"` (needs `docs/research/search-bench/data/corpus.jsonl`, see the quality-suite section below), or natively `npx tsx scripts/search/bench.ts --docs=50000 --dir=/tmp/ncb-search-bench`.

## Search quality suite (S-15)

Where: `packages/search/test/quality.test.ts` (runs in `pnpm test`, so in CI). Two corpora:

- **Synthetic, 5,000 pages, always.** `packages/search/test/synth.ts` generates it from a fixed seed (20261102) with a handful of planted articles (Astronomy, Planet, Solar System, Moon, Mars). `packages/search/test/quality/queries.json` is the 230-query set generated from it with seed 1234567 (the same generator style as `docs/research/search-bench/gen_queries.mjs`: 40 single, 100 multi, 40 typo, 30 phrase, 30 prefix, 30 filtered); the test regenerates it and fails if the committed file differs. `quality/golden.json` holds the top-5 page ids of every third query.
- **Simple English Wikipedia, 50,000 pages, when present.** The corpus is a **test-only artefact**: `docs/research/search-bench/build_corpus.py` builds `docs/research/search-bench/data/corpus.jsonl` from the Simple English Wikipedia XML dump (`simplewiki-latest-pages-articles.xml.bz2`, about 340 MB). The `data/` directory is gitignored, nothing in the product reads it, and CI does not have it, so CI runs the synthetic corpus only. The suite uses the research `queries.json` (seed 1234567). Set `NCB_QUALITY_REAL=0` to skip it, `NCB_SEARCH_CORPUS=/path` to point at another file. Synthetic and real corpora must never be mixed in one index.

Tolerances (a failure means a ranking or matching regression; they are written in the test header too):

| Check | Tolerance |
|---|---|
| Zero-result queries (single, multi, prefix) | none |
| Zero-result phrase queries | none on the synthetic corpus; at most 2 of 30 on Wikipedia (the research generator ignores digits, so a few "phrases" straddle a number such as "completed $1.35 billion") |
| Zero-result domain-filtered queries | at most 10% (research: 12 of 30 failed before the OR fallback) |
| Typo recovery (correction equals the word the typo was made from) | at least 90% synthetic, 75% Wikipedia |
| Golden top-5 (synthetic) | mean overlap at least 0.9, and the top result may change for at most 10% of queries |
| Spot checks | `astronamy` returns Astronomy first; `plenets` corrects to `planets`; `"solar system"` hits contain the phrase; `site:` results are all on the site; `after:` results are all dated after the cut; `-mars` excludes Mars; `discovering planets` returns results |
| Latency (single term p95 under 50 ms) | informational: printed, never failing |

After an intended change in ranking, regenerate the golden lists with `UPDATE_GOLDEN=1 pnpm test` and review the diff of `quality/golden.json` and the changed queries in the commit.

## Wikipedia client against the real service (Z-07)

Manual smoke test, run once on 2 November 2026 from a home connection with `NCB_CONTACT=https://github.com/slaterjohn/nocon-brain` (a web address, no email): `node --import tsx scripts/manual-wikipedia-check.ts` (default article `Ethylbenzene`, language `en`). It makes two requests, one second apart, through the same `WikipediaClient` the server uses; it is not part of any suite.

| Request | Result |
|---|---|
| `GET https://en.wikipedia.org/w/rest.php/v1/page/Ethylbenzene/html` with `User-Agent: NoConBrain/0.1.0 (https://github.com/slaterjohn/nocon-brain)` | 200 in 1,027 ms, 154,967 bytes (Parsoid HTML). `ETag: W/"1380098400/eb76eda4-d416-11f1-a716-434a25102701/view+lang:und"`, `Last-Modified` present, `Content-Language: en`. No `X-Revision-Id` header: the revision (1380098400) is read from the start of the `ETag`, and equals the one in the document (`about=".../Special:Redirect/revision/1380098400"`). Page id 1730352, namespace 0, `dc:modified` 2026-10-13T19:46:18Z |
| Link extraction on that body | 267 distinct `mw:WikiLink` article links, 60 of them in the lead section (the infobox is part of the lead), 11 images with a file page |
| `GET /w/api.php?action=query&prop=imageinfo&iiprop=url\|extmetadata&titles=File:Ethylbenzene-2D-skeletal.svg&maxlag=5&format=json&formatversion=2` | 200 in 338 ms |

Findings:

- The conditional-request validator is the `ETag`; its first number is the revision id, which is what `revisionFromEtag` reads.
- The first run returned no image credits although the answer held them. The file lives on Commons, and for such a file the wiki reports the page as `missing: true` (with `imagerepository: "shared"`) while still giving `imageinfo`. The client skipped pages marked missing. Fixed to look at `imageinfo` only, and covered by a unit test built from that response shape. Not re-run against the real service, to stay within the two requests agreed for the smoke test.
- The client state afterwards: 2 requests, 0 retries, 0 rate-limit answers, breaker closed.
- Not measured: behaviour under a real 429 or `maxlag` answer (the fake Wikimedia server covers both), and a crawl of more than one page.

## Scale test: 500,000 pages

This is the H-09 run: a synthetic library of 500,000 pages built through the application's own database, migrations, volume and file layout, with the real server started on it. The full JSON is in [benchmarks-data/scale-500k-m4pro-arm64.json](benchmarks-data/scale-500k-m4pro-arm64.json). **Not a Pi, and not x86-64.**

| Field | Value |
|---|---|
| Date | 3 November 2026 |
| Machine | Apple Mac mini, Apple M4 Pro (12 cores), 24 GiB RAM, internal SSD (APFS, 460 GiB, about 20 GiB free at the start), macOS 26.0.1 (Darwin 25.0.0), arm64 |
| Software | Node 24.22.2, SQLite 3.53.4 (better-sqlite3 13.0.3), commit of version 1.0.0-rc.1 plus the uncommitted wave D changes |
| Command | `pnpm bench:scale --pages 500000 --out result.json` (`scripts/bench-scale.ts`) |
| Runs | 1 full run. The query timings are 300 queries per type, each run once with the hot-query cache off |
| Library | 500,000 pages, 549,899 saved copies (10% of pages have two), 2,000 hosts, 300 sources (5% P1, 15% P2, 40% P3, 40% P4), 1,158 MB of extracted text (mean 2.1 KB a copy), 6,000 shared assets (a style sheet, a logo and a font for each host, referenced by every page of the host), 74,866 page-specific images, 1,724,563 asset references, 630,765 stored files. Text is made from a Zipf-distributed made-up vocabulary |
| Not in the library | Outline blobs (headings are not indexed), the link graph (no `links` rows), rendered captures, bookmarks, history. Document sizes are drawn from one distribution, so there are no very large pages |
| Other load | A Time Machine backup of the machine was running throughout, which makes disk-heavy figures (start-up, first reads) noisier than on a quiet machine. The first block of library timings in the full run (3 s a page of 50) was disturbed by it; the separate library run below is the figure used |

### What it costs on disk and in memory

| Measure | Value |
|---|---|
| `main.db` | 1,244 MB (2,489 bytes a page) |
| `index.db` | 3,764 MB (7,527 bytes a page; 3.23 times the extracted text, PT-13) |
| Saved files | 630,765 files, 881 MB stored (zstd for text), 2,589 MB on disk because of 4 KB blocks |
| Server process, idle, search index present, no browser (`node apps/server/dist/index.js`) | 293 MiB resident ten seconds after healthy |
| In-process run after the index rebuild | 601 MiB |
| In-process run while planning an eviction | **2,694 MiB** (the planner loads every page) |
| Peak of the whole run (server, workers and the benchmark together) | 2,847 MiB sampled, 2,606 MiB from the operating system |

### Start-up and rebuild

| Measure | Value |
|---|---|
| Start with no search index (until healthy) | 3.5 s |
| Start with the index present, in-process | 59.5 s |
| Start with the index present, the production bundle, until `/api/system/health` answers `ok` | **43.6 s** (1.5 s at 20,000 pages) |
| First search after that start | 149 ms |
| Index rebuild from the saved text of 500,000 pages | **347 s** (5.8 minutes, 1,441 pages a second), no growth in memory during it |
| Graceful shutdown | 40 ms |

Starting with the index present is slower than starting without one because the server checks the index end to end (`PRAGMA quick_check`) before it uses it; reading a 3.7 GB file takes most of the time. See HB-27.

### Search latency, 500,000 pages

Milliseconds, through the search service (a worker thread round trip and the mapping to the API shape), the page cache warm, the hot-query cache bypassed by making every query distinct:

| Query type | n | p50 | p95 | p99 | max | Mean hits |
|---|---|---|---|---|---|---|
| Common single term | 300 | 13.9 | 20.5 | 134 | 304 | 2,000 |
| Mid-frequency single term | 300 | 16.3 | 22.7 | 26.3 | 28.2 | 1,603 |
| Unique token (one hit) | 300 | 29.9 | 31.8 | 32.5 | 32.9 | 1 |
| Two or three words | 300 | 17.3 | 21.4 | 28.1 | 32.2 | 539 |
| Phrase of three words | 300 | 24.0 | 155 | 350 | 1,941 | 506 |
| Term with a domain filter | 300 | 54.8 | 97.1 | 127 | 146 | 37 |
| Term with a source filter | 300 | 68.7 | 186 | 219 | 284 | 240 |
| Typo (two letters swapped) | 300 | 24.0 | 30.7 | 34.0 | 103 | 1,426 |
| Exact page title | 300 | 21.2 | 60.1 | 316 | 704 | 786 |
| **All 2,700** | 2,700 | **22.8** | **98.4** | **195** | 1,941 | |

Other measures: the first five queries after opening took 46, 29, 21, 19 and 19 ms. With facets, as the results page asks: p50 28.9, p95 102 ms. Suggestions for a three-letter prefix: p50 0.28 ms, p95 1.25 ms. The time the engine reports for its own part is about 4 ms below the service figure at the median. 30 of the 300 typo queries found nothing, because a swapped pair in a made-up word is not always a word that exists.

The unique-token queries cost about 30 ms for one hit, which is more than a common word. That is the price of the title and vocabulary lookups that run before a rare term is accepted; it is flat, not growing.

### Library paging, 500,000 pages

Measured separately on the same library after the full run (`--stage library`), 50 pages a request, milliseconds, p50 / p95:

| Request | p50 | p95 |
|---|---|---|
| Newest first, first page | 184 | 189 |
| Newest first, offset 1,000 | 187 | 196 |
| Newest first, offset 100,000 | 288 | 292 |
| Newest first, offset at 90% of the library | 361 | 365 |
| Sorted by title | 209 | 215 |
| Sorted by site | 126 | 128 |
| Sorted by size | 258 | 269 |
| One source (1,838 pages) | 285 | 295 |
| One domain (293 pages) | 0.9 | 1.1 |
| Priority P1 only (29,426 pages) | 102 | 106 |
| Title or address contains a word | 320 | 323 |
| Walking the first 100 pages in turn | 188 | 196 |

Each request sorts all 500,000 rows (the order is `COALESCE(last_captured_at, 0) DESC, id DESC`, which no index serves), so the cost grows linearly with the library: 24 ms at 100,000 pages in the same test. An order that an index could serve was tried and dropped: it was faster at 100,000 pages, and the 500,000-page result was inconclusive because of the disturbance above. The query is unchanged. A page of the Library takes about a fifth of a second at this size; an open item if it matters.

### Storage planning, execution and verify

| Measure | Value |
|---|---|
| Eviction plan to free 2% of the stored bytes for an incoming P1 (16,074 copies chosen), three runs | 8.2, 9.2, 8.7 s |
| Tidy-up plan (38,838 surplus older copies) | 8.2 s |
| The plan as the API returns it | 8.8 s |
| Usage by priority | 6.9 s |
| Executing a plan: 2,915 copies | 4.5 s, **649 copies a second** (each is one durable transaction); the search index caught up 18.7 s later |
| Backup of `main.db` (`VACUUM INTO`, 1.1 GB, checksummed) | 18.2 s |
| Verify, all checks, default options | 45.2 s |

Verify by check (milliseconds): I-1 stored files exist with the right size (630,765 files) 34,576; I-2 files with no row 8,045; I-3 reference counts 776; I-4 dangling references 2,552; I-5 to I-9 under 300 each; I-10 search index against the archive 609; I-11 checksum of 2,000 files 587 (0.29 ms a file, so a full checksum scrub of 630,765 files would take about 3 minutes plus the disk reads); I-12 database integrity check 4,190; I-13 and REF under 200. No finding of any kind: the synthetic library is consistent, which also shows the seeding matches what the app writes.

### What the test found and fixed

The first runs at 30,000 to 100,000 pages found four faults that grew with the square of the library, and one that held memory. All are fixed and have tests ([hardening-backlog.md](hardening-backlog.md) HB-24 to HB-26):

| Fault | Before | After |
|---|---|---|
| Index rebuild held memory per page (HB-25) | about 40 KB a page: 7.5 GB at 172,000 pages (stopped there) | flat at about 600 MiB for 500,000 pages |
| Verify I-3 (reference counts), no index on the blob columns of `version_content` (HB-24) | 63 s at 30,000 pages (hours at 500,000) | 0.8 s at 500,000 |
| Eviction plan, same missing indexes (HB-24) | 1.0 s at 30,000 pages | 0.33 s at 30,000; 8.7 s at 500,000 (linear) |
| Executing an eviction, unindexed foreign keys and a count of every reference to a shared style sheet (HB-26) | 12 copies a second at 100,000 pages | 804 a second at 100,000, 649 at 500,000 |

### Open findings from this test

- **Start-up reads the whole index (HB-27).** 44 s to healthy at 500,000 pages against a target of 30 s. Mitigation applied: the server image's health check now has a 300 s start period (it was 30 s, so a library this size would have been reported unhealthy). The fix still to do is to run the check in the background after the server is up.
- **Planning an eviction needs 2.7 GB (HB-28).** The planner loads every page into memory, which is over the 768 MB the Compose file gives `server`. A library near 500,000 pages would be killed by the container's memory limit the first time storage runs short of space. Mitigation to do: plan in page chunks, or in two passes (candidates first). Until then, the practical limit for the default memory is well below 500,000 pages; the figure for it is not measured.
- **Planning takes 8 to 9 s at 500,000 pages**, against 5 s in the target (PT-17). It is linear (0.33 s at 30,000), so it follows from the same cause.
- **Idle memory of the server is 293 MiB**, against 200 MB for the Pi profile (PT-05). Not measured on a Pi; the figure is Node plus the libraries on an arm64 Mac.
- The 100 GB blob store and the large crawl with a trap fixture in H-09 were not run: the disk of the test machine had about 20 GB free. The synthetic library has 2.6 GB of files.

## Performance targets

Every target in [implementation-plan.md](implementation-plan.md#11-performance-targets-to-be-measured) with what was measured. The targets are written for a Raspberry Pi; a figure from a Mac says the software has no problem at that size, not that a Pi will keep up. "Not measured" says why.

| ID | Measured | State |
|---|---|---|
| PT-01 | Pi 5: not measured, no Pi available. Mac, 50,000 pages: p95 13 ms (S-13 above); 500,000 pages: p50 23 ms, p95 98 ms | Pi not measured |
| PT-02 | Pi 5: not measured, no Pi. Mac, 500,000 pages: overall p95 98 ms (target 150), common single term p95 21 ms (target 300). Phrase p95 155 ms and source filter p95 186 ms are over 150 | Pi not measured; Mac within target |
| PT-03 | Pi 4: not measured, no Pi | Not measured |
| PT-04 | Pi 5: not measured, no Pi. Mac, 500,000 pages: typo p95 31 ms, suggestions p95 1.25 ms | Pi not measured |
| PT-05 | Server idle 293 MiB on an arm64 Mac in the `pi-lite` profile; target 200 MB. Not measured on a Pi | Mac: miss |
| PT-06 | `web` idle memory: not measured. Nothing in the scale test starts it | Not measured |
| PT-07 | Peak memory of `server` during a crawl: not measured (no Pi; the scale test does not crawl) | Not measured |
| PT-08 | Crawl pages a second on one host: not measured, no Pi. The politeness delay caps it near 0.67 | Not measured |
| PT-09 | Aggregate crawl throughput across 20 hosts: not measured, no Pi | Not measured |
| PT-10 | Pipeline time for a typical article: not measured, no Pi. Research figure for extraction on a Mac in [crawling-rendering.md](research/crawling-rendering.md) | Not measured |
| PT-11 | Extraction of a 1 MB page: not measured on a Pi. Mac: 177 to 294 ms (research) | Not measured |
| PT-12 | Pi: not measured. Mac: 500,000 pages rebuilt in 347 s (5.8 min); 20,000 in 9.3 s; incremental upsert 0.2 ms (S-13) | Pi not measured |
| PT-13 | Index size 3.23 times the extracted text at 500,000 pages (target 3.5) | Met |
| PT-14 | Serve time of an archived page: not measured, no Pi | Not measured |
| PT-15 | Time to healthy at 500,000 pages: 43.6 s with the index (target 30 s), 3.5 s without it; 1.5 s at 20,000. With a migration: not measured at scale. Pi: not measured | Mac: miss (HB-27) |
| PT-16 | ZIM open, read and search on a 13 GB package: not measured, no 13 GB package or Pi. Research figures on a 132 MB package are above | Not measured |
| PT-17 | Eviction plan 8.2 to 9.2 s at 500,000 pages (target 5 s); execution 649 copies a second (target 50) | Plan: miss (HB-28); execution met on a Mac |
| PT-18 | Quick verify (I-1, existence and size of every file): 34.6 s for 630,765 files (target 10 minutes). | Met on a Mac; resuming an interrupted run was not tested |
| PT-19 | Pi: not measured. Mac, 20,000 pages: common single term p50 11.7 ms during a rebuild against 10.7 ms idle (1.1 times) | Pi not measured; Mac within target |
| PT-20 | First paint of local results after a combined search: not measured (needs a browser run on a Pi) | Not measured |
| PT-21 | Server-sent event overhead through the `web` proxy: not measured | Not measured |
| PT-22 | Bytes written per 1,000 captured pages: not measured | Not measured |

## AMD64

**Not measured.** No x86-64 machine was available, and a container emulating x86-64 on this Mac measures the emulator. [release/bench.yml.draft](release/bench.yml.draft) is a workflow that runs `pnpm bench:scale` and the queue benchmark on a GitHub-hosted x86-64 runner and an arm64 runner and uploads the JSON. It was written, not run, and it is not in `.github/` (the Human adds it). GitHub runners are shared and small, so use `--pages 50000` there and take the median of three runs.

## Raspberry Pi 4 and Pi 5

**Not measured.** No Raspberry Pi was available to this project. Every figure above is from a Mac. The Pi differs in ways that matter for these numbers: a slower CPU (several times slower for indexing), less memory (the server container is limited to 768 MB), and storage that may be an SD card or a USB SSD with a very different random-read rate. Do not read the Mac figures as Pi figures. To fill the Pi rows: follow [guides/install.md](guides/install.md#raspberry-pi), put the data on an SSD, and run `pnpm bench:scale --pages 50000` (then 500,000 if the disk has 15 GB free), plus `scripts/bench/search.sh`, and add an entry here with the JSON.

## Reproduce

```sh
pnpm install
pnpm --filter @ncb/server build          # the script also starts the production bundle
pnpm bench:scale                         # 20,000 pages, about 3 minutes
pnpm bench:scale --pages 500000 --out result.json   # about 20 minutes, needs 15 GB free
```

The script makes a scratch folder under the system temporary folder (`--dir` to choose another, `--keep` to keep it), starts one empty server so that the database, migrations and storage volume are created exactly as in a real install, fills it in a child process, then measures in a fresh process so that the generator's memory does not count. Flags: `--pages`, `--seed`, `--exec N` (copies to evict in the execution sample, 0 skips it), `--under-load 0|1` (search while a second rebuild runs; default on up to 100,000 pages), `--out FILE` (also writes `FILE.partial` after each stage, so an interrupted run keeps what it measured), `--force` (skip the free-disk check). `--stage seed` and `--stage library` run the two parts alone. The scratch folder is deleted at the end; nothing generated is committed. To compare two commits, run the same `--pages` and `--seed` on both.

How the numbers are taken: latencies are wall-clock times around the call, from a fresh set of generated queries each run (seeded, so the same queries each time for one `--seed`); percentiles are by rank in the sorted sample. Memory is the resident set size of the process (`process.memoryUsage().rss`, sampled every 100 ms for the peak, and `ps` for the separate production-bundle process). The page cache is warmed by reading the two database files once before the search timings; the first five queries are reported separately. Nothing contacts a network.

