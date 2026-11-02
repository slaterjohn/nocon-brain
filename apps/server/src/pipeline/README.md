# Capture pipeline

Tasks A-05 to A-11. Code: `apps/server/src/pipeline`. Pure content code is in `packages/content`.

## Flow

`captureUrl(url, opts)` inserts a `download_jobs` row and enqueues a `fetch` job (queue `crawl`, idempotency key `capture:<url_key>`).
The `fetch` job (main thread) fetches with `@ncb/fetch` (robots checked in `hooks.beforeHop`, a user-initiated save bypasses robots and logs an activity row), applies change detection, stores the original bytes as a blob, creates the `page_versions` row (`capturing`) and the 15 `pipeline_stage_runs` rows, and enqueues a `process` job in one transaction.
The `process` job runs the stages. DOM work (stages 4 to 7 and 10) goes to the extract worker pool; with `NCB_EXTRACT_WORKERS=0` it runs in-thread with the same caps.

| # | stage | what it does |
|---|---|---|
| 1 | validate | status 2xx, HTML content type, non-empty, size cap |
| 2 | store_original | links the blob to the version as a `document` asset reference |
| 3 | assets | discovers and fetches sub-resources, CSS `@import`/`url()` chain, dedupe by sha256, negative records, caps |
| 4 | metadata | title, description, language, author, site name, dates |
| 5 | readable | Readability, defuddle, body text; content hash |
| 6 | sections | outline blob with anchors |
| 7 | links | `links` rows with region, features, score |
| 8 | normalise | canonical (same registrable domain only), redirects, `page_aliases`, page identity |
| 9 | dedup | unchanged under `on_change` ends the capture; same text on another page is flagged (`duplicate_of_version_id`); `simhash` unused |
| 10 | reader | reader HTML and plain-text blobs |
| 11 | render_prep | `version_resources` (replaceable through `stageOverrides.render_prep`) |
| 12 | index | writes an `upsert_page` row to `index_outbox`; the `index` worker applies it (search tasks S-01, S-02) |
| 13-14 | link_graph, candidates | `skipped` stubs |
| 15 | status | one transaction: `ready`/`partial`, `pages.latest_version_id`, link resolution, `inbound_count`, versioning policy, download job done |

A finished stage is never re-run; a stage found `running` after a crash is re-run (attempts accumulate, at most 3 per stage). Each stage writes with upserts or content-addressed blobs. Readers (`SqliteCaptureStore`) only see `ready`/`partial` versions, and `latest_version_id` moves only in stage 15.

## Service API (`svc.pipeline`)

```ts
captureUrl(url, opts?: CaptureOptions): { downloadId: string /* dl_... */; jobId: number }
urlKey(url): string                                    // the dedup key under the pipeline's query policy
holdCapture(downloadId) / resumeHeld(): number         // queue-while-offline: hold a capture, release every held one
captureProgress(downloadId): CaptureEvent | undefined  // the same figures as the `capture` event
getCapture(downloadId): { state, outcome: "pending" | "created" | "unchanged" | "failed", versionId?, pageId?, failureCode?, failureMessage? }
getPage(idOrPublicId): PageDetail | undefined          // availability, latest version, counts, aliases
findPageByUrl(url): PageDetail | undefined             // by url_key or alias
getVersion(idOrPublicId): VersionDetail | undefined    // metadata, stage runs, content blob shas
listVersions(pageIdOrPublicId): VersionSummary[]       // newest first
listResources(versionIdOrPublicId): VersionResource[]  // { key, url, role, status, viaKey, blobSha256, blobId, mime, kind, sizeBytes }
getResource(versionId, key), getContentBlobs(versionId)
runVersion(versionId, opts)                            // run or resume the stages directly (tests)
```

`CaptureOptions`: `priority` (1-4, default 3), `versioning`, `caps`, `requestedBy`, `force`, `sourceId`, `userInitiated`.

- Versioning (`VersioningPolicy`): `latest_only`, `all`, `last_n {n}`, `period {day|week|month}`, `on_change` (default). Only `on_change` sends conditional requests (ETag, Last-Modified). An unchanged page (304, same bytes, or same content hash) creates no version and updates `pages.last_checked_at` and the validators. Superseded versions are deleted in stage 15 with their blob references released.
- Caps (`caps`): `maxDocumentBytes` 20 MiB, `maxAssets` 300, `maxAssetBytes` 25 MiB, `maxTotalAssetBytes` 150 MiB, `maxCssDepth` 5, `assetConcurrency` 4. A cap hit gives `partial` with `size_cap`.
- Partial reasons: `size_cap` (cap hit, or the page was larger than the extraction limit), `assets_missing` (an asset failed or its host was blocked), `truncated` (too many nodes or too deep), `reader_only` (neither Readability nor defuddle found an article; body text only).
- Resource keys are `r` plus 15 hex characters of `sha256(referenced_url)`; they match the listener's key pattern.

**Progress events.** `captureUrl`, each stage start and end, completion and failure publish a `capture` event on the event bus (`GET /api/system/events`): `{ downloadId, url, state, held, outcome, label, percent, stage?, pageId?, versionId?, failureMessage? }`. `label` is the plain-English stage name (`STAGE_LABELS` in `progress.ts`), `percent` is finished stages over 15.

The listener reads through `SqliteCaptureStore` (`archiveStore` in `createServer` replaces it). Tests: `tests/integration/pipeline`.

## Imports and rendered captures

- **Imported documents** (C-14, `apps/server/src/imports/README.md`) enter the same 15 stages without a fetch: the import service creates the page (`origin = 'import'`), the version and the `process` job. For an import, stage 3 (`assets`) does nothing, and stage 15 sets `pages.content_type` to `html`, `pdf` or `text` and never marks the version `reader_only`. `deleteVersion` also releases the upload's own blob (`import_documents`).
- **Rendered captures** (C-16, `apps/server/src/renderer/README.md`): `PipelineDeps.onVersionDone(versionId, options)` runs after a version finishes (`ready` or `partial`), and the renderer uses it to decide whether to queue a `render` job. The job creates a second version of the page from the browser's DOM with `page_versions.render_mode = 'browser'`; it runs the normal stages, so scripts in it stay text and are sanitised when the listener serves it.
- The `extract` worker handler also runs `import_text`, `import_markdown` and `import_pdf` (the PDF text extraction).
