import { createFetcher, createSsrfGuard, FetchError, isSsrfError, type Fetcher } from "@ncb/fetch";
import { SearchError, type HttpClient } from "./types.js";

/**
 * Provider HTTP goes through the same SSRF-guarded fetcher as captures. The one exception is the host the Human configured for
 * that provider (a SearXNG on the local network, or a test server): exactly that host (and port, when given) is allowed, nothing else.
 * Redirects are guarded on every hop and custom headers (the API token) never follow a redirect to another host.
 */
export function mapFetchError(e: unknown): SearchError {
  if (e instanceof SearchError) return e;
  if (e instanceof FetchError) {
    switch (e.code) {
      case "rate_limited": return new SearchError("rate_limited", "The provider is rate limiting requests.", { status: 429, retryAfterMs: e.retryAfterMs, retryable: false });
      case "timeout_connect": case "timeout_headers": case "timeout_body": case "timeout_total": return new SearchError("timeout", "The provider did not answer in time.", { retryable: false });
      case "aborted": return new SearchError("timeout", "The request was cancelled.", { retryable: false });
      case "offline": return new SearchError("disabled", "Work offline is on.", { retryable: false });
      case "ssrf_blocked": return new SearchError("bad_request", "That address is not allowed for a provider (private or unsafe).", { retryable: false });
      case "content_type_blocked": return new SearchError("bad_request", "The provider did not answer with JSON.", { retryable: false });
      case "network": return new SearchError("network", "Could not connect to the provider.");
      default: return new SearchError("upstream", "The provider's answer could not be read.", { retryable: e.code === "size_cap" ? false : true });
    }
  }
  if (isSsrfError(e)) return new SearchError("bad_request", "That address is not allowed for a provider (private or unsafe).", { retryable: false });
  const name = (e as { name?: string } | undefined)?.name;
  if (name === "AbortError" || name === "TimeoutError") return new SearchError("timeout", "The provider did not answer in time.", { retryable: false });
  return new SearchError("network", "Could not connect to the provider.");
}

export interface ProviderHttpOptions {
  userAgent: string;
  isOffline: () => boolean;
}

export class ProviderHttp {
  private readonly cache = new Map<string, { fetcher: Fetcher; client: HttpClient }>();
  constructor(private readonly o: ProviderHttpOptions) {}

  /** A client whose guard allows only `allowHost` (host or host:port) in addition to public addresses. */
  clientFor(baseUrl: string | null, defaultBase: string | null): HttpClient {
    const allow = this.allowFor(baseUrl, defaultBase);
    const key = allow ?? "";
    let c = this.cache.get(key);
    if (!c) {
      const fetcher = createFetcher({
        userAgent: this.o.userAgent,
        isOffline: this.o.isOffline,
        ssrf: createSsrfGuard({ allow: allow ? [allow] : [] }),
        maxRedirects: 2,
        maxBytes: 2 * 1024 * 1024,
        timeouts: { totalMs: 30_000 },
      });
      const client: HttpClient = {
        async get(url, g) {
          try {
            const r = await fetcher.fetch(url, { accept: ["application/json", "text/json", "application/*+json"], signal: g.signal, maxBytes: g.maxBytes ?? 2 * 1024 * 1024, headers: g.headers });
            return { status: r.status, headers: r.headers, body: (r.body as Buffer).toString("utf8") };
          } catch (e) {
            throw mapFetchError(e);
          }
        },
      };
      c = { fetcher, client };
      this.cache.set(key, c);
    }
    return c.client;
  }

  private allowFor(baseUrl: string | null, defaultBase: string | null): string | undefined {
    if (!baseUrl) return undefined;
    try {
      const u = new URL(baseUrl);
      if (defaultBase && u.host === new URL(defaultBase).host) return undefined;
      return u.host.toLowerCase();
    } catch { return undefined; }
  }

  async close(): Promise<void> {
    await Promise.all([...this.cache.values()].map((c) => c.fetcher.close().catch(() => undefined)));
    this.cache.clear();
  }
}
