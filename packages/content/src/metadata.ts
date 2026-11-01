import { franc } from "franc-min";
import { domList } from "./dom.js";
import { parseHTML } from "linkedom";
import { registrableDomain, resolveHttpUrl } from "./url.js";

/**
 * Page metadata (task A-07). Precedence, per docs/research/crawling-rendering.md 4.3:
 * - title: og:title > JSON-LD headline > <title> (site suffix removed) > first <h1>
 * - description: og:description > meta description > JSON-LD description
 * - published: article:published_time (og) > JSON-LD datePublished > <time> in the article > meta date > URL
 *   pattern. The fetch date is never used.
 * - language: <html lang> > Content-Language > og:locale > franc-min on the body text (>= 50 characters)
 */

export type DateSource = "og" | "jsonld" | "time_element" | "meta" | "url" | "none";
export type Confidence = "high" | "medium" | "low";
export type LanguageSource = "html_lang" | "content_language" | "og_locale" | "franc" | "none";

export interface DateInfo {
  /** Unix milliseconds, UTC. */
  at: number;
  source: Exclude<DateSource, "none">;
  confidence: Confidence;
}

export interface PageMetadata {
  title: string | null;
  titleSource: "og" | "jsonld" | "title" | "h1" | "none";
  description: string | null;
  language: string | null;
  languageSource: LanguageSource;
  author: string | null;
  siteName: string | null;
  image: string | null;
  type: string | null;
  canonicalUrl: string | null;
  published: DateInfo | null;
  modified: DateInfo | null;
  keywords: string[];
  jsonLd: { blocks: number; invalid: number; oversize: number; types: string[] };
}

export interface MetadataOptions {
  url: string;
  headers?: Record<string, string>;
  /** Largest single JSON-LD block that is parsed. Default 256 KiB. */
  maxJsonLdBytes?: number;
  /** Total JSON-LD characters parsed per page. Default 1 MiB. */
  maxJsonLdTotalBytes?: number;
}

const clean = (s: string | null | undefined, max = 1000): string | null => {
  if (!s) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

// ---- dates ----------------------------------------------------------------------------------------

/** Parses an ISO-8601-ish string to UTC milliseconds. A string without an offset is read as UTC. */
export function parseDate(v: unknown): number | null {
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s || s.length > 64) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += "T00:00:00Z";
  else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(" ", "T") + "Z";
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  const year = new Date(t).getUTCFullYear();
  return year < 1990 || year > 2200 ? null : t;
}

function dateFromUrl(url: string): number | null {
  const m = /\/((?:19|20)\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])(?:\/|$)/.exec(new URL(url).pathname);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

// ---- JSON-LD --------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function parseJsonLoose(text: string): unknown {
  const attempts = [
    text,
    text.replace(/^\s*(?:<!--|\/\/\s*<!\[CDATA\[|<!\[CDATA\[)/, "").replace(/(?:-->|\/\/\s*\]\]>|\]\]>)\s*$/, ""),
  ];
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      /* try the next repair */
    }
  }
  // Common authoring faults: trailing commas and raw control characters inside strings.
  try {
    return JSON.parse(attempts[1]!.replace(/,\s*([}\]])/g, "$1").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " "));
  } catch {
    return undefined;
  }
}

function typesOf(o: Obj): string[] {
  const t = o["@type"];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string");
}

/** Flattens arrays and `@graph` into one list of typed objects, resolving `@id` references one level deep. */
export function flattenJsonLd(root: unknown): Obj[] {
  const out: Obj[] = [];
  const byId = new Map<string, Obj>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 8) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (!isObj(v)) return;
    if (Array.isArray(v["@graph"])) walk(v["@graph"], depth + 1);
    if (v["@type"] !== undefined) {
      out.push(v);
      if (typeof v["@id"] === "string") byId.set(v["@id"], v);
    }
  };
  walk(root, 0);
  const deref = (v: unknown): unknown => (isObj(v) && typeof v["@id"] === "string" && Object.keys(v).length === 1 ? byId.get(v["@id"]) ?? v : v);
  return out.map((o) => {
    const copy: Obj = { ...o };
    for (const k of ["author", "publisher", "creator", "isPartOf"]) {
      const val = copy[k];
      copy[k] = Array.isArray(val) ? val.map(deref) : deref(val);
    }
    return copy;
  });
}

const ARTICLE_RANK = ["NewsArticle", "Article", "BlogPosting", "TechArticle", "ScholarlyArticle", "Report", "Review", "Recipe", "WebPage", "ItemPage", "CollectionPage", "WebSite"];

function pickMain(nodes: Obj[]): Obj | undefined {
  let best: Obj | undefined;
  let bestRank = Infinity;
  for (const n of nodes) {
    for (const t of typesOf(n)) {
      const r = ARTICLE_RANK.indexOf(t);
      if (r >= 0 && r < bestRank) {
        best = n;
        bestRank = r;
      }
    }
  }
  return best;
}

