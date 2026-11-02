import { child, childrenOf, parseXml, textOf, XmlError, type XmlElement } from "./xml.js";
import { cleanLoc } from "./sitemap.js";

export const FEED_MAX_ITEMS = 5_000;

export interface FeedItem {
  /** Absolute address of the item. */
  url: string;
  /** The feed's own identifier (guid or Atom id), when it has one. */
  id?: string;
  title?: string;
  /** Unix ms. `published` is the first publication, `updated` the latest change. */
  published?: number;
  updated?: number;
  author?: string;
  summary?: string;
}

export interface ParsedFeed {
  format: "rss2" | "rss1" | "atom";
  title?: string;
  items: FeedItem[];
  /** Entries dropped because the same item appeared twice (same id or same address). */
  duplicates: number;
  /** Entries with no usable web address. */
  skipped: number;
  truncated: boolean;
}

function date(s: string): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

const clip = (s: string, n = 500): string | undefined => (s ? s.replace(/\s+/g, " ").trim().slice(0, n) || undefined : undefined);

function atomLink(entry: XmlElement, base?: string): string | undefined {
  const links = childrenOf(entry, "link");
  const alt = links.find((l) => !l.attrs.rel || l.attrs.rel === "alternate") ?? links.find((l) => l.attrs.rel !== "self" && l.attrs.rel !== "enclosure" && l.attrs.rel !== "edit");
  return alt?.attrs.href ? cleanLoc(alt.attrs.href, base) : undefined;
}

/**
 * Parses RSS 2.0, RSS 1.0 (RDF) and Atom into one shape. Items are de-duplicated by identifier and by address (fragment
 * ignored, a trailing slash ignored), keeping the first and taking the newest dates seen. Throws `XmlError` for anything else.
 */
export function parseFeed(text: string, opts: { base?: string; maxItems?: number } = {}): ParsedFeed {
  const max = opts.maxItems ?? FEED_MAX_ITEMS;
  const root = parseXml(text);
  let format: ParsedFeed["format"];
  let title: string | undefined;
  let raw: FeedItem[] = [];
  let skipped = 0;

  if (root.local === "rss") {
    format = "rss2";
    const channel = child(root, "channel");
    if (!channel) throw new XmlError("This RSS feed has no channel");
    title = clip(textOf(child(channel, "title")), 200);
    const base = cleanLoc(textOf(child(channel, "link")), opts.base) ?? opts.base;
    for (const it of childrenOf(channel, "item")) {
      const guid = child(it, "guid");
      const guidIsUrl = guid && (guid.attrs.isPermaLink ?? "true").toLowerCase() !== "false";
      const url = cleanLoc(textOf(child(it, "link")), base) ?? (guidIsUrl ? cleanLoc(textOf(guid), base) : undefined);
      if (!url) { skipped++; continue; }
      raw.push({
        url, id: textOf(guid) || undefined, title: clip(textOf(child(it, "title")), 300),
        published: date(textOf(child(it, "pubdate"))) ?? date(textOf(child(it, "date"))),
        updated: date(textOf(child(it, "updated"))),
        author: clip(textOf(child(it, "creator")) || textOf(child(it, "author")), 200),
        summary: clip(textOf(child(it, "description"))),
      });
    }
  } else if (root.local === "rdf") {
    format = "rss1";
    const channel = child(root, "channel");
    title = clip(textOf(child(channel ?? root, "title")), 200);
    for (const it of childrenOf(root, "item")) {
      const url = cleanLoc(textOf(child(it, "link")) || (it.attrs["rdf:about"] ?? it.attrs.about ?? ""), opts.base);
      if (!url) { skipped++; continue; }
      raw.push({
        url, id: it.attrs["rdf:about"] ?? it.attrs.about, title: clip(textOf(child(it, "title")), 300),
        published: date(textOf(child(it, "date"))), author: clip(textOf(child(it, "creator")), 200), summary: clip(textOf(child(it, "description"))),
      });
    }
  } else if (root.local === "feed") {
    format = "atom";
    title = clip(textOf(child(root, "title")), 200);
    const base = root.attrs["xml:base"] ?? opts.base;
    for (const e of childrenOf(root, "entry")) {
      const url = atomLink(e, base);
      if (!url) { skipped++; continue; }
      const authorEl = child(e, "author");
      const author = authorEl ? child(authorEl, "name") ?? authorEl : undefined;
      raw.push({
        url, id: textOf(child(e, "id")) || undefined, title: clip(textOf(child(e, "title")), 300),
        published: date(textOf(child(e, "published"))), updated: date(textOf(child(e, "updated"))),
        author: clip(textOf(author), 200), summary: clip(textOf(child(e, "summary")) || textOf(child(e, "content"))),
      });
    }
  } else {
    throw new XmlError(`This is not a feed: the top element is <${root.name}>`);
  }

  const byId = new Map<string, FeedItem>();
  const byUrl = new Map<string, FeedItem>();
  const items: FeedItem[] = [];
  let duplicates = 0;
  let truncated = false;
  for (const it of raw) {
    const urlKey = it.url.replace(/\/$/, "");
    const prior = (it.id ? byId.get(it.id) : undefined) ?? byUrl.get(urlKey);
    if (prior) {
      duplicates++;
      prior.published = Math.min(prior.published ?? Infinity, it.published ?? Infinity);
      if (prior.published === Infinity) prior.published = undefined;
      prior.updated = Math.max(prior.updated ?? -Infinity, it.updated ?? -Infinity);
      if (prior.updated === -Infinity) prior.updated = undefined;
      continue;
    }
    if (items.length >= max) { truncated = true; break; }
    items.push(it);
    if (it.id) byId.set(it.id, it);
    byUrl.set(urlKey, it);
  }
  raw = [];
  return { format, title, items, duplicates, skipped, truncated };
}
