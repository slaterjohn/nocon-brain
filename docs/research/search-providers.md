# Online search providers for NoConBrain

Research date: 1 November 2026. Prices and terms change often. Items marked **(uncertain)** come from third-party sources or could not be confirmed on the provider's own page. Re-check the provider's terms before shipping an adapter.

## Summary

- **SearXNG** is the best first adapter. Self-hosted, no key, no per-query cost, official multi-arch image (amd64, arm64, arm/v7). JSON output works once `json` is added to `search.formats`. Tested here.
- **Brave Search API** is the best first *commercial* adapter: own index, $5 per 1,000 requests with a monthly credit, 50 QPS. **Caveat: Brave's terms forbid storing or caching results except transient storage**, and a separate "storage rights" plan exists. NoConBrain must not save Brave results into its archive or index unless the Human is on that plan.
- **Google Custom Search JSON API** is **closed to new customers** and ends on **1 January 2027**. Do not build an adapter.
- **Bing Web Search API** was **retired on 11 August 2025**. The replacement (Grounding with Bing Search in Azure AI Agents) returns LLM-grounded answers, not raw results. Do not build an adapter.
- **Mojeek** is a good small second adapter: independent index, from £2 per 1,000, clear caching rules (1 hour on the cheapest plan, indefinite on Business).
- **Marginalia**, **Kagi**, **Exa** and **Tavily** are optional. Marginalia suits a "small web" panel. Kagi's API is higher priced and I could not confirm current availability. Exa and Tavily are built for LLM agents and are a weaker fit.

---

## 1. Provider notes

### SearXNG (self-hosted metasearch)

Docs: https://docs.searxng.org/dev/search_api.html

- Image: `searxng/searxng:latest` on Docker Hub. `docker buildx imagetools inspect` lists **linux/amd64, linux/arm/v7, linux/arm64**. Ran natively on arm64 here.
- Memory: about 100 MB right after start, 130 MB after one query (one worker). Fine for a Pi 4 with 2 GB or more, but it is a separate Python service.
- JSON API: `GET /search?q=…&format=json`. Parameters per the docs: `q`, `categories`, `language`, `pageno` (default 1), `time_range` (`day`/`month`/`year`), `safesearch` (`0`, `1`, `2`), `format` (`json`, `csv`, `rss`). `engines` is also accepted (documented in the preferences docs **(uncertain)**).
- **JSON must be enabled**: the default config only allows `html`, and requesting a format that is not enabled returns **403 Forbidden** (docs). The settings I used for the test:

```yaml
use_default_settings: true
server:
  secret_key: "<generate with: openssl rand -hex 32>"
  limiter: false          # fine on a private network; keep true if exposed
search:
  formats: [html, json]
```

  Mounted at `/etc/searxng/settings.yml`. With the limiter off, no Valkey/Redis is required. If exposed publicly, enable the limiter and set `limiter.toml` (a missing `limiter.toml` produced only a warning).
