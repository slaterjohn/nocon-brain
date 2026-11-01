import type { SsrfReason } from "./ssrf";

export type FetchErrorCode =
  | "offline" | "invalid_url" | "ssrf_blocked" | "too_many_redirects" | "redirect_loop" | "bad_redirect"
  | "timeout_connect" | "timeout_headers" | "timeout_body" | "timeout_total" | "aborted" | "rate_limited"
  | "size_cap" | "content_length_exceeded" | "too_many_encodings" | "unsupported_encoding"
  | "content_type_blocked" | "network";

export interface RedirectHop {
  url: string;
  status: number;
  location: string;
}

export class FetchError extends Error {
  readonly code: FetchErrorCode;
  url?: string;
  redirects: RedirectHop[] = [];
  retryAfterMs?: number;
  ssrfReason?: SsrfReason;
  status?: number;
  constructor(code: FetchErrorCode, message: string, extra: Partial<Pick<FetchError, "url" | "redirects" | "retryAfterMs" | "ssrfReason" | "status" | "cause">> = {}) {
    super(message);
    this.name = "FetchError";
    this.code = code;
    Object.assign(this, extra);
  }
}
