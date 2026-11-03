import { isMainNamespace, normaliseTitle } from "./url.js";

/**
 * Reading Parsoid HTML, the format the core REST `page/{title}/html` route returns (docs/research/zim-wikipedia.md section 5). Parsoid's
 * markup is regular (one `<a>` tag per link, `rel="mw:WikiLink"` on links to other articles, a `<section>` per top-level section), so
 * plain scanning is enough and no HTML parser is needed on this path.
 */

export interface WikiLink {
  /** Title as Wikipedia keys it (underscores, first letter upper case), without a fragment. */
  title: string;
  /** The link appears in the lead section (before the first heading). */
  lead: boolean;
  /** How many times the page links to it. */
  count: number;
  /** Position of the first appearance, 0-based. */
  position: number;
  text: string;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[1] ?? m[2]) : undefined;
}

const decodeEntities = (s: string): string => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Links to other articles in a page: `<a rel="mw:WikiLink" href="./Title">`, namespace 0 only (no `File:`, `Category:`, `Template:`, `Special:`,
 * `Help:`, `Wikipedia:`), fragments removed, repeats merged. Red links (pages that do not exist) and links with a query are left out.
 * External links (`rel="mw:ExtLink"`) are never returned. Order is the order of first appearance.
 */
export function extractWikiLinks(html: string): WikiLink[] {
  const found = new Map<string, WikiLink>();
  const tokens = /<section\b[^>]*>|<h[1-6]\b|<a\b[^>]*>/gi;
  let inLead = false;
  let sawSection = false;
  let sawHeading = false;
  let m: RegExpExecArray | null;
  while ((m = tokens.exec(html))) {
    const tag = m[0]!;
    const lower = tag.toLowerCase();
    if (lower.startsWith("<section")) {
      const id = attr(tag, "data-mw-section-id");
      if (id !== undefined) {
        sawSection = true;
        inLead = id === "0";
      }
      continue;
    }
    if (lower.startsWith("<h")) {
      sawHeading = true;
      // Without section wrappers the lead is everything before the first heading.
      if (!sawSection) inLead = false;
      continue;
    }
    if (!/\brel\s*=\s*["'][^"']*\bmw:WikiLink\b/i.test(tag)) continue;
    const hrefRaw = attr(tag, "href");
    if (!hrefRaw) continue;
    let href = decodeEntities(hrefRaw);
    if (/\bclass\s*=\s*["'][^"']*\bnew\b/i.test(tag)) continue; // a page that does not exist
    if (!href.startsWith("./")) continue;
    href = href.slice(2);
    if (href.includes("?")) continue; // `?action=edit&redlink=1`
    const title = normaliseTitle(safeDecode(href));
    if (!title || !isMainNamespace(title)) continue;
    const lead = sawSection ? inLead : !sawHeading;
    const end = html.indexOf("</a>", tokens.lastIndex);
    const text = end >= 0 ? decodeEntities(html.slice(tokens.lastIndex, Math.min(end, tokens.lastIndex + 400)).replace(/<[^>]*>/g, "")).trim().slice(0, 100) : "";
    const cur = found.get(title);
    if (cur) {
      cur.count++;
      cur.lead ||= lead;
    } else found.set(title, { title, lead, count: 1, position: found.size, text });
  }
  return [...found.values()];
}

export interface ParsoidMeta {
  revisionId?: string;
  pageId?: string;
  modified?: string;
  namespace?: string;
}

/** Revision and page facts that Parsoid writes into the document head. */
export function parsoidMeta(html: string): ParsoidMeta {
  const head = html.slice(0, 6000);
  const rev = /\babout\s*=\s*["'][^"']*\/Special:Redirect\/revision\/(\d+)["']/i.exec(head)?.[1];
  const prop = (name: string) => new RegExp(`<meta\\b[^>]*\\bproperty\\s*=\\s*["']${name}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["']`, "i").exec(head)?.[1];
  return { revisionId: rev, pageId: prop("mw:pageId"), modified: prop("dc:modified"), namespace: prop("mw:pageNamespace") };
}

/** The revision id in a REST `ETag` such as `W/"1234567/9f1c..."`. */
export function revisionFromEtag(etag: string | undefined): string | undefined {
  if (!etag) return undefined;
  return /^(?:W\/)?"?(\d{1,15})\//.exec(etag.trim())?.[1];
}

// ---- image files ------------------------------------------------------------------------------------------------------------------

export interface WikiImage {
  /** `File:Name.png` with underscores, as the Action API wants it. */
  file: string;
  /** The `src` of the `<img>`, as written (often protocol-relative). */
  src: string;
}

/**
 * The images a page shows and the file page each one comes from: `<img resource="./File:Name.png" src="//upload...">`. Math and other
 * generated images have no `resource` and no file page, so they are not listed.
 */
export function extractWikiImages(html: string): WikiImage[] {
  const out = new Map<string, WikiImage>();
  const re = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0]!;
    const resource = attr(tag, "resource");
    const src = attr(tag, "src");
    if (!resource || !src || !resource.startsWith("./File:")) continue;
    const file = `File:${normaliseFileName(safeDecode(decodeEntities(resource.slice(7))))}`;
    if (!out.has(file + "|" + src)) out.set(file + "|" + src, { file, src: decodeEntities(src) });
  }
  return [...out.values()];
}

/** File names keep their case after the first letter; spaces and underscores are the same. */
function normaliseFileName(n: string): string {
  const t = n.replace(/[ _]+/g, "_").replace(/^_+|_+$/g, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

export interface ImageAttribution {
  author: string | null;
  licenseName: string | null;
  licenseUrl: string | null;
  sourcePageUrl: string | null;
  nonFree: boolean;
  description: string | null;
  attributionRequired: boolean | null;
}

type Meta = Record<string, { value?: unknown } | undefined>;
const metaText = (m: Meta, k: string): string | null => {
  const v = m[k]?.value;
  if (v === undefined || v === null) return null;
  const t = stripTags(String(v));
  return t || null;
};

/** The licence facts of one `imageinfo` entry (`extmetadata`), with the HTML in author and description reduced to text. */
export function attributionFromImageInfo(info: { extmetadata?: Meta; descriptionurl?: string } | undefined, origin: string): ImageAttribution {
  const m: Meta = info?.extmetadata ?? {};
  let licenseUrl = metaText(m, "LicenseUrl");
  if (licenseUrl?.startsWith("//")) licenseUrl = `https:${licenseUrl}`;
  let source = info?.descriptionurl ?? null;
  if (source?.startsWith("//")) source = `${origin.startsWith("http:") ? "http:" : "https:"}${source}`;
  const nonFree = String(m.NonFree?.value ?? "").toLowerCase() === "true";
  const attr = metaText(m, "AttributionRequired");
  return {
    author: metaText(m, "Artist") ?? metaText(m, "Credit"),
    licenseName: metaText(m, "LicenseShortName") ?? metaText(m, "UsageTerms"),
    licenseUrl, sourcePageUrl: source, nonFree,
    description: metaText(m, "ImageDescription"),
    attributionRequired: attr === null ? null : attr.toLowerCase() === "true",
  };
}
