"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FALLBACK_BY_CODE, isPlain, plainMessage } from "./errors";

export class ApiError extends Error {
  status: number;
  /** One of the docs/api.md error codes, or "network". */
  code: string;
  details: unknown;
  requestId?: string;
  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PUBLIC_PAGES = ["/login", "/setup"];

function redirectTo(path: string) {
  if (typeof window === "undefined") return;
  if (window.location.pathname === path) return;
  window.location.assign(path);
}

/** An ended session sends the person to sign in, says so there, and brings them back to the page they were on. */
function redirectToSignIn() {
  if (typeof window === "undefined") return;
  const here = window.location.pathname + window.location.search;
  window.location.assign(`/login?expired=1&next=${encodeURIComponent(here)}`);
}

function onPublicPage() {
  if (typeof window === "undefined") return false;
  return PUBLIC_PAGES.some((p) => window.location.pathname.startsWith(p));
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Skip the 401 and setup_required redirects (used by login and setup calls). */
  noRedirect?: boolean;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = (opts.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (MUTATING.has(method)) headers["X-NoCon-CSRF"] = "1";

  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    body = opts.body;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body, credentials: "include", signal: opts.signal, cache: "no-store" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network", FALLBACK_BY_CODE.network!);
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const e = (data ?? {}) as { error?: string; message?: string; details?: unknown; requestId?: string };
    const code = e.error ?? (res.status === 401 ? "unauthorized" : res.status === 429 ? "rate_limited" : "internal");
    if (!opts.noRedirect) {
      if (res.status === 401 && !onPublicPage()) redirectToSignIn();
      if (code === "setup_required" && !onPublicPage()) redirectTo("/setup");
    }
    throw new ApiError(res.status, code, plainMessage(res.status, code, e.message), e.details, e.requestId);
  }
  return data as T;
}

export const get = <T,>(path: string) => api<T>(path);
export const post = <T,>(path: string, body?: unknown) => api<T>(path, { method: "POST", body });
export const put = <T,>(path: string, body?: unknown) => api<T>(path, { method: "PUT", body });
export const patch = <T,>(path: string, body?: unknown) => api<T>(path, { method: "PATCH", body });
export const del = <T,>(path: string) => api<T>(path, { method: "DELETE" });

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && isPlain(err.message)) return err.message;
  return FALLBACK_BY_CODE.internal!;
}

/**
 * Turns the `details` of a 400 into a map keyed by field path. docs/api.md leaves `details` as `unknown`. The server
 * sends `{ fields: [{ in, path: "a.b", message }] }`; zod-style issue arrays (`path` as an array) and a plain
 * `{ field: message }` object are accepted too.
 */
export function fieldErrors(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(err instanceof ApiError)) return out;
  let d = err.details;
  if (d && typeof d === "object" && !Array.isArray(d) && Array.isArray((d as { fields?: unknown }).fields)) {
    d = (d as { fields: unknown[] }).fields;
  }
  if (Array.isArray(d)) {
    for (const issue of d as { path?: string | (string | number)[]; message?: string }[]) {
      const key = Array.isArray(issue.path) ? issue.path.join(".") : (issue.path ?? "");
      if (key && issue.message && !out[key]) out[key] = issue.message;
    }
  } else if (d && typeof d === "object") {
    for (const [k, v] of Object.entries(d as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

export interface UseApiOptions {
  refreshInterval?: number;
  /** Set false to hold off fetching. */
  enabled?: boolean;
}

export interface UseApiResult<T> {
  data: T | undefined;
  error: ApiError | undefined;
  isLoading: boolean;
  isValidating: boolean;
  mutate: () => Promise<void>;
  setData: (d: T | undefined) => void;
}

/** Minimal SWR-style hook: keeps stale data while revalidating, polls, and refetches when the tab becomes visible. */
export function useApi<T>(path: string | null, opts: UseApiOptions = {}): UseApiResult<T> {
  const { refreshInterval, enabled = true } = opts;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [isValidating, setValidating] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const seq = useRef(0);
  const pathRef = useRef(path);

  useEffect(() => {
    if (pathRef.current !== path) {
      pathRef.current = path;
      setData(undefined);
      setError(undefined);
      setLoaded(false);
    }
  }, [path]);

  const load = useCallback(async () => {
    if (!path || !enabled) return;
    const id = ++seq.current;
    setValidating(true);
    try {
      const res = await api<T>(path);
      if (id !== seq.current) return;
      setData(res);
      setError(undefined);
    } catch (e) {
      if (id !== seq.current) return;
      if (e instanceof DOMException) return;
      setError(e as ApiError);
    } finally {
      if (id === seq.current) {
        setValidating(false);
        setLoaded(true);
      }
    }
  }, [path, enabled]);

  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [load]);

  useEffect(() => {
    if (!refreshInterval || !enabled) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, refreshInterval);
    return () => clearInterval(t);
  }, [refreshInterval, enabled, load]);

  useEffect(() => {
    if (!enabled) return;
    const onVis = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [enabled, load]);

  return {
    data,
    error,
    isLoading: enabled && !!path && !loaded,
    isValidating,
    mutate: load,
    setData,
  };
}
