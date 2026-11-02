# Data model

Status: the schema through migration 0012 is built; sections 3.4a to 3.5a, 6.2, 6.3 and 5.6 record where the built schema differs from the proposals below. The tables below are the design that the Drizzle schema and the hand-written SQL migrations implement (Drizzle for ordinary tables, raw SQL migrations for FTS5 virtual tables, triggers and partial indexes; see [technology-decisions.md](technology-decisions.md#orm-and-migrations)).

## 1. Conventions

- Two SQLite files: `main.db` (authoritative) and `index.db` (derived, deletable). Section 6 covers `index.db`.
- All tables are `STRICT`. Timestamps are `INTEGER` Unix milliseconds in UTC (`*_at`). Booleans are `INTEGER` with `CHECK (x IN (0,1))`. JSON is `TEXT` with `CHECK (json_valid(x))`. Sizes are bytes.
- **Identifiers (D-9).** Each table has `id INTEGER PRIMARY KEY AUTOINCREMENT` (internal, never reused). Exposed entities also have `public_id TEXT NOT NULL UNIQUE`, a prefixed ULID (`usr_`, `src_`, `col_`, `pg_`, `ver_`, `job_`, `dl_`, `vol_`, `prv_`, `cand_`, `zim_`, `bm_`, `ss_`, `hs_` for history entries). Foreign keys use the integer. IDs and URLs never encode file paths.
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

**`discovery_candidates`**: `id`, `public_id` (`cand_`), `url`, `url_key UNIQUE`, `title_hint`, `state` (`new`, `approved`, `queued`, `archived`, `dismissed`, `expired`), `score REAL`, `score_components_json` (each component with weight and raw value; see D-03), `est_bytes`, `suggested_source_id`, `suggested_collection_id`, `first_seen_at`, `last_seen_at`, `expires_at`, `decided_by`, `decided_at`. Indexes `(state, score DESC)`, `(expires_at)`. Candidates for URLs already archived or queued are not created. Phase 7 adds `host`, `depth`, `attempts`, `scored_at` and `download_job_id` (section 5.8).

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

**`maintenance_runs`** (built in 0012 with a `public_id`): `id`, `kind` (`verify`, `repair`, `gc`, `backup`, `integrity_check`, `scrub`), `dry_run INTEGER`, `state`, `started_at`, `finished_at`, `report_json` (counts and per-finding detail: orphan blobs, missing blobs, refcount mismatches, dangling references, index drift, stale reservations, temp files, `capturing` versions).

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
- `page_pins`, `page_sources` and `url_exclusions` were not created in Phase 2; `page_sources` and `url_exclusions` arrived with migration 0006 (see 3.3a), `page_pins` arrived with migration 0012 (5.6).
- Migration `0004_bookmarks_history` (A-17) creates `bookmarks` and `history_entries`. Differences from the descriptions above: `bookmarks.collection_id` and `bookmarks.zim_package_id` are plain integers until `collections` and `zim_packages` exist; `bookmarks.reference_priority` stores `browser.bookmarkPriority` at creation for Phase 6; one live bookmark per user and URL key (partial unique index); history `public_id` uses the `hs_` prefix; the archive reference of a bookmark is resolved by URL when listed, `page_id` and `version_id` are only the link made at creation. There is no frame-grant table: archive tokens are stateless.
- Superseded versions (`latest_only`, `last_n`, `period`) are deleted in stage 15 rather than by the retention job; Phase 6 may move this.

### 3.3a Phase 3 implementation notes (migration 0006_sources_collections)

Differences between the tables in 3.3 and `packages/db/migrations/0006_sources_collections.sql`:

- **`page_sources`** (the source reference) has one extra column, `priority_override` (1 to 4, NULL normally). It is set when a capture was admitted at a priority different from the source's own (a Quick save at P1 under the P3 Quick saves source); the most important (lowest) value seen is kept. **Phase 6 reference priority = `COALESCE(page_sources.priority_override, sources.priority)`; retention comes from `sources.retention_mode/json`; `autoEvict` from `sources.automatic_eviction`; the reference is active while `sources.deleted_at IS NULL`.** `enabled=0` and `paused_at` do not matter: a disabled or paused source keeps its references. `apps/server/src/sources/references.ts` (`sourceReferences(db, pageId)`) returns exactly this; `apps/server/src/collections/references.ts` (`collectionReferences`) returns the collection half (collections with `priority_floor`). Rows are written when a capture links a page (`linkPageSource`, called by the pipeline for every capture that carries a `sourceId`, including unchanged re-fetches, which only move `last_seen_at`) with `discovered_via` and `depth` from the capture. `pages.effective_priority` stays a cache: the pipeline still sets it from the job priority, and a collection floor lowers it (more important) on membership; Phase 6 recomputes it from the references.
- **Deleting a source removes its `page_sources` rows** (and schedules, windows, discovery records), cancels its work and soft-deletes the `sources` row (`deleted_at`). The pages stay; a page with no reference left is priority 4 and surplus, which is what the verify operation reports and the planner evicts by policy. Old `page_versions.source_id` and `download_jobs.source_id` keep pointing at the hidden row.
- `sources` adds `paused_at` (pause scheduled work without disabling). `system_kind` rows are created at start-up, not by the migration (public ids are ULIDs generated in code).
- `source_discovered_urls (source_id, url_key, url, via, item_date, first_seen_at, last_seen_at)` records the addresses a sitemap or feed run has already queued, so later runs add only new items.
- `url_exclusions` also has a partial unique index for `source_id IS NULL`. `DELETE /api/archive/pages/{id}` writes a global `deleted_by_user` row unless `exclude=false`; sitemap and feed runs skip excluded addresses; saving by hand ignores them.
- `schedules` adds `spec_json` (the inputs a cron expression was built from), `last_slot_at` (the last slot claimed, which makes a slot run at most once and survives restarts) and has public ids `sch_`. `download_windows` adds `name`, has public ids `win_`, and `end_minute` may be less than `start_minute` (past midnight) or 1440. `download_jobs` adds `paused_by_window`.
- `collections`: the favourites index is partial on live rows; two triggers reject a parent cycle and nesting deeper than 8 levels. Deleting a collection is a soft delete: children move to its parent, memberships and `source_collections` rows are removed. `collection_memberships.zim_package_id` is a plain integer until `zim_packages` exists.
- Foreign keys added by table rebuild (the migration runner reads `-- ncb:fk table.column REFERENCES ...` lines and runs the 12-step procedure with `foreign_keys` off, then `foreign_key_check`): `download_jobs.source_id` and `crawl_jobs.source_id` to `sources`, `download_jobs.config_id` and `crawl_jobs.config_id` to `source_configs` (all `ON DELETE SET NULL`), `page_versions.source_id` to `sources` (`SET NULL`), `bookmarks.collection_id` to `collections` (`SET NULL`). Stale values in those columns are cleared first (nothing could have created a source before). Still plain integers: `jobs.version_id`, `page_versions.crawl_job_id`, `bookmarks.zim_package_id`, `*.candidate_id`, `sources.saved_search_id`.
- Not created here: `page_pins` (Phase 6) and `saved_searches` (Phase 7).

### 3.5a Phase 3 implementation notes (migration 0007_downloads_refresh)

- `download_jobs` adds `paused_by_limit` (1 when the disk guard paused the job because every online volume is under its free-space reserve; only those are resumed when space returns), `attempts` (retries by hand) and `summary_json` (counters for one kind of job; a `refresh` job holds `{ checked, unchanged, changed, gone, failed }`). `paused_by_window` from 0006 and `paused_by_limit` together with the job rows give the pause reason the API shows: `window_closed`, `volume_full`, `user`, or `offline` (the stored state is still `queued` while every piece of work is `held`; the API shows that as `paused`).
- `pages` adds `gone_at` and `gone_status`. A refresh that gets 404 or 410 sets them and keeps the page and every version (`availability` is not changed); a later successful check clears them. `last_checked_at` is set by every refresh check, changed or not.
- `idempotency_keys (key, request_hash, download_job_id, created_at)` backs `Idempotency-Key` on `POST /api/downloads` (24 hours).
- A `refresh_check` job has `url` and `url_key` of the page, `payload = { pageId, options }`, idempotency key `refresh:<pageId>` (a page is never checked by two refreshes at once), and `payload.failed = 1` once the check ended as a failure, so that a retry by hand runs exactly those.
- The queue claim reads global limits (`hostLimits`): the per-host cap is `MIN(host_state.max_concurrent, resources.perHostConcurrency)` and the pause after a request is `MAX(host_state.crawl_delay_ms, resources.perHostDelayMs)`. Manual ordering (`queue_order`) is applied to queued captures and refreshes through `jobs.score` (`-queue_order`); a crawl's frontier keeps its link scores, so ordering does not reorder inside a running crawl.

### 3.4c Library filter indexes (migration 0009_library_filters)

Partial indexes for `GET /api/archive/pages`: `page_versions_rendered_idx` (versions with `render_mode = 'browser'`, for `type=rendered`), `import_documents_kind_idx (kind, page_id)` (for `type=pdf|markdown|text`) and `pages_multi_version_idx` (pages with `version_count > 1`, for `minVersions`). The source, collection, priority, date and domain filters use the existing indexes (`page_sources` primary key, `collection_memberships_page_idx`, `pages_priority_idx`, `pages_last_captured_idx`, `pages_host_idx`).

### 3.4b Phase 3 implementation notes (migration 0008_imports)

- **`import_documents`** (one row per imported version): `version_id` UNIQUE (CASCADE), `page_id`, `source_id` (SET NULL), `kind` (`html`, `pdf`, `text`, `markdown`), `filename`, `declared_mime`, `detected_mime`, `original_blob_id` (RESTRICT; one reference counted, released by `deleteVersion`), `size_bytes`, `page_count`, `info_json` (PDF title, author, subject, keywords, creator, producer, dates, PDF version, empty pages, truncated flag, characters; for Markdown and text, counts), `created_at`.
- An upload is an ordinary page and version: `pages.origin = 'import'`, `pages.content_type` is `html`, `pdf` or `text` (Markdown counts as `text`). The URL is synthetic and never fetched: `https://imports.noconbrain.invalid/<first 16 hex of the upload's sha256>/<file name>` (`.invalid` is reserved, RFC 2606). The same bytes give the same URL, so a repeat import finds the existing page. `page_versions.raw_hash` / `document_blob_id` is the HTML document the pipeline reads: the upload itself for HTML; for Markdown, text and PDF a deterministic HTML document derived from it (`apps/server/src/imports/convert.ts`), so a better converter can re-derive it from the original in `import_documents`. `download_jobs.kind = 'import'`.
- Stages for an import: `assets` is skipped (nothing is fetched on behalf of an upload), and `status` never gives `reader_only` (a short note is still a whole document).
- **Rendered captures need no column.** `page_versions.render_mode` (`plain`, `browser`, from migration 0003) is the "rendered" flag. A rendered version belongs to the same page as the plain version it came from, has `download_job_id = NULL`, and its `raw_hash` is the hash of the serialised DOM. `jobs.type = 'render'` (queue `crawl`) uses the pseudo-host `renderer.internal`, so `host_state.max_concurrent` for that host is the render concurrency.

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
7. **Incoming gate.** (Built as the formula in this rule; see 5.6 for the clarification about P2 downloads.) When eviction frees space for an incoming download of priority `q`, a candidate must satisfy `priority(V) > q`, or `priority(V) = q` with `q` in `{3, 4}`. A P4 download can reclaim only P4. A P3 download can reclaim P3 and P4. A P2 download can reclaim P3 and P4, and P2 only if permitted. A P1 download can reclaim P2 (if permitted), P3 and P4. Maintenance-driven eviction (no incoming job) uses `q = 1` (anything eligible by rules 1 to 6).
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

### 5.6 Phase 6 as built (migration `0012_intelligent_storage`, tasks T-01 to T-12)

Code: `packages/storage-planner` (pure: priority, retention, eligibility, planner, forecast, explanation; no clock, no I/O, no randomness) and `apps/server/src/storage` (inventory reader, executor, admission, usage, maintenance, service). The API is in [api.md section 10](api.md#10-storage-phase-6-as-built).

**Tables added** (all `STRICT`):

| Table | Columns | Notes |
|---|---|---|
| `page_pins` | `id`, `page_id` FK CASCADE, `user_id` FK CASCADE, `priority` 1 to 4, `reason`, `created_at`; UNIQUE `(page_id, user_id)` | A pin retains the latest copy only. A P1 pin has `autoEvict=false`, which vetoes automatic eviction of every copy of the page. |
| `eviction_runs` | `id`, `public_id` (`evr_`), `trigger` (`admission`, `threshold`, `prune`, `manual`, `recovery`), `state` (`running`, `done`, `failed`, `interrupted`), `incoming_priority`, `bytes_needed`, `volume_id` FK SET NULL, `versions_planned`, `versions_evicted`, `versions_skipped`, `bytes_freed`, `blobs_deleted`, `error`, `started_at`, `finished_at` | One row per execution of the executor. A crash leaves `running`, which recovery turns into `interrupted`. |
| `storage_audit` | `id`, `kind` (`evicted`, `deleted`), `at`, `run_id` FK SET NULL, `page_id` and `version_id` (plain integers, no foreign keys, so the row outlives the page), `page_url`, `version_no`, `priority` 1 to 4 or NULL, `surplus`, `step`, `reason`, `trigger` (`explicit` for a deletion), `exclusive_bytes`, `refs_json`, `confirmed_protected`, `user_id` | The durable "why". `activity_log` is pruned by the retention window; this is not. Written in the same transaction as the eviction or the deletion. Invariant I-13 reads it. |
| `maintenance_runs` | as in 3.9 plus `public_id` (`mnt_`) | `report_json` holds the full `MaintenanceRun`. |

**Columns added:** `volume_reservations.priority`, `volume_reservations.source_id` (FK SET NULL), and a unique index on `(volume_id, download_job_id)` (one row per download per volume; a crawl adds to it page by page and gives back page by page).

**Deviations from 5.1 to 5.5:**

- **The incoming gate (5.2 rule 7).** The built rule is the formula: a candidate qualifies when `priority(V) > q`, or `priority(V) = q` with `q` in `{3, 4}`. The sentence in the proposal that a P2 download may reclaim P2 if permitted is not built: an equal-priority P2 download does not evict P2 content. Maintenance eviction (no incoming download) uses `q = 1`.
- **Phase B uses no grace for what the run just un-referenced.** The proposal had garbage collection delete files after `orphan_grace_seconds`. Under space pressure the space must come back at once, so blobs whose last reference this run removed are deleted straight away (they are unreferenced by the rows the same transaction committed). Blobs that were already orphaned are only touched when they are past `orphan_grace_seconds`, which is re-checked at deletion. After a crash the normal grace applies.
- **Blob deletion order.** `BlobStore.deleteIfUnreferenced` recounts the references from the rows (never the cached `refcount`), sets the blob row to `quarantined`, deletes the file, then deletes the row, all inside a per-hash gate shared with `put`. A crash between the steps leaves a `quarantined` row with no references, which `finishPendingDeletes` completes at start-up; a row in state `ready` never points at a missing file. `put` takes a re-used zero-reference blob off the collector's list (`zero_since = NULL`) until its reference arrives, and heals a `missing` blob when the same bytes are stored again.
- **A version being captured holds its original by hash.** Counting references for deletion includes `page_versions.raw_hash` of a `capturing` version, because its asset reference does not exist until stage 2.
- **Phase A removes everything at once.** In the one transaction the executor sets `evicting`, deletes `asset_references`, `version_resources`, `version_content` and the import document, clears `document_blob_id`, releases the blob counts, deletes assets nothing uses, repoints `pages.latest_version_id` (to the newest remaining copy, or NULL with `availability = 'evicted'`) and writes the audit and log rows. Phase B deletes files, then sets `evicted` and deletes the version's outgoing `links` (recomputing `inbound_count` of the targets). The outbox rows come from the migration 0010 triggers on those statements; the executor writes none by hand.
- **Policy lives in settings.** The group `storage` is the source of truth (api.md 10.9); the `storage_policies` global row is kept equal to it. Thresholds stay on `volumes`; there are no per-volume policy rows yet.
- **Usage cache.** `storage_usage_cache` rows are `(volume, dimension, key)` with `bytes` = exclusive + shared, `shared_bytes` and `blob_count`; keys are `P1`..`P4` and `unreferenced`, source public ids (or `unassigned`/`unreferenced`), and blob kinds. The API computes fresh figures; the cache is rewritten by the storage pass.
- **Cached priorities.** `pages.effective_priority` and `page_versions.retained` are refreshed (`PriorityCache`) when a page is finalised, a source's priority, retention or flag changes, a source is deleted, a bookmark is made or removed, or a pin changes. Nothing that deletes reads them.

**Admission and the byte budget.** Each download reserves room before it writes (`AdmissionService`): the estimate is 1.5 times the median size of the source's last 200 copies (else the archive's, else 1 MiB), cut to the capture caps. The crawl engine also reserves each page's share of `maxBytes` (HB-06) and measures time with the steady clock (HB-04).

**5.7 Volume-to-volume migration (design note, task T-11, post-v1).** `POST /api/storage/volumes/{id}/migrate` answers 501. The intended design, so that nothing built now blocks it: because a blob's path derives from `(volume root, sha256)`, migration is "copy blob files, flip `blobs.volume_id`, delete the source file", blob by blob, each step crash safe in the same way as eviction. (1) Set the source volume `draining` (no new blobs go there). (2) For each blob on it, in batches: pick a target by the placement policy; reserve its bytes there; write to `tmp/`, fsync, rename into place; verify the SHA-256; in one transaction set `volume_id` (the row never points at a missing file because the new file exists before the flip); then delete the old file under the same per-hash gate as `deleteIfUnreferenced`. (3) Record progress in a `volume_migrations` table (source, target, state, bytes done) so a restart resumes; a blob found already at the target is skipped. (4) When the volume holds no blobs it can be removed (the existing refusal rule). Offline source volumes cannot be migrated; a target going offline pauses the job. No change to the reference model, priorities or the planner is needed, because they never look at paths.

### 5.8 Phase 7 as built (migration `0013_discovery`, tasks D-01 to D-08)

Code: `apps/server/src/discovery` (settings, pure scoring and planner, store, scorer, ledger, runner, service) and `apps/server/src/routes/discovery.ts`. The contract is [api.md section 9](api.md#9-discovery-phase-7-as-built). `discovery_candidates` and `candidate_provenance` were created by 0011 for saved-search sources and are **extended, not duplicated**.

- **`discovery_candidates` gains**: `host` (lower-case host, for the per-site cap; filled in at startup for older rows), `depth` (hops from a page the Human saved, default 0), `attempts` (downloads that failed; two failures expire the candidate), `scored_at`, and `download_job_id` (the download the runner or "queue now" started; `download_jobs.candidate_id` points back). States and the 0011 triggers are unchanged: a candidate whose `origin_storage` is `none` (Brave) still exists only once approved, carries no title and no `score_components_json`, and is **deleted** (not expired or dismissed) when it cannot continue; a `ttl` candidate still has no text or components and expires with the provider's cache time. For those two origins the score is stored but the components are recomputed on demand by the explain API.
- **`candidate_provenance` gains** a unique index `candidate_provenance_once_per_day` on `(candidate_id, kind, ref_page_id, ref_source_id, ref_search_id, day of seen_at)` so the same reason is recorded once a day (re-saving a page does not inflate counts), and an index on `ref_page_id`. Rows inserted with `ON CONFLICT DO NOTHING`. `detail` holds only a machine-made note (the link region, or `live`/`offline` for a visit); `ref_search_id` is not written by Phase 7 (no search text or search-history link is kept).
- **`discovery_ledger`** (new): `id`, `day` (UTC `YYYY-MM-DD`), `at`, `lane` (`active`, `background`, `auto_cache`), `candidate_id` FK SET NULL, `download_job_id` FK SET NULL, `host`, `requests` (1; 0 when a queued download was cancelled before it started), `reserved_bytes` (the allotment, also the capture's size cap), `bytes` (what the download really took, set when settled), `state` (`reserved`, `settled`), `outcome` (`archived`, `unchanged`, `failed`, `cancelled`), `settled_at`. Used today = sum of `bytes` for settled rows and `reserved_bytes` for open ones. Pruned after 90 days. This is the budget source of truth; the `usage_counters` kinds `discovery_requests` and `discovery_bytes` of section 3.6 are not used (they cannot hold per-host or per-lane figures).
- **`discovery_state`** (new, one row, `id = 1`): `paused_at`, `paused_by` (the kill switch), `last_pass_at`, `last_pass_json`.
- **Settings** live in the `discovery` group of `settings` (JSON, defaults all off). The old keys `enabled` and `passiveCandidates` of the Phase 1 stub are replaced (`enabled` stays as the master switch; unknown stored keys are dropped on read). `browser.autoCacheOpened` of Phase 4 is superseded by `discovery.searchDriven.autoCacheOpenedOnlinePages` and is no longer read.
- **Download jobs** started by discovery have `requested_by = 'discovery'`, `kind = 'capture'` and priority 4; their pages are linked to the source they were filed under (`page_sources.discovered_via` is `link` or `search`, `depth` is the candidate's depth).
- **Activity log**: discovery writes under area `crawl` (adding an area would need a rebuild of `activity_log` for its `CHECK`).

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

### 6.2 Phase 4 as built (tasks S-01 to S-15)

Code: `packages/search` (`@ncb/search`: parser, query builder, FTS5 engine behind the `SearchIndex` interface) and `apps/server/src/search` (workers, service, rebuild). Deviations from the tables above:

- **Own FTS content.** `fts_en`, `fts_default` and `title_fts` are ordinary FTS5 tables that hold their own text (`title`, `headings`, `url` without scheme, `body`, body capped at 120,000 characters); `docs` holds metadata only (no `body` or `headings`). Reason: one language group per document needs two FTS tables, and an external-content table reads every `docs` row on `rebuild`. Because of this nothing uses `INSERT INTO fts(fts) VALUES('rebuild')`; documents are inserted directly (bulk path) and `optimize` runs at the end. `docs.id` (the rowid) is the FTS rowid. Extra `docs` columns: `title_norm` (exact-title matches), `words`; `simhash` is filled (64-bit, hex, over word 3-grams of the first 1000 words).
- `doc_sources.source_id` and `doc_collections.collection_id` hold **public ids** (`src_...`, `col_...`) as text, not integers; `doc_collections` includes every ancestor of each collection the page belongs to. New tables: `domains` (host counts for autocomplete). `vocab` is built from the raw (unstemmed, accent-folded) words of title, headings and body, 3 to 32 letters, not plain numbers, because `fts5vocab` over a Porter table yields stems. It is counted exactly on incremental changes and recounted in memory during a build (single-use terms are dropped if the map passes 2,000,000 terms).
- `meta` also holds `last_optimize_at`; shadow files hold `rebuild_in_progress`, `rebuild_checkpoint` (last page id), `rebuild_done`, `outbox_start`.
- **Outbox by trigger.** `index_outbox` rows (migration `0010_search`) are written by triggers on `pages` (latest version, availability, deletion, title, type, language, priority, in-link bucket, delete), `page_versions` (eviction states, deletion), `collection_memberships`, `collections` (move, delete: every member of the subtree), and `page_sources`, plus pipeline stage 12 (`upsert_page`). The consumer treats `op` as a hint and reads the page's current state, so rows are idempotent and coalesced per page. The index worker keeps `last_applied_outbox_id` in `index.db` `meta`; the main thread deletes outbox rows up to the applied id (not during a rebuild, whose replay point is the highest id seen when it began).
- A page is indexed when it is not deleted, `availability` is `archived` or `partial`, and its latest version is `ready` or `partial`. Eviction and deletion therefore remove the document.
- `saved_searches` gains `scope` and `updated_at`; `collection_id` is a plain integer. A saved-search collection stores `{"savedSearchId": "ss_..."}` in `collections.rule_json` and its members as `collection_memberships` with `added_by = 'rule'`.
- `index_generations.state` may also be `failed`; `indexing_jobs` has `detail_json`, `started_at` and states `queued`, `running`, `done`, `failed`, `cancelled`.
- Writers: the `index` worker thread is the only writer of `index.db` (lock file `index.db.lock`); the `search` worker thread reads through a read-only connection. The shadow file `index.rebuild.db` is built by the same worker and swapped with an atomic rename after the live file is checkpointed and closed.

### 6.3 Phase 5 as built (migration `0011_online_search`, tasks O-01 to O-11)

Code: `apps/server/src/online` (adapters, runner, provider service, sessions and fusion, coverage, saved-search sources). The migration creates **`search_providers`**, **`provider_result_cache`**, **`usage_counters`**, **`discovery_candidates`** and **`candidate_provenance`**, and adds two columns to `saved_searches`. Deviations from section 3.6:

- `search_providers.credentials_enc` is `TEXT` (the `v1:<iv>:<tag>:<data>` AES-256-GCM envelope of `lib/secrets.ts`), never `BLOB`; it is never returned by the API (`hasCredentials` is). `priority` is "1 is first" (orders runs, ties, and the overlap rule of the fusion). `rate_limit_per_sec` is `REAL`; `timeout_ms` defaults to 4000 and is checked 500 to 30000; `safe_search` is `off`, `moderate` or `strict`; `health_state` is `unknown`, `ok`, `degraded` or `down`; `weight` defaults to 1.0 (0 to 10). `circuit_open_until` mirrors the runner's in-memory circuit so the UI can show it. `fallback_provider_id` is a self foreign key (`ON DELETE SET NULL`).
- **Storage triggers.** `search_providers_policy_insert` / `_update` abort a Brave row whose `storage_kind` is not `none` and a Mojeek row that is `unrestricted` or has `storage_ttl_seconds` above 3600. `search_providers_policy_purge` empties a provider's cache when its policy is tightened. `provider_result_cache_guard_insert` / `_update` abort any cache row for a provider whose `storage_kind` is `none`, whose adapter is `brave` (whatever its row says), or whose `expires_at` is later than `fetched_at + storage_ttl_seconds * 1000`. The runner only ever caches for `ttl` and `unrestricted` providers with a TTL above 0 and clamps the TTL to the adapter's maximum, so the triggers are the last line of defence, not the first.
- `provider_result_cache` has `UNIQUE (provider_id, query_hash, page)`; `results_json` holds normalised results only (URL, title and snippet as plain text, rank). `query_hash` is a SHA-256 of adapter, lower-cased query, page, page size, language, region and SafeSearch. Expired rows are deleted when the next cache lookup for any provider misses.
- `usage_counters` is `WITHOUT ROWID`, one row per `(kind, subject, period)`. For `kind = 'provider_requests'` the `subject` is the provider's public id and there are two rows per provider: the UTC month (`2026-11`) and the UTC day (`2026-11-02`). A retry counts as a request (it is billed). Deleting a provider deletes its counters.
- **`discovery_candidates` and `candidate_provenance`** are created here, with the columns of section 3.6 plus `origin_storage` (`none`, `ttl` or `unrestricted`: the storage policy of the provider that produced the candidate; NULL for candidates from elsewhere). Triggers: a candidate with `origin_storage = 'none'` (Brave) can only be inserted as `approved`, `queued` or `archived`, with no `title_hint` and no `score_components_json`; a candidate with `origin_storage = 'ttl'` (Mojeek) must have `expires_at`, no title and no score components; provenance rows of either kind cannot carry `detail`. Candidates from `unrestricted` providers (SearXNG) keep the title as `title_hint`. Phase 7 builds scoring, expiry sweeps and the discovery UI on these tables; Phase 5 only writes them from saved-search sources and sweeps expired `ttl` candidates.
- `saved_searches` gains `on_result` (`candidates` or `downloads`, default `candidates`) and `max_results` (1 to 50, default 20). `saved_searches.source_id` now points at the `saved_search` source that was created for it, and that source's `saved_search_id` points back.
- Sessions, events, the merged result list and the pending ("transient") candidates of a provider whose policy is `none` are **memory only** (30 minutes; transient candidates until the next run, approval, dismissal, or 24 hours). `search_history.online_providers_json` holds provider public ids only.
- **What is allowed to persist from a Brave search**: nothing a Brave result said. The address of a page the Human saves (`download_jobs.requested_url`, the page row) or approves (`discovery_candidates.url` with no title) is the page the Human chose, not Brave data. An integration test scans every table and every file under the data directory after a Brave search, a second page, a repeat search and a save.

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
