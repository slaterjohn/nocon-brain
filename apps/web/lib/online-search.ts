// Combined-search shapes from docs/api.md section 6.2 (copied, not imported), plus small pure helpers.
import type { Coverage, SearchResult } from "./search";

export type SearchErrorCode = "timeout" | "rate_limited" | "auth" | "quota_exhausted" | "bad_request" | "upstream" | "network" | "disabled" | "unsupported";

export interface ProviderError {
  code: SearchErrorCode;
  message: string;
  retryAfterMs?: number;
}

export interface ProviderRun {
  id: string;
  name: string;
  adapter: string;
  state: "pending" | "ok" | "error" | "skipped";
  count: number;
  hasMore: boolean;
  error?: ProviderError;
}

export interface OnlineInfo {
  state: "disabled" | "offline" | "pending" | "done";
  pending: string[];
  disclosure: string;
  providers?: ProviderRun[];
}

export interface ResultUpdate {
  key: string;
  alsoOnline?: true;
  addAttribution?: NonNullable<SearchResult["attribution"]>[number];
  snippetExtra?: string;
}

export type SearchEvent = { seq: number; at: string } & (
  | { type: "provider_started"; providerId: string; name: string; adapter: string; page: number; fallbackFor?: string }
  | {
      type: "provider_results";
      providerId: string;
      page: number;
      hasMore: boolean;
      tookMs: number;
      cached: boolean;
      partial?: { failedEngines: string[] };
      dropped: number;
      append: SearchResult[];
      update: ResultUpdate[];
    }
  | { type: "provider_error"; providerId: string; code: SearchErrorCode; message: string; retryAfterMs?: number; fallbackProviderId?: string }
  | { type: "coverage"; coverage: Coverage }
  | { type: "reorder_available"; fusedOrder: string[] }
  | { type: "done"; reason: "all_providers_answered" | "deadline" | "cancelled" | "no_providers" }
);

export const EVENT_TYPES = ["provider_started", "provider_results", "provider_error", "coverage", "reorder_available", "done"] as const;

export interface Provider {
  id: string;
  adapter: "searxng" | "brave" | "mojeek";
  name: string;
  enabled: boolean;
  priority: number;
  baseUrl: string | null;
  hasCredentials: boolean;
  timeoutMs: number;
  rateLimitPerSec: number;
  monthlyCap: number | null;
  dailyCap: number | null;
  fallbackProviderId: string | null;
  language: string | null;
  region: string | null;
  safeSearch: "off" | "moderate" | "strict";
  weight: number;
  storage: { policy: "none" | "ttl" | "unrestricted"; ttlSeconds: number | null; adapterPolicy: string; maxTtlSeconds: number | null; note: string };
  health: { state: "unknown" | "ok" | "degraded" | "down"; lastOkAt?: string; lastErrorCode?: SearchErrorCode; circuitOpenUntil?: string };
  usage: { month: { period: string; requests: number; cap: number | null }; day: { period: string; requests: number; cap: number | null } };
}

export interface ProvidersResponse {
  items: Provider[];
  online: { enabled: boolean; acknowledgedAt: string | null; disclosure: string; state: "off" | "offline" | "ready" };
}

export const ADAPTER_LABELS: Record<Provider["adapter"], string> = { searxng: "SearXNG", brave: "Brave Search", mojeek: "Mojeek" };

export const ERROR_TEXT: Record<SearchErrorCode, string> = {
  timeout: "did not answer in time",
  rate_limited: "is limiting requests",
  auth: "refused the key",
  quota_exhausted: "has reached its usage limit",
  bad_request: "could not understand the request",
  upstream: "had a problem on its side",
  network: "could not be reached",
  disabled: "is switched off",
  unsupported: "does not support this search",
};

/** One plain sentence for a provider failure. The code is always shown next to it. */
export const errorSentence = (name: string, code: SearchErrorCode) => `${name} ${ERROR_TEXT[code] ?? "failed"}`;

/** Only http and https links are ever rendered as links. */
export function safeHttpUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export interface SaveResponse {
  downloadId: string;
  url: string;
  state: "queued";
  held: boolean;
  priority: string;
  key: string;
}
