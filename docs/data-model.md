# Data model

Status: proposed schema. Nothing is built. This is the design the Drizzle schema and hand-written SQL migrations will implement (Drizzle for ordinary tables, raw SQL migrations for FTS5 virtual tables, triggers and partial indexes; see [technology-decisions.md](technology-decisions.md#orm-and-migrations)).

## 1. Conventions

- Two SQLite files: `main.db` (authoritative) and `index.db` (derived, deletable). Section 6 covers `index.db`.
- All tables are `STRICT`. Timestamps are `INTEGER` Unix milliseconds in UTC (`*_at`). Booleans are `INTEGER` with `CHECK (x IN (0,1))`. JSON is `TEXT` with `CHECK (json_valid(x))`. Sizes are bytes.
- **Identifiers (D-9).** Each table has `id INTEGER PRIMARY KEY AUTOINCREMENT` (internal, never reused). Exposed entities also have `public_id TEXT NOT NULL UNIQUE`, a prefixed ULID (`usr_`, `src_`, `col_`, `pg_`, `ver_`, `job_`, `dl_`, `vol_`, `prv_`, `cand_`, `zim_`, `bm_`, `ss_`). Foreign keys use the integer. IDs and URLs never encode file paths.
- **Priority** columns are `INTEGER CHECK (priority BETWEEN 1 AND 4)`: 1 Protected (P1), 2 Important (P2), 3 Standard (P3), 4 Opportunistic (P4). A lower number is more important. This differs from NoConMedia, where P0 to P3 were used with P0 the most protected. The API sends `"P1"` to `"P4"`.
- Foreign keys are enforced (`PRAGMA foreign_keys=ON`). `ON DELETE` actions are stated per key; the default is `RESTRICT`.
- "Cached" columns (marked **cache**) are hints maintained for speed. Any destructive operation re-derives the truth from reference tables inside its own transaction.

## 2. Entity overview

```
 users -< sessions
 users -< bookmarks, history_entries, search_history, saved_searches, user_settings

 sources -< source_configs                 sources -< schedules
 sources >-< collections  (source_collections)
 sources >-< pages        (page_sources)   = the "source reference"
 collections >-< pages / zim entries (collection_memberships)
 pages -< page_versions -< asset_references >- assets >- blobs >- volumes
 pages -< page_aliases
 page_versions -< links (to_page_id -> pages)
 page_versions -< pipeline_stage_runs
 page_versions - version_content (blob refs: text, reader, outline)

 download_jobs -< crawl_jobs -< jobs (type=fetch frontier, process, render, index, ...)
 jobs >- host_state (politeness, one in flight per host)

 discovery_candidates -< candidate_provenance
 search_providers -< provider_result_cache,  usage_counters
 volumes -< storage_policies, volume_reservations, blobs
 zim_packages (federated search; no rows in pages)
 index_outbox, indexing_jobs, index_generations   (main.db side of the index)
 activity_log, maintenance_runs, app_meta
```

Required entities from the specification and where they are: users, sessions, sources, source configs, collections, memberships, pages, page versions, assets, asset references, links, download jobs, crawl jobs, discovery candidates, search providers, search history, saved searches, volumes, storage policies, indexing jobs, settings. All are present below. Additional tables: `blobs` (the physical store), `page_aliases`, `page_sources`, `page_pins`, `pipeline_stage_runs`, `jobs`, `host_state`, `schedules`, `download_windows`, `bookmarks`, `history_entries`, `candidate_provenance`, `provider_result_cache`, `usage_counters`, `volume_reservations`, `storage_usage_cache`, `url_exclusions`, `zim_packages`, `asset_attributions`, `page_attributions`, `index_outbox`, `index_generations`, `activity_log`, `maintenance_runs`, `app_meta`, `user_settings`.

## 3. Tables (`main.db`)

### 3.1 Identity and settings

**`users`**

| Column | Type | Notes |
|---|---|---|
| id, public_id | | `usr_` |
| username | TEXT NOT NULL | `UNIQUE COLLATE NOCASE` |
| password_hash | TEXT NOT NULL | scrypt N=2^15, r=8, p=1, 16-byte salt, 64-byte key, encoded |
| role | TEXT NOT NULL DEFAULT 'admin' | `CHECK (role IN ('admin'))` in v1; widening the check is the multi-user path |
| created_at, last_login_at, disabled_at | INTEGER | |

**`sessions`**: `id`, `user_id` FK `users` ON DELETE CASCADE, `token_hash TEXT NOT NULL UNIQUE` (SHA-256 of 32 random bytes), `created_at`, `last_seen_at`, `expires_at` (sliding 30 days), `absolute_expires_at` (created + 90 days), `ip TEXT`, `user_agent TEXT`, `revoked_at`. Index `(user_id)`, `(expires_at)`.

**`settings`**: `key TEXT PRIMARY KEY`, `value_json TEXT NOT NULL`, `updated_at`, `updated_by` FK `users` ON DELETE SET NULL. Holds system settings: resource profile, limits, privacy (`history.enabled`, `searchHistory.enabled`, `onlineSearch.enabled`), connectivity (`offline.forced`), discovery settings and weights, download windows defaults, appearance defaults, `browser.bookmarkPriority` (default 2), `storage.permitImportantEviction` mirror (authoritative copy is in `storage_policies`).

**`user_settings`**: `(user_id, key)` PRIMARY KEY, `value_json`, `updated_at`. Theme, density, shortcuts, tab restore.

**`app_meta`**: `key TEXT PRIMARY KEY`, `value TEXT`. Holds `rewriter_version`, `extractor_version`, `pipeline_version`, `index_expected_docs`, `last_verify_at`.

**`activity_log`**: `id`, `at INTEGER`, `level TEXT CHECK IN ('debug','info','warn','error')`, `area TEXT` (`crawl`, `pipeline`, `storage`, `search`, `auth`, `system`, `zim`, `provider`), `message TEXT`, `details_json`, `download_job_id` FK nullable ON DELETE SET NULL, `job_id` nullable, `version_id` nullable, `user_id` nullable. Indexes `(at)`, `(area, at)`, `(download_job_id, at)`. Pruned by retention (`NCB_ACTIVITY_LOG_RETENTION_DAYS`) and a row cap. Secrets and URL credentials are redacted before insert.

### 3.2 Storage

**`volumes`**

| Column | Type | Notes |
|---|---|---|
| id, public_id | | `vol_` |
| name | TEXT NOT NULL UNIQUE | |
| root_path | TEXT NOT NULL | Container path under an allowed root; validated with `resolveInside` rules |
| marker_uuid | TEXT NOT NULL | Also written to `.noconbrain-volume` at the root; a mismatch marks the volume `offline` |
| state | TEXT NOT NULL | `online`, `offline`, `readonly`, `draining`, `disabled` |
| quota_bytes | INTEGER NULL | Optional user limit below device capacity |
| reserve_free_bytes | INTEGER NOT NULL | Hard floor of free space |
| soft_threshold_pct | INTEGER NOT NULL DEFAULT 85 | P4 throttling begins |
| evict_start_pct, evict_target_pct | INTEGER | Defaults 90 and 80 |
| is_default | INTEGER | Exactly one `1` (partial unique index) |
| stat_total, stat_free, stat_at | INTEGER | **cache** of `statfs` |
| created_at | INTEGER | |

**`storage_policies`**: `id`, `scope TEXT CHECK IN ('global','volume')`, `volume_id` FK NULL, `permit_important_eviction INTEGER NOT NULL DEFAULT 0`, `throttle_opportunistic INTEGER DEFAULT 1`, `prune_surplus_versions INTEGER DEFAULT 1`, `orphan_grace_seconds INTEGER DEFAULT 86400`, `max_eviction_batch_bytes INTEGER`, `updated_at`. One `global` row (partial unique index `WHERE scope='global'`); a `volume` row overrides only the volume-scoped thresholds, never `permit_important_eviction` (global only).

**`volume_reservations`**: `id`, `volume_id` FK CASCADE, `download_job_id` FK CASCADE, `reserved_bytes`, `written_bytes DEFAULT 0`, `created_at`, `expires_at`. Index `(volume_id)`. Reservation cleanup is part of recovery.

**`blobs`** (the physical, content-addressed store)

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| sha256 | TEXT NOT NULL UNIQUE | 64 hex characters of the **decoded** content; the file path derives from it: `<root>/blobs/ab/cd/<sha256>` (optionally `.zst`) |
| size_bytes | INTEGER NOT NULL | Decoded size |
| stored_bytes | INTEGER NOT NULL | On-disk size |
| compression | TEXT | `none`, `zstd` |
| mime | TEXT | Sniffed type |
| kind | TEXT | `document`, `css`, `image`, `font`, `media`, `pdf`, `text`, `reader`, `json`, `other` |
| volume_id | INTEGER NOT NULL FK `volumes` | One blob lives on exactly one volume |
| refcount | INTEGER NOT NULL DEFAULT 0 | **cache**; truth is `COUNT(asset_references)` plus `version_content` references; verified by maintenance |
| zero_since | INTEGER NULL | Set when refcount reaches 0; GC deletes after `orphan_grace_seconds` |
| state | TEXT NOT NULL DEFAULT 'ready' | `writing`, `ready`, `missing`, `quarantined` |
| verified_at | INTEGER | Last background hash check |
| created_at | INTEGER | |

Indexes: `(volume_id, zero_since)` partial `WHERE zero_since IS NOT NULL`; `(volume_id, kind)`. The path is never stored; it is derived from `volume_id` and `sha256`, so volumes can be moved by changing `root_path`.

**`storage_usage_cache`**: `(volume_id, dimension, key)` PRIMARY KEY with `dimension IN ('priority','source','kind')`, `bytes`, `blob_count`, `shared_bytes` (bytes also referenced by another key), `computed_at`. **cache**; recomputed by maintenance and incrementally adjusted. Priority here is the blob's effective priority (section 5.5).

### 3.3 Sources, schedules, collections

**`sources`**

| Column | Type | Notes |
|---|---|---|
| id, public_id | | `src_` |
| name, description | TEXT | |
| type | TEXT NOT NULL | `single_page`, `website`, `section`, `linked_collection`, `sitemap`, `feed`, `saved_search`, `knowledge_package`, `imported_documents` |
| adapter | TEXT NOT NULL DEFAULT 'http' | `http`, `wikipedia`, `zim`, `import`; the Wikipedia crawl is `adapter='wikipedia'` with type `website` or `linked_collection` |
| start_url | TEXT NULL | Required for web types |
| strategy | TEXT NOT NULL | `capture`, `explore`, `mirror` |
| profile | TEXT NOT NULL | `focused`, `balanced`, `comprehensive`, `custom` |
| current_config_id | INTEGER FK `source_configs` | |
| priority | INTEGER NOT NULL | 1 to 4 |
| retention_mode | TEXT NOT NULL | `all`, `latest`, `time`, `budget`, `custom` |
| retention_json | TEXT NOT NULL | Parameters; validated per mode (section 5.3) |
| automatic_eviction | INTEGER NOT NULL | Default 1 for P3/P4, 0 for P1/P2 |
| storage_budget_bytes | INTEGER NULL | Source cap; stops crawling when reached |
| preferred_volume_id | INTEGER FK NULL | |
| discovery_enabled | INTEGER NOT NULL DEFAULT 0 | Whether links from this source feed candidates |
| enabled | INTEGER NOT NULL DEFAULT 1 | A disabled source still holds its references (it does not make content evictable) |
| system_kind | TEXT NULL | `quick_saves`, `browsing_cache`, `imports`; unique when set. Browsing cache is P4; Quick saves default P3 |
| saved_search_id | INTEGER FK NULL | When `type='saved_search'` |
| last_run_at, next_run_at, last_status | | |
| created_at, updated_at, deleted_at | | Soft delete; `deleted_at` references are inactive |

**`source_configs`** (versioned so a job records the exact configuration it ran with): `id`, `source_id` FK CASCADE, `version INTEGER`, `config_json TEXT NOT NULL`, `created_at`, `UNIQUE (source_id, version)`. `config_json` is validated by a zod schema and contains:

`depth`, `maxPages`, `maxBytes`, `maxDurationSeconds`, `allowedDomains[]`, `excludedDomains[]`, `allowedPaths[]` (glob), `excludedPaths[]`, `includeExternal` (bool), `externalDepth`, `assets` (`all`, `same-origin`, `none`, `images-css-only`), `concurrency`, `perDomainDelayMs`, `retries`, `queryParamPolicy` (`keep-all`, `strip-tracking`, `allowlist`, `drop-all`), `respectRobots`, `versioning` (`latest_only`, `all`, `last_n`, `period`, `on_change` with `n` or `period`), `renderMode` (`never`, `auto`, `always`), `linkPriorityWeights`, `maxLinksPerPage`, `userAgentSuffix`, and for Wikipedia `language`, `images`, `linkedExpansionDepth`, `preferZim`.

**`schedules`**: `id`, `source_id` FK CASCADE NULL (NULL = global job such as maintenance), `kind TEXT CHECK IN ('manual','hourly','daily','weekly','cron')`, `cron_expr TEXT`, `timezone TEXT`, `window_id` FK NULL, `missed_run_policy TEXT` (`skip`, `run_once`), `next_run_at`, `last_run_at`, `enabled`. Index `(enabled, next_run_at)`.

**`download_windows`**: `id`, `source_id` FK NULL (NULL = global), `days_mask INTEGER` (bit 0 Monday), `start_minute`, `end_minute`, `timezone`, `limits_json NULL` (optional concurrency or bandwidth overrides inside the window), `enabled`. A schedule fires only inside a window when one is attached; running jobs pause at the window edge and resume at the next window.

**`collections`**

| Column | Notes |
|---|---|
| id, public_id | `col_` |
| name, description, icon | `icon` is a name from a fixed icon set |
| kind | `manual`, `auto`, `saved_search`, `favourites`; nested collections are expressed by `parent_id` on any kind |
| parent_id | FK `collections` NULL ON DELETE RESTRICT; a trigger rejects cycles (depth cap 8) |
| rule_json | NULL for manual. `auto`: filter expression (source, domain, type, tag-free fields). `saved_search`: `{query, filters}` |
| priority_floor | INTEGER NULL (1 to 4). If set, membership creates a reference at this priority that retains the latest version (section 5.1) |
| sort_order, created_at, updated_at, deleted_at | |

At most one `favourites` collection per user (partial unique index on `(kind)` where `kind='favourites'` in v1, becoming `(user_id, kind)` with multi-user).

**`source_collections`**: `(source_id, collection_id)` PRIMARY KEY; pages captured by the source are added to these collections (`added_by='source'`).

**`collection_memberships`**: many-to-many between collections and content, without copying storage.

| Column | Notes |
|---|---|
| id | |
| collection_id | FK CASCADE |
| page_id | FK `pages` NULL, ON DELETE CASCADE |
| zim_package_id, zim_path | NULL unless the item is a ZIM article |
| added_by | `user`, `rule`, `source` |
| added_at | |

`CHECK ((page_id IS NOT NULL) <> (zim_package_id IS NOT NULL))`. Partial unique indexes `(collection_id, page_id) WHERE page_id IS NOT NULL` and `(collection_id, zim_package_id, zim_path) WHERE zim_package_id IS NOT NULL`. Index `(page_id)` for the reverse lookup.

### 3.4 Pages, versions, assets, links

**`pages`** (one row per canonical URL)

| Column | Type | Notes |
|---|---|---|
| id, public_id | | `pg_` |
| url_key | TEXT NOT NULL UNIQUE | Normalised dedup key of the canonical URL (never the URL we fetch) |
| canonical_url | TEXT NOT NULL | Display and fetch URL |
| host, registrable_domain | TEXT NOT NULL | Indexed for `site:` and per-host stats |
| origin | TEXT NOT NULL | `web`, `wikipedia`, `import` |
| content_type | TEXT | Category: `html`, `pdf`, `image`, `text`, `other` |
| title, language | TEXT | **cache** of the latest version |
| latest_version_id | INTEGER FK `page_versions` NULL | Moves only in stage 15 |
| version_count | INTEGER | **cache** |
| availability | TEXT NOT NULL | `archived` (latest `ready`), `partial`, `evicted` (no live versions), `failed` (never succeeded) |
| effective_priority | INTEGER | **cache** of section 5.1 |
| inbound_count | INTEGER DEFAULT 0 | **cache**: archived pages linking here (link-graph signal) |
| first_captured_at, last_captured_at, last_checked_at | INTEGER | |
| created_at, deleted_at | INTEGER | Soft delete during explicit deletion; rows are hard-deleted by the deletion job |

Indexes: `(host)`, `(registrable_domain)`, `(availability)`, `(last_captured_at)`, `(effective_priority, last_captured_at)`.

**`page_aliases`**: `url_key TEXT PRIMARY KEY`, `page_id` FK CASCADE, `kind` (`redirect`, `canonical`, `alias`, `trailing_slash`), `first_seen_at`. Resolve looks up `pages.url_key` then `page_aliases`. This keeps redirects and canonical differences from creating duplicate pages.

**`page_versions`** (one row per capture)

| Column | Type | Notes |
|---|---|---|
| id, public_id | | `ver_` |
| page_id | FK `pages` ON DELETE CASCADE | |
| version_no | INTEGER NOT NULL | `UNIQUE (page_id, version_no)` |
| source_id | FK `sources` NULL ON DELETE SET NULL | Capturing source |
| download_job_id, crawl_job_id | FK NULL | |
| requested_url, final_url | TEXT | After manual redirect hops |
| status | TEXT NOT NULL | `capturing`, `ready`, `partial`, `failed`, `evicting`, `evicted` |
| partial_reason | TEXT | `assets_missing`, `truncated`, `reader_only`, `size_cap` |
| http_status | INTEGER | |
| render_mode | TEXT | `plain`, `browser` |
| document_blob_id | FK `blobs` NULL | The original main resource |
| raw_hash | TEXT | SHA-256 of the original bytes (equals the blob's `sha256`) |
| content_hash | TEXT | SHA-256 of normalised main text, used for change detection and exact-duplicate detection |
| etag, last_modified | TEXT | For conditional refresh |
| title, description, language, author, site_name | TEXT | |
| published_at, modified_at | INTEGER NULL | |
| published_source | TEXT | `og`, `jsonld`, `time_element`, `meta`, `url`, `none` |
| published_confidence | TEXT | `high`, `medium`, `low` |
| word_count, total_bytes | INTEGER | `total_bytes` is the sum of all referenced asset sizes (not exclusive) |
| headers_json | TEXT | Allowlist only: content-type, last-modified, etag, link, content-language |
| extractor_version, rewriter_version, pipeline_version | TEXT | Triggers re-extraction when behind |
| retained | INTEGER | **cache**: 1 if at least one reference retains it (section 5.1) |
| fetched_at, created_at, evicted_at | INTEGER | |
| last_accessed_at | INTEGER NULL | Updated in batches when the version is served; eviction order input |

Indexes: `(page_id, version_no DESC)`, `(status)`, `(content_hash)`, `(source_id)`, `(fetched_at)`.

**`version_content`**: `version_id` PK FK `page_versions` ON DELETE CASCADE, `text_blob_id`, `reader_blob_id`, `outline_blob_id` (all FK `blobs`, nullable), `keywords_json`. These blobs count as references on the blob (included in `refcount`). Plain text is what rebuilds the index.

**`page_attributions`**: `version_id` PK FK CASCADE, `license_name`, `license_url`, `source_url`, `revision_id`, `history_url`, `credit_text`. Required for Wikipedia (CC BY-SA 4.0) and any package with licence metadata.

**`assets`** (a logical captured resource: one URL observed with one content)

| Column | Notes |
|---|---|
| id | |
| blob_id | FK `blobs` ON DELETE RESTRICT |
| url, url_key | `UNIQUE (url_key, blob_id)`: the same URL with the same content is one asset row, reused by every version that references it |
| kind | `document`, `css`, `image`, `font`, `media`, `pdf`, `other` |
| mime, http_status, fetched_at | |
| status | `ok`, `error`, `blocked` (error rows keep a negative record so the rewriter knows the resource was missing) |

**`asset_references`** (version to asset; the unit of reference counting)

| Column | Notes |
|---|---|
| id | |
| version_id | FK `page_versions` ON DELETE CASCADE |
| asset_id | FK `assets` ON DELETE RESTRICT |
| via_asset_id | FK `assets` NULL: set when the asset was referenced from a CSS file |
| role | `document`, `stylesheet`, `image`, `font`, `media`, `icon`, `other` |
| referenced_url | The URL as it appeared after resolving against the page URL; the rewriter looks up by `(version_id, referenced_url)` |

Primary key `(version_id, asset_id, referenced_url)`; index `(asset_id)`; index `(version_id, referenced_url)`. `blobs.refcount` is adjusted in the same transaction as inserts and deletes here. A trigger-free approach (explicit updates in the repository layer, covered by property tests) is planned; maintenance recomputes and reports mismatches.

**`asset_attributions`**: `asset_id` PK, `author`, `license_name`, `license_url`, `source_page_url`. Used for Wikipedia images (per-image licence metadata).

**`links`** (the link graph)

| Column | Notes |
|---|---|
| id | |
| from_version_id | FK `page_versions` ON DELETE CASCADE |
| from_page_id | FK `pages` (denormalised for inbound queries) |
| to_url | As found, resolved absolute |
| to_url_key | Normalised dedup key |
| to_page_id | FK `pages` NULL ON DELETE SET NULL; set when the target exists; backfilled when a target is archived later |
| anchor_text | Truncated to 200 characters |
| context | Surrounding text, up to 200 characters |
| region | `content`, `heading`, `related`, `nav`, `footer`, `other` |
| score | REAL: 0 to 1 from the classifier |
| is_internal, rel_nofollow | INTEGER |
| position | INTEGER (order in document) |

Indexes: `(from_version_id)`, `(to_url_key)`, `(to_page_id)`, `(from_page_id, to_page_id)`. Links of superseded versions are deleted when the version is no longer retained. **Cached/queued flags are derived**, not stored: *cached* = `to_page_id` points at a page whose availability is `archived`/`partial`; *queued* = a `download_jobs`/`jobs` row for `to_url_key` is `queued` or `running`. Collections of a link target come from `collection_memberships` through `to_page_id`. This avoids stale flags; the listener resolves a whole page's links with one batched `IN (...)` lookup on `url_key`/`page_aliases`.

**`page_sources`** (the source reference): `(page_id, source_id)` PRIMARY KEY, `first_seen_at`, `last_seen_at`, `discovered_via` (`seed`, `link`, `sitemap`, `feed`, `search`, `manual`), `depth`. ON DELETE CASCADE both ways. Index `(source_id)`.

**`page_pins`**: `id`, `page_id` FK CASCADE, `user_id` FK, `priority`, `reason`, `created_at`. UNIQUE `(page_id, user_id)`. A manual "Keep" action. Retains the latest version; `automaticEviction` is effectively false for a pin at P1 and true otherwise (see 5.2).

**`url_exclusions`**: `id`, `source_id` FK NULL (NULL = all sources), `url_key`, `reason` (`deleted_by_user`, `blocked`, `trap`), `created_at`. UNIQUE `(source_id, url_key)`. Prevents re-downloading what the Human explicitly deleted.

**`pipeline_stage_runs`** (each stage retryable)

| Column | Notes |
|---|---|
| version_id | FK CASCADE |
| stage | One of `validate`, `store_original`, `assets`, `metadata`, `readable`, `sections`, `links`, `normalise`, `dedup`, `reader`, `render_prep`, `index`, `link_graph`, `candidates`, `status` (15 stages, ordered) |
| state | `pending`, `running`, `done`, `failed`, `skipped` |
| attempts, last_error, started_at, finished_at | |

Primary key `(version_id, stage)`. A stage is idempotent: it writes derived rows keyed by `(version_id, …)` using upserts and content-addressed blobs, so a re-run after a crash converges.

### 3.5 Jobs

**`download_jobs`** (user-visible)

| Column | Notes |
|---|---|
| id, public_id | `dl_` |
| source_id | FK NULL ON DELETE SET NULL |
| config_id | FK `source_configs` NULL (snapshot) |
| kind | `capture`, `explore`, `mirror`, `refresh`, `wikipedia`, `zim_import`, `import`, `discovery`, `coverage` |
| state | `queued`, `running`, `paused`, `completed`, `failed`, `cancelled` |
| priority | 1 to 4: the **storage** priority content captured by this job is created under (feeds admission and eviction) |
| queue_order | INTEGER: manual ordering within the same priority |
| requested_url | TEXT NULL |
| requested_by | `user`, `schedule`, `discovery`, `search`, `system` |
| candidate_id | FK NULL |
| estimated_pages, estimated_bytes | INTEGER NULL; labelled as estimates in the UI |
| pages_done, pages_failed, bytes_done | INTEGER |
| failure_code, failure_message | `network`, `robots_blocked`, `ssrf_blocked`, `size_cap`, `disk_full`, `timeout`, `http_4xx`, `http_5xx`, `parse_error`, `limit_reached`, `cancelled_by_user`, `internal` |
| scheduled_for, started_at, finished_at, created_at | |

Indexes `(state, priority, queue_order)`, `(source_id)`. Transitions: `queued→running`, `running→paused|completed|failed|cancelled`, `paused→queued` (resume), `failed→queued` (retry, `attempts` visible in the log), `queued|paused→cancelled`. `completed` and `cancelled` are terminal. Pausing marks child `jobs` as `held`; resuming returns them to `queued`.

**`crawl_jobs`**: `id`, `download_job_id` FK CASCADE UNIQUE, `source_id`, `config_id`, `mode`, `max_depth`, `max_pages`, `max_bytes`, `deadline_at`, `seed_urls_json`, `pages_discovered`, `pages_fetched`, `pages_failed`, `bytes_fetched`, `depth_reached`, `stop_reason` (`completed`, `max_pages`, `max_bytes`, `max_depth`, `deadline`, `source_budget`, `volume_full`, `cancelled`), `finished_at`. A single-page capture has a `download_jobs` row and no `crawl_jobs` row.

**`jobs`** (internal persistent queue; also the crawl frontier)

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| type | TEXT | `fetch`, `asset_fetch`, `process`, `render`, `index`, `discover`, `evict`, `gc`, `verify`, `zim_scan`, `wikipedia_fetch`, `refresh_check`, `export` |
| queue | TEXT | `crawl`, `process`, `index`, `maintenance` (workers pull per queue) |
| state | TEXT | `queued`, `running`, `held`, `done`, `failed`, `dead`, `cancelled` |
| priority | INTEGER | Higher runs first |
| score | REAL | Link-priority score (frontier ordering) |
| host | TEXT NULL | For per-host invariants |
| url, url_key | TEXT NULL | |
| download_job_id, crawl_job_id | FK NULL ON DELETE CASCADE | |
| version_id | FK NULL | For `process` jobs |
| depth | INTEGER | |
| payload_json | TEXT | |
| idempotency_key | TEXT NULL | Partial unique index `(type, idempotency_key) WHERE state IN ('queued','running','held')` |
| attempts, max_attempts | INTEGER | |
| run_at | INTEGER | Backoff target |
| lease_until, worker_id | | |
| last_error | TEXT | |
| created_at, started_at, finished_at | | |

Indexes: `(queue, state, priority DESC, score DESC, id)` for claims (`run_at` is filtered while walking the index in claim order; putting `run_at` before the ordering columns made every claim sort all due rows, 12 ms instead of about 1 ms at 50,000 queued, measured in F-04); `(lease_until) WHERE state='running'` for the reaper; `UNIQUE (crawl_job_id, url_key)` for the crawl visited set; `(download_job_id)`. Finished rows are pruned after the crawl completes; a daily rollup keeps counters.

Claim (illustrative, inside `BEGIN IMMEDIATE`):

```sql
UPDATE jobs SET state='running', lease_until=:lease, worker_id=:w, attempts=attempts+1, started_at=:now
WHERE id = (
  SELECT j.id FROM jobs j LEFT JOIN host_state h ON h.host = j.host
  WHERE j.queue=:q AND j.state='queued' AND j.run_at<=:now
    AND (j.host IS NULL OR (h.in_flight < COALESCE(h.max_concurrent,1)
         AND COALESCE(h.next_allowed_at,0)<=:now AND COALESCE(h.backoff_until,0)<=:now))
  ORDER BY j.priority DESC, j.score DESC, j.id LIMIT 1)
RETURNING *;
-- same transaction: UPDATE host_state SET in_flight=in_flight+1 WHERE host=:host
```

**`host_state`**: `host TEXT PRIMARY KEY`, `in_flight INTEGER DEFAULT 0 CHECK (in_flight >= 0)`, `max_concurrent INTEGER DEFAULT 1`, `next_allowed_at`, `crawl_delay_ms`, `backoff_until`, `consecutive_failures`, `robots_status` (`ok`, `none`, `disallow_all_temp`), `robots_fetched_at`, `robots_blob_id` FK NULL. `in_flight` is rebuilt from `jobs` on startup (crash recovery) rather than trusted.

### 3.6 Discovery and search metadata

**`discovery_candidates`**: `id`, `public_id` (`cand_`), `url`, `url_key UNIQUE`, `title_hint`, `state` (`new`, `approved`, `queued`, `archived`, `dismissed`, `expired`), `score REAL`, `score_components_json` (each component with weight and raw value; see D-03), `est_bytes`, `suggested_source_id`, `suggested_collection_id`, `first_seen_at`, `last_seen_at`, `expires_at`, `decided_by`, `decided_at`. Indexes `(state, score DESC)`, `(expires_at)`. Candidates for URLs already archived or queued are not created.

**`candidate_provenance`**: `id`, `candidate_id` FK CASCADE, `kind` (`link`, `search_result`, `saved_search`, `visit`, `bookmark`, `missing_link`, `manual`), `ref_page_id` FK NULL, `ref_search_id` INTEGER NULL (search history row), `ref_source_id` NULL, `detail TEXT`, `weight REAL`, `seen_at`. Provenance lets the UI answer "why is this suggested?". `search_result` and `visit` rows exist only when the Human enabled search-driven discovery or history.

**`search_providers`**

| Column | Notes |
|---|---|
| id, public_id | `prv_` |
| adapter | `searxng`, `brave`, `mojeek` (more later) |
| name, enabled, priority | Priority orders fallback and ties |
| base_url | For SearXNG |
| credentials_enc | BLOB: AES-256-GCM with a key derived from `NCB_SECRET_KEY`; never returned by the API |
| timeout_ms, rate_limit_per_sec, monthly_cap, daily_cap | |
| fallback_provider_id | FK self NULL: used when this provider errors |
| language, region, safe_search | |
| storage_kind | `none`, `ttl`, `unrestricted` (mirror of the adapter default, user-restrictable but never loosened beyond what the adapter declares) |
| storage_ttl_seconds | |
| weight | RRF weight, default 1.0 |
| health_state, last_ok_at, last_error_code, circuit_open_until | |

**`provider_result_cache`**: `id`, `provider_id` FK CASCADE, `query_hash`, `page`, `results_json`, `fetched_at`, `expires_at`. A trigger aborts inserts when the provider's `storage_kind='none'`, and an `expires_at` beyond `fetched_at + storage_ttl_seconds` for `ttl`. Brave rows can therefore never exist.

**`search_history`**: `id`, `user_id` FK CASCADE, `query`, `normalised_query`, `at`, `local_count`, `online_providers_json`, `scope`, `clicked_page_id` NULL. Written only if `searchHistory.enabled`. Index `(user_id, at)`, `(normalised_query)`.

**`saved_searches`**: `id`, `public_id` (`ss_`), `user_id`, `name`, `query`, `filters_json`, `include_online INTEGER`, `created_at`, `last_run_at`, `last_result_count`, `source_id` FK NULL, `collection_id` FK NULL (a saved search can be a source or a collection).

**`usage_counters`**: `(kind, subject, period)` PRIMARY KEY; `kind` (`provider_requests`, `discovery_bytes`, `discovery_requests`, `wikipedia_requests`), `subject` (provider public ID or `global`), `period` (`2026-11` or `2026-11-01`), `count`, `bytes`. Enforces monthly request caps and the background discovery budget.

### 3.7 Personal data

**`bookmarks`**: `id`, `public_id` (`bm_`), `user_id` FK CASCADE, `original_url`, `url_key`, `title`, `page_id` FK NULL ON DELETE SET NULL (the archive reference), `version_id` FK NULL (optional pinned version), `zim_package_id` + `zim_path` NULL, `collection_id` FK NULL, `created_at`, `deleted_at`. Indexes `(user_id, created_at)`, `(url_key)`. A bookmark is a reference at `browser.bookmarkPriority` (default P2) on its page, retaining the latest version. Bookmarks of live-only URLs have `page_id NULL` and a "Save for offline" action.

**`history_entries`**: `id`, `user_id` FK CASCADE, `url`, `url_key`, `title`, `visited_at`, `page_id` NULL, `zim_package_id` NULL, `served_from` (`archive`, `cache`, `zim`, `live`, `offline`). Written only if `history.enabled`; "clear" deletes rows; "disable" stops writing. Not an eviction reference.

### 3.8 ZIM packages

**`zim_packages`**: `id`, `public_id` (`zim_`), `name` (ZIM `Name`), `title`, `description`, `language`, `creator`, `publisher`, `date`, `flavour`, `tags`, `uuid UNIQUE`, `volume_id` FK, `relative_path` (under the volume's `zim/` directory), `size_bytes`, `checksum_sha256`, `article_count`, `media_count`, `has_fulltext_index`, `has_title_index`, `new_namespace_scheme`, `license_name`, `license_url`, `attribution_text`, `priority` (1 to 4; storage accounting and removal safety), `enabled_for_search`, `state` (`importing`, `ready`, `missing`, `removing`), `imported_at`, `last_verified_at`. A ZIM is read directly from its file; it is never extracted. Safe removal refuses (or requires confirmation) when bookmarks or collection memberships reference it, then removes memberships, history references and the file.

### 3.9 Index bookkeeping and maintenance

**`index_outbox`**: `id`, `op` (`upsert_page`, `delete_page`, `update_membership`, `update_priority`, `update_inlinks`), `page_id`, `version_id` NULL, `queued_at`. Written in the same transaction as the change. The `index` worker applies rows in order and stores `last_applied_id` in `app_meta`.

**`index_generations`**: `id`, `schema_version`, `tokenizer_config_json`, `state` (`building`, `active`, `retired`), `doc_count`, `built_at`, `rebuild_reason`. The active generation's `schema_version` must match the code or the index is rebuilt.

**`indexing_jobs`**: `id`, `kind` (`rebuild`, `reindex_page`, `optimize`, `vocab_rebuild`, `consistency_check`), `scope_json`, `state`, `docs_total`, `docs_done`, `generation_id` FK NULL, `error`, `created_at`, `finished_at`. Progress for the admin UI; the work itself is `jobs` rows of type `index`.

**`maintenance_runs`**: `id`, `kind` (`verify`, `repair`, `gc`, `backup`, `integrity_check`, `scrub`), `dry_run INTEGER`, `state`, `started_at`, `finished_at`, `report_json` (counts and per-finding detail: orphan blobs, missing blobs, refcount mismatches, dangling references, index drift, stale reservations, temp files, `capturing` versions).

### 3.4a Phase 2 implementation notes (migration 0003_pages_versions)

Differences between the tables above and `packages/db/migrations/0003_pages_versions.sql`:

- `page_versions.source_id` and `crawl_job_id` are plain integers (no foreign key) until `sources` and the crawl tables arrive in Phase 3. `jobs.version_id` is likewise unconstrained until a table rebuild.
- `assets.blob_id` is nullable: failed, blocked and skipped fetches keep a negative record. `assets.status` adds `skipped` (per-capture cap), and `error_code`, `error_message`, `size_bytes` are added. Uniqueness is `(url_key, blob_id)` for stored assets and `(url_key, status)` for negative records.
- The main document is also an `asset_references` row with role `document`, so `blobs.refcount` stays "asset references plus `version_content` references".
- `page_versions` adds `duplicate_of_version_id` (stage 9 flag), `simhash` (reserved, unused), `metadata_json`, `mime`, `raw_bytes`, `failure_stage`, `failure_message`.
- `version_content` adds `extraction_blob_id` (intermediate extraction result, counted as a reference) and `extraction_method`.
- New table `version_resources`: `(version_id, resource_key, url, asset_id, via_resource_key, role, status)`, written by stage 11, read by the archive listener. `resource_key` is `r` plus 15 hex characters of the SHA-256 of the referenced URL.
- `pipeline_stage_runs` adds `detail_json`. `links` adds `features_json`.
- `pages.availability` defaults to `failed` until the first version is finalised.
- `page_pins`, `page_sources` and `url_exclusions` are not created yet (they need `sources` or bookmarks).
- Superseded versions (`latest_only`, `last_n`, `period`) are deleted in stage 15 rather than by the retention job; Phase 6 may move this.

## 4. Key relationships

### 4.1 Blobs, assets and references

```
 volume ─< blob (sha256) ─< asset (url_key + blob) ─< asset_reference >─ page_version >─ page
                  ^
                  └── version_content (text, reader, outline)  also references blobs
```

- A blob is stored once, anywhere on any volume, identified by SHA-256 of its decoded content. A new capture that fetches identical bytes finds the existing blob by `sha256` and adds only an `assets` row (if the URL is new) and an `asset_references` row. No duplicate bytes are written ("assets are not stored twice").
- `blobs.refcount` equals the number of `asset_references` (through `assets`) plus `version_content` references. It changes in the same transaction as the reference rows. When it reaches 0, `zero_since` is set; garbage collection deletes the file and the row after the grace period, re-checking the count inside the deleting transaction.
- **Shared assets survive while referenced by protected content** structurally: deleting or evicting a version removes only its own `asset_references`; any other version that still references the asset (for example a P1 page sharing a stylesheet) keeps `refcount > 0`, so the blob cannot be collected. Eviction planning counts only **exclusive bytes** (blobs whose every reference is inside the set being evicted), so it never over-estimates what it frees.

### 4.2 Page and version

- A `pages` row exists per canonical URL. Redirects and canonical differences become `page_aliases` rows pointing at the same page.
- Each capture creates a `page_versions` row (`capturing`), runs the pipeline, and becomes `ready` or `partial` in stage 15, where `pages.latest_version_id` moves. Readers and the index only see versions in `ready`/`partial`.
- Versioning rules (per source, `versioning` in the config): `latest_only` (the previous latest becomes surplus), `all`, `last_n`, `period` (one version per day, week or month; a later capture in the same period replaces the earlier one), `on_change` (a new version only if `content_hash` differs; otherwise only `last_checked_at` and conditional-request validators are updated). Versioning governs **creation**; retention (5.3) governs **deletion**. Defaults: `latest_only` implies retention `latest(1)`, `all` implies retention `all`.

### 4.3 Source and collection membership, and references

- A page belongs to sources through `page_sources` and to collections through `collection_memberships`. Both are many-to-many and add no storage.
- **References** that matter for priority are derived from these rows plus pins and bookmarks (section 5.1). Collection membership by itself does not protect anything; only a collection with `priority_floor` does.
- Saved searches can be sources (`sources.saved_search_id`) and collections (`collections.kind='saved_search'`). A saved-search source schedules the search, adds results as candidates or downloads per its config.

### 4.4 Link graph

`links` rows belong to a version. Outbound links come from `from_version_id`; inbound links to a page are `WHERE to_page_id = :page` (restricted to the latest version of each source page for ranking). When a new page is archived, a `gc`-queue job runs `UPDATE links SET to_page_id = :id WHERE to_url_key IN (:keys)` and recomputes `pages.inbound_count` for the targets and `index_outbox` rows for pages whose in-link count crossed a bucket boundary. When a page is evicted, `to_page_id` stays (the page row remains as a tombstone) so link states can show "evicted, can be re-downloaded".

### 4.5 Jobs

A user action creates a `download_jobs` row. Executing it creates a `crawl_jobs` row (explore, mirror) and `jobs` rows: `fetch` frontier entries (visited set enforced by `UNIQUE (crawl_job_id, url_key)`), `asset_fetch`, then a `process` job per fetched document (stages in `pipeline_stage_runs`), `index` follow-ups through the outbox. State lives in the database; a restart reclaims expired leases, rebuilds `host_state.in_flight` and resumes. Pausing and cancelling are state changes the runner checks between stages and between requests.

### 4.6 ZIM

ZIM contents are not copied into `pages`. `zim_packages` registers the file; the `zim` worker reads it. Unified browsing happens in `resolve` (a Wikipedia URL maps to `zim_path` when `hasEntryByPath`). Bookmarks, history and collection memberships can reference a ZIM entry by `(zim_package_id, zim_path)`.

## 5. Effective priority and eviction eligibility

These rules are the specification for the pure planner in `packages/storage-planner`. Every numbered rule has unit tests (tasks T-01 to T-03).

### 5.1 References and effective priority

A **reference** to a page is any of:

| Source of reference | Priority | `retains(V)` | `autoEvict` |
|---|---|---|---|
| `page_sources` row whose source is not soft-deleted | `sources.priority` | per `sources.retention_*` (5.3) | `sources.automatic_eviction` |
| `collection_memberships` of a collection with `priority_floor` set and not soft-deleted | `priority_floor` | latest version only | true (eviction permission comes from the priority class, rules 5.2.5 and 5.2.6) |
| `page_pins` row | `page_pins.priority` | latest version only | false when priority is 1, otherwise true |
| `bookmarks` row (not soft-deleted) | `browser.bookmarkPriority` setting (default 2) | latest version only | true |

A reference is **active** unless its source or collection is soft-deleted or the row is removed. A **disabled** source (`enabled=0`) keeps its references active: disabling a source must never make its content evictable.

For a version `V` of page `A`:

```
retainingRefs(V)   = { R in activeRefs(A) : R.retains(V) }
priority(V)        = min over retainingRefs(V) of R.priority         (numerically lowest = most important)
                   = 4 and V is *surplus* if retainingRefs(V) is empty
effective priority of page A = priority(latest version of A)
effective priority of blob B = min over versions V that reference B (through asset_references or version_content) of priority(V), for versions not evicted
```

"Effective priority is the highest active reference" is this `min`. `pages.effective_priority`, `page_versions.retained` and `blobs` priority classes are caches. They are recomputed (in chunks, by a `gc`-queue job) after changes to references, source priority, retention, pins, bookmarks or collection floors. **The executor never trusts them**; it recomputes from reference rows inside its transaction (rule 5.2.9).

A page with **no active references** at all (for example every source was deleted) has effective priority 4, is surplus, and is evictable under the P3/P4 rules; the verify operation reports such pages so the Human can adopt or delete them.

### 5.2 Eligibility for automatic eviction

A version `V` of page `A` is **eligible for automatic eviction** only if all of these hold, evaluated in this order:

1. `V.status` is `ready` or `partial`, and no running job is writing to `A`. (Versions in `capturing` are recovered, not evicted.)
2. **P1 is absolute.** If `priority(V) = 1`, `V` is not eligible, whatever any `automaticEviction` value says. `automaticEviction=true` on a P1 source is valid configuration; it permits eviction only of content that source does *not* retain at P1 (for example surplus versions beyond its retention), never of P1 content.
3. **`automaticEviction` is a veto at page level.** For every active reference `R` of `A` (not only retaining ones), `R.autoEvict` must be true. If any referencing source has `automatic_eviction=false`, nothing about `A` is auto-evicted, including surplus versions, so that "do not auto-delete anything from this source" holds.
4. The class of `V` is `priority(V)` as defined in 5.1. A surplus version (no retaining reference) counts as priority 4. Rules 5 and 6 apply by class.
5. **P2 only under explicitly permitted policy.** If `priority(V) = 2`, `V` is eligible only if the global `storage_policies.permit_important_eviction = 1`. Default is 0.
6. **P3 and P4** are eligible (subject to rules 1 to 3).
7. **Incoming gate.** When eviction frees space for an incoming download of priority `q`, a candidate must satisfy `priority(V) > q`, or `priority(V) = q` with `q` in `{3, 4}`. A P4 download can reclaim only P4. A P3 download can reclaim P3 and P4. A P2 download can reclaim P3 and P4, and P2 only if permitted. A P1 download can reclaim P2 (if permitted), P3 and P4. Maintenance-driven eviction (no incoming job) uses `q = 1` (anything eligible by rules 1 to 6).
8. **Blob rule.** Even for an eligible version, a blob is removed only when its `refcount` falls to 0 and the grace period has elapsed. Blobs referenced by any non-evicted version, in particular a protected one, are never removed.
9. **Re-derivation.** The executor recomputes `priority(V)` and rules 2, 3 and 5 from reference rows inside the same transaction that marks `V` as `evicting`. If the result differs from the plan, the version is skipped and logged. Cached priority columns are never the basis for a delete.

**Explicit user deletion is a different operation** (`DELETE /api/archive/pages/{id}` or `/versions/{id}`). It is allowed on any priority, including P1, but requires `confirmProtected=true` when the target has P1 or P2 references, removes the target's references, optionally adds a `url_exclusions` row (default on, so the next crawl does not fetch it again), and still uses reference counting: shared blobs used by other versions survive. It is never triggered by space pressure.

### 5.3 Retention

Per-source retention decides which versions a source's reference retains. The page's latest version is retained by `all`, `latest`, `time` (with `keepLatest`), `budget` and `custom` unless stated.

| Mode | `retention_json` | `retains(V)` |
|---|---|---|
| `all` | `{}` | every version |
| `latest` | `{ "count": N }` (N at least 1) | the N most recent versions of the page by `fetched_at` |
| `time` | `{ "days": D, "keepLatest": true }` | versions with `fetched_at >= now - D days`; plus the latest version if `keepLatest` |
| `budget` | `{ "bytes": B }` | across the source's pages, the most recently captured pages' latest versions, in order of `last_captured_at` descending, until the cumulative **exclusive-within-source** bytes would exceed B; versions outside are surplus |
| `custom` | `{ "combine": "union"|"intersection", "rules": [ {mode, ...} ] }` | the union or intersection of the atom results (atoms are the four modes above, at most 4) |

Ties and ordering are deterministic (`fetched_at`, then `id`). Retention never deletes by itself; surplus versions are removed by the planner under rules 5.2.1 to 5.2.9, scheduled by `prune_surplus_versions` and under space pressure.

### 5.4 Eviction order (planner)

The planner is pure: `planEviction(state, incomingPriority, bytesNeeded) → plan`, deterministic for the same input, with a dry-run API. Steps:

0. **Throttle** opportunistic (P4) downloads when used space exceeds `soft_threshold_pct` (admission control; nothing is deleted yet).
1. **Unreferenced blobs and temp files** past the grace period (cheapest; no content loss).
2. **Surplus versions** (retained by no reference), non-latest first, then by oldest `fetched_at`.
3. **P4** versions, then **P3**, then **P2 only if permitted**; never **P1**. Within a class, superseded (non-latest) versions go before latest versions, then least recently served, then larger exclusive size. The sort key is `(priority class DESC, is_latest ASC, last_accessed_at ASC NULLS FIRST, exclusive_bytes DESC, version_id ASC)`. `last_accessed_at` is updated (batched) when a version is served; never-served versions go first.
4. Stop when `reclaimable ≥ bytesNeeded` (reclaimable counts exclusive bytes only). If all eligible content cannot cover the need the plan is `insufficient` and **nothing is deleted**; the admission fails with a clear message (`disk_full`) instead.

Execution (two phases, safe to interrupt): phase A, one transaction per version: re-derive eligibility (5.2.9), set `status='evicting'`, delete `asset_references`, decrement `refcount`s (set `zero_since`), write `index_outbox(delete_page or upsert_page)`, and when it was the last live version set `pages.availability='evicted'`. Phase B (GC): delete blob files and rows whose `refcount=0` after grace; then mark the version `evicted` and delete its `links`/`version_content` rows. A crash between A and B leaves `evicting` versions and zero-ref blobs that recovery completes; a crash during A rolls back. File deletes happen only after the database state is final, so a database row never points at a missing file as a result of eviction.

### 5.5 Usage and forecasting

- Usage by priority groups blobs by effective priority (min across non-evicted referencing versions). Usage by source attributes bytes to each referencing source twice (shared bytes appear under every source) and reports `exclusive_bytes` and `shared_bytes` separately; UI totals use the deduplicated blob sum.
- Forecasts (T-08) are estimates computed from observed bytes per page per source, planned page counts and, for crawl previews, a sampled average; they carry `estimate: true`, a low/high range and an input description. They are never presented as measured values.

## 6. Search index database (`index.db`)

Derived entirely from `main.db` content. Opened by two worker threads only: `index` (writer) and `search` (read-only). Path `${NCB_DATA_DIR}/index/index.db`.

| Table | Definition |
|---|---|
| `meta` | `key`, `value`: `generation_id`, `schema_version`, `tokenizers`, `built_at`, `last_applied_outbox_id` |
| `docs` | `rowid` (integer, FTS rowid), `page_id INTEGER UNIQUE`, `version_id`, `public_page_id TEXT`, `url`, `domain`, `registrable_domain`, `title`, `description`, `headings`, `keywords`, `body`, `lang`, `fts_group` (`en`, `default`), `type`, `origin`, `source_ids_json`, `captured_at`, `published_at`, `date_for_ranking`, `availability`, `priority`, `inlinks`, `content_hash`, `simhash NULL` |
| `doc_sources` | `(doc_rowid, source_id)` PRIMARY KEY, index `(source_id)` |
| `doc_collections` | `(doc_rowid, collection_id)` PRIMARY KEY, index `(collection_id)` (maintained by `update_membership` ops, including nested-collection expansion) |
| `fts_en` | `CREATE VIRTUAL TABLE fts_en USING fts5(title, headings, url, body, content='docs', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2', prefix='2 3 4')` |
| `fts_default` | same columns with `tokenize='unicode61 remove_diacritics 2'` for languages without a stemmer in this build |
| `title_fts` | `fts5(title, content='docs', prefix='2 3 4 5')`, autocomplete |
| `vocab` | `term TEXT PRIMARY KEY, df INTEGER` (STRICT); built from `fts5vocab` (type `row`) |
| `vocab_tri` | `fts5(term, content='vocab', tokenize='trigram')` |
| `synonyms` | `term TEXT, expansion TEXT, kind TEXT ('oneway','twoway'), PRIMARY KEY (term, expansion)`; user-editable through the API; mirrored from `main.db` (`settings` or a small table) at rebuild |
| `stopwords` | `lang, term` |

Notes:

- One document per **page** (latest version). Older versions are not searchable in v1 (later: version search).
- Fields indexed from the spec: title, URL, description, content, headings, keywords, language, source, collections, type, capture date, publication date and links (inbound count; link text from archived inbound links is a later ranking field).
- Filters (source, collection, domain, type, downloaded date, published date, availability, language) are `WHERE` clauses joined to `docs`, `doc_sources` and `doc_collections`.
- Ranking: `bm25(fts, 10, 5, 3, 1)` for title, headings, URL, body, combined in application code with freshness (from `date_for_ranking`), link-graph (`log(1+inlinks)`), user preferences (domain and source boosts) and a modest cached-content boost (`availability`), all with configurable weights and a score-explanation field for debugging.
- ZIM packages are **not** in `index.db` (federated search, section 4.6 and [architecture.md](architecture.md#41-capture-and-processing-pipeline)).
- Image sub-documents (alt text and context per `<img>`) are a later addition (S-14); until then the Images category filters on `type='image'` pages.

### 6.1 Rebuild path

The index is rebuildable from stored content:

1. `POST /api/index/rebuild` creates an `index_generations` row (`building`) and an `indexing_jobs` row; the `index` worker creates `index.rebuild.db` next to the live file.
2. It iterates `pages JOIN page_versions` (latest versions with status `ready`/`partial`) in id order, reading `version_content.text_blob_id` (plain text), the outline blob (headings) and metadata from `main.db`, inserting `docs` in batches of 500 (one transaction per batch), plus `doc_sources` and `doc_collections`.
3. It runs `INSERT INTO fts_en(fts_en) VALUES('rebuild')` (and `fts_default`), builds `vocab` and `vocab_tri`, then `optimize`.
4. It records `last_applied_outbox_id` = the highest outbox id observed at the start; outbox rows created during the build are applied after the swap (replayed against the new file). The build is resumable by page id checkpoint.
5. The `search` worker is told to reopen; the files are swapped with an atomic rename; the old file is deleted after a short drain. Searches keep working on the old index during the build.
6. The generation becomes `active`, the previous one `retired`.

If `index.db` is missing, corrupt or has a different `schema_version`, the server starts, serves archived content, shows "search index is rebuilding", and rebuilds automatically. Benchmark reference: 50,000 pages indexed in about 11 s on the Mac (docs 3.1 s, FTS 6.2 s, optimise 1.1 s, vocab 0.7 s); Pi figures are to be measured (S-13).

## 7. Integrity invariants and the verify-and-repair operation

Checked by the maintenance `verify` run (dry-run by default), repaired by `repair`:

| # | Invariant | Repair |
|---|---|---|
| I-1 | Every `blobs` row with `state='ready'` has a file of the expected size on its volume | Mark `missing`, mark dependent versions `partial`, list for recapture |
| I-2 | Every blob file on a volume has a `blobs` row | Move to `quarantine/`, report; delete after review |
| I-3 | `blobs.refcount` equals the computed count; `zero_since` set iff 0 | Recompute |
| I-4 | No `asset_references`, `links.from_version_id` or `version_content` row points at a missing parent (FKs make this structural; checked after restores) | Delete dangling rows |
| I-5 | Every version in `capturing` is attached to a live job or older than the lease limit | Resume or mark `failed` and clean up |
| I-6 | `pages.latest_version_id` points at a `ready`/`partial` version of the same page | Re-point to the newest valid version |
| I-7 | `host_state.in_flight` equals running `fetch` jobs per host | Reset |
| I-8 | `volume_reservations` rows belong to live jobs | Delete stale |
| I-9 | Temp files older than 24 hours in `tmp/` dirs | Delete |
| I-10 | `index.db` doc count and `last_applied_outbox_id` match `main.db` expectation; sampled docs match | Enqueue targeted reindex or full rebuild |
| I-11 | Sampled blob contents hash to their `sha256` (throttled scrub) | Quarantine and mark `missing` |
| I-12 | `PRAGMA integrity_check` on both databases (nightly `quick_check`) | Report; recommend restore from backup |
| I-13 | No P1-priority version is in `evicting`/`evicted` unless an explicit deletion record exists in `activity_log` | Report loudly (should be impossible) |

## 8. Migrations

- Forward-only SQL migrations in `packages/db/migrations`, generated by `drizzle-kit` or hand-written (virtual tables, triggers, partial indexes), applied at boot inside a transaction, each preceded by a `VACUUM INTO` backup of `main.db` (kept for the last N migrations).
- `index.db` is never migrated: a `schema_version` mismatch triggers a rebuild.
- The pipeline, extractor and rewriter versions are separate integers in `app_meta`; versions captured with older extractors are re-processed by an optional background job (`re-extract`), which is possible because original bytes are kept.
- Tests: migration-from-empty, migration N-1 to N with realistic data, and a restore-then-migrate test (tasks F-03, H-10).
