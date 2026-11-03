-- 0015_maintenance: Phase 9 (task H-02). Daily counters kept when finished rows of `jobs` are pruned (data-model.md section 3.5:
-- "finished rows are pruned ...; a daily rollup keeps counters").
--   * One row per (UTC day the job finished, queue, type, final state). `jobs` counts the rows pruned, `attempts` their total attempts and
--     `runtime_ms` the total time between start and finish for rows that have both.

CREATE TABLE job_rollups (
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  queue TEXT NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  jobs INTEGER NOT NULL DEFAULT 0 CHECK (jobs >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  runtime_ms INTEGER NOT NULL DEFAULT 0 CHECK (runtime_ms >= 0),
  PRIMARY KEY (day, queue, type, state)
) STRICT, WITHOUT ROWID;
