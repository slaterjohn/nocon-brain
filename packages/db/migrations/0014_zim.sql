-- 0014_zim: Phase 8 (tasks Z-01 to Z-09). See docs/data-model.md section 3.8 and "Phase 8 as built".
--
-- zim_packages registers a ZIM file that is read in place (or was copied to a volume's zim/ folder). The contents of a ZIM are never copied
-- into pages or blobs, never indexed into index.db and never evicted: a package leaves only by an explicit, confirmed removal.
--   * storage_mode 'in_place': the file stays where the Human put it, under an allowed root; volume_id is NULL unless the folder is a
--     registered volume. 'copied': the file was copied to <volume>/zim/ and the copy is ours (it is deleted with the package).
--   * file_path is the absolute real path at registration time. relative_path is set for copied files (under the volume root).
--   * sources.zim_package_id binds a knowledge_package source to its package (Z-09).
-- The bookmarks, history_entries and collection_memberships columns zim_package_id/zim_path already exist (0004, 0006) as plain integers; the
-- foreign keys below are added by table rebuild so a removed package cannot leave dangling references.

CREATE TABLE zim_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  language TEXT,
  creator TEXT,
  publisher TEXT,
  date TEXT,
  flavour TEXT,
  tags TEXT,
  uuid TEXT NOT NULL UNIQUE,
  volume_id INTEGER REFERENCES volumes(id) ON DELETE RESTRICT,
  storage_mode TEXT NOT NULL CHECK (storage_mode IN ('in_place','copied')),
  file_path TEXT NOT NULL,
  relative_path TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  checksum_sha256 TEXT,
  checksum_state TEXT NOT NULL DEFAULT 'pending' CHECK (checksum_state IN ('pending','done','failed')),
  article_count INTEGER NOT NULL DEFAULT 0,
  media_count INTEGER NOT NULL DEFAULT 0,
  entry_count INTEGER NOT NULL DEFAULT 0,
  has_fulltext_index INTEGER NOT NULL CHECK (has_fulltext_index IN (0,1)),
  has_title_index INTEGER NOT NULL CHECK (has_title_index IN (0,1)),
  new_namespace_scheme INTEGER NOT NULL CHECK (new_namespace_scheme IN (0,1)),
  main_path TEXT,
  has_illustration INTEGER NOT NULL DEFAULT 0 CHECK (has_illustration IN (0,1)),
  source_url TEXT,
  license_name TEXT,
  license_url TEXT,
  attribution_text TEXT,
  priority INTEGER NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 4),
  enabled_for_search INTEGER NOT NULL DEFAULT 1 CHECK (enabled_for_search IN (0,1)),
  state TEXT NOT NULL CHECK (state IN ('importing','ready','degraded','missing','removing')),
  state_detail TEXT,
  imported_at INTEGER NOT NULL,
  last_verified_at INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX zim_packages_state_idx ON zim_packages (state);
CREATE INDEX zim_packages_language_idx ON zim_packages (language);
CREATE UNIQUE INDEX zim_packages_path_uq ON zim_packages (file_path);

ALTER TABLE sources ADD COLUMN zim_package_id INTEGER REFERENCES zim_packages(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX sources_zim_package_uq ON sources (zim_package_id) WHERE zim_package_id IS NOT NULL AND deleted_at IS NULL;
