-- 0013_discovery: Phase 7 (tasks D-01 to D-08). See docs/data-model.md section 5.8.
--
-- discovery_candidates and candidate_provenance already exist (0011, created early for saved-search sources). This migration extends them
-- instead of duplicating them, and adds the budget ledger and the runner's small state row.
--   * discovery_candidates gains: host (per-site cap), depth (hops from a page the Human saved), attempts (failed downloads),
--     scored_at, download_job_id (the download the runner or a "queue now" started).
--   * candidate_provenance gets a unique index so the same reason is recorded once per day (re-capturing a page does not inflate counts).
--   * discovery_ledger records every download the runner or the auto-cache started: what was set aside, what was used.
--   * discovery_state holds the kill switch and the last pass.
-- Nothing here changes the triggers of 0011: a candidate from a provider that allows no storage still cannot carry text or components.

ALTER TABLE discovery_candidates ADD COLUMN host TEXT;
ALTER TABLE discovery_candidates ADD COLUMN depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0);
ALTER TABLE discovery_candidates ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0);
ALTER TABLE discovery_candidates ADD COLUMN scored_at INTEGER;
ALTER TABLE discovery_candidates ADD COLUMN download_job_id INTEGER REFERENCES download_jobs(id) ON DELETE SET NULL;
CREATE INDEX discovery_candidates_host_idx ON discovery_candidates (host);
CREATE INDEX discovery_candidates_download_idx ON discovery_candidates (download_job_id);

DELETE FROM candidate_provenance WHERE id NOT IN (
  SELECT MIN(id) FROM candidate_provenance
  GROUP BY candidate_id, kind, COALESCE(ref_page_id, 0), COALESCE(ref_source_id, 0), COALESCE(ref_search_id, 0), seen_at / 86400000
);
CREATE UNIQUE INDEX candidate_provenance_once_per_day ON candidate_provenance
  (candidate_id, kind, COALESCE(ref_page_id, 0), COALESCE(ref_source_id, 0), COALESCE(ref_search_id, 0), (seen_at / 86400000));
CREATE INDEX candidate_provenance_page_idx ON candidate_provenance (ref_page_id);

CREATE TABLE discovery_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  at INTEGER NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('active','background','auto_cache')),
  candidate_id INTEGER REFERENCES discovery_candidates(id) ON DELETE SET NULL,
  download_job_id INTEGER REFERENCES download_jobs(id) ON DELETE SET NULL,
  host TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 1 CHECK (requests >= 0),
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
  bytes INTEGER CHECK (bytes IS NULL OR bytes >= 0),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','settled')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('archived','unchanged','failed','cancelled')),
  settled_at INTEGER
) STRICT;
CREATE INDEX discovery_ledger_day_idx ON discovery_ledger (day, lane);
CREATE INDEX discovery_ledger_host_idx ON discovery_ledger (day, host);
CREATE INDEX discovery_ledger_open_idx ON discovery_ledger (state) WHERE state = 'reserved';

CREATE TABLE discovery_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused_at INTEGER,
  paused_by TEXT,
  last_pass_at INTEGER,
  last_pass_json TEXT CHECK (last_pass_json IS NULL OR json_valid(last_pass_json))
) STRICT;
INSERT INTO discovery_state (id) VALUES (1);
