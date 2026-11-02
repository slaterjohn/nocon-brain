import { anyPathMatches } from "./glob.js";
import type { QueryConfig, ScopeConfig } from "./types.js";
import { authorityOf, crawlUrl, hasNoRegistrableDomain, registrableDomainOf, siteOf, type Authority } from "./url.js";

/** Where a candidate link was found. */
export interface ScopeParent {
  /** Depth of the page the link is on (start URLs are 0). */
  depth: number;
  /** 0 for pages inside the scope, 1 for a page one hop outside, and so on. */
  externalDepth: number;
}

export type ScopeSkipReason =
  | "scope:invalid_url"
  | "scope:scheme"
  | "scope:credentials"
  | "scope:excluded_domain"
  | "scope:excluded_path"
  | "scope:path_not_allowed"
  | "scope:external"
  | "scope:external_depth"
  | "scope:left_scope"
  | "scope:depth"
  | "scope:query_params";

export type ScopeDecision =
  | { allow: true; internal: boolean; depth: number; externalDepth: number; fetchUrl: string; key: string; host: string; sessionStripped: boolean }
  | { allow: false; reason: ScopeSkipReason; internal?: boolean };

/** Does `host` (with `port`) match a domain entry? `example.com` = host or subdomain, `*.example.com` = subdomains only, `host:port` is exact. */
export function domainMatches(entry: string, a: Authority): boolean {
  let e = entry.trim().toLowerCase();
  if (!e) return false;
  if (/^[^/]*:\d+$/.test(e) && !e.startsWith("[")) {
    const [h, p] = [e.slice(0, e.lastIndexOf(":")), e.slice(e.lastIndexOf(":") + 1)];
    return a.host === h && a.port === p;
  }
  e = e.replace(/\.$/, "");
  if (e.startsWith("*.")) return a.host.endsWith(e.slice(1)) && a.host.length > e.length - 1;
  return a.host === e || a.host.endsWith("." + e);
}

const stripWww = (h: string) => h.replace(/^www\./, "");

/** Compiled scope rules for one crawl. Create it once from the config and the start URLs. */
export class Scope {
  private readonly seeds: Authority[];
  private readonly seedSites: Set<string>;

  constructor(readonly config: ScopeConfig, readonly query: QueryConfig, startUrls: readonly string[]) {
    this.seeds = startUrls.map((u) => authorityOf(new URL(u)));
    this.seedSites = new Set(this.seeds.map(siteOf));
  }

  /** Is this authority inside the crawl's own site(s)? */
  isInternal(a: Authority): boolean {
    if (this.config.allowedDomains.some((d) => domainMatches(d, a))) return true;
    switch (this.config.internal) {
      case "host":
        return this.seeds.some((s) => s.host === a.host && (!hasNoRegistrableDomain(a.host) || s.port === a.port));
      case "subdomains":
        return this.seeds.some((s) => {
          const base = stripWww(s.host);
          if (hasNoRegistrableDomain(s.host)) return s.host === a.host && s.port === a.port;
          return a.host === base || a.host.endsWith("." + base);
        });
      case "registrable":
        return this.seedSites.has(siteOf(a));
    }
  }

  /**
   * Decides whether to follow a link. `raw` may be relative to `base`. The decision carries the cleaned URL to fetch,
   * its visited-set key and the depth values to store with the new frontier row.
   */
  evaluate(raw: string, parent: ScopeParent, base?: string): ScopeDecision {
    let u: URL;
    try {
      u = new URL(raw, base);
    } catch {
      return { allow: false, reason: "scope:invalid_url" };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { allow: false, reason: "scope:scheme" };
    if (u.username || u.password) return { allow: false, reason: "scope:credentials" };
    const a = authorityOf(u);
    const cfg = this.config;

    if (cfg.excludedDomains.some((d) => domainMatches(d, a))) return { allow: false, reason: "scope:excluded_domain" };
    if (anyPathMatches(cfg.excludedPaths, u.pathname)) return { allow: false, reason: "scope:excluded_path" };

    const internal = this.isInternal(a);
    const depth = parent.depth + 1;
    if (depth > cfg.maxDepth) return { allow: false, reason: "scope:depth", internal };

    let externalDepth = 0;
    if (internal) {
      if (parent.externalDepth > 0) return { allow: false, reason: "scope:left_scope", internal };
      if (cfg.allowedPaths.length > 0 && !anyPathMatches(cfg.allowedPaths, u.pathname)) return { allow: false, reason: "scope:path_not_allowed", internal };
    } else {
      if (cfg.externalDepth <= 0) return { allow: false, reason: "scope:external", internal };
      externalDepth = parent.externalDepth + 1;
      if (externalDepth > cfg.externalDepth) return { allow: false, reason: "scope:external_depth", internal };
    }

    if ([...new Set(u.searchParams.keys())].length > cfg.maxQueryParams) return { allow: false, reason: "scope:query_params", internal };

    const c = crawlUrl(u.href, this.query);
    if (!c) return { allow: false, reason: "scope:invalid_url", internal };
    return { allow: true, internal, depth, externalDepth, fetchUrl: c.fetchUrl, key: c.key, host: c.host, sessionStripped: c.sessionStripped };
  }
}

export { registrableDomainOf };
