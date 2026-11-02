import { tokenize } from "./text.js";

/** Query language (S-03). Never throws and never produces text that FTS5 cannot parse: every term reaches FTS5 as a quoted word. */

export type OperatorName = "site" | "type" | "before" | "after";

export type Node =
  | { type: "term"; value: string; tokens: string[]; negated: boolean; prefix: boolean }
  | { type: "phrase"; value: string; tokens: string[]; negated: boolean }
  | { type: "operator"; name: OperatorName; value: string; negated: boolean };

export interface ParsedQuery {
  raw: string;
  ast: Node[];
  /** Positive bare terms in order (a term with punctuation inside, such as `foo.bar`, becomes a phrase). */
  terms: TermNode[];
  phrases: string[][];
  excludedTerms: string[][];
  filters: {
    site: string[]; notSite: string[]; type: string[]; notType: string[];
    /** Epoch ms, exclusive upper bound. */
    before?: number;
    /** Epoch ms, inclusive lower bound. */
    after?: number;
  };
  warnings: string[];
}

export interface TermNode { text: string; tokens: string[]; prefix: boolean }

export const MAX_QUERY_LENGTH = 500;
const MAX_TERMS = 32;

const OPERATOR = /^(site|type|before|after):(.*)$/i;
const TYPE_ALIASES: Record<string, string[]> = {
  html: ["html"], web: ["html"], page: ["html"], pdf: ["pdf"], image: ["image"], img: ["image"], images: ["image"], text: ["text"], txt: ["text"],
  markdown: ["text"], md: ["text"], document: ["pdf", "text"], doc: ["pdf", "text"], documents: ["pdf", "text"], other: ["other"],
};

