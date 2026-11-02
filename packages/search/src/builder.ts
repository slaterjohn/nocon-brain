import type { Filters, SynonymConfig } from "./types.js";
import type { ParsedQuery } from "./parser.js";
import { normaliseTypes } from "./parser.js";
import { tokenize } from "./text.js";

/** FTS5 expression building (S-04). Every word reaches FTS5 inside double quotes, so no user text is ever syntax. */

/** A quoted FTS5 atom for a word or phrase. Tokens come from `tokenize`, so they hold only letters and digits. */
export function atom(tokens: string[], prefix = false): string {
  const body = tokens.join(" ");
  return prefix && tokens.length === 1 ? `"${body}"*` : `"${body}"`;
}

export interface MatchParts {
  /** Each group is a list of alternatives (a term and its synonyms or corrections); groups are ANDed (or ORed in `or` mode). */
  groups: string[][];
  negatives: string[];
  mode: "and" | "or";
  /** Restrict the positive part to these columns (the title-first pass). */
  columns?: string[];
}

/** The FTS5 `MATCH` string for the parts, or null when there is nothing positive to match. */
export function matchExpr(p: MatchParts): string | null {
  const groups = p.groups.filter((g) => g.length > 0);
  if (!groups.length) return null;
  const grp = (g: string[]) => (g.length === 1 ? g[0]! : `(${g.join(" OR ")})`);
  let pos: string;
  if (p.mode === "and") pos = groups.map(grp).join(" AND ");
  else pos = groups.flat().join(" OR ");
  if (p.columns?.length) pos = `{${p.columns.join(" ")}} : (${pos})`;
  if (!p.negatives.length) return pos;
  return `(${pos}) NOT (${p.negatives.join(" OR ")})`;
}

export type SynonymMap = Map<string, string[][]>;

/** Index of the synonym entries by folded term. Two-way entries expand from every member; one-way only from the term. */
export function synonymMap(cfg: SynonymConfig | undefined): SynonymMap {
  const map: SynonymMap = new Map();
  if (!cfg?.enabled) return map;
  const add = (k: string, v: string[]) => {
    if (!k) return;
    const list = map.get(k) ?? [];
    if (!list.some((x) => x.join(" ") === v.join(" "))) list.push(v);
    map.set(k, list);
  };
  for (const e of cfg.items) {
    const t = tokenize(e.term);
    const ex = e.expansions.map(tokenize).filter((x) => x.length);
    if (!t.length || !ex.length) continue;
    for (const x of ex) add(t.join(" "), x);
    if (e.kind === "twoway") {
      for (const x of ex) {
        add(x.join(" "), t);
        for (const y of ex) if (y !== x) add(x.join(" "), y);
      }
    }
  }
  return map;
}

export interface FilterSql { where: string; params: (string | number)[] }

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Filters as SQL on `docs` aliased `d`. `skip` leaves one facet dimension out (used for facet counts). */
export function filterSql(parsed: ParsedQuery | null, f: Filters = {}, o: { skip?: string; onlyOperators?: boolean } = {}): FilterSql {
  const w: string[] = [];
  const p: (string | number)[] = [];
  const hostMatch = (hosts: string[], negate: boolean) => {
    const parts = hosts.map(() => `(d.domain = ? OR d.domain LIKE ? ESCAPE '\\')`);
    for (const h of hosts) p.push(h, `%.${likeEscape(h)}`);
    w.push(`${negate ? "NOT " : ""}(${parts.join(" OR ")})`);
  };
  const inList = (col: string, vals: string[], negate = false) => {
    w.push(`${col} ${negate ? "NOT " : ""}IN (${vals.map(() => "?").join(",")})`);
    p.push(...vals);
  };
  if (parsed) {
    if (parsed.filters.site.length) hostMatch(parsed.filters.site, false);
    if (parsed.filters.notSite.length) hostMatch(parsed.filters.notSite, true);
    if (parsed.filters.type.length) inList("d.type", [...new Set(parsed.filters.type)]);
    if (parsed.filters.notType.length) inList("d.type", [...new Set(parsed.filters.notType)], true);
    if (parsed.filters.before !== undefined) { w.push("d.date_for_ranking < ?"); p.push(parsed.filters.before); }
    if (parsed.filters.after !== undefined) { w.push("d.date_for_ranking >= ?"); p.push(parsed.filters.after); }
  }
  if (!o.onlyOperators) {
    const use = (k: string) => o.skip !== k;
    if (use("domains") && f.domains?.length) hostMatch(f.domains.map((x) => x.toLowerCase()), false);
    if (use("types") && f.types) {
      const t = normaliseTypes(f.types);
      if (t.length) inList("d.type", t);
      else w.push("0");
    }
    if (use("languages") && f.languages?.length) inList("d.lang", f.languages.map((x) => x.toLowerCase().split(/[-_]/)[0]!));
    if (use("availability") && f.availability?.length) {
      const map: Record<string, string> = { cached: "archived", partial: "partial" };
      const a = f.availability.map((x) => map[x]).filter((x): x is string => !!x);
      if (a.length) inList("d.availability", a);
      else w.push("0");
    }
    if (use("sources") && f.sources?.length) {
      w.push(`EXISTS (SELECT 1 FROM doc_sources s WHERE s.doc_id = d.id AND s.source_id IN (${f.sources.map(() => "?").join(",")}))`);
      p.push(...f.sources);
    }
    if (use("collections") && f.collections?.length) {
      w.push(`EXISTS (SELECT 1 FROM doc_collections c WHERE c.doc_id = d.id AND c.collection_id IN (${f.collections.map(() => "?").join(",")}))`);
      p.push(...f.collections);
    }
    if (use("downloaded")) {
      if (f.downloadedFrom !== undefined) { w.push("d.captured_at >= ?"); p.push(f.downloadedFrom); }
      if (f.downloadedTo !== undefined) { w.push("d.captured_at <= ?"); p.push(f.downloadedTo); }
    }
    if (use("published")) {
      if (f.publishedFrom !== undefined) { w.push("d.published_at >= ?"); p.push(f.publishedFrom); }
      if (f.publishedTo !== undefined) { w.push("d.published_at <= ?"); p.push(f.publishedTo); }
    }
  }
  return { where: w.length ? w.join(" AND ") : "1", params: p };
}
