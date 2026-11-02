import { describe, expect, it } from "vitest";
import { FakeClock } from "@ncb/shared";
import { migrate, openDb } from "@ncb/db";
import { ProviderRunner, type ProviderRuntime } from "../../src/online/runner.js";
import { SearchError, type ProviderAdapter, type ProviderResponse } from "../../src/online/types.js";

const ok = (n = 2): ProviderResponse => ({ hasMore: false, dropped: 0, results: Array.from({ length: n }, (_, i) => ({ url: `https://x.example/${i}`, title: `T${i}`, snippet: "s", rank: i + 1, providerRank: i + 1 })) });

function setup(script: (call: number) => ProviderResponse | SearchError | Promise<ProviderResponse>, o: { kind?: "none" | "ttl" | "unrestricted"; ttl?: number; adapter?: string; monthlyCap?: number | null; dailyCap?: number | null; timeoutMs?: number; offline?: () => boolean } = {}) {
  const db = openDb(":memory:");
  migrate(db);
  const clock = new FakeClock();
  const now = clock.now();
  const adapterId = o.adapter ?? "searxng";
  const kind = o.kind ?? "unrestricted";
  db.run(
    `INSERT INTO search_providers (public_id, adapter, name, enabled, storage_kind, storage_ttl_seconds, created_at, updated_at) VALUES ('prv_x', ?, 'X', 1, ?, ?, ?, ?)`,
    [adapterId, kind, o.ttl ?? 0, now, now]);
  const calls = { n: 0 };
  const adapter: ProviderAdapter = {
    info: { id: adapterId as never, label: "X", storage: { policy: kind, maxTtlSeconds: adapterId === "mojeek" ? 3600 : null, note: "" }, needsBaseUrl: false, needsKey: false, defaultBaseUrl: null, maxPageSize: 10, defaultRatePerSec: 50, hosted: true },
    async search() {
      calls.n++;
      const r = await script(calls.n);
      if (r instanceof SearchError) throw r;
      return r;
    },
    async health() { return { ok: true }; },
  };
  const rt: ProviderRuntime = {
    rowId: 1, id: "prv_x", name: "X", adapter, config: { baseUrl: null, apiKey: "k" }, timeoutMs: o.timeoutMs ?? 200, ratePerSec: 1000, monthlyCap: o.monthlyCap ?? null, dailyCap: o.dailyCap ?? null,
    safeSearch: "moderate", storage: { kind, ttlSeconds: o.ttl ?? 0 },
  };
  const runner = new ProviderRunner({ db, clock, http: () => ({ get: async () => { throw new Error("unused"); } }), isOffline: o.offline ?? (() => false), log: { warn() {} }, retryDelayMs: [1, 2] });
  return { db, clock, rt, runner, calls };
}
const q = { query: "turbines", page: 1, pageSize: 10 };

