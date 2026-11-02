# Sources, collections and schedules

Tasks C-06, C-07, C-09 and C-13. API contract and deviations: `docs/api.md` sections 7 and 8. Tables: `docs/data-model.md` 3.3 and 3.3a (migration 0006).

| Folder | What it holds |
|---|---|
| `sources/` | `SourceService` (CRUD, versioned configs, run, pause, delete, stats, preview), zod schemas and ceilings (`schema.ts`, `limits.ts`), `references.ts` (page_sources, exclusions), `crawl-port.ts` (adapter to `startCrawl`), `discovery/` (XML, sitemap and feed parsers, guarded fetching) |
| `collections/` | `CollectionService` (tree with cycle and depth guards, memberships, auto rules, floors), `rules.ts`, `icons.ts` (fixed lucide names), `references.ts` |
| `schedule/` | `ScheduleService` (schedules and windows), `cron.ts` (cron-parser), `windows.ts`, `time.ts`, `scheduler.ts` (the tick) |

## What a source reference is (for Phase 6)

`page_sources(page_id, source_id, first_seen_at, last_seen_at, discovered_via, depth, priority_override)`. Reference priority is `COALESCE(priority_override, sources.priority)`. Retention and automatic eviction come from the source row. The reference is active while the source is not soft-deleted; disabled and paused sources keep theirs. Use `sourceReferences(db, pageId)` and `collectionReferences(db, pageId)`.

## Deleting a source

Soft delete. The source's `page_sources` rows are removed, so nothing keeps a reference to it; its schedules and windows go; queued and running downloads are cancelled. Pages are not deleted (unless `?deletePages=true`, and then only those with no other source and no bookmark). A page with no reference at all is priority 4 and surplus, and Phase 6 evicts it by policy. Nothing is orphaned silently: the activity log records the counts and the API returns them.

## Running a source

`SourceService.run` by type (`imported_documents` has nothing to run: its files arrive through `POST /api/archive/import`, see `apps/server/src/imports/README.md`): `single_page` goes to `pipeline.captureUrl`; `sitemap` and `feed` are read through the guarded fetcher (50,000 addresses, 50 MB compressed and unpacked, nesting and file-count caps) and only addresses not in `source_discovered_urls` are captured; `website`, `section` and `linked_collection` go through `EngineCrawlPort` to `CrawlService.startCrawl`. Captures carry `sourceId`, `discoveredVia` and `depth`; the pipeline writes the reference.

## Scheduler

`Scheduler.tick()` is called from `JobRunner`'s loop (`periodic`) and throttles itself to one pass per 15 s of monotonic time. It enforces download windows on download jobs and claims schedule slots through a `ScheduleGate` (saved in `schedules.last_slot_at` before the run starts). `Scheduler.isOpen(sourceId, requestedBy)` is the question the crawl engine asks before starting background work. See `docs/api.md` section 8 for the policy.
