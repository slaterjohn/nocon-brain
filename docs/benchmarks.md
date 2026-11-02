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
