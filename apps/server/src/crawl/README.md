# Crawl engine

Tasks C-01 to C-05. Pure rules (scope, link priority, trap guard, modes and profiles) are in `packages/crawl` (`@ncb/crawl`); this folder wires them to the job queue and the capture pipeline. Sources (C-06) and schedules call the engine; they do not need to know how it works.

## API (stable)

```ts
import { resolveCrawlConfig, type CrawlConfig, type CrawlRequest } from "@ncb/crawl";

// 1. Resolve a mode + profile (+ overrides) into a full config. Throws CrawlConfigError { issues: { path, message }[] }
//    for invalid values and anything above the hard ceilings of the resource profile.
const config: CrawlConfig = resolveCrawlConfig({
  startUrls: ["https://example.com/docs/"],
  mode: "explore",                  // "capture" | "explore" | "mirror"
  profile: "balanced",              // "focused" | "balanced" | "comprehensive" | "custom"
  resource: svc.settings.internal("resources").profile,   // "pi-lite" | "standard"
  section: false,                   // mirror only: stay inside the start URL's directory
  overrides: { scope: { maxDepth: 2, excludedPaths: ["/search/**"] }, limits: { maxPages: 100 } },
  sourceId, configId, priority: 3, requestedBy: "user",
});

// 2. Start it. Everything else is the engine's job.
const run = svc.crawl.startCrawl(config);
// { downloadId: "dl_...", downloadJobId: number, crawlJobId: number | null, mode, jobIds: number[] }
```

`startCrawl(config: CrawlConfig)` is synchronous: it validates the config again (a hand-built object gets the same checks), writes the `download_jobs` + `crawl_jobs` rows (the resolved config is stored in `crawl_jobs.config_json`, so a restart resumes with the same rules), enqueues the start URLs as `fetch` jobs and returns. It throws `AppError("bad_request")` with `details.fields` for an invalid config.

- **capture** mode never creates a `crawl_jobs` row: it calls `pipeline.captureUrl` for the one start URL and returns `{ downloadId, downloadJobId, crawlJobId: null }`. Robots.txt is respected unless the caller used `captureUrl` itself with `userInitiated` (a user's single-page save); `startCrawl` never bypasses robots.
- **explore** and **mirror** create a `crawl_jobs` row and a frontier.

Control and status, by `downloadId` (public id) or `crawlJobId`:

```ts
svc.crawl.pause(id)     // holds the queued frontier; the request in flight finishes. Idempotent.
svc.crawl.resume(id)    // releases it; the time spent paused does not count against maxDuration.
svc.crawl.cancel(id)    // cancels the frontier and aborts requests in flight. stop_reason = "cancelled".
svc.crawl.get(id)       // CrawlStatus (below), or undefined
svc.crawl.list(filter?) // CrawlStatus[]
```

```ts
interface CrawlStatus {
  crawlJobId: number; downloadId: string; downloadJobId: number; sourceId: number | null;
  mode: string; profile: string;
  state: "running" | "paused" | "completed" | "cancelled" | "failed";   // download_jobs.state
  stopReason: StopReason | null;       // set when the crawl ends (see below)
  pagesDiscovered: number;             // frontier rows ever created, start URLs included
  pagesFetched: number;                // pages stored (or confirmed unchanged) with a 2xx/304
  pagesFailed: number; pagesSkipped: number /* links not followed */;
  bytesFetched: number; depthReached: number;
  startedAt: number; finishedAt: number | null;
  skips: Record<string, number>;       // reason -> links skipped: scope:*, trap:*, filter:*, robots, ...
  followed: Record<string, number>;    // link region -> new URLs queued from links in that region
  frontier: { queued: number; running: number; held: number; done: number; other: number };
}
```

### Stop reasons (`crawl_jobs.stop_reason`)

| value | when |
|---|---|
| `completed` | the frontier ran dry |
| `max_depth` | the frontier ran dry and at least one internal link was not followed because it was past `scope.maxDepth` |
| `max_pages` | `limits.maxPages` pages were fetched (requests in flight are counted, so it is never exceeded) |
| `max_bytes` | `limits.maxBytes` of documents and assets were stored (a page in flight can overshoot by one page; the document cap shrinks as the budget runs out) |
| `deadline` | `limits.maxDurationMs` of wall-clock time, not counting time paused |
| `cancelled` | `cancel()` |
| `source_budget`, `volume_full` | reserved for the sources and storage tasks; the engine does not set them yet |

`download_jobs.state` is `completed` for every reason except `cancelled`.

### Rules the engine always applies

- **robots.txt is obeyed; there is no setting to skip it.** A disallowed URL is counted under the skip reason `robots`. `Crawl-delay` raises the per-host delay (capped at 30 s by `@ncb/fetch`).
- **One request in flight per host** (`host_state.in_flight` and `max_concurrent`, enforced by the queue claim) and at least `politeness.minDelayMs` between requests to a host (`host_state.crawl_delay_ms` is raised to that value and to any robots delay). Asset fetches inside a page capture use `politeness.assetConcurrency` (default 1).
- **429 and 503** back the whole host off (`Retry-After`, else exponential with jitter) and the URL is retried; after the last attempt the page counts as failed.
- **The visited set** is `UNIQUE (crawl_job_id, url_key)` on the frontier rows. The key is computed after session ids are removed and the query policy is applied.
- Pages are captured with the normal pipeline (`PipelineService.fetchForCrawl` then `runVersion`). Link priority and features come from the `links` rows stage 7 writes; nothing is re-parsed.
- Every frontier row keeps the reason it was queued in `jobs.payload_json.via` (source URL, region, anchor, score and score components), which is the debugging log for C-03.
- Activity log (`area: "crawl"`): one row at start, one at stop with the stop reason and totals, plus pause/resume/cancel.

### Events

`crawl` on the event bus: `{ crawlJobId, downloadId, state, stopReason?, pagesFetched, pagesDiscovered, pagesFailed }` after each page and at each state change.

## Tables (migration 0005)

`crawl_jobs` gains `config_json`, `max_duration_ms`, `started_at`, `paused_at`, `pages_skipped`, `stop_detail`. New: `crawl_skips (crawl_job_id, reason, count, sample_urls_json)` and `crawl_counters (crawl_job_id, kind, key, value)` (trap budgets, duplicate streaks, per-region follow counts, the depth-limited flag).

## Tests

`tests/integration/crawl`: engine (depth, limits, politeness, pause/resume/cancel, kill and resume), traps, modes and profiles. Unit tests for the pure rules: `packages/crawl/test`.
