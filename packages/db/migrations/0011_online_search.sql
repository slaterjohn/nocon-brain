-- 0011_online_search: combined search (Phase 5, tasks O-01 to O-11; docs/data-model.md section 3.6 and "Phase 5 notes").
-- Provider rows with encrypted credentials, the bounded result cache, request counters, discovery candidates for saved-search
-- sources, and the guard triggers that keep transient provider data (Brave) out of the database.
--
-- Deliberate differences from the doc (recorded in docs/data-model.md):
--   * `credentials_enc` is TEXT (the `v1:<iv>:<tag>:<data>` string of lib/secrets.ts), not BLOB.
--   * `search_providers.priority` is "1 is first". `weight` defaults to 1.0.
--   * `discovery_candidates` and `candidate_provenance` are created here (with the doc's columns plus `origin_storage`) because a
--     saved-search source needs somewhere to put candidates; Phase 7 builds the scoring and UI on top of the same tables.
--   * `saved_searches` gains `on_result` and `max_results` for the saved-search source.

CREATE TABLE search_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  adapter TEXT NOT NULL CHECK (adapter IN ('searxng','brave','mojeek')),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 1000),
  base_url TEXT,
  credentials_enc TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 4000 CHECK (timeout_ms BETWEEN 500 AND 30000),
  rate_limit_per_sec REAL NOT NULL DEFAULT 1 CHECK (rate_limit_per_sec > 0 AND rate_limit_per_sec <= 50),
  monthly_cap INTEGER CHECK (monthly_cap IS NULL OR monthly_cap >= 0),
  daily_cap INTEGER CHECK (daily_cap IS NULL OR daily_cap >= 0),
  fallback_provider_id INTEGER REFERENCES search_providers(id) ON DELETE SET NULL,
  language TEXT,
  region TEXT,
  safe_search TEXT NOT NULL DEFAULT 'moderate' CHECK (safe_search IN ('off','moderate','strict')),
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('none','ttl','unrestricted')),
  storage_ttl_seconds INTEGER CHECK (storage_ttl_seconds IS NULL OR storage_ttl_seconds >= 0),
  weight REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 10),
  health_state TEXT NOT NULL DEFAULT 'unknown' CHECK (health_state IN ('unknown','ok','degraded','down')),
  last_ok_at INTEGER,
  last_error_code TEXT,
  circuit_open_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX search_providers_enabled_idx ON search_providers (enabled, priority);

-- Brave's terms allow transient storage only; Mojeek's cheapest plan allows one hour. The adapter limits are enforced here as well as in code.
CREATE TRIGGER search_providers_policy_insert BEFORE INSERT ON search_providers
WHEN (NEW.adapter = 'brave' AND NEW.storage_kind <> 'none')
  OR (NEW.adapter = 'mojeek' AND (NEW.storage_kind = 'unrestricted' OR COALESCE(NEW.storage_ttl_seconds, 0) > 3600))
BEGIN
  SELECT RAISE(ABORT, 'storage policy is looser than the provider allows');
END;
CREATE TRIGGER search_providers_policy_update BEFORE UPDATE OF adapter, storage_kind, storage_ttl_seconds ON search_providers
WHEN (NEW.adapter = 'brave' AND NEW.storage_kind <> 'none')
  OR (NEW.adapter = 'mojeek' AND (NEW.storage_kind = 'unrestricted' OR COALESCE(NEW.storage_ttl_seconds, 0) > 3600))
BEGIN
  SELECT RAISE(ABORT, 'storage policy is looser than the provider allows');
END;
CREATE TABLE provider_result_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES search_providers(id) ON DELETE CASCADE,
  query_hash TEXT NOT NULL,
  page INTEGER NOT NULL CHECK (page >= 1),
  results_json TEXT NOT NULL CHECK (json_valid(results_json)),
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (provider_id, query_hash, page)
) STRICT;
CREATE INDEX provider_result_cache_expires_idx ON provider_result_cache (expires_at);

-- A `none` provider (and Brave, whatever its row says) can never have cache rows; a row cannot outlive the provider's TTL.
CREATE TRIGGER provider_result_cache_guard_insert BEFORE INSERT ON provider_result_cache
WHEN EXISTS (
  SELECT 1 FROM search_providers p WHERE p.id = NEW.provider_id
    AND (p.storage_kind = 'none' OR p.adapter = 'brave' OR NEW.expires_at > NEW.fetched_at + COALESCE(p.storage_ttl_seconds, 0) * 1000)
)
BEGIN
  SELECT RAISE(ABORT, 'this provider''s results may not be stored (or not for that long)');
END;
CREATE TRIGGER provider_result_cache_guard_update BEFORE UPDATE ON provider_result_cache
WHEN EXISTS (
  SELECT 1 FROM search_providers p WHERE p.id = NEW.provider_id
    AND (p.storage_kind = 'none' OR p.adapter = 'brave' OR NEW.expires_at > NEW.fetched_at + COALESCE(p.storage_ttl_seconds, 0) * 1000)
)
BEGIN
  SELECT RAISE(ABORT, 'this provider''s results may not be stored (or not for that long)');