describe("provider runner (O-01)", () => {
  it("retries a network or upstream error once, then reports it", async () => {
    const a = setup((n) => (n === 1 ? new SearchError("network", "down") : ok()));
    const r = await a.runner.run(a.rt, q);
    expect(r.ok).toBe(true);
    expect(a.calls.n).toBe(2);
    const b = setup(() => new SearchError("upstream", "5xx"));
    const f = await b.runner.run(b.rt, q);
    expect(f).toMatchObject({ ok: false, error: { code: "upstream" } });
    expect(b.calls.n).toBe(2);
  });

  it.each(["auth", "quota_exhausted", "bad_request", "rate_limited"] as const)("never retries %s", async (code) => {
    const a = setup(() => new SearchError(code, "no", { retryable: code === "rate_limited" ? false : undefined }));
    const r = await a.runner.run(a.rt, q);
    expect(r).toMatchObject({ ok: false, error: { code } });
    expect(a.calls.n).toBe(1);
  });

  it("times out without a retry and without throwing", async () => {
    const a = setup(() => new Promise<ProviderResponse>(() => undefined), { timeoutMs: 50 });
    // The fake adapter ignores the signal, so only the runner's own race would end it: the real adapters honour the signal.
    const slow = { ...a.rt, adapter: { ...a.rt.adapter, search: (qq: { signal: AbortSignal }) => new Promise<ProviderResponse>((_, rej) => qq.signal.addEventListener("abort", () => rej(new Error("aborted")))) } } as ProviderRuntime;
    const r = await a.runner.run(slow, q);
    expect(r).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("opens a circuit after 429 for Retry-After and closes it when the time passes", async () => {
    const a = setup((n) => (n === 1 ? new SearchError("rate_limited", "429", { retryAfterMs: 30_000, retryable: false }) : ok()));
    const first = await a.runner.run(a.rt, q);
    expect(first).toMatchObject({ ok: false, error: { code: "rate_limited", retryAfterMs: 30_000 } });
    const blocked = await a.runner.run(a.rt, q);
    expect(blocked).toMatchObject({ ok: false, skipped: true, error: { code: "rate_limited" } });
    expect(a.calls.n).toBe(1); // no request was made while open
    expect(a.runner.circuitOpenUntil(1)).toBeGreaterThan(a.clock.now());
    a.clock.advance(30_001);
    expect((await a.runner.run(a.rt, q)).ok).toBe(true);
    expect(a.runner.circuitOpenUntil(1)).toBeUndefined();
  });

  it("blocks calls when the monthly or daily cap is reached and counts every request", async () => {
    const a = setup(() => ok(), { monthlyCap: 2 });
    expect((await a.runner.run(a.rt, { ...q, query: "a" })).ok).toBe(true);
    expect((await a.runner.run(a.rt, { ...q, query: "b" })).ok).toBe(true);
    const c = await a.runner.run(a.rt, { ...q, query: "c" });
    expect(c).toMatchObject({ ok: false, skipped: true, error: { code: "quota_exhausted" } });
    expect(a.calls.n).toBe(2);
    const row = a.db.get<{ count: number }>("SELECT count FROM usage_counters WHERE kind = 'provider_requests' AND subject = 'prv_x' AND length(period) = 7");
    expect(row?.count).toBe(2);
    // A new month starts a new counter.
    a.clock.advance(40 * 86_400_000);
    expect((await a.runner.run(a.rt, { ...q, query: "d" })).ok).toBe(true);
    const d = setup(() => ok(), { dailyCap: 1 });
    await d.runner.run(d.rt, { ...q, query: "a" });
    expect(await d.runner.run(d.rt, { ...q, query: "b" })).toMatchObject({ ok: false, error: { code: "quota_exhausted" } });
    d.clock.advance(86_400_000 + 1000);
    expect((await d.runner.run(d.rt, { ...q, query: "c" })).ok).toBe(true);
  });

  it("a token bucket spaces requests and refuses to queue for long", async () => {
    const a = setup(() => ok());
    const slowRt: ProviderRuntime = { ...a.rt, ratePerSec: 0.5 };       // one token, refilled every 2 s
    expect((await a.runner.run(slowRt, { ...q, query: "a" })).ok).toBe(true);
    const second = await a.runner.run(slowRt, { ...q, query: "b" });
    expect(second).toMatchObject({ ok: false, skipped: true, error: { code: "rate_limited" } });
    expect(second.ok === false && second.error.retryAfterMs).toBeGreaterThan(1000);
    expect(a.calls.n).toBe(1);
    // A fast bucket makes a short wait instead of failing.
    const b = setup(() => ok());
    const fast: ProviderRuntime = { ...b.rt, ratePerSec: 20 };
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) expect((await b.runner.run(fast, { ...q, query: `q${i}` })).ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(900);
    expect(b.calls.n).toBe(3);
  });

  it("makes no call at all while offline", async () => {
    const a = setup(() => ok(), { offline: () => true });
    expect(await a.runner.run(a.rt, q)).toMatchObject({ ok: false, skipped: true });
    expect(a.calls.n).toBe(0);
  });

  it("an adapter that throws something odd still becomes a typed outcome", async () => {
    const a = setup(() => { throw new TypeError("boom"); });
    const r = await a.runner.run(a.rt, q);
    expect(r).toMatchObject({ ok: false, error: { code: "network" } });
  });

  it("caches only when the policy allows, honours the TTL and refetches after it", async () => {
    const a = setup(() => ok(), { kind: "ttl", ttl: 3600, adapter: "mojeek" });
    const first = await a.runner.run(a.rt, q);
    const second = await a.runner.run(a.rt, q);
    expect(first).toMatchObject({ ok: true, cached: false });
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(a.calls.n).toBe(1);
    a.clock.advance(3599_000);
    expect(await a.runner.run(a.rt, q)).toMatchObject({ cached: true });
    a.clock.advance(2_000);
    expect(await a.runner.run(a.rt, q)).toMatchObject({ ok: true, cached: false });
    expect(a.calls.n).toBe(2);
    // A configured TTL above the adapter's limit is clamped to the limit.
    const b = setup(() => ok(), { kind: "ttl", ttl: 100_000, adapter: "searxng" });
    b.rt.adapter.info.storage.maxTtlSeconds = 3600;
    await b.runner.run(b.rt, q);
    const row = b.db.get<{ fetched_at: number; expires_at: number }>("SELECT fetched_at, expires_at FROM provider_result_cache")!;
    expect(row.expires_at - row.fetched_at).toBeLessThanOrEqual(3600_000);
    // `none` never caches.
    const c = setup(() => ok(), { kind: "none", ttl: 0 });
    await c.runner.run(c.rt, q); await c.runner.run(c.rt, q);
    expect(c.calls.n).toBe(2);
    expect(c.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM provider_result_cache")!.n).toBe(0);
  });

  it("the database refuses cache rows for a none provider and rows that outlive the TTL (O-03, O-04 triggers)", () => {
    const a = setup(() => ok(), { kind: "none", ttl: 0, adapter: "brave" });
    const now = a.clock.now();
    expect(() => a.db.run("INSERT INTO provider_result_cache (provider_id, query_hash, page, results_json, fetched_at, expires_at) VALUES (1, 'h', 1, '{}', ?, ?)", [now, now + 1000])).toThrow(/may not be stored/);
    const b = setup(() => ok(), { kind: "ttl", ttl: 60, adapter: "mojeek" });
    const n2 = b.clock.now();
    expect(() => b.db.run("INSERT INTO provider_result_cache (provider_id, query_hash, page, results_json, fetched_at, expires_at) VALUES (1, 'h', 1, '{}', ?, ?)", [n2, n2 + 61_000])).toThrow(/may not be stored/);
    b.db.run("INSERT INTO provider_result_cache (provider_id, query_hash, page, results_json, fetched_at, expires_at) VALUES (1, 'h', 1, '{}', ?, ?)", [n2, n2 + 60_000]);
    // Tightening the policy empties the cache.
    b.db.run("UPDATE search_providers SET storage_kind = 'none', storage_ttl_seconds = 0 WHERE id = 1");
    expect(b.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM provider_result_cache")!.n).toBe(0);
  });

  it("the database refuses a policy looser than the provider allows", () => {
    const a = setup(() => ok());
    const now = a.clock.now();
    expect(() => a.db.run("INSERT INTO search_providers (public_id, adapter, name, storage_kind, created_at, updated_at) VALUES ('prv_b', 'brave', 'B', 'ttl', ?, ?)", [now, now])).toThrow(/looser/);
    expect(() => a.db.run("INSERT INTO search_providers (public_id, adapter, name, storage_kind, storage_ttl_seconds, created_at, updated_at) VALUES ('prv_m', 'mojeek', 'M', 'ttl', 7200, ?, ?)", [now, now])).toThrow(/looser/);
  });
});
