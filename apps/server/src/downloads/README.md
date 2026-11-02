# Downloads, limits and refresh

Tasks C-08, C-10, C-11 and C-15. API contract: `docs/api.md` section 8 (downloads, limits, refresh) and section 7 (preview). Tables: `docs/data-model.md` 3.5 and 3.5a (migration 0007).

| Folder | What it holds |
|---|---|
| `downloads/` | `DownloadService` (list, detail, log, queue summary, create, pause, resume, cancel, retry, priority and order; `download.update` events; the repair sweep), `state.ts` (the state machine), `failures.ts` (plain-English text for every failure code), `build.ts` (crawl config for a download made from a URL) |
| `limits/` | `ResourceGovernor` (global fetch concurrency, per-host limits for the queue claim, CPU guard, disk guard), `BandwidthLimiter` (one token bucket shared by all response streams), `presets.ts` (`pi-lite` and `standard`) |
| `refresh/` | `RefreshService` (`refresh` downloads and their `refresh_check` jobs: conditional request, hash comparison, version per policy, gone handling) |
| `sources/preview.ts` | The sampled estimate behind `POST /api/sources/preview` |

## Download state

The state of a download is the `download_jobs.state` column, kept up to date by whoever owns the work: the pipeline for a capture, the crawl engine for a crawl, the refresh service for a refresh, the scheduler for window pauses and the governor for disk pauses. `DownloadService` only reads it, adds what the Human needs (title, progress label, estimate, pause reason, failure text, allowed controls) and applies controls through the owner: a crawl is paused, resumed and cancelled by `CrawlService`; everything else by holding, releasing and cancelling its `jobs` rows with the queue API (`holdByDownloadJob`, `resumeByDownloadJob`, `cancelByDownloadJob`). `sweep()` runs every second and closes a capture whose jobs all ended without the download being closed.

Downloads survive a restart because nothing is kept in memory: the queue recovers `running` jobs at startup, `CrawlService.start()` closes crawls whose last job ended before the crash, and the list is the table. The only in-memory state is the event throttle.

## Limits

- Global concurrency: `JobRunner` asks `governor.fetchConcurrency()` on every poll (`resources.maxFetchConcurrency`, halved while the CPU guard is active, 1 when it is severe).
- Per host: `JobQueue` reads `governor.hostLimits()` on every claim (cap and delay floor, see the data model note).
- Bandwidth: `createFetcher({ bodyThrottle })` puts `limiter.transform()` in front of the byte counters of each response. `resources.bandwidthLimitKbps` (kilobits per second) sets the shared rate; every download, sitemap and page fetch of the server draws on it.
- CPU: `cpuTick()` samples event-loop lag (a 25 ms timer's lateness) and the one-minute load average per core, and throttles above the thresholds of `resources.cpuThrottle` (`low`: 250 ms or 2.0, `medium`: 100 ms or 1.25), with release at 50% of the lag and 80% of the load. Tests pass `limits: { lagSource, loadSource }` to `createServer`.
- Disk: `diskTick()` refreshes every volume's `statfs` every 5 s. When no online volume has room above its `reserve_free_bytes`, all downloads except a single page the Human saved are paused (`paused_by_limit = 1`, reason `volume_full`); they resume when any volume has room again. Phase 6 evicts; this only pauses. Tests pass `volumeProbes.statfs`.
- `renderConcurrency` is a setting only; the renderer (C-16) reads `settings.internal("resources").renderConcurrency`.

## Refresh

A source with a schedule whose scheduled slot comes up while the source has saved pages runs a refresh instead of a full run (sitemaps and feeds also look for new items). `POST /api/sources/{id}/refresh` and `POST /api/downloads { kind: "refresh", sourceId }` do the same on demand. Each check goes through `PipelineService.fetchForCrawl` with the `on_change` rules (conditional headers, then byte hash), then `runVersion` with the source's own versioning policy. Under `on_change` the dedup stage also ends a check whose extracted text did not change; under `all`, `last_n`, `period` and `latest_only` changed bytes make a version, as the policy says.
