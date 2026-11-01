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
