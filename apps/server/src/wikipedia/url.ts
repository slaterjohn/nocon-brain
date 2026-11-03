/**
 * Wikipedia addresses and titles (tasks Z-06 to Z-08). Pure functions, no I/O.
 *
 * A Wikipedia article can be reached as `https://<lang>.wikipedia.org/wiki/<Title>`, from a phone as `https://<lang>.m.wikipedia.org/wiki/<Title>`,
 * or as `.../w/index.php?title=<Title>` (also `/index.php?title=`). All of them name the same article, so they all map to one
 * `{ lang, title }`. `origin` is the optional replacement for the real site (`NCB_WIKIPEDIA_ORIGIN`): addresses on that origin are
 * read as articles of `defaultLang`.
 */

export interface WikiTarget {
  lang: string;
  /** Title as Wikipedia keys it: underscores, first letter upper case, no fragment. */
  title: string;
}

const HOST = /^([a-z]{2,12}(?:-[a-z0-9]+)*)(?:\.m)?\.wikipedia\.org$/i;
const LANG = /^[a-z]{2,12}(?:-[a-z0-9]+)*$/i;

/** Namespace prefixes of the English Wikipedia (and the canonical names MediaWiki accepts on every wiki). A link into one is not an article. */
const NAMESPACES = new Set([
  "media", "special", "talk", "user", "user talk", "wikipedia", "wikipedia talk", "project", "file", "image", "file talk", "mediawiki", "mediawiki talk",
  "template", "template talk", "help", "help talk", "category", "category talk", "portal", "portal talk", "draft", "draft talk", "timedtext",
  "timedtext talk", "module", "module talk", "wp", "wt", "wikt", "commons", "wikidata", "wikisource", "meta", "mos", "cat",
]);

export function isLanguageCode(code: string): boolean {
  return LANG.test(code) && code.length <= 12;
}

