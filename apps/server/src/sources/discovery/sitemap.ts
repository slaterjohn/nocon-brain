import { child, childrenOf, parseXml, textOf, XmlError } from "./xml.js";

export const SITEMAP_MAX_URLS = 50_000;

export interface SitemapEntry {
  loc: string;
  lastmod?: number;
  changefreq?: string;
  priority?: number;
}

export type ParsedSitemap =
  | { kind: "urlset"; urls: SitemapEntry[]; truncated: boolean; skipped: number }
  | { kind: "index"; sitemaps: { loc: string; lastmod?: number }[]; truncated: boolean };

function date(s: string): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

/** Accepts only absolute http(s) addresses without credentials. Relative or odd values are skipped, not guessed. */
export function cleanLoc(raw: string, base?: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  try {
    const u = new URL(t, base);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return undefined;
    u.hash = "";
    return u.href;
  } catch {
    return undefined;
  }
}

/**
 * Parses a sitemap document: a `<urlset>`, a `<sitemapindex>`, or a plain-text list with one address per line.
 * At most `maxUrls` entries are returned; `truncated` says there were more. Malformed XML throws `XmlError`.
 */
export function parseSitemap(text: string, opts: { maxUrls?: number; base?: string } = {}): ParsedSitemap {
  const max = opts.maxUrls ?? SITEMAP_MAX_URLS;
  const head = text.trimStart();
  if (!head.startsWith("<")) {
    const urls: SitemapEntry[] = [];
    let skipped = 0;
    let truncated = false;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const loc = cleanLoc(line, opts.base);
      if (!loc) { skipped++; continue; }
      if (urls.length >= max) { truncated = true; break; }
      urls.push({ loc });
    }
    if (urls.length === 0) throw new XmlError("This is not a sitemap: it holds no web addresses");
    return { kind: "urlset", urls, truncated, skipped };
  }
  const root = parseXml(text);
  if (root.local === "sitemapindex") {
    const out: { loc: string; lastmod?: number }[] = [];
    let truncated = false;
    for (const s of childrenOf(root, "sitemap")) {
      const loc = cleanLoc(textOf(child(s, "loc")), opts.base);
      if (!loc) continue;
      if (out.length >= max) { truncated = true; break; }
      out.push({ loc, lastmod: date(textOf(child(s, "lastmod"))) });
    }
    return { kind: "index", sitemaps: out, truncated };
  }
  if (root.local === "urlset") {
    const urls: SitemapEntry[] = [];
    let skipped = 0;
    let truncated = false;
    for (const u of childrenOf(root, "url")) {
      const loc = cleanLoc(textOf(child(u, "loc")), opts.base);
      if (!loc) { skipped++; continue; }
      if (urls.length >= max) { truncated = true; break; }
      const pr = Number(textOf(child(u, "priority")));
      urls.push({
        loc, lastmod: date(textOf(child(u, "lastmod"))), changefreq: textOf(child(u, "changefreq")) || undefined,
        priority: Number.isFinite(pr) && textOf(child(u, "priority")) !== "" ? pr : undefined,
      });
    }
    return { kind: "urlset", urls, truncated, skipped };
  }
  throw new XmlError(`This is not a sitemap: the top element is <${root.name}>`);
}
