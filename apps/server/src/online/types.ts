/** Provider adapter contract (docs/research/search-providers.md "Generic adapter interface"; docs/api.md section 6.2). */

export type SearchErrorCode = "timeout" | "rate_limited" | "auth" | "quota_exhausted" | "bad_request" | "upstream" | "network" | "disabled" | "unsupported";
export type StorageKind = "none" | "ttl" | "unrestricted";
export type AdapterId = "searxng" | "brave" | "mojeek";

export class SearchError extends Error {
  readonly code: SearchErrorCode;
  readonly retryAfterMs?: number;
  readonly status?: number;
  readonly retryable: boolean;
  constructor(code: SearchErrorCode, message: string, o: { retryAfterMs?: number; status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "SearchError";
    this.code = code;
    this.retryAfterMs = o.retryAfterMs;
    this.status = o.status;
    this.retryable = o.retryable ?? (code === "network" || code === "upstream");
  }
}

export interface SearchQuery {
  query: string;
  language?: string;
  region?: string;
  safesearch?: "off" | "moderate" | "strict";
  /** 1-based. */
  page?: number;
  pageSize?: number;
  signal: AbortSignal;
}

/** One normalised hit. Everything is plain text; URLs are validated http(s). */
export interface ProviderResult {
  url: string;
  title: string;
  snippet: string;
  /** 1-based position within the provider's page. */
  rank: number;
  /** Absolute rank: (page - 1) * pageSize + rank. */
  providerRank: number;
  publishedAt?: string;
  engines?: string[];
}

export interface ProviderResponse {
  results: ProviderResult[];
  hasMore: boolean;
  /** Results discarded because the URL was missing, malformed or not http(s). */
  dropped: number;
  partial?: { failedEngines: string[] };
  rateLimit?: { limit?: number; remaining?: number; resetAfterMs?: number };
}

/** The HTTP seam adapters use. The production implementation is the SSRF-guarded `@ncb/fetch` fetcher. */
export interface HttpClient {
  get(url: string, o: { headers?: Record<string, string>; signal: AbortSignal; maxBytes?: number }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

export interface AdapterConfig {
  baseUrl: string | null;
  apiKey: string | undefined;
}

export interface AdapterInfo {
  id: AdapterId;
  label: string;
  /** What the adapter allows to be stored. */
  storage: { policy: StorageKind; maxTtlSeconds: number | null; note: string };
  needsBaseUrl: boolean;
  needsKey: boolean;
  defaultBaseUrl: string | null;
  maxPageSize: number;
  defaultRatePerSec: number;
  /** Hosted adapters leave the machine for the internet; SearXNG may be on the local network. */
  hosted: boolean;
}

export interface ProviderAdapter {
  readonly info: AdapterInfo;
  search(q: SearchQuery, cfg: AdapterConfig, http: HttpClient): Promise<ProviderResponse>;
  /** A cheap request that proves the credentials and URL work. */
  health(cfg: AdapterConfig, http: HttpClient, signal: AbortSignal): Promise<{ ok: boolean; detail?: string }>;
}