- Tested request: `/search?q=aromaticity&format=json&language=en-GB&safesearch=1&pageno=1` returned HTTP 200 in 0.78 s with 40 results from several engines.
- **Response fields** (observed):
  - top level: `query`, `results`, `answers`, `corrections`, `infoboxes`, `suggestions`, `unresponsive_engines`
  - per result: `url`, `title`, `content` (snippet), `engines` (list), `engine`, `positions` (rank per engine), `score` (SearXNG's own merged score), `category`, `publishedDate`, `thumbnail`, `img_src`, `template`, `parsed_url`, `priority`
  - `unresponsive_engines` is a list of `[engine, reason]`, useful to report partial failure.
  - It returned a `wikipedia`/`wikidata` infobox, which may be worth rendering or ignoring.
- Rank: results arrive already merged and sorted. Use array order as rank and keep `engines`/`score` as provider metadata.
- Terms: SearXNG itself is AGPL-3.0, so it is licence-friendly. The upstream engines (Google, Brave, DuckDuckGo, etc.) are scraped, so their terms apply to the instance operator, and engines often rate-limit or CAPTCHA a home IP. In this test several engines responded (brave, google cse, duckduckgo). Stability varies: engines break and recover. The Human self-hosts and is responsible for use.
- Storing results: no licence restriction from SearXNG; upstream engine terms are the Human's concern. Mark results as `storage: "unknown"` in provider metadata.
- Public instances: most disable JSON; do not rely on them.

### Brave Search API

Pages: https://brave.com/search/api/, terms at https://api-dashboard.search.brave.com/documentation/resources/terms-of-service. The dashboard pricing page is a client-rendered shell and could not be read directly.

- Plans on brave.com/search/api (fetched 1 Nov 2026):
  - **Search**: $5 per 1,000 requests, $5 free credit each month (about 1,000 requests), **50 QPS**. Features: Goggles, extra snippets, schema-enriched results.
  - **Answers**: $4 per 1,000 plus $5 per million tokens, $5 free credit monthly, 2 QPS.
  - **Enterprise**: custom.
- The same page's headline says "Up to $20 in free calls every month", which does not match the $5 credit in the plan sections. Third-party pages disagree about the old free tier (2,000 free queries per month at 1 QPS was retired in early 2026 according to some sources). **(uncertain: check the live pricing page and a card may be required)**
- Terms (section 3(b)): customers may not "store, cache, or create a database of Search Results, in whole or in part, other than transient storage required for operation". Search Results include Generated Results and third-party content. Also forbidden: redistribution, derivative works, AI training or evaluation, and bypassing rate limits with multiple accounts. Results may not be kept after the agreement ends. Attribution ("Powered by Brave") is optional.
- Brave's docs help page (via search results) says its standard plans do not allow retaining any output and that a separate **"Data with Storage Rights"** plan allows storing the full JSON; its price is not public **(uncertain, secondary source)**.
- Request: `GET https://api.search.brave.com/res/v1/web/search?q=…` with header `X-Subscription-Token`. Documented parameters include `country`, `search_lang`, `ui_lang`, `count`, `offset`, `safesearch` (`off`/`moderate`/`strict`), `freshness`, `extra_snippets`, `goggles` **(from memory of earlier docs, uncertain for current version)**.
- Response: `web.results[]` with `title`, `url`, `description`, `age`, `language`, `extra_snippets`, plus `query`, `mixed`, `infobox`, `news`, `videos` **(from memory, uncertain)**. Rate-limit headers are `X-RateLimit-Limit/Remaining/Reset` **(uncertain)**.
- Fit: very good for live "online mode" search of a personal tool: the user's query is not shared or trained on (per brave.com). The no-storage rule means NoConBrain should keep Brave results only in memory (and in a short-lived per-session view), and never index or archive snippets. Archiving the *page* the Human chooses to open is a separate action: fetching the page itself from the original site, not copying Brave's result data.

### Google Programmable Search / Custom Search JSON API

Official page: https://developers.google.com/custom-search/v1/overview (fetched 1 Nov 2026).

- "The Custom Search JSON API is closed to new customers." Existing customers can use it only until it is **discontinued on 1 January 2027**. New projects reportedly get HTTP 403 `PERMISSION_DENIED` **(uncertain, from vendor blogs)**.
- Free quota 100 queries per day, $5 per 1,000 beyond, max 10,000 per day (existing customers).
- Whole-web search: engines created after 20 January 2026 cannot use the "search the entire web" setting; "Sites to search" is limited to 50 domains. Google's page points full-web needs to contacting Google, and recommends Vertex AI Search for up to 50 domains. **(Whole-web details from third-party summaries, uncertain.)**
- Verdict: **not viable.** Skip it. SearXNG has a `google cse` engine and other engines that scrape; that is the operator's risk, not a supported API.

### Bing Web Search API

Official notice: https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement

- "Bing Search APIs will be retired on August 11, 2025." Existing instances were decommissioned; no new signups.
- Replacement offered: **Grounding with Bing Search** in Azure AI Agents, for LLM agents to use real-time web data. Third-party sources say it does not give developers raw results, and cost either $14 or $35 per 1,000 transactions (sources conflict). **(uncertain)**
- Verdict: **not usable** as a search-results provider. Skip.

### Mojeek Search API

Page: https://www.mojeek.com/services/api.html (fetched 1 Nov 2026). Own independent crawler and index (UK).

- Startup: £2 per 1,000 requests, up to 10 results per request, 5 QPS, 100,000 per day; free credit on signup (card required).
- Business: £3 per 1,000, up to 40 results per request, 10 QPS, 400,000 per day.
- Storage: **Startup results can be cached for one hour; Business and Enterprise allow indefinite retention.** No attribution required. Commercial use allowed. The terms are at https://www.mojeek.com/about/legal/api-terms.html (not read in full).
- Parameters: country and language boosting, safesearch, title and description lengths, ranking and clustering (see their Request Parameters page, not read in full). Each result includes URL, title and a query-dependent snippet. JSON and XML supported.
- Fit: good. Cheap, clear terms, privacy-friendly, independent index. Index is smaller than Google or Bing, so recall is lower for obscure queries.

### Marginalia Search API

Docs: https://about.marginalia-search.com/article/api (could not fetch directly; details from a search summary, **uncertain**).

- Independent index focused on non-commercial, text-heavy "small web" sites. Search engine code is AGPL-3.0.
- Current API host: `api2.marginalia-search.com`, key in an `API-Key` header, endpoint `/search` with a query parameter. A shared public key exists for trying things out and often hits the rate limit. A personal key for non-commercial use is available by emailing the operator, under CC-BY-NC-SA 4.0. The old `api.marginalia.nu` API is deprecated.
- Fit: a nice optional adapter for discovery of personal sites, blogs and documentation. Not a general web search. The non-commercial licence is fine for a personal tool; check the terms before storing results **(uncertain)**.

### Kagi Search API

Docs: https://kagi.com/api/docs (fetched; thin) and https://help.kagi.com/kagi/api/search.html.

- The API is `POST https://kagi.com/api/v1/search` with a bearer key. It inherits the account's personalisation (blocked and promoted sites, lenses). Terms at https://kagi.com/privacy/api (not read).
- Pricing and access: the docs page does not list prices. Third-party trackers quote figures from $2.50 to $25 per 1,000 searches and disagree on availability and free trials. **(uncertain, verify on Kagi's pricing page.)** Historically the API was invite-only and more expensive than rivals.
- Fit: high-quality results, but a Kagi subscription is likely required; a good optional adapter for people who already pay for Kagi. Terms on storage unknown.

### Exa

Pricing: https://exa.ai/pricing (fetched 1 Nov 2026).

- Per 1,000 requests, up to 10 results: `lite`/`instant` $4, `auto`/`fast` $7, deep search $12 to $15. Extra results $1 per 1,000. Free tier: $10 of credit at signup, reset to $10 monthly (about 2,500 lite searches), no card.
- A neural/semantic search engine aimed at AI agents, returning content and highlights. QPS limits not published for standard plans.
- Terms on caching/storage: not confirmed. One third-party site claims Exa forbids persistent caching **(unverified)**. Check https://exa.ai/terms before shipping.
- Fit: moderate. Good for "find pages like this" and research queries; less suited to everyday keyword search.

### Tavily

Pricing: https://www.tavily.com/pricing (fetched 1 Nov 2026).

- Free "Researcher" plan: 1,000 credits per month, no card. Pay as you go $0.008 per credit. Project $30 per month for 4,000 credits. Rate limits not published.
- Built to feed LLMs: returns summarised content. Storage terms unconfirmed.
- Fit: weak for a classic results list; optional.

---

## 2. Comparison table

| Provider | Status (Nov 2026) | Cost | Free tier | Rate limit | Raw results | Storing results | Needs key | ARM64 / self-host | Fit |
|---|---|---|---|---|---|---|---|---|---|
| SearXNG | Active, self-hosted | Free (own hardware) | n/a | Upstream engines may throttle | Yes (JSON) | No SearXNG limit; upstream terms apply | No | Yes, official multi-arch image | **Ship first** |
| Brave Search API | Active | $5 / 1,000 | $5 credit per month (headline claims up to $20, uncertain) | 50 QPS (Search plan) | Yes | **No** (transient only) unless a storage-rights plan | Yes | Hosted | **Ship first (commercial)** |
| Google Custom Search JSON | Closed to new customers, ends 2027-01-01 | $5 / 1,000 (existing only) | 100/day (existing only) | 10,000/day | Yes | Not reviewed | n/a | Hosted | **Do not build** |
| Bing Web Search API | Retired 2025-08-11 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | **Do not build** |
| Grounding with Bing (Azure AI Agents) | Active, agent-only | $14 or $35 / 1,000 (sources conflict) | None known | Azure quotas | No raw results | Restricted | Azure account | Hosted | **Not suitable** |
| Mojeek | Active | £2 / 1,000 (Startup); £3 (Business) | Free credit on signup | 5 QPS (Startup), 10 (Business) | Yes | 1 hour (Startup); indefinite (Business) | Yes | Hosted | **Ship second** |
| Marginalia | Active, community | Free for non-commercial personal key | Yes | Strict, public key often limited | Yes | Unconfirmed | Yes (shared or personal) | Hosted | Optional |
| Kagi | Active, access unclear | About $2.50 to $25 / 1,000 (sources conflict) | Unclear | Unknown | Yes | Unknown | Yes | Hosted | Optional |
| Exa | Active | $4 to $15 / 1,000 | $10 credit monthly | Not published | Yes plus content | Unconfirmed | Yes | Hosted | Optional |
| Tavily | Active | $0.008 / credit | 1,000 credits monthly | Not published | LLM-oriented | Unconfirmed | Yes | Hosted | Optional |

---

## 3. Recommendation

### Adapters to ship first

1. **SearXNG** (default; offered in the compose file as an optional profile with `formats: [html, json]`).
2. **Brave Search API** (bring-your-own key; clear UI note that results are not stored).
3. **Mojeek** (bring-your-own key; stored for up to the plan's cache time only).
4. Later and optional: Marginalia, Kagi, Exa, Tavily. A "generic JSON provider" adapter (URL template plus JSONPath mapping) would let the Human wire in others without code.

Do not add Google CSE or Bing.

### Rules for storing results (the policy layer)

Each adapter declares `storagePolicy` in its metadata:

- `none`: keep only in memory for the active session (Brave standard).
- `ttl:<seconds>`: allowed to cache (Mojeek Startup: 3600).
- `unrestricted`: no known restriction (SearXNG; still subject to upstream engines).

The result cache and the local index writer check this field. Even when results are not stored, NoConBrain may archive a *page* when the Human explicitly saves it, because that is fetching the original page, not Brave's data. Do not save the provider's snippet as the page's description for `none` providers.

### Generic adapter interface

```ts
interface SearchQuery {
  query: string;
  language?: string;      // BCP 47, for example "en-GB"
  region?: string;        // ISO 3166-1 alpha-2, for example "GB"
  safesearch?: "off" | "moderate" | "strict";
  page?: number;          // 1-based
  pageSize?: number;      // provider may clamp
  freshness?: "day" | "week" | "month" | "year";   // optional
  signal: AbortSignal;    // caller-controlled timeout and cancellation
}

interface SearchResult {
  url: string;            // canonicalised
  title: string;
  snippet: string;        // plain text; HTML stripped
  rank: number;           // 1-based position within the provider's page
  providerRank?: number;  // absolute rank (offset + position)
  provider: string;       // "searxng" | "brave" | "mojeek"
  metadata: {
    engines?: string[];       // SearXNG sub-engines
    providerScore?: number;   // not comparable across providers
    publishedAt?: string;
    storage: "none" | { ttlSeconds: number } | "unrestricted";
    raw?: unknown;            // only kept when storage allows
  };
}

interface SearchResponse {
  provider: string;
  results: SearchResult[];
  hasMore: boolean;
  totalEstimate?: number;
  rateLimit?: { limit?: number; remaining?: number; resetAt?: Date };
  partial?: { failedEngines: string[] };   // SearXNG unresponsive_engines
  tookMs: number;
}

type SearchErrorCode =
  "timeout" | "rate_limited" | "auth" | "quota_exhausted" |
  "bad_request" | "upstream" | "network" | "disabled" | "unsupported";

class SearchError extends Error {
  code: SearchErrorCode;
  retryAfterMs?: number;     // from Retry-After or reset header
  status?: number;
  retryable: boolean;
}

interface SearchProvider {
  id: string;
  capabilities: { language: boolean; region: boolean; safesearch: boolean;
                  freshness: boolean; maxPageSize: number; storage: StoragePolicy };
  search(q: SearchQuery): Promise<SearchResponse>;   // throws SearchError
  health(): Promise<{ ok: boolean; detail?: string }>;
}
```

Behaviours the runner (not each adapter) should own:

- **Timeouts**: default 4 s per provider for interactive search, using `AbortSignal.timeout`. Local results never wait for online ones.
- **Retry**: at most one retry, only for `network`/`upstream` errors that are `retryable`, with jitter. Never retry on `auth` or `quota_exhausted`.
- **Rate limits**: a per-provider token bucket (for example Brave 1 to 5 requests per second client side, well under 50 QPS; Mojeek under 5 QPS), plus respect for `Retry-After` and `X-RateLimit-*` headers. After a 429, open a circuit for the `retryAfterMs` window and show "Brave is rate-limited" in the UI.
- **Budget**: a monthly request counter per paid provider with a configurable cap, so a bug cannot run up a bill.
- **Offline**: if the app is in offline mode or the health check fails, skip online providers without error.
- **Privacy**: no query logging by default, a per-provider enable switch, and a visible indicator that a query left the machine.
- **Normalisation**: canonical URL (strip tracking parameters, lower-case host, drop fragments), HTML-to-text for snippets, and clamp `page`/`pageSize` to what the provider supports (for example Mojeek 10 per request on Startup).

### Merging with local results: weighted reciprocal rank fusion

Reciprocal rank fusion (Cormack, Clarke and Buettcher, SIGIR 2009) scores a document `d` as `Σ_i  w_i / (k + rank_i(d))`, with `k = 60` as the usual constant. It uses only ranks, so it works with scores that are not comparable (ZIM's 0 to 100, SearXNG's score, Brave's none).

Suggested weights, to be tuned with real queries:

| Source | Weight `w` |
|---|---|
| Local archive/index (the Human's own pages) | 1.5 |
| ZIM full-text (per ZIM) | 1.0 |
| Online providers | 1.0 each (0.7 if a second online provider overlaps heavily) |

Details:

1. **Dedupe by canonical URL** before fusing. A page that appears in the local archive and online gets the sum of both contributions, which promotes pages the Human has already saved. Keep the local copy as the primary link and show "also online" metadata.
2. Use `k = 60` for online lists and a **smaller `k` (for example 20) for local results** so that local rank 1 stays clearly above online rank 1. Alternatively add a fixed small bonus for local hits. Keep this as one config value.
3. Fuse over only the top 20 to 30 from each source, to bound cost.
4. Tie-break by: local first, then higher fused score, then earlier `providerRank`, then URL string, so ordering is deterministic.
5. Wikipedia: a ZIM hit and a live `en.wikipedia.org/wiki/X` hit from a web provider are the same document. Canonicalise Wikipedia URLs to `wikipedia:<lang>:<title>` so they merge, and prefer the offline copy.

### Stable ordering when online results arrive late

The results page is built in stages. Local and ZIM results come back in tens of milliseconds, online providers in 300 ms to 2 s or never.

Recommended behaviour: **append-only progressive merge with a freeze on interaction.**

1. **Stage 1 (immediate):** render local plus ZIM results, ranked by RRF. This is the stable "above the fold".
2. **Stage 2 (online arrives):** compute the full RRF, but do not move any already-visible result. Handle three cases:
   - **New online-only results**: insert only *below the current viewport*, or append to the end of the list under a quiet "More from the web" divider. Never insert above something the Human is looking at.
   - **Results that appear in both**: update their metadata in place (a badge such as "also on the web", an extra snippet) without moving them.
   - **Rank changes** that would reorder visible items: hold them back. Offer a non-intrusive "Re-rank with web results" button; apply only on click.
3. **Freeze on interaction:** once the Human scrolls, focuses a result, hovers for more than about 300 ms, or starts typing in the filter, the ordering of everything rendered so far is frozen. Later arrivals are only appended.
4. **Time box:** after a deadline (for example 2 s) or when all providers have answered, stop updating. Slow providers after that go into a "Load more from the web" action, not the live list.
5. **Reserve layout space:** show a fixed-height "Searching the web…" placeholder at the bottom so the page does not jump. Announce updates politely for screen readers with `aria-live="polite"` (a single "12 more results from the web" message rather than each result).
6. **Different sessions can differ:** do not promise identical order for repeat queries, since online data changes. For the same session, keep a snapshot so back navigation restores the exact list (store the ordered list of URLs in memory or session storage; this stores only URLs and not snippets for `storage: none` providers).
7. **Pagination:** page 2 fetches the next page from each provider and runs the same append-only rule. Rank offsets use the provider's absolute rank.

The fusion weights should be changeable at runtime, and the server should expose both the fused order and each source's rank, so the UI can display "local #2, Brave #5" in a debug view.

---

## 4. Open points

1. Confirm the live Brave pricing page (free credit, whether a card is needed, price of the storage-rights plan).
2. Read the full Mojeek, Kagi, Exa and Tavily terms for storage wording before enabling any caching.
3. Confirm Marginalia's current key process and terms.
4. Test the SearXNG JSON API behind the limiter, and over a few days to see how often upstream engines return CAPTCHAs from a home IP.
5. Decide whether the "generic JSON provider" adapter is worth building in the first release.

## Sources

- https://docs.searxng.org/dev/search_api.html (and hands-on test with `searxng/searxng:latest`, arm64)
- https://brave.com/search/api/
- https://api-dashboard.search.brave.com/documentation/resources/terms-of-service
- https://developers.google.com/custom-search/v1/overview
- https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement
- https://www.mojeek.com/services/api.html
- https://about.marginalia-search.com/article/api (via search summary)
- https://help.kagi.com/kagi/api/search.html and https://kagi.com/api/docs
- https://exa.ai/pricing
- https://www.tavily.com/pricing
- Cormack, Clarke, Buettcher, "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods", SIGIR 2009
