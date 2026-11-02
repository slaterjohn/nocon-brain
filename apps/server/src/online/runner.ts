import { createHash } from "node:crypto";
import type { Db } from "@ncb/db";
import type { Clock } from "@ncb/shared";
import { SearchError, type AdapterConfig, type HttpClient, type ProviderAdapter, type ProviderResponse, type ProviderResult, type SearchErrorCode, type SearchQuery, type StorageKind } from "./types.js";
import { mapFetchError } from "./http.js";

/** Everything the runner needs to call one provider. A snapshot of the row, with the credential already decrypted. */
export interface ProviderRuntime {
  rowId: number;
  id: string;
  name: string;
  adapter: ProviderAdapter;
  config: AdapterConfig;
  timeoutMs: number;
  ratePerSec: number;
  monthlyCap: number | null;
  dailyCap: number | null;
  language?: string;
  region?: string;
  safeSearch: "off" | "moderate" | "strict";
  storage: { kind: StorageKind; ttlSeconds: number };
}

export interface RunError { code: SearchErrorCode; message: string; retryAfterMs?: number }
export type RunOutcome =
  | { ok: true; response: ProviderResponse; cached: boolean; tookMs: number }
  | { ok: false; error: RunError; tookMs: number; /** No request was made (circuit, cap, offline). */ skipped: boolean };

export interface RunnerOptions {
  db: Db;
  clock: Clock;
  http: (p: ProviderRuntime) => HttpClient;
  isOffline: () => boolean;
  log: { warn(o: unknown, m?: string): void };
  /** Jitter range before the single retry. */
  retryDelayMs?: [number, number];
}

const DEFAULT_CIRCUIT_MS = 60_000;

const utcMonth = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Calls providers for the combined search (task O-01). `run` never throws: every failure becomes a typed outcome, so a provider
 * can never break the local search path. The runner owns timeouts, the single retry, token buckets, the 429 circuit, the request
 * caps, health, the result cache and the storage-policy enforcement point.
 */
export class ProviderRunner {
  private readonly circuits = new Map<number, number>();
  private readonly buckets = new Map<number, { tokens: number; at: number }>();
  private readonly failures = new Map<number, number>();
  /** Provider requests started (tests assert on this). */
  requests = 0;

  constructor(private readonly o: RunnerOptions) {}

  /** True when a cap would refuse the next request (used to report "cap reached" without calling). */
  capReached(p: ProviderRuntime): boolean {
    const now = this.o.clock.now();
    return (p.monthlyCap !== null && this.count(p.id, utcMonth(now)) >= p.monthlyCap) || (p.dailyCap !== null && this.count(p.id, utcDay(now)) >= p.dailyCap);
  }

  circuitOpenUntil(rowId: number): number | undefined {
    const t = this.circuits.get(rowId);
    return t !== undefined && t > this.o.clock.now() ? t : undefined;
  }

  resetState(rowId?: number): void {
    if (rowId === undefined) { this.circuits.clear(); this.buckets.clear(); this.failures.clear(); return; }
    this.circuits.delete(rowId); this.buckets.delete(rowId); this.failures.delete(rowId);
  }

  async run(p: ProviderRuntime, q: Omit<SearchQuery, "signal" | "language" | "region" | "safesearch">, opts: { signal?: AbortSignal; purpose?: "search" | "test" } = {}): Promise<RunOutcome> {
    const t0 = performance.now();
    const took = () => Math.round(performance.now() - t0);
    try {
      return await this.runInner(p, q, opts, took);
    } catch (e) {
      const err = mapFetchError(e);
      this.o.log.warn({ provider: p.id, code: err.code }, "provider run failed unexpectedly");
      return { ok: false, error: { code: err.code, message: err.message }, tookMs: took(), skipped: false };
    }
  }

