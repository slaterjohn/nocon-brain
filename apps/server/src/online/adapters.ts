import { checkResultUrl, htmlToText } from "./normalise.js";
import {
  SearchError, type AdapterConfig, type AdapterId, type AdapterInfo, type HttpClient, type ProviderAdapter, type ProviderResponse, type ProviderResult, type SearchQuery,
} from "./types.js";

/** Parses a JSON body or throws the typed error for a malformed answer. */
function parseJson(body: string, what: string): Record<string, unknown> {
  let v: unknown;
  try { v = JSON.parse(body); } catch { throw new SearchError("bad_request", `${what} did not answer with JSON.`, { retryable: false }); }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new SearchError("upstream", `${what} answered with something unexpected.`, { retryable: false });
  return v as Record<string, unknown>;
}

/** Maps HTTP status codes to the shared error codes. 2xx returns normally. */
function checkStatus(status: number, headers: Record<string, string>, what: string): void {
  if (status >= 200 && status < 300) return;
  const ra = (() => {
    const h = headers["retry-after"];
    if (!h) return undefined;
    if (/^\d+$/.test(h.trim())) return Number(h) * 1000;
    const t = Date.parse(h);
    return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now());
  })();
  if (status === 429) throw new SearchError("rate_limited", `${what} is rate limiting requests.`, { status, retryAfterMs: ra, retryable: false });
  if (status === 401 || status === 403) throw new SearchError("auth", `${what} refused the request (HTTP ${status}). Check the key.`, { status, retryable: false });
  if (status === 402) throw new SearchError("quota_exhausted", `${what} says the plan's quota is used up.`, { status, retryable: false });
  if (status >= 500) throw new SearchError("upstream", `${what} had an error (HTTP ${status}).`, { status, retryAfterMs: ra });
  throw new SearchError("bad_request", `${what} rejected the request (HTTP ${status}).`, { status, retryable: false });
}

function pick(raw: unknown[], q: SearchQuery, pageSize: number, map: (r: Record<string, unknown>) => { url: unknown; title: unknown; snippet: unknown; extra?: Partial<ProviderResult> }): { results: ProviderResult[]; dropped: number } {
  const results: ProviderResult[] = [];
  let dropped = 0;
  const page = q.page ?? 1;
  raw.forEach((r, i) => {
    if (typeof r !== "object" || r === null) { dropped++; return; }
    const m = map(r as Record<string, unknown>);
    const u = checkResultUrl(m.url);
    if (!u) { dropped++; return; }
    const title = htmlToText(m.title, 300) || u.host;
    results.push({
      ...m.extra, url: u.url, title, snippet: htmlToText(m.snippet, 400),
      rank: results.length + 1, providerRank: (page - 1) * pageSize + results.length + 1,
    });
    void i;
  });
  return { results, dropped };
}

const SEARXNG_INFO: AdapterInfo = {
  id: "searxng", label: "SearXNG", needsBaseUrl: true, needsKey: false, defaultBaseUrl: null, maxPageSize: 20, defaultRatePerSec: 5, hosted: false,
  storage: { policy: "unrestricted", maxTtlSeconds: null, note: "SearXNG itself sets no limit; the engines it queries have their own terms. Nothing is cached unless you set a cache time." },
};

