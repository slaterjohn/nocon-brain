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