  private async runInner(p: ProviderRuntime, q: Omit<SearchQuery, "signal" | "language" | "region" | "safesearch">, opts: { signal?: AbortSignal; purpose?: "search" | "test" }, took: () => number): Promise<RunOutcome> {
    const { clock } = this.o;
    const test = opts.purpose === "test";
    const fail = (code: SearchErrorCode, message: string, skipped: boolean, retryAfterMs?: number): RunOutcome => ({ ok: false, error: { code, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }, tookMs: took(), skipped });

    if (this.o.isOffline()) return fail("disabled", "The server is working offline, so no provider is contacted.", true);
    if (!test) {
      const open = this.circuitOpenUntil(p.rowId);
      if (open !== undefined) return fail("rate_limited", `${p.name} is rate limited for a while.`, true, open - clock.now());
    }

    // Cache (storage policy enforcement point: only ttl/unrestricted providers with a TTL ever have rows).
    const ttl = this.cacheTtlSeconds(p);
    const qhash = createHash("sha256").update(JSON.stringify([p.adapter.info.id, q.query.trim().toLowerCase(), q.page ?? 1, q.pageSize ?? 0, p.language ?? "", p.region ?? "", p.safeSearch])).digest("hex");
    if (!test && ttl > 0) {
      const row = this.o.db.get<{ results_json: string }>("SELECT results_json FROM provider_result_cache WHERE provider_id = ? AND query_hash = ? AND page = ? AND expires_at > ?", [p.rowId, qhash, q.page ?? 1, clock.now()]);
      if (row) {
        try {
          const cached = JSON.parse(row.results_json) as ProviderResponse;
          if (Array.isArray(cached.results)) return { ok: true, response: cached, cached: true, tookMs: took() };
        } catch { /* refetch */ }
      }
      this.o.db.run("DELETE FROM provider_result_cache WHERE expires_at <= ?", [clock.now()]);
    }

    // Caps.
    const month = this.count(p.id, utcMonth(clock.now()));
    if (p.monthlyCap !== null && month >= p.monthlyCap) return fail("quota_exhausted", `The monthly limit of ${p.monthlyCap} requests for ${p.name} is used up.`, true);
    const day = this.count(p.id, utcDay(clock.now()));
    if (p.dailyCap !== null && day >= p.dailyCap) return fail("quota_exhausted", `The daily limit of ${p.dailyCap} requests for ${p.name} is used up.`, true);

    // Token bucket.
    const wait = this.takeToken(p);
    if (wait > 1000) return fail("rate_limited", `Too many requests to ${p.name}; slow down.`, true, wait);
    if (wait > 0) await sleep(wait);

    const http = this.o.http(p);
    let last: SearchError | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      this.bump(p.id);
      this.requests++;
      const timeout = AbortSignal.timeout(p.timeoutMs);
      const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
      try {
        const response = await p.adapter.search({ ...q, language: p.language, region: p.region, safesearch: p.safeSearch, signal }, p.config, http);
        this.markOk(p);
        if (!test && ttl > 0 && response.results.length > 0) this.store(p, qhash, q.page ?? 1, response, ttl);
        return { ok: true, response: this.bound(response, q.pageSize), cached: false, tookMs: took() };
      } catch (e) {
        let err = mapFetchError(e);
        if (timeout.aborted && err.code !== "rate_limited") err = new SearchError("timeout", `${p.name} did not answer within ${Math.round(p.timeoutMs / 100) / 10} s.`, { retryable: false });
        last = err;
        if (opts.signal?.aborted) break;
        if (err.retryable && attempt === 1 && !test) {
          const [lo, hi] = this.o.retryDelayMs ?? [100, 300];
          await sleep(lo + Math.random() * (hi - lo));
          continue;
        }
        break;
      }
    }
    const err = last ?? new SearchError("upstream", "The provider failed.");
    this.markFailed(p, err);
    return fail(err.code, err.message, false, err.retryAfterMs);
  }

  // ---- helpers -------------------------------------------------------------------------------

  private cacheTtlSeconds(p: ProviderRuntime): number {
    if (p.storage.kind === "none") return 0;
    const max = p.adapter.info.storage.maxTtlSeconds;
    const ttl = Math.max(0, p.storage.ttlSeconds);
    return max === null ? ttl : Math.min(ttl, max);
  }

  private store(p: ProviderRuntime, qhash: string, page: number, r: ProviderResponse, ttl: number): void {
    const now = this.o.clock.now();
    try {
      this.o.db.run(
        `INSERT INTO provider_result_cache (provider_id, query_hash, page, results_json, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id, query_hash, page) DO UPDATE SET results_json = excluded.results_json, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
        [p.rowId, qhash, page, JSON.stringify(r), now, now + ttl * 1000]);
    } catch (e) {
      // The database trigger is the last line of defence; a refusal just means nothing is cached.
      this.o.log.warn({ provider: p.id, err: String(e) }, "provider result not cached");
    }
  }

  private bound(r: ProviderResponse, pageSize?: number): ProviderResponse {
    const max = Math.max(1, Math.min(pageSize ?? 50, 100));
    const results: ProviderResult[] = r.results.slice(0, max);
    return { ...r, results };
  }

  private count(subject: string, period: string): number {
    return this.o.db.get<{ count: number }>("SELECT count FROM usage_counters WHERE kind = 'provider_requests' AND subject = ? AND period = ?", [subject, period])?.count ?? 0;
  }

  private bump(subject: string): void {
    const now = this.o.clock.now();
    for (const period of [utcMonth(now), utcDay(now)]) {
      this.o.db.run("INSERT INTO usage_counters (kind, subject, period, count) VALUES ('provider_requests', ?, ?, 1) ON CONFLICT(kind, subject, period) DO UPDATE SET count = count + 1", [subject, period]);
    }
  }

  /** Milliseconds to wait for a token (0 when one is free). */
  private takeToken(p: ProviderRuntime): number {
    const rate = Math.max(0.05, p.ratePerSec);
    const cap = Math.max(1, rate);
    const now = performance.now();
    const b = this.buckets.get(p.rowId) ?? { tokens: cap, at: now };
    b.tokens = Math.min(cap, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
    let wait = 0;
    if (b.tokens >= 1) b.tokens -= 1;
    else { wait = Math.ceil(((1 - b.tokens) / rate) * 1000); b.tokens = 0; b.at = now + wait; }
    this.buckets.set(p.rowId, b);
    return wait;
  }

  private markOk(p: ProviderRuntime): void {
    this.failures.delete(p.rowId);
    this.circuits.delete(p.rowId);
    this.o.db.run("UPDATE search_providers SET health_state = 'ok', last_ok_at = ?, last_error_code = NULL, circuit_open_until = NULL WHERE id = ?", [this.o.clock.now(), p.rowId]);
  }

  private markFailed(p: ProviderRuntime, err: SearchError): void {
    const now = this.o.clock.now();
    const n = (this.failures.get(p.rowId) ?? 0) + 1;
    this.failures.set(p.rowId, n);
    let open: number | null = null;
    if (err.code === "rate_limited") {
      open = now + Math.min(3_600_000, Math.max(1000, err.retryAfterMs ?? DEFAULT_CIRCUIT_MS));
      this.circuits.set(p.rowId, open);
    }
    const state = err.code === "auth" || err.code === "quota_exhausted" || n >= 3 ? "down" : "degraded";
    this.o.db.run("UPDATE search_providers SET health_state = ?, last_error_code = ?, circuit_open_until = ? WHERE id = ?", [state, err.code, open, p.rowId]);
  }
}