function nameOf(v: unknown): string | null {
  if (typeof v === "string") return clean(v, 200);
  if (Array.isArray(v)) {
    const names = v.map(nameOf).filter((x): x is string => !!x);
    return names.length ? names.slice(0, 5).join(", ") : null;
  }
  if (isObj(v)) return nameOf(v.name);
  return null;
}

function strOf(v: unknown): string | null {
  if (typeof v === "string") return clean(v);
  if (Array.isArray(v)) return strOf(v[0]);
  if (isObj(v)) return strOf(v.url ?? v["@id"] ?? v.name);
  return null;
}

// ---- main -----------------------------------------------------------------------------------------

const LANG_MAP: Record<string, string> = {
  eng: "en", fra: "fr", deu: "de", spa: "es", ita: "it", por: "pt", nld: "nl", rus: "ru", cmn: "zh", jpn: "ja", kor: "ko",
  arb: "ar", hin: "hi", swe: "sv", dan: "da", nob: "nb", fin: "fi", pol: "pl", tur: "tr", ces: "cs", ell: "el", heb: "he",
  hun: "hu", ind: "id", ron: "ro", ukr: "uk", vie: "vi", tha: "th", bul: "bg", cat: "ca", hrv: "hr", slk: "sk", srp: "sr",
};

function normaliseLang(v: string | null | undefined): string | null {
  const t = (v ?? "").trim().replace(/_/g, "-");
  if (!t || /^(und|x-default|mul|zxx)$/i.test(t) || !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(t)) return null;
  const [primary, ...rest] = t.split("-");
  return [primary!.toLowerCase(), ...rest.map((r) => (r.length === 2 ? r.toUpperCase() : r.length === 4 ? r[0]!.toUpperCase() + r.slice(1).toLowerCase() : r))].join("-");
}

export function detectLanguage(text: string): string | null {
  const sample = text.replace(/\s+/g, " ").trim().slice(0, 2000);
  if (sample.length < 50) return null;
  const code = franc(sample, { minLength: 50 });
  if (code === "und") return null;
  return LANG_MAP[code] ?? code;
}