export function normaliseTypes(values: string[]): string[] {
  const out = new Set<string>();
  for (const v of values) for (const t of TYPE_ALIASES[v.toLowerCase()] ?? []) out.add(t);
  return [...out];
}

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD` as the UTC start of that period, or null. */
export function parseDateStart(v: string): number | null {
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(v.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = m[2] ? Number(m[2]) : 1, d = m[3] ? Number(m[3]) : 1;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1000) return null;
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null; // 31 February
  return t;
}

function cleanHost(v: string): string {
  return v.toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/[^a-z0-9.\-¡-￿]/g, "").replace(/^\.+|\.+$/g, "");
}

interface RawToken { text: string; quoted: boolean; negated: boolean }

function scan(input: string, warnings: string[]): RawToken[] {
  const out: RawToken[] = [];
  const s = input;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    let negated = false;
    if (c === "-" || c === "−") {
      // A leading minus excludes the next word or phrase; a lone minus is ignored.
      const next = s[i + 1];
      if (next === undefined || /\s/.test(next)) { i++; continue; }
      negated = true;
      i++;
    }
    if (s[i] === '"' || s[i] === "“") {
      const close = s.slice(i + 1).search(/["”]/);
      let body: string;
      if (close === -1) {
        body = s.slice(i + 1);
        i = n;
        warnings.push('A quotation mark was not closed, so the rest of the query is treated as one phrase.');
      } else {
        body = s.slice(i + 1, i + 1 + close);
        i = i + close + 2;
      }
      out.push({ text: body, quoted: true, negated });
      continue;
    }
    let j = i;
    // `site:"a b"` keeps its quoted value together.
    while (j < n && !/\s/.test(s[j]!)) {
      if (s[j] === '"' && /:$/.test(s.slice(i, j))) {
        const end = s.indexOf('"', j + 1);
        j = end === -1 ? n : end + 1;
        break;
      }
      j++;
    }
    out.push({ text: s.slice(i, j), quoted: false, negated });
    i = j;
  }
  return out;
}

/** Parses a search box string. Total: any input gives a result, problems become warnings. */
export function parseQuery(input: string): ParsedQuery {
  const warnings: string[] = [];
  const raw = typeof input === "string" ? input : "";
  let text = raw.normalize("NFC");
  if (text.length > MAX_QUERY_LENGTH) {
    text = text.slice(0, MAX_QUERY_LENGTH);
    warnings.push(`The query was cut to ${MAX_QUERY_LENGTH} characters.`);
  }
  const res: ParsedQuery = {
    raw, ast: [], terms: [], phrases: [], excludedTerms: [],
    filters: { site: [], notSite: [], type: [], notType: [] }, warnings,
  };
  let count = 0;
  for (const tok of scan(text, warnings)) {
    if (count >= MAX_TERMS) { warnings.push(`Only the first ${MAX_TERMS} words are used.`); break; }
    if (tok.quoted) {
      const tokens = tokenize(tok.text);
      if (!tokens.length) { warnings.push(`Ignored an empty or punctuation-only phrase.`); continue; }
      res.ast.push({ type: "phrase", value: tok.text, tokens, negated: tok.negated });
      (tok.negated ? res.excludedTerms : res.phrases).push(tokens);
      count++;
      continue;
    }
    const op = OPERATOR.exec(tok.text);
    if (op) {
      const name = op[1]!.toLowerCase() as OperatorName;
      let value = op[2]!.trim();
      if (value.startsWith('"')) value = value.replace(/^"/, "").replace(/"$/, "");
      if (!value) { warnings.push(`Ignored "${name}:" because it has no value.`); continue; }
      if (name === "site") {
        const host = cleanHost(value);
        if (!host) { warnings.push(`Ignored "site:${value}" because it is not a site name such as site:example.org.`); continue; }
        (tok.negated ? res.filters.notSite : res.filters.site).push(host);
        res.ast.push({ type: "operator", name, value: host, negated: tok.negated });
      } else if (name === "type") {
        const types = normaliseTypes([value]);
        if (!types.length) { warnings.push(`Ignored "type:${value}" because the types are html, pdf, image and text.`); continue; }
        (tok.negated ? res.filters.notType : res.filters.type).push(...types);
        res.ast.push({ type: "operator", name, value: value.toLowerCase(), negated: tok.negated });
      } else {
        const t = parseDateStart(value);
        if (t === null) { warnings.push(`Ignored "${name}:${value}" because it needs a date such as ${name}:2026-01-01.`); continue; }
        if (tok.negated) { warnings.push(`A minus before "${name}:" is not supported and was ignored.`); }
        if (name === "before") res.filters.before = res.filters.before === undefined ? t : Math.min(res.filters.before, t);
        else res.filters.after = res.filters.after === undefined ? t : Math.max(res.filters.after, t);
        res.ast.push({ type: "operator", name, value, negated: false });
      }
      count++;
      continue;
    }
    let word = tok.text;
    let prefix = false;
    if (/\*$/.test(word)) { prefix = true; word = word.replace(/\*+$/, ""); }
    const tokens = tokenize(word);
    if (!tokens.length) { if (word.trim()) warnings.push(`Ignored "${word.trim().slice(0, 30)}" because it has no letters or digits.`); continue; }
    count++;
    if (tok.negated) {
      res.ast.push({ type: "term", value: word, tokens, negated: true, prefix: false });
      res.excludedTerms.push(tokens);
      continue;
    }
    res.ast.push({ type: "term", value: word, tokens, negated: false, prefix });
    res.terms.push({ text: tokens.join(" "), tokens, prefix: prefix && tokens.length === 1 });
  }
  if (res.filters.before !== undefined && res.filters.after !== undefined && res.filters.after >= res.filters.before) {
    warnings.push("The after: date is not earlier than the before: date, so nothing can match.");
  }
  return res;
}

export function hasPositive(q: ParsedQuery): boolean {
  return q.terms.length > 0 || q.phrases.length > 0;
}
export function hasAnyCriteria(q: ParsedQuery): boolean {
  return hasPositive(q) || q.excludedTerms.length > 0 || q.filters.site.length > 0 || q.filters.type.length > 0 || q.filters.notSite.length > 0 ||
    q.filters.notType.length > 0 || q.filters.before !== undefined || q.filters.after !== undefined;
}

/** The `parsed` block of the API response. */
export function parsedForApi(q: ParsedQuery): { terms: string[]; phrases: string[]; excluded: string[]; operators: Record<string, string>; warnings: string[] } {
  const operators: Record<string, string> = {};
  for (const n of q.ast) {
    if (n.type !== "operator") continue;
    const key = n.negated ? `-${n.name}` : n.name;
    operators[key] = operators[key] ? `${operators[key]},${n.value}` : n.value;
  }
  return {
    terms: q.terms.map((t) => t.text),
    phrases: q.phrases.map((p) => p.join(" ")),
    excluded: q.excludedTerms.map((p) => p.join(" ")),
    operators,
    warnings: q.warnings,
  };
}
