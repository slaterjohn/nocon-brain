/** Error codes from docs/api.md section 1. */
export const ERROR_CODES = [
  "bad_request", "unauthorized", "forbidden", "csrf", "not_found", "conflict", "rate_limited",
  "setup_required", "offline", "blocked", "insufficient_storage", "provider_error",
  "not_implemented", "internal", "unavailable",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  csrf: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  setup_required: 409,
  offline: 409,
  blocked: 403,
  insufficient_storage: 507,
  provider_error: 502,
  not_implemented: 501,
  internal: 500,
  unavailable: 503,
};

export interface ApiError {
  error: ErrorCode;
  message: string;
  details?: unknown;
  requestId: string;
}

/** An error the API may show to the user. The message is plain UK English and never holds a stack. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Converts any thrown value to the public error body. Unknown errors become a generic `internal`. */
export function toApiError(e: unknown, requestId: string): { status: number; body: ApiError } {
  if (isAppError(e)) {
    const body: ApiError = { error: e.code, message: e.message, requestId };
    if (e.details !== undefined) body.details = e.details;
    return { status: e.status, body };
  }
  return {
    status: 500,
    body: { error: "internal", message: "Something went wrong. Try again, and check the logs if it keeps happening.", requestId },
  };
}
