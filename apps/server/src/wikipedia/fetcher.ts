import { FetchError } from "@ncb/fetch";
import type { PipelineFetcher, PipelineFetchOptions, PipelineFetchResult } from "../pipeline/types.js";
import { WikipediaError, type WikipediaClient } from "./client.js";
import { parseWikipediaUrl } from "./url.js";

const WIKI_HOSTS = /(^|\.)(wikipedia|wikimedia)\.org$/i;

/** True for a file or script on a Wikimedia host (an image on `upload.wikimedia.org`, a stylesheet on a wiki). */
export function isWikimediaAsset(url: string, replacementOrigin?: string): boolean {
  try {
    const u = new URL(url);
    if (replacementOrigin && u.origin === new URL(replacementOrigin).origin) return true;
    return u.protocol === "https:" && WIKI_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

function asFetchError(e: unknown, url: string): unknown {
  if (!(e instanceof WikipediaError)) return e;
  switch (e.reason) {
    case "rate_limited":
    case "maxlag":
    case "circuit_open":
      return new FetchError("rate_limited", e.message, { url, retryAfterMs: e.retryAfterMs, status: 429 });
    case "no_contact":
      return new FetchError("invalid_url", e.message, { url });
    case "blocked_host":
      return new FetchError("ssrf_blocked", e.message, { url });
    case "too_large":
      return new FetchError("size_cap", e.message, { url });
    default:
      return new FetchError("network", e.message, { url });
  }
}

/**
 * Sends Wikipedia traffic of the capture pipeline through the `WikipediaClient` (tasks Z-07, Z-08). An article address is fetched with the
 * core REST `page/{title}/html` route instead of by scraping the reading page; images, stylesheets and other files on Wikimedia hosts use the
 * same limiter and User-Agent. Everything else goes to the ordinary guarded fetcher. The page is stored under its reading address
 * (`https://en.wikipedia.org/wiki/Title`), so browsing, bookmarks and the Wikipedia-to-package mapping all see one address.
 */
export class WikipediaRoutedFetcher implements PipelineFetcher {
  constructor(private readonly inner: PipelineFetcher, private readonly client: WikipediaClient, private readonly replacementOrigin?: () => string | undefined) {}

  async fetch(url: string, opts: PipelineFetchOptions = {}): Promise<PipelineFetchResult> {
    const target = parseWikipediaUrl(url, this.client.urlOptions);
    if (target) return this.page(url, target.lang, target.title, opts);
    // Files on Wikimedia hosts: through the client when it may run, otherwise as for any other site.
    if (this.client.hasContact && isWikimediaAsset(url, this.replacementOrigin?.())) return this.media(url, opts);
    return this.inner.fetch(url, opts);
  }

  private async page(url: string, lang: string, title: string, opts: PipelineFetchOptions): Promise<PipelineFetchResult> {
    try {
      const r = await this.client.pageHtml(lang, title, { etag: opts.conditional?.etag ?? undefined, signal: opts.signal, maxBytes: opts.maxBytes });
      if (r.kind === "not_modified") {
        return { status: 304, finalUrl: url, headers: r.etag ? { etag: r.etag } : {}, body: Buffer.alloc(0), contentType: null, notModified: true };
      }
      if (r.kind === "missing") {
        return { status: 404, finalUrl: url, headers: {}, body: Buffer.alloc(0), contentType: "text/html", notModified: false };
      }
      const headers: Record<string, string> = {
        "content-type": "text/html; charset=utf-8", "x-ncb-source": "wikipedia",
        ...(r.etag ? { etag: r.etag } : {}), ...(r.lastModified ? { "last-modified": r.lastModified } : {}),
        ...(r.revisionId ? { "x-revision-id": r.revisionId } : {}), ...(r.contentLanguage ? { "content-language": r.contentLanguage } : {}),
      };
      return {
        status: 200, finalUrl: r.articleUrl, headers, body: r.body, contentType: "text/html; charset=utf-8", notModified: false,
        redirects: r.redirectedFrom ? [{ url, status: 307, location: r.articleUrl }] : [],
      };
    } catch (e) {
      throw asFetchError(e, url);
    }
  }

  private async media(url: string, opts: PipelineFetchOptions): Promise<PipelineFetchResult> {
    try {
      const r = await this.client.media(url, {
        signal: opts.signal, maxBytes: opts.maxBytes, headers: { accept: (opts.accept ?? ["*/*"]).join(", ") },
      });
      const ct = r.headers["content-type"] ?? null;
      return { status: r.status, finalUrl: r.url, headers: r.headers, body: r.body, contentType: ct, notModified: r.status === 304, redirects: r.redirects.map((u) => ({ url, status: 302, location: u })) };
    } catch (e) {
      throw asFetchError(e, url);
    }
  }
}
