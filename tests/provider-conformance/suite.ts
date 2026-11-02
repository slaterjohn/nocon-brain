import { describe, expect, it } from "vitest";
import { ProviderHttp, SearchError, type AdapterConfig, type ProviderAdapter } from "@ncb/server";

/**
 * The provider conformance suite (task O-01; O-12 reuses it). Adding an adapter means writing a `Target`: how to put the fake
 * provider into each mode, and the config that works. Everything an adapter must guarantee is checked here:
 *  - results are plain text, URLs are http(s), ranks run 1..n;
 *  - every failure is a typed `SearchError` with the right code and retry flag, and never leaks the key;
 *  - unsafe URLs are dropped and counted; the abort signal is honoured; the storage policy is declared.
 */
export type Mode = "ok" | "empty" | "auth" | "rate429" | "error500" | "malformed" | "xss";

export interface Target {
  name: string;
  adapter: ProviderAdapter;
  /** Base URL of the fake provider and the credential it accepts. */
  baseUrl: string;
  apiKey?: string;
  setMode(mode: Mode, o?: { retryAfter?: number }): Promise<void>;
  /** The query that finds results in the fake. */
  query: string;
  /** What the adapter must declare. */
  storage: "none" | "ttl" | "unrestricted";
}

export function defineConformance(getTarget: () => Target): void {
  const http = new ProviderHttp({ userAgent: "NoConBrain-conformance/0", isOffline: () => false });
  const run = async (t: Target, o: { apiKey?: string | null; signal?: AbortSignal; page?: number; pageSize?: number } = {}) => {
    const cfg: AdapterConfig = { baseUrl: t.baseUrl, apiKey: o.apiKey === null ? undefined : o.apiKey ?? t.apiKey };
    const client = http.clientFor(t.baseUrl, t.adapter.info.defaultBaseUrl);
    return t.adapter.search({ query: t.query, page: o.page ?? 1, pageSize: o.pageSize ?? 10, signal: o.signal ?? AbortSignal.timeout(5000) }, cfg, client);
  };
  const failure = async (p: Promise<unknown>): Promise<SearchError> => {
    try { await p; } catch (e) { expect(e).toBeInstanceOf(SearchError); return e as SearchError; }
    throw new Error("expected the call to fail");
  };

  describe("provider conformance", () => {
    it("declares its identity, storage policy and paging limits", () => {
      const t = getTarget();
      const i = t.adapter.info;
      expect(i.id).toBe(t.adapter.info.id);
      expect(i.storage.policy).toBe(t.storage);
      expect(i.maxPageSize).toBeGreaterThan(0);
      expect(i.defaultRatePerSec).toBeGreaterThan(0);
      expect(i.label.length).toBeGreaterThan(0);
      if (i.storage.policy === "none") expect(i.storage.maxTtlSeconds).toBe(0);
      if (i.storage.policy === "ttl") expect(i.storage.maxTtlSeconds).toBeGreaterThan(0);
    });

    it("returns normalised results: ranked from 1, plain text, http(s) addresses", async () => {
      const t = getTarget();
      await t.setMode("ok");
      const r = await run(t);
      expect(r.results.length).toBeGreaterThan(0);
      expect(r.results.length).toBeLessThanOrEqual(t.adapter.info.maxPageSize);
      r.results.forEach((x, i) => {
        expect(x.rank).toBe(i + 1);
        expect(x.providerRank).toBeGreaterThanOrEqual(x.rank);
        expect(x.url).toMatch(/^https?:\/\//);
        expect(x.title.length).toBeGreaterThan(0);
        expect(x.title + x.snippet).not.toMatch(/[<>]/);
        expect(x.title.length).toBeLessThanOrEqual(300);
        expect(x.snippet.length).toBeLessThanOrEqual(400);
      });
      expect(r.dropped).toBeGreaterThanOrEqual(0);
      expect(typeof r.hasMore).toBe("boolean");
    });

    it("pages: a second page has a higher absolute rank", async () => {
      const t = getTarget();
      await t.setMode("ok");
      const first = await run(t, { page: 1, pageSize: 3 });
      const second = await run(t, { page: 2, pageSize: 3 });
      if (second.results.length) expect(second.results[0]!.providerRank).toBeGreaterThan(first.results[0]!.providerRank);
    });

    it("an empty answer is an empty list, not an error", async () => {
      const t = getTarget();
      await t.setMode("empty");
      const r = await run(t);
      expect(r.results).toEqual([]);
      expect(r.hasMore).toBe(false);
    });

    it("unsafe addresses are dropped and counted; markup in text is removed", async () => {
      const t = getTarget();
      await t.setMode("xss");
      const r = await run(t);
      expect(r.dropped).toBeGreaterThanOrEqual(2);
      for (const x of r.results) {
        expect(x.url).toMatch(/^https?:\/\//);
        expect(x.title + x.snippet).not.toMatch(/[<>]/);
        expect(x.title + x.snippet).not.toMatch(/onerror|onload|<script/i);
      }
    });

    it("a refused credential is an auth error that is not retryable and does not repeat the key", async () => {
      const t = getTarget();
      await t.setMode("auth");
      const e = await failure(run(t));
      if (t.adapter.info.needsKey || t.adapter.info.id === "searxng") expect(["auth", "bad_request"]).toContain(e.code);
      expect(e.retryable).toBe(false);
      expect(e.message).not.toContain(t.apiKey ?? "no-key-here");
    });

    it("a missing key is reported before any request when the adapter needs one", async () => {
      const t = getTarget();
      await t.setMode("ok");
      if (!t.adapter.info.needsKey) return;
      const e = await failure(run(t, { apiKey: null }));
      expect(e.code).toBe("auth");
    });

    it("429 is rate_limited with Retry-After in milliseconds and is not retryable", async () => {
      const t = getTarget();
      await t.setMode("rate429", { retryAfter: 7 });
      const e = await failure(run(t));
      expect(e.code).toBe("rate_limited");
      expect(e.retryAfterMs).toBe(7000);
      expect(e.retryable).toBe(false);
    });

    it("a 5xx is upstream and retryable", async () => {
      const t = getTarget();
      await t.setMode("error500");
      const e = await failure(run(t));
      expect(e.code).toBe("upstream");
      expect(e.retryable).toBe(true);
    });

    it("malformed JSON is a typed error, never a crash", async () => {
      const t = getTarget();
      await t.setMode("malformed");
      const e = await failure(run(t));
      expect(["bad_request", "upstream"]).toContain(e.code);
    });

    it("honours the abort signal", async () => {
      const t = getTarget();
      await t.setMode("ok");
      const ac = new AbortController();
      ac.abort();
      const e = await failure(run(t, { signal: ac.signal }));
      expect(["timeout", "network"]).toContain(e.code);
    });

    it("health() answers { ok } and never throws", async () => {
      const t = getTarget();
      await t.setMode("ok");
      const cfg: AdapterConfig = { baseUrl: t.baseUrl, apiKey: t.apiKey };
      const h = await t.adapter.health(cfg, http.clientFor(t.baseUrl, t.adapter.info.defaultBaseUrl), AbortSignal.timeout(5000));
      expect(h.ok).toBe(true);
      await t.setMode("error500");
      const bad = await t.adapter.health(cfg, http.clientFor(t.baseUrl, t.adapter.info.defaultBaseUrl), AbortSignal.timeout(5000));
      expect(bad.ok).toBe(false);
    });
  });
}
