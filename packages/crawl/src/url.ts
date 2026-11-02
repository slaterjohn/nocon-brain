import { getDomain, parse } from "tldts";
import { normaliseUrl, TRACKING_PARAMS } from "@ncb/fetch";
import type { QueryConfig } from "./types.js";

/** Query parameters that carry a session, always removed from crawl URLs whatever the query policy. */
export const SESSION_PARAMS: readonly RegExp[] = [/^phpsessid$/i, /^jsessionid$/i, /^sessionid$/i, /^sid$/i, /^session_id$/i, /^sessid$/i, /^aspsessionid/i, /^cfid$/i, /^cftoken$/i, /^s_id$/i];

const SESSION_PATH = /;(?:jsessionid|phpsessid|sessionid|sid)=[^/;?#]*/gi;

export function isSessionParam(name: string): boolean {
  return SESSION_PARAMS.some((r) => r.test(name));
}

export interface Authority {
  host: string;
  port: string;
}

export function authorityOf(u: URL): Authority {
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return { host, port: u.port || (u.protocol === "https:" ? "443" : "80") };
}

/** True for IP literals, `localhost` and other hosts without a public suffix. They are compared with their port. */
export function hasNoRegistrableDomain(host: string): boolean {
  return getDomain(host, { allowPrivateDomains: true }) === null;
}

/**
 * The registrable domain (eTLD+1) of a host from the public suffix list, private suffixes included, so `a.github.io`
 * and `b.github.io` are different sites. Hosts with no registrable domain are returned unchanged.
 */
export function registrableDomainOf(host: string): string {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return getDomain(h, { allowPrivateDomains: true }) ?? h;
}

/** The site identity used for internal/external: the registrable domain, or `host:port` when there is none. */
export function siteOf(a: Authority): string {
  return hasNoRegistrableDomain(a.host) ? `${a.host}:${a.port}` : registrableDomainOf(a.host);
}

export function isIpHost(host: string): boolean {
  return parse(host, { allowPrivateDomains: true }).isIp === true;
}

/** Removes session ids from the query and from `;jsessionid=` path parameters. Returns the URL and whether anything was removed. */
export function stripSessionIds(u: URL): { url: URL; removed: boolean } {
  const out = new URL(u.href);
  let removed = false;
  const path = out.pathname.replace(SESSION_PATH, () => {
    removed = true;
    return "";
  });
  if (path !== out.pathname) out.pathname = path || "/";
  for (const k of [...new Set(out.searchParams.keys())]) {
    if (isSessionParam(k)) {
      out.searchParams.delete(k);
      removed = true;
    }
  }
  if (removed && out.search === "?") out.search = "";
  return { url: out, removed };
}

function matchesTracking(name: string): boolean {
  return TRACKING_PARAMS.some((p) => (typeof p === "string" ? p === name : p.test(name)));
}

/** Applies the query policy to the URL that will be fetched, so the stored request matches the key. */
export function applyQueryPolicy(u: URL, q: QueryConfig): URL {
  const out = new URL(u.href);
  if (q.policy === "keep_all") return out;
  if (q.policy === "drop_all") {
    out.search = "";
    return out;
  }
  const keep = new Set(q.allowParams);
  for (const k of [...new Set(out.searchParams.keys())]) {
    if (q.policy === "strip_tracking" ? matchesTracking(k) : !keep.has(k)) out.searchParams.delete(k);
  }
  if (out.search === "?") out.search = "";
  return out;
}

export interface CrawlUrl {
  /** The URL to request (session ids and policy-dropped parameters removed, fragment dropped). */
  fetchUrl: string;
  /** The visited-set key. */
  key: string;
  host: string;
  /** A session id was present and removed. */
  sessionStripped: boolean;
}

/** Clean and key a URL under a query policy. Returns null for anything that is not an http(s) URL. */
export function crawlUrl(raw: string, q: QueryConfig, base?: string): CrawlUrl | null {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  const s = stripSessionIds(u);
  const cleaned = applyQueryPolicy(s.url, q);
  try {
    const n = normaliseUrl(cleaned, { queryPolicy: q.policy, allowParams: q.allowParams });
    return { fetchUrl: cleaned.href, key: n.key, host: n.host, sessionStripped: s.removed };
  } catch {
    return null;
  }
}
