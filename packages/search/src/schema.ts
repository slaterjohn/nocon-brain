import { STOPWORDS } from "./stopwords.js";

/**
 * Bump when the layout or the tokenisers change. `index.db` is never migrated: a different version is rebuilt
 * (docs/data-model.md section 8).
 */
export const SCHEMA_VERSION = 1;
export const TOKENIZERS = "en=porter unicode61 remove_diacritics 2; default=unicode61 remove_diacritics 2; title=unicode61; vocab=trigram";

export const SCHEMA_SQL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) STRICT;

CREATE TABLE docs (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL UNIQUE,
  version_id INTEGER,
  public_page_id TEXT NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  registrable_domain TEXT NOT NULL,
  title TEXT NOT NULL,
  title_norm TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '',
  lang TEXT,
  fts_group TEXT NOT NULL CHECK (fts_group IN ('en','default')),
  type TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'web',
  captured_at INTEGER,
  published_at INTEGER,
  date_for_ranking INTEGER,
  availability TEXT NOT NULL,
  priority INTEGER,
  inlinks INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  simhash TEXT,
  words INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX docs_domain_idx ON docs (domain);
CREATE INDEX docs_title_norm_idx ON docs (title_norm);
CREATE INDEX docs_type_idx ON docs (type);
CREATE INDEX docs_date_idx ON docs (date_for_ranking);
CREATE INDEX docs_group_idx ON docs (fts_group);
CREATE INDEX docs_hash_idx ON docs (content_hash) WHERE content_hash IS NOT NULL;

CREATE TABLE doc_sources (doc_id INTEGER NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY (doc_id, source_id)) STRICT, WITHOUT ROWID;
CREATE INDEX doc_sources_source_idx ON doc_sources (source_id);
CREATE TABLE doc_collections (doc_id INTEGER NOT NULL, collection_id TEXT NOT NULL, PRIMARY KEY (doc_id, collection_id)) STRICT, WITHOUT ROWID;
CREATE INDEX doc_collections_collection_idx ON doc_collections (collection_id);

CREATE VIRTUAL TABLE fts_en USING fts5(title, headings, url, body, tokenize='porter unicode61 remove_diacritics 2', prefix='2 3 4');
CREATE VIRTUAL TABLE fts_default USING fts5(title, headings, url, body, tokenize='unicode61 remove_diacritics 2', prefix='2 3 4');
CREATE VIRTUAL TABLE title_fts USING fts5(title, tokenize='unicode61 remove_diacritics 2', prefix='2 3 4 5');

CREATE TABLE vocab (term TEXT PRIMARY KEY, df INTEGER NOT NULL) STRICT;
CREATE VIRTUAL TABLE vocab_tri USING fts5(term, tokenize='trigram', detail=none);

CREATE TABLE domains (domain TEXT PRIMARY KEY, n INTEGER NOT NULL) STRICT, WITHOUT ROWID;
CREATE TABLE synonyms (term TEXT NOT NULL, expansion TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('oneway','twoway')), PRIMARY KEY (term, expansion)) STRICT, WITHOUT ROWID;
CREATE TABLE stopwords (lang TEXT NOT NULL, term TEXT NOT NULL, PRIMARY KEY (lang, term)) STRICT, WITHOUT ROWID;
`;

export function seedStopwords(): [string, string][] {
  const out: [string, string][] = [];
  for (const [lang, words] of Object.entries(STOPWORDS)) for (const w of new Set(words)) out.push([lang, w]);
  return out;
}
