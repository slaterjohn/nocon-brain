import { gunzipSync } from "node:zlib";
import type { Readable } from "node:stream";
import { AppError } from "@ncb/shared";
import { parseFeed, type ParsedFeed } from "./feed.js";
import { parseSitemap, SITEMAP_MAX_URLS, type SitemapEntry } from "./sitemap.js";
import { XmlError } from "./xml.js";

export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;
export const SITEMAP_MAX_FILES = 50;

/** The part of the guarded fetcher this module needs. The real one blocks private addresses and counts connectivity. */
export interface DiscoveryFetcher {
  fetch(
    url: string,
    opts: { maxBytes: number; accept: readonly string[]; signal?: AbortSignal },
  ): Promise<{ status: number; body: Buffer | Readable; finalUrl?: string }>;
}

const XML_TYPES = ["application/xml", "text/xml", "application/gzip", "application/x-gzip", "application/octet-stream", "text/plain", "application/rss+xml", "application/atom+xml", "application/rdf+xml", "text/*", "application/*"];

async function bodyOf(b: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(b)) return b;
  const parts: Buffer[] = [];
  for await (const c of b) parts.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(parts);
}

/** Fetches one document through the guard, undoes gzip (by magic bytes, whatever the type says) and decodes it as text. */
export async function fetchText(fetcher: DiscoveryFetcher, url: string, maxBytes: number, signal?: AbortSignal): Promise<{ text: string; finalUrl: string }> {
  let res;
  try {
    res = await fetcher.fetch(url, { maxBytes, accept: XML_TYPES, signal });
  } catch (e) {
    if (e instanceof AppError) throw e;
    const code = (e as { code?: string }).code;
    if (code === "ssrf_blocked") throw new AppError("blocked", "That address is not allowed because it points at a private or local network.", { url });
    if (code === "size_cap" || code === "content_length_exceeded") throw new AppError("bad_request", `That file is larger than the ${Math.round(maxBytes / 1048576)} MB limit.`, { url });
    if (code === "offline") throw new AppError("offline", "There is no internet connection, so the address cannot be read now.");
    throw new AppError("provider_error", `The address could not be read: ${(e as Error).message}`, { url });
  }
  if (res.status < 200 || res.status > 299) throw new AppError("provider_error", `The server answered ${res.status} for ${url}.`, { url, status: res.status });
  let buf = await bodyOf(res.body);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = gunzipSync(buf, { maxOutputLength: maxBytes });
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new AppError("bad_request", `That file is larger than the ${Math.round(maxBytes / 1048576)} MB limit once unpacked.`, { url });
      throw new AppError("bad_request", "That file looks compressed but could not be unpacked.", { url });
    }
  }
  if (buf.length > maxBytes) throw new AppError("bad_request", `That file is larger than the ${Math.round(maxBytes / 1048576)} MB limit.`, { url });
  return { text: buf.toString("utf8"), finalUrl: res.finalUrl ?? url };
}

export interface SitemapResult {
  urls: SitemapEntry[];
  filesFetched: number;
  truncated: boolean;
  warnings: string[];
}

/**
 * Reads a sitemap or a sitemap index. Nested indexes are followed to `maxDepth` levels and `maxFiles` files, each fetched through
 * the guard with the 50 MB cap (compressed and unpacked). Collects at most `maxUrls` distinct addresses (default 50,000). A broken
 * child sitemap is reported as a warning and skipped; a broken starting document is an error.
 */
export async function readSitemap(
  fetcher: DiscoveryFetcher, startUrl: string,
  opts: { maxUrls?: number; maxDepth?: number; maxFiles?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<SitemapResult> {
  const maxUrls = opts.maxUrls ?? SITEMAP_MAX_URLS;
  const maxDepth = opts.maxDepth ?? 3;
  const maxFiles = opts.maxFiles ?? SITEMAP_MAX_FILES;
  const maxBytes = opts.maxBytes ?? SITEMAP_MAX_BYTES;
  const seenFiles = new Set<string>();
  const seenUrls = new Set<string>();
  const urls: SitemapEntry[] = [];
  const warnings: string[] = [];
  let filesFetched = 0;
  let truncated = false;

  const visit = async (url: string, depth: number, isRoot: boolean): Promise<void> => {
    if (seenFiles.has(url) || truncated) return;
    if (filesFetched >= maxFiles) { truncated = true; warnings.push(`Stopped after ${maxFiles} sitemap files.`); return; }
    seenFiles.add(url);
    filesFetched++;
    try {
      const { text, finalUrl } = await fetchText(fetcher, url, maxBytes, opts.signal);
      const parsed = parseSitemap(text, { maxUrls: maxUrls - urls.length + 1, base: finalUrl });
      if (parsed.kind === "urlset") {
        for (const u of parsed.urls) {
          if (seenUrls.has(u.loc)) continue;
          if (urls.length >= maxUrls) { truncated = true; break; }
          seenUrls.add(u.loc);
          urls.push(u);
        }
        if (parsed.truncated) truncated = true;
        return;
      }
      if (depth >= maxDepth) { warnings.push(`Did not follow nested sitemaps below ${maxDepth} levels (${url}).`); return; }
      for (const s of parsed.sitemaps) {
        await visit(s.loc, depth + 1, false);
        if (truncated) break;
      }
    } catch (e) {
      if (isRoot) {
        if (e instanceof XmlError) throw new AppError("bad_request", `That address is not a valid sitemap: ${e.message}.`, { url });
        throw e;
      }
      if (e instanceof AppError && (e.code === "offline" || e.code === "blocked")) throw e;
      warnings.push(`Skipped ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await visit(startUrl, 0, true);
  if (truncated && urls.length >= maxUrls) warnings.push(`Stopped at ${maxUrls.toLocaleString("en-GB")} addresses.`);
  return { urls, filesFetched, truncated, warnings };
}

export async function readFeed(fetcher: DiscoveryFetcher, url: string, opts: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<ParsedFeed> {
  const { text, finalUrl } = await fetchText(fetcher, url, opts.maxBytes ?? 10 * 1024 * 1024, opts.signal);
  try {
    return parseFeed(text, { base: finalUrl });
  } catch (e) {
    if (e instanceof XmlError) throw new AppError("bad_request", `That address is not a valid feed: ${e.message}.`, { url });
    throw e;
  }
}