function stripSiteSuffix(title: string, siteName: string | null, host: string): string {
  const parts = title.split(/\s+(?:[|–—·:\-])\s+/);
  if (parts.length < 2) return title;
  const brand = (siteName ?? registrableDomain(host).split(".")[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!brand) return title;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const last = parts[parts.length - 1]!;
  const first = parts[0]!;
  if (norm(last) === brand || (norm(last).length >= 3 && brand.includes(norm(last)))) return title.slice(0, title.length - last.length).replace(/\s+[|–—·:\-]\s+$/, "") || title;
  if (norm(first) === brand && parts.length === 2) return parts[1]!;
  return title;
}

export function extractMetadata(html: string, opts: MetadataOptions): PageMetadata {
  const { document } = parseHTML(html);
  const url = opts.url;
  const meta = (key: string): string | null => {
    const sel = `meta[property="${key}" i], meta[name="${key}" i], meta[itemprop="${key}" i]`;
    for (const el of domList(document.querySelectorAll(sel))) {
      const c = clean(el.getAttribute("content"));
      if (c) return c;
    }
    return null;
  };

  // JSON-LD ---------------------------------------------------------------------------------------
  const maxBlock = opts.maxJsonLdBytes ?? 256 * 1024;
  let budget = opts.maxJsonLdTotalBytes ?? 1024 * 1024;
  let invalid = 0;
  let oversize = 0;
  let blocks = 0;
  const nodes: Obj[] = [];
  for (const s of domList(document.querySelectorAll('script[type="application/ld+json" i], script[type^="application/ld+json" i]'))) {
    const text = s.textContent ?? "";
    blocks++;
    if (text.length > maxBlock || text.length > budget) {
      oversize++;
      continue;
    }
    budget -= text.length;
    const parsed = parseJsonLoose(text.trim());
    if (parsed === undefined) invalid++;
    else nodes.push(...flattenJsonLd(parsed));
  }
  const ld = pickMain(nodes);
  const ldWebsite = nodes.find((n) => typesOf(n).includes("WebSite") || typesOf(n).includes("Organization"));

  // site name -------------------------------------------------------------------------------------
  const host = new URL(url).hostname;
  const siteName =
    meta("og:site_name") ?? nameOf(ld?.publisher) ?? (ldWebsite ? nameOf(ldWebsite.name) : null) ?? meta("application-name") ?? null;

  // title -----------------------------------------------------------------------------------------
  let rawTitle = clean(document.querySelector("title")?.textContent, 500);
  if (!rawTitle) {
    // linkedom sometimes returns an empty title; read the source text directly.
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(0, 200_000));
    rawTitle = m ? clean(m[1]!.replace(/<[^>]+>/g, ""), 500) : null;
  }
  let title: string | null = null;
  let titleSource: PageMetadata["titleSource"] = "none";
  const ogTitle = meta("og:title");
  const ldTitle = clean(typeof ld?.headline === "string" ? ld.headline : typeof ld?.name === "string" ? ld.name : null, 500);
  if (ogTitle) [title, titleSource] = [ogTitle, "og"];
  else if (ldTitle) [title, titleSource] = [ldTitle, "jsonld"];
  else if (rawTitle) [title, titleSource] = [stripSiteSuffix(rawTitle, siteName, host), "title"];
  else {
    const h1 = clean(document.querySelector("h1")?.textContent, 500);
    if (h1) [title, titleSource] = [h1, "h1"];
  }

  const description = meta("og:description") ?? meta("description") ?? clean(typeof ld?.description === "string" ? ld.description : null, 1000);

  // author ----------------------------------------------------------------------------------------
  const articleAuthor = meta("article:author");
  const author =
    meta("author") ??
    (articleAuthor && !/^https?:\/\//i.test(articleAuthor) ? articleAuthor : null) ??
    nameOf(ld?.author) ??
    clean(document.querySelector('[rel~="author"], [itemprop="author"]')?.textContent, 200);

  // dates -----------------------------------------------------------------------------------------
  let published: DateInfo | null = null;
  const tryPub = (v: unknown, source: DateInfo["source"], confidence: Confidence) => {
    if (published) return;
    const at = parseDate(v);
    if (at !== null) published = { at, source, confidence };
  };
  tryPub(meta("article:published_time") ?? meta("og:published_time"), "og", "high");
  tryPub(ld?.datePublished, "jsonld", "high");
  if (!published) {
    const scope = document.querySelector("article, main, [role=main]") ?? document.body;
    const t = scope?.querySelector("time[itemprop=datePublished][datetime], time.published[datetime], time.entry-date[datetime], time[pubdate][datetime], time[datetime]");
    tryPub(t?.getAttribute("datetime"), "time_element", "medium");
  }
  tryPub(meta("date") ?? meta("DC.date") ?? meta("DC.date.issued") ?? meta("pubdate") ?? meta("datePublished"), "meta", "medium");
  if (!published) {
    const u = dateFromUrl(url);
    if (u !== null) published = { at: u, source: "url", confidence: "low" };
  }
  let modified: DateInfo | null = null;
  const m1 = parseDate(meta("article:modified_time") ?? meta("og:updated_time"));
  const m2 = parseDate(ld?.dateModified);
  if (m1 !== null) modified = { at: m1, source: "og", confidence: "high" };
  else if (m2 !== null) modified = { at: m2, source: "jsonld", confidence: "high" };
  else {
    const m3 = parseDate(meta("last-modified") ?? meta("dateModified"));
    if (m3 !== null) modified = { at: m3, source: "meta", confidence: "medium" };
  }

  // language --------------------------------------------------------------------------------------
  let language = normaliseLang(document.documentElement?.getAttribute("lang") ?? document.documentElement?.getAttribute("xml:lang"));
  let languageSource: LanguageSource = language ? "html_lang" : "none";
  if (!language) {
    language = normaliseLang((opts.headers?.["content-language"] ?? "").split(",")[0]);
    if (language) languageSource = "content_language";
  }
  if (!language) {
    language = normaliseLang(meta("og:locale"));
    if (language) languageSource = "og_locale";
  }
  if (!language) {
    const scope = document.querySelector("article, main, [role=main]") ?? document.body;
    for (const el of domList(scope?.querySelectorAll("script, style, noscript, nav, header, footer") ?? [])) el.remove();
    language = detectLanguage(scope?.textContent ?? "");
    if (language) languageSource = "franc";
  }

  // misc ------------------------------------------------------------------------------------------
  const canonicalHref = document.querySelector('link[rel~="canonical" i]')?.getAttribute("href");
  const imageRaw = meta("og:image") ?? strOf(ld?.image);
  const keywordSource = meta("keywords") ?? (Array.isArray(ld?.keywords) ? (ld.keywords as unknown[]).join(",") : typeof ld?.keywords === "string" ? ld.keywords : null);
  const keywords = (keywordSource ?? "").split(",").map((k) => k.trim()).filter(Boolean).slice(0, 30);

  return {
    title,
    titleSource,
    description,
    language,
    languageSource,
    author: clean(author, 200),
    siteName: clean(siteName, 200),
    image: imageRaw ? resolveHttpUrl(imageRaw, url) : null,
    type: meta("og:type") ?? (ld ? typesOf(ld)[0] ?? null : null),
    canonicalUrl: canonicalHref ? resolveHttpUrl(canonicalHref, url) : null,
    published,
    modified,
    keywords,
    jsonLd: { blocks, invalid, oversize, types: [...new Set(nodes.flatMap(typesOf))].slice(0, 20) },
  };
}