END;

-- Tightening a policy empties the cache of that provider.
CREATE TRIGGER search_providers_policy_purge AFTER UPDATE OF storage_kind, storage_ttl_seconds ON search_providers
WHEN NEW.storage_kind = 'none' OR COALESCE(NEW.storage_ttl_seconds, 0) < COALESCE(OLD.storage_ttl_seconds, 0)
BEGIN
  DELETE FROM provider_result_cache WHERE provider_id = NEW.id;
END;

CREATE TABLE usage_counters (
  kind TEXT NOT NULL CHECK (kind IN ('provider_requests','discovery_bytes','discovery_requests','wikipedia_requests')),
  subject TEXT NOT NULL,
  period TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  PRIMARY KEY (kind, subject, period)
) STRICT, WITHOUT ROWID;

-- Discovery candidates (docs/data-model.md section 3.6). `origin_storage` is the storage policy of the provider that produced the
-- candidate ('none' for Brave). Such a candidate exists only once the Human approved it, and never carries provider text.
CREATE TABLE discovery_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  url_key TEXT NOT NULL UNIQUE,
  title_hint TEXT,
  state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new','approved','queued','archived','dismissed','expired')),
  score REAL NOT NULL DEFAULT 0,
  score_components_json TEXT CHECK (score_components_json IS NULL OR json_valid(score_components_json)),
  est_bytes INTEGER,
  suggested_source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  suggested_collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  origin_storage TEXT CHECK (origin_storage IS NULL OR origin_storage IN ('none','ttl','unrestricted')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER,
  decided_by TEXT,
  decided_at INTEGER
) STRICT;
CREATE INDEX discovery_candidates_state_idx ON discovery_candidates (state, score);
CREATE INDEX discovery_candidates_expires_idx ON discovery_candidates (expires_at);

CREATE TRIGGER discovery_candidates_transient_insert BEFORE INSERT ON discovery_candidates
WHEN NEW.origin_storage = 'none'
  AND (NEW.title_hint IS NOT NULL OR NEW.score_components_json IS NOT NULL OR NEW.state NOT IN ('approved','queued','archived'))
BEGIN
  SELECT RAISE(ABORT, 'a candidate from a transient-only provider is stored only after approval, and without provider text');
END;
CREATE TRIGGER discovery_candidates_transient_update BEFORE UPDATE ON discovery_candidates
WHEN NEW.origin_storage = 'none'
  AND (NEW.title_hint IS NOT NULL OR NEW.score_components_json IS NOT NULL OR NEW.state NOT IN ('approved','queued','archived'))
BEGIN
  SELECT RAISE(ABORT, 'a candidate from a transient-only provider is stored only after approval, and without provider text');
END;

-- A candidate from a `ttl` provider (Mojeek) carries no provider text and expires with the provider's cache time.
CREATE TRIGGER discovery_candidates_ttl_insert BEFORE INSERT ON discovery_candidates
WHEN NEW.origin_storage = 'ttl' AND (NEW.title_hint IS NOT NULL OR NEW.score_components_json IS NOT NULL OR NEW.expires_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'a candidate from a time-limited provider has no provider text and must expire');
END;
CREATE TRIGGER discovery_candidates_ttl_update BEFORE UPDATE ON discovery_candidates
WHEN NEW.origin_storage = 'ttl' AND (NEW.title_hint IS NOT NULL OR NEW.score_components_json IS NOT NULL OR NEW.expires_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'a candidate from a time-limited provider has no provider text and must expire');
END;

CREATE TABLE candidate_provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES discovery_candidates(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('link','search_result','saved_search','visit','bookmark','missing_link','manual')),
  ref_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  ref_search_id INTEGER,
  ref_source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  detail TEXT,
  weight REAL,
  seen_at INTEGER NOT NULL
) STRICT;
CREATE INDEX candidate_provenance_candidate_idx ON candidate_provenance (candidate_id);

CREATE TRIGGER candidate_provenance_transient BEFORE INSERT ON candidate_provenance
WHEN NEW.detail IS NOT NULL AND EXISTS (SELECT 1 FROM discovery_candidates c WHERE c.id = NEW.candidate_id AND c.origin_storage IN ('none','ttl'))
BEGIN
  SELECT RAISE(ABORT, 'provenance of a transient-only provider carries no provider text');
END;

ALTER TABLE saved_searches ADD COLUMN on_result TEXT NOT NULL DEFAULT 'candidates' CHECK (on_result IN ('candidates','downloads'));
ALTER TABLE saved_searches ADD COLUMN max_results INTEGER NOT NULL DEFAULT 20 CHECK (max_results BETWEEN 1 AND 50);