/** `Benzene`, `benzene`, `Black hole` and `Black_hole#History` become `Benzene`, `Benzene`, `Black_hole`, `Black_hole`. */
export function normaliseTitle(raw: string): string {
  let t = raw;
  const hash = t.indexOf("#");
  if (hash >= 0) t = t.slice(0, hash);
  t = t.replace(/[ _]+/g, "_").replace(/^_+|_+$/g, "");
  if (t.length === 0) return "";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The reading form of a title (`Black_hole` is shown as `Black hole`). */
export const displayTitle = (title: string): string => title.replace(/_/g, " ");

/** True for an article (namespace 0). `Star Trek: Voyager` is an article; `Category:Stars` and `File:Sun.png` are not. */
export function isMainNamespace(title: string): boolean {
  const colon = title.indexOf(":");
  if (colon <= 0) return true;
  const prefix = title.slice(0, colon).replace(/_/g, " ").trim().toLowerCase();
  return !NAMESPACES.has(prefix);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export interface WikiUrlOptions {
  /** `NCB_WIKIPEDIA_ORIGIN` (no trailing slash) or empty. */
  origin?: string;
  /** Language assumed for addresses on `origin`. Default `en`. */
  defaultLang?: string;
}

/**
 * The article an address names, or undefined when it is not a plain article address (another site, a special page, an old revision, an
 * edit form, a title in another namespace).
 */
export function parseWikipediaUrl(raw: string, o: WikiUrlOptions = {}): WikiTarget | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (u.username || u.password) return undefined;
  let lang: string | undefined;
  const m = HOST.exec(u.hostname);
  if (m && m[1]!.toLowerCase() !== "www") lang = m[1]!.toLowerCase();
  else if (o.origin && u.origin === originOf(o.origin)) lang = (o.defaultLang ?? "en").toLowerCase();
  if (!lang) return undefined;

  let title: string | undefined;
  if (u.pathname.startsWith("/wiki/")) {
    title = safeDecode(u.pathname.slice(6));
    // `/wiki/Title?action=edit` and `?oldid=` are not the current article.
    for (const k of ["action", "oldid", "diff", "veaction", "curid"]) if (u.searchParams.has(k)) return undefined;
  } else if (u.pathname === "/w/index.php" || u.pathname === "/index.php") {
    const t = u.searchParams.get("title");
    if (!t) return undefined;
    for (const k of ["action", "oldid", "diff", "veaction", "curid", "search"]) if (u.searchParams.has(k)) return undefined;
    title = t;
  }
  if (title === undefined) return undefined;
  const norm = normaliseTitle(title);
  if (!norm || norm.length > 255 || !isMainNamespace(norm)) return undefined;
  return { lang, title: norm };
}

function originOf(o: string): string {
  try {
    return new URL(o).origin;
  } catch {
    return o;
  }
}

/** The origin that serves a language: the replacement when one is set, else the real site. */
export function originFor(lang: string, o: WikiUrlOptions = {}): string {
  return o.origin ? originOf(o.origin) : `https://${lang.toLowerCase()}.wikipedia.org`;
}

/** The canonical reading address of an article (the address a page is archived under). */
export function articleUrl(t: WikiTarget, o: WikiUrlOptions = {}): string {
  return `${originFor(t.lang, o)}/wiki/${encodeTitle(t.title)}`;
}

/** The address of the article's edit history, which CC BY-SA attribution links to. */
export function historyUrl(t: WikiTarget, o: WikiUrlOptions = {}): string {
  return `${originFor(t.lang, o)}/w/index.php?title=${encodeURIComponent(t.title)}&action=history`;
}

/** Percent-encodes a title for a path, keeping the characters Wikipedia leaves readable. */
export function encodeTitle(title: string): string {
  return encodeURIComponent(title).replace(/%3A/gi, ":").replace(/%2C/gi, ",").replace(/%28/g, "(").replace(/%29/g, ")").replace(/%40/g, "@").replace(/%21/g, "!").replace(/%27/g, "'");
}

/** The key the ZIM stores an article under: the title as it is, with underscores (`Black_hole`). */
export function zimPathOf(t: WikiTarget): string {
  return t.title;
}

// ---- pages that are not worth following by default --------------------------------------------------------------------------

export type SkipKind = "disambiguation" | "list" | "year";

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const YEARISH = new RegExp(
  `^(?:\\d{1,4}(?:_BC|_BCE|_AD|_CE)?|\\d{1,4}s(?:_BC|_BCE)?|\\d{1,2}(?:st|nd|rd|th)_(?:century|millennium)(?:_BC|_BCE)?|(?:${MONTHS})_\\d{1,2}|\\d{1,4}_in_.+|(?:Deaths|Births)_in_.+|\\d{4}[-–]\\d{2,4}_.+)$`,
  "i",
);

/**
 * Whether a title is a disambiguation page (by its name), a list or index, or a year or date page. Wikipedia's own page properties are
 * more exact and the preview uses them; the crawl has no network at the point it chooses links, so it goes by the title.
 */
export function skipKindOf(title: string): SkipKind | undefined {
  const t = title.replace(/ /g, "_");
  if (/_\(disambiguation\)$/i.test(t)) return "disambiguation";
  if (/^(?:List|Lists|Index|Outline|Glossary|Timeline)_of_/i.test(t)) return "list";
  if (YEARISH.test(t)) return "year";
  return undefined;
}

export interface SkipOptions { disambiguation: boolean; lists: boolean; years: boolean }
export const DEFAULT_SKIP: SkipOptions = { disambiguation: true, lists: true, years: true };

export function skipReason(title: string, s: SkipOptions): string | null {
  const k = skipKindOf(title);
  if (k === "disambiguation" && s.disambiguation) return "wikipedia:disambiguation";
  if (k === "list" && s.lists) return "wikipedia:list";
  if (k === "year" && s.years) return "wikipedia:year";
  return null;
}
