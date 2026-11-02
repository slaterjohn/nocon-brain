-- 0012_intelligent_storage: pins, eviction runs, the storage audit trail, maintenance runs and reservation columns
-- (Phase 6, tasks T-01 to T-10). Source: docs/data-model.md sections 3.2, 3.4, 3.9, 5 and 7.
--
-- Differences from the doc (recorded in docs/data-model.md "Phase 6 as built"):
--   * storage_audit is new. It is the durable "why" of every eviction and every explicit deletion. activity_log is pruned by
--     the retention window; this table is not, so "why was this evicted?" can still be answered years later, and invariant I-13
--     has something to check against. version_id and page_id are plain integers: a deleted page or version leaves its audit row.
--   * eviction_runs records each execution of the executor (trigger, incoming priority, counts) so an interrupted run is visible.
--   * maintenance_runs exists as described in 3.9, with a public id.
--   * volume_reservations gains priority and source_id, and one reservation per (volume, download job).
--   * Pins are per user and retain the latest version only (data-model 5.1).

CREATE TABLE page_pins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 4),
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (page_id, user_id)
) STRICT;
CREATE INDEX page_pins_page_idx ON page_pins (page_id);

CREATE TABLE eviction_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  trigger TEXT NOT NULL CHECK (trigger IN ('admission','threshold','prune','manual','recovery')),
  state TEXT NOT NULL CHECK (state IN ('running','done','failed','interrupted')),
  incoming_priority INTEGER NOT NULL CHECK (incoming_priority BETWEEN 1 AND 4),
  bytes_needed INTEGER NOT NULL DEFAULT 0 CHECK (bytes_needed >= 0),
  volume_id INTEGER REFERENCES volumes(id) ON DELETE SET NULL,
  versions_planned INTEGER NOT NULL DEFAULT 0,
  versions_evicted INTEGER NOT NULL DEFAULT 0,
  versions_skipped INTEGER NOT NULL DEFAULT 0,
  bytes_freed INTEGER NOT NULL DEFAULT 0,
  blobs_deleted INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;
CREATE INDEX eviction_runs_started_idx ON eviction_runs (started_at);

CREATE TABLE storage_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('evicted','deleted')),
  at INTEGER NOT NULL,
  run_id INTEGER REFERENCES eviction_runs(id) ON DELETE SET NULL,
  page_id INTEGER NOT NULL,
  page_url TEXT NOT NULL,
  version_id INTEGER,
  version_no INTEGER,
  -- The class the version was in when it went: 1 to 4, or NULL for an explicit deletion that did not compute one.
  priority INTEGER CHECK (priority IS NULL OR priority BETWEEN 1 AND 4),
  surplus INTEGER NOT NULL DEFAULT 0 CHECK (surplus IN (0,1)),
  step TEXT,
  reason TEXT NOT NULL,
  trigger TEXT,
  exclusive_bytes INTEGER NOT NULL DEFAULT 0,
  refs_json TEXT CHECK (refs_json IS NULL OR json_valid(refs_json)),
  confirmed_protected INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_protected IN (0,1)),
  user_id INTEGER
) STRICT;
CREATE INDEX storage_audit_page_idx ON storage_audit (page_id, at);
CREATE INDEX storage_audit_version_idx ON storage_audit (version_id);
CREATE INDEX storage_audit_at_idx ON storage_audit (at);

CREATE TABLE maintenance_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('verify','repair','gc','backup','integrity_check','scrub')),
  dry_run INTEGER NOT NULL DEFAULT 1 CHECK (dry_run IN (0,1)),
  state TEXT NOT NULL CHECK (state IN ('running','done','failed')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  report_json TEXT CHECK (report_json IS NULL OR json_valid(report_json))
) STRICT;
CREATE INDEX maintenance_runs_started_idx ON maintenance_runs (started_at);

ALTER TABLE volume_reservations ADD COLUMN priority INTEGER CHECK (priority IS NULL OR priority BETWEEN 1 AND 4);
ALTER TABLE volume_reservations ADD COLUMN source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX volume_reservations_job_uq ON volume_reservations (volume_id, download_job_id);
