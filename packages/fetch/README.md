# @ncb/fetch

Guarded HTTP fetching for NoConBrain (tasks A-01 to A-04). Import from `@ncb/fetch` (source export, no build step). Everything here is pure library code: no database, no server imports, no logging. Callers log.

## URLs (A-01)

```ts
import { normaliseUrl, urlKey, tryNormaliseUrl } from "@ncb/fetch";

const n = normaliseUrl("https://www.Example.com/a//b/?utm_source=x&b=2&a=1#frag", { queryPolicy: "strip_tracking" });
n.fetchUrl; // "https://www.example.com/a//b/?utm_source=x&b=2&a=1"   what you request: fragment stripped, nothing else changed
n.key;      // "https://www.example.com/a/b/?a=1&b=2"                  what you dedup on (UNIQUE url_key). Never fetch this.
urlKey(href, opts); // same as normaliseUrl(href, opts).key
```

- `NormaliseOptions`: `{ base?: string | URL; queryPolicy?: "keep_all" | "strip_tracking" | "allowlist" | "drop_all"; allowParams?: string[] }`. Default policy `keep_all`. The hyphenated forms from the data model (`keep-all`, `strip-tracking`, `drop-all`) are accepted too.
- `allowlist` keeps only the parameters named in `allowParams` (exact, case-sensitive).
- `strip_tracking` removes `utm_*`, `mc_*`, `fbclid`, `gclid`, `msclkid`, `_ga`, `PHPSESSID`, `sid`, `jsessionid` (query and `;jsessionid=` path form) and similar. `TRACKING_PARAMS` is exported.
- `www.` and the apex are never merged; trailing slashes are preserved in `fetchUrl`; punycode via WHATWG; credentials are dropped from the key (`hasCredentials` is set so callers can refuse them).
- Throws `InvalidUrlError` (code `invalid_url`) for unparsable URLs or schemes other than http/https. `tryNormaliseUrl` returns `null` instead.

## SSRF guard (A-02)

```ts
const guard = createSsrfGuard({ allow: process.env.NCB_FETCH_ALLOW_PRIVATE_HOSTS });
guard.checkUrl("http://2130706433/");   // throws SsrfError { reason: "ip_literal" }
guard.checkRedirect(currentUrl, locationHeader); // resolves and re-validates one hop, returns URL
guard.lookup;                           // pass as undici connect.lookup (the fetcher does this for you)
```

Layers: scheme (http/https only), credentials rejected, port policy, IP-literal check (all WHATWG/legacy forms, IPv4-mapped IPv6) with `ipaddr.js` unicast-only, and a validating `connect.lookup` that returns only allowed addresses (so DNS rebinding cannot swap the address between check and connect).

Operator allowlist (default empty): comma separated entries `host`, `host:port`, `*.suffix`, `1.2.3.4`, `10.0.0.0/8`, `10.0.0.0/8:8080`. Suggested env var: `NCB_FETCH_ALLOW_PRIVATE_HOSTS` (`allowlistFromEnv()` reads it). Port policy: default denylist of well-known internal service ports (22, 25, 3306, 5432, 6379, 2375 and so on); `portPolicy: "strict"` allows only 80, 443 and `allowedPorts`.

`SsrfError.reason`: `scheme | credentials | port | ip_literal | hostname | resolved_address | invalid_url`.

## Fetcher (A-03)

```ts
const fetcher = createFetcher({
  userAgent: buildUserAgent({ version, contact }),   // "NoConBrain/<ver> (+<repo>; <contact>)"
  isOffline: () => state.forcedOffline,              // hook; no server import
  ssrf: guard,                                       // optional, default guard from env allowlist
  hooks: { beforeHop(info) {}, afterHop(info) {} },  // politeness/robots per hop; throw to abort
});
const r = await fetcher.fetch(url, { conditional: { etag, lastModified }, maxBytes: 5 * 2**20, accept: ["text/html"], signal });
```

`FetchResult`: `{ status, finalUrl, redirects: { url, status, location }[], headers (lower-case, no set-cookie), body: Buffer (or Readable with bodyMode: "stream"), contentType (sniffed, effective), declaredContentType, charset, charsetSource, notModified, retryAfterMs?, truncated, bytes: { wire, decoded }, timings: { startedAt, ttfbMs, totalMs, hops[] } }`.

- 4xx/5xx are returned as results (the pipeline decides); `429` throws `FetchError` code `rate_limited` with `retryAfterMs`; other responses carrying `Retry-After` (503) expose `retryAfterMs`.
- `FetchError.code`: `offline | invalid_url | ssrf_blocked | too_many_redirects | redirect_loop | bad_redirect | timeout_connect | timeout_headers | timeout_body | timeout_total | aborted | rate_limited | size_cap | content_length_exceeded | too_many_encodings | unsupported_encoding | content_type_blocked | network`. Errors carry `url`, `redirects`, `ssrfReason?`, `retryAfterMs?`.
- Manual redirects (max 5, guard on every hop, loop detection). Timeouts: connect 10 s, headers 15 s, body idle 30 s, wall clock 60 s (all options). Own `node:zlib` decoding (gzip, deflate, br) with a cap on decoded bytes at every layer and a limit of 3 nested encodings. No cookies are ever sent or stored.
- Content type: allowlist plus byte sniffing (a sniffed type beats a lying header). `accept` overrides the allowlist per request and is sent as `Accept`.
- Charset: BOM, then header, then `<meta>` in the first 1024 bytes. `decodeText(buffer, charset)` is exported.
- `truncateAtCap: true` returns the first `maxBytes` bytes with `truncated: true` instead of failing (used for robots.txt).
- Offline: `isOffline()` is checked before every request; throws `offline` and makes no network call.

## robots.txt (A-04)

```ts
const robots = new RobotsService({ fetcher, userAgentToken: "NoConBrain" });
const d = await robots.check(url, { bypass: userInitiatedSinglePageSave });
if (!d.allowed) skip(url, d.reason);
if (d.bypassed) activityLog("robots_bypassed", { url, reason: d.wouldBlockReason }); // the caller must log this
queue.setDelay(host, d.crawlDelayMs);
```

`RobotsDecision`: `{ allowed, reason, bypassed, wouldBlockReason?, crawlDelayMs (capped 30 s), sitemaps, robotsUrl, robotsStatus, fromCache, stale, expiresAt }`. RFC 9309: 2xx parse (first 500 KiB), other 4xx allow all, 5xx / timeout / network error disallow all temporarily (short retry TTL, stale good copy reused), up to 5 redirects, 24 h cache, matching by our UA token. `429` is treated as temporary disallow (deviation: Google does the same). Offline throws the fetcher's `offline` error and caches nothing.
