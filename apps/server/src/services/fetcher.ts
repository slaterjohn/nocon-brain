import { AppError } from "@ncb/shared";
import type { ConnectivityService } from "./connectivity.js";

/**
 * The seam for outbound requests. The real SSRF-guarded fetcher arrives in Phase 2 (task A-01); until then
 * `NotImplementedFetcher` stands in. Whatever implements `Fetcher` is wrapped in `ConnectivityGuardedFetcher`
 * so that forced-offline refuses every call and every outcome feeds passive connectivity.
 */
export interface FetchRequest {
  url: string;
  method?: "GET" | "HEAD";
  /** Crawling, discovery and provider refreshes. A user-initiated fetch is not background. */
  background?: boolean;
}

export interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface Fetcher {
  fetch(req: FetchRequest): Promise<FetchResponse>;
}

export class NotImplementedFetcher implements Fetcher {
  async fetch(): Promise<FetchResponse> {
    throw new AppError("not_implemented", "Fetching from the web arrives with the archiving phase.");
  }
}

/** True for errors that mean no server was reached (as opposed to an HTTP error). */
export function isNetworkError(e: unknown): boolean {
  const code = (e as { code?: string; cause?: { code?: string } } | undefined);
  const c = code?.code ?? code?.cause?.code;
  return typeof c === "string" && /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT)$/.test(c);
}

export class ConnectivityGuardedFetcher implements Fetcher {
  constructor(private readonly inner: Fetcher, private readonly connectivity: ConnectivityService) {}

  async fetch(req: FetchRequest): Promise<FetchResponse> {
    this.connectivity.assertCanReachInternet({ background: req.background });
    try {
      const res = await this.inner.fetch(req);
      this.connectivity.recordOutcome({ ok: true });
      return res;
    } catch (e) {
      if (isNetworkError(e)) this.connectivity.recordOutcome({ ok: false, network: true });
      throw e;
    }
  }
}

/** The same guard for the provider runner (Phase 5): call before any provider request. */
export function guardProviderCall(connectivity: ConnectivityService): void {
  connectivity.assertCanReachInternet({ background: false });
}