export const searxng: ProviderAdapter = {
  info: SEARXNG_INFO,
  async search(q, cfg, http) {
    const base = (cfg.baseUrl ?? "").replace(/\/+$/, "");
    const u = new URL(base + "/search");
    u.searchParams.set("q", q.query);
    u.searchParams.set("format", "json");
    u.searchParams.set("pageno", String(q.page ?? 1));
    if (q.language) u.searchParams.set("language", q.language);
    u.searchParams.set("safesearch", q.safesearch === "strict" ? "2" : q.safesearch === "off" ? "0" : "1");
    const res = await http.get(u.href, { signal: q.signal, headers: { accept: "application/json" } });
    if (res.status === 403) {
      throw new SearchError("bad_request", "SearXNG refused the JSON format. Add json to search.formats in its settings.yml (formats: [html, json]) and restart it.", { status: 403, retryable: false });
    }
    checkStatus(res.status, res.headers, "SearXNG");
    const j = parseJson(res.body, "SearXNG");
    if (!Array.isArray(j.results)) throw new SearchError("upstream", "SearXNG answered without a results list.", { retryable: false });
    const { results, dropped } = pick(j.results, q, 10, (r) => ({
      url: r.url, title: r.title, snippet: r.content,
      extra: {
        engines: Array.isArray(r.engines) ? r.engines.filter((e): e is string => typeof e === "string").slice(0, 8) : undefined,
        publishedAt: typeof r.publishedDate === "string" ? r.publishedDate.slice(0, 40) : undefined,
      },
    }));
    const failed = Array.isArray(j.unresponsive_engines)
      ? j.unresponsive_engines.map((e) => (Array.isArray(e) ? String(e[0]) : String(e))).filter(Boolean).slice(0, 20)
      : [];
    return { results, dropped, hasMore: results.length > 0, ...(failed.length ? { partial: { failedEngines: failed } } : {}) };
  },
  async health(cfg, http, signal) {
    try {
      const r = await searxng.search({ query: "test", signal }, cfg, http);
      return { ok: true, detail: `${r.results.length} results` };
    } catch (e) { return { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
  },
};

const BRAVE_INFO: AdapterInfo = {
  id: "brave", label: "Brave Search", needsBaseUrl: false, needsKey: true, defaultBaseUrl: "https://api.search.brave.com", maxPageSize: 20, defaultRatePerSec: 1, hosted: true,
  storage: { policy: "none", maxTtlSeconds: 0, note: "Brave's terms allow transient use only. Results are shown and then forgotten: they are never cached, indexed or saved. Saving a result archives the page itself." },
};

export const brave: ProviderAdapter = {
  info: BRAVE_INFO,
  async search(q, cfg, http) {
    if (!cfg.apiKey) throw new SearchError("auth", "Brave needs an API key.", { retryable: false });
    const base = (cfg.baseUrl ?? BRAVE_INFO.defaultBaseUrl!).replace(/\/+$/, "");
    const size = Math.min(q.pageSize ?? 10, BRAVE_INFO.maxPageSize);
    const u = new URL(base + "/res/v1/web/search");
    u.searchParams.set("q", q.query);
    u.searchParams.set("count", String(size));
    u.searchParams.set("offset", String(Math.min(9, (q.page ?? 1) - 1)));
    u.searchParams.set("safesearch", q.safesearch ?? "moderate");
    if (q.region) u.searchParams.set("country", q.region);
    if (q.language) u.searchParams.set("search_lang", q.language.split("-")[0]!.toLowerCase());
    const res = await http.get(u.href, { signal: q.signal, headers: { accept: "application/json", "x-subscription-token": cfg.apiKey } });
    checkStatus(res.status, res.headers, "Brave");
    const j = parseJson(res.body, "Brave");
    const web = (j.web ?? {}) as { results?: unknown };
    const list = Array.isArray(web.results) ? web.results : [];
    const { results, dropped } = pick(list, { ...q, page: 1 }, size, (r) => ({
      url: r.url, title: r.title, snippet: r.description,
      extra: { publishedAt: typeof r.age === "string" ? r.age.slice(0, 40) : undefined },
    }));
    const offset = Math.min(9, (q.page ?? 1) - 1);
    results.forEach((r, i) => { r.providerRank = offset * size + i + 1; });
    const rl = Number(res.headers["x-ratelimit-remaining"]?.split(",")[0]);
    return { results, dropped, hasMore: results.length >= size && offset < 9, ...(Number.isFinite(rl) ? { rateLimit: { remaining: rl } } : {}) };
  },
  async health(cfg, http, signal) {
    try {
      const r = await brave.search({ query: "test", pageSize: 1, signal }, cfg, http);
      return { ok: true, detail: `${r.results.length} results` };
    } catch (e) { return { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
  },
};

const MOJEEK_INFO: AdapterInfo = {
  id: "mojeek", label: "Mojeek", needsBaseUrl: false, needsKey: true, defaultBaseUrl: "https://api.mojeek.com", maxPageSize: 10, defaultRatePerSec: 2, hosted: true,
  storage: { policy: "ttl", maxTtlSeconds: 3600, note: "Mojeek's Startup plan allows results to be cached for one hour. NoConBrain never keeps them longer." },
};

export const mojeek: ProviderAdapter = {
  info: MOJEEK_INFO,
  async search(q, cfg, http) {
    if (!cfg.apiKey) throw new SearchError("auth", "Mojeek needs an API key.", { retryable: false });
    const base = (cfg.baseUrl ?? MOJEEK_INFO.defaultBaseUrl!).replace(/\/+$/, "");
    const size = Math.min(q.pageSize ?? 10, MOJEEK_INFO.maxPageSize);
    const page = q.page ?? 1;
    const u = new URL(base + "/search");
    u.searchParams.set("q", q.query);
    u.searchParams.set("api_key", cfg.apiKey);
    u.searchParams.set("fmt", "json");
    u.searchParams.set("t", String(size));
    u.searchParams.set("s", String((page - 1) * size + 1));
    if (q.region) u.searchParams.set("rb", q.region.toLowerCase());
    if (q.language) u.searchParams.set("lb", q.language.split("-")[0]!.toLowerCase());
    u.searchParams.set("safe", q.safesearch === "off" ? "0" : "1");
    const res = await http.get(u.href, { signal: q.signal, headers: { accept: "application/json" } });
    checkStatus(res.status, res.headers, "Mojeek");
    const j = parseJson(res.body, "Mojeek");
    const resp = (j.response ?? {}) as { results?: unknown; status?: unknown };
    if (typeof resp.status === "string" && resp.status !== "OK") {
      throw new SearchError(/key|auth|forbidden/i.test(resp.status) ? "auth" : "upstream", `Mojeek said: ${htmlToText(resp.status, 80)}.`, { retryable: false });
    }
    const list = Array.isArray(resp.results) ? resp.results : [];
    const { results, dropped } = pick(list, q, size, (r) => ({ url: r.url, title: r.title, snippet: r.desc }));
    return { results, dropped, hasMore: results.length >= size };
  },
  async health(cfg, http, signal) {
    try {
      const r = await mojeek.search({ query: "test", pageSize: 1, signal }, cfg, http);
      return { ok: true, detail: `${r.results.length} results` };
    } catch (e) { return { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
  },
};

export const ADAPTERS: Record<AdapterId, ProviderAdapter> = { searxng, brave, mojeek };
export type { AdapterConfig, ProviderResponse };
