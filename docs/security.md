# Security

How NoConBrain is meant to resist attack, what each container may do, and how secrets are handled. This page is the working record for the hardening phase (H-03): the design, the tests behind it, and what the review found. To report a problem, see [SECURITY.md](../SECURITY.md).

## Threat model in short

NoConBrain is a single-user, self-hosted server. The administrator is trusted. What is not trusted:

- **Archived content.** Pages, stylesheets, scripts and ZIM entries come from the open web. They must never run script in the app's origin, read its cookies or reach the API.
- **Remote servers.** A page, a redirect or a feed can point at an address inside the network. Every outbound request is checked against private ranges.
- **Other containers on a shared network**, such as SearXNG, and anything else that can reach the API port.
- **Other people on the LAN**, when trusted-LAN read-only mode is on.
- **The browser renderer**, which runs untrusted pages in Chromium.

Out of scope: an attacker with administrator access or a shell on the host.

## Isolation design

| Boundary | Mechanism |
|---|---|
| Archived pages vs the app | Pages are served from a separate origin (the archive listener, port 3002) inside a sandboxed frame with a strict Content-Security-Policy, short-lived signed tokens bound to the app origin, and rewritten links. No cookie of the app is ever sent there |
| API vs other containers | The API port is not published. The API refuses any request that neither carries the shared proxy secret (the `web` container adds it) nor comes from inside its own container (the health check). This applies even on a shared Docker network (HB-01, `NCB_API_PROXY_ONLY`, default on). The secret also counts only when the request comes from the `backend` network (HB-11, `NCB_API_PROXY_FROM`), so a container that holds a copy of it, such as the renderer, cannot use it. Client addresses and forwarded hosts are trusted only with the secret |
| `web` vs the internet | `web` is on `frontend` (no masquerade) and `backend` (internal). On Linux that leaves it no route out. Docker Desktop for Mac does not honour the masquerade setting; see HB-02 in the hardening backlog |
| Server vs internet | One fetcher with an SSRF guard: scheme, credentials, ports, IP literals in every spelling, and a resolver that is the only way a name becomes an address, so the checked address is the used address |
| Renderer vs everything | The `renderer` container is only on the internal `render` network. Its one way out is the guarded forward proxy that `server` runs. The proxy listens only on the server's address in the `render` subnet (HB-07, `NCB_RENDER_PROXY_HOST` is that subnet), so `web` and `searxng` cannot reach it, and it also needs the renderer secret |
| Fetched pages vs the database | Extraction and PDF parsing run in worker threads with a memory limit; they never touch the database |

## Container capabilities

Every container drops all Linux capabilities (`cap_drop: [ALL]`), sets `no-new-privileges`, has a read-only root file system, small `tmpfs` mounts, memory and process limits, and runs as an unprivileged user.

**The one exception is the renderer, which adds back `CAP_SYS_CHROOT` (HB-08).** Chromium's own sandbox calls `chroot()` as part of setting up its renderer processes. Playwright's seccomp profile (`docker/renderer/seccomp.json`, from `microsoft/playwright`) allows `chroot()` only for a process that holds this capability, and allows the user namespaces Chromium needs. So the renderer gets exactly that capability and nothing else, and Chromium runs with its sandbox on (no `--no-sandbox`). What the capability allows: changing a process's root directory, inside the container's own mount namespace. It does not allow mounting, raw network access, loading kernel modules or any change outside the container. The renderer also has no route to the internet or the LAN, a read-only root and a 1 GiB memory limit. The decision stays under review: if a rootless Chromium sandbox option appears that works under Docker's default seccomp profile, the capability can be removed. A host that forbids unprivileged user namespaces (some hardened Ubuntu settings) stops the renderer from starting; the server then keeps the plain capture.

## Secrets

| Secret | Use | Where it lives |
|---|---|---|
| `NCB_PROXY_SECRET` | Proves a request came from `web` (and only from the `backend` network); also the default renderer and SearXNG secrets, so set `NCB_RENDERER_SECRET` and `NCB_SEARXNG_SECRET` separately when you can | `.env`; required in production (at least 16 characters); never logged (header redacted in logs) |
| `NCB_RENDERER_SECRET` | Password the renderer uses at the forward proxy | `.env`, defaults to the proxy secret |
| `NCB_SECRET_KEY` or `/data/secrets/secret.key` | AES-256-GCM key for stored search-provider credentials and the archive token signature | Environment, or a file with mode 0600 generated on first start. Not in backups unless asked for |
| Provider API keys | Brave, Mojeek | Encrypted at rest, never returned by the API, redacted in logs |
| Passwords | Administrator login | scrypt hashes; sessions are random tokens stored hashed |

Losing the secret key means entering provider keys again and signing in again; no archive data is lost.

## Tests behind these claims

The `security` vitest project (`pnpm test:security`, files in `tests/security/`) is the named suite for task H-03. The older tests below stay where they are and keep running with `pnpm test:integration`.

| Check | Where | What it proves |
|---|---|---|
| Authorisation matrix | `tests/security/authz-matrix.test.ts` | Every API route, read from Fastify's own route table, against anonymous, trusted-LAN guest, administrator, no or wrong proxy secret, missing CSRF header, wrong `Origin`, cross-site fetch metadata, and an unfinished set-up |
| Proxy-secret source | `tests/security/api-proxy-source.test.ts` | The secret only counts from the `backend` network; the compose file keeps the renderer and SearXNG off it |
| SSRF guard fuzzing | `tests/security/ssrf-guard.test.ts` with the corpus in `ssrf-corpus.ts` | 781 direct targets, 25 redirect forms and 36 malformed addresses, plus about 11,000 generated spellings of private addresses, are refused; public addresses still pass |
| SSRF at every entry point | `tests/security/ssrf-entrypoints.test.ts` with `hostile.ts` | The corpus through save page, live check, downloads, first source, crawl, sitemap, feed, robots, assets, redirects, the renderer proxy, the Wikipedia client, ZIM registration, provider redirects and the probe address |
| XSS: archived pages | `tests/security/xss-serving.test.ts` | The sanitiser corpus, hostile titles, addresses and credits, the interstitial, error pages, reader preferences, sub-resources, headers on every route class, token tampering, cookie and CORS behaviour |
| XSS: ZIM serving | `tests/security/xss-zim.test.ts` | A package built to attack the reader: one article per corpus vector, entries whose type disagrees with their bytes, markup in every metadata field, path tricks |
| XSS: search | `tests/security/xss-search.test.ts` | Snippets and highlighted titles hold `<mark>` and nothing else (ZIM snippets: `<b>` and nothing else, in `xss-zim.test.ts`) |
| XSS in real browsers | `tests/security/xss-browsers.test.ts` | The corpus executed in Chromium and Firefox (WebKit with `SECURITY_BROWSERS`), through the sanitiser alone and through the listener |
| Isolation proof of concept | `tests/e2e/35-isolation-poc.spec.ts`, run in every browser project | See "Isolation proof of concept" below |
| Untrusted strings in the UI | `tests/e2e/36-untrusted-strings.spec.ts` | A page whose title, heading and text are markup is text in search, the library, History, Bookmarks, the tab and the address bar |
| Web `/api` proxy | `apps/web/test/api-proxy.test.ts` | The API's security headers reach the browser; client-written forwarding headers do not reach the API |
| SBOM | `scripts/test/sbom.test.ts` | The lockfile reader and the CycloneDX document |

Older tests: `tests/integration/server/hardening.test.ts` (proxy secret, renderer proxy binding), `tests/integration/fetch/ssrf.test.ts` and `tests/integration/renderer/proxy.test.ts` (the bait fixture), `tests/integration/archive/isolation.test.ts` and `listener.test.ts` (headers on every route class, the first isolation proof of concept), `packages/render/test/sanitize.test.ts` (the corpus and a fuzz round trip), and `tests/reliability` (corruption cases).

## Results of the H-03 review (2026-11-03)

### Authorisation matrix

188 routes, all listed with a reviewed access level in the test (5 public, 44 readable by a trusted-LAN guest of which one, search, also accepts a guest `POST`, 139 administrator only). A route added without an entry fails the first test; a route whose declared level differs fails the second. Every route is then called in every role. Outcome: the matrix found one real bug (below) and no wrong access level.

### SSRF

Every place the server fetches an address someone else chose was driven with the corpus, against local fake servers and a fake DNS (no real name or address is contacted; a canary server counts any request that should not have arrived, and every test asserts it stayed at zero):

- Forms: private, loopback, link-local, carrier-grade NAT, documentation, benchmark, multicast, reserved and broadcast IPv4; cloud metadata (169.254.169.254, 169.254.170.2, `fd00:ec2::254`); decimal, hexadecimal, octal, mixed, short, trailing-dot and zero-padded IPv4 spellings; IPv6 loopback, link-local with and without zone, unique-local, site-local, Teredo, discard and documentation; IPv4 inside IPv6 as mapped (dotted and hex), compatible, NAT64, 6to4 and SIIT; `localhost` in several cases and under `.localhost`; the schemes `file`, `ftp`, `gopher`, `data`, `javascript`, `ws`, `dict`, `ldap`, `jar`, `blob`, `smb` and others, padded with spaces and tabs; user-info tricks in both directions; encoded dots and digits, full-width digits and ideographic full stops; service ports on a public name.
- Resolution: names that resolve to private, loopback, metadata, mapped, NAT64, 6to4, link-local, unique-local and multicast addresses; a name with a private address among public ones (only the public one is ever used); a name that changes its answer between lookups (every lookup is judged, and exactly one resolution happens per connection, so the checked address is the used address); a resolver that fails or answers nothing.
- Redirects: 25 `Location` forms (absolute, scheme-relative, backslash, single-slash and no-slash schemes, numeric hosts, mapped IPv6, `file`, `gopher`, `data`, `javascript`, user-info, padded) in all five redirect statuses and in a chain. `http:127.0.0.1/x` and `http:/127.0.0.1/x` are relative references against an `http` base (WHATWG), so they stay on the allowed host; the test asserts that and that nothing else leaves.
- Entry points: save page, browser save, live check, source preview, downloads, the set-up wizard's first source, website crawl (links, images, `srcset`, `<source>`, frames, objects, embeds, video, forms, inline styles, a stylesheet with `@import` and `url()`, a page whose `<base>` is the canary), robots.txt that redirects inside, `Sitemap:` lines that point inside, sitemap and sitemap index, RSS feed, the renderer's forward proxy (plain requests and `CONNECT`), the Wikipedia client (look-alike hosts, redirects off Wikimedia, a downgrade to `http`), search-provider redirects.
- Outcomes that are not SSRF by design, recorded so they are a decision and not an accident: (1) a search provider's own base address and the connectivity probe address are chosen by the administrator and may be private (SearXNG on the LAN is the normal case); redirects from a provider are still checked, and the exact host and port is the only exception. (2) ZIM registration takes a path on the server's own disk, inside the allowed roots, and never an address; there is nothing to fetch. (3) `NCB_WIKIPEDIA_ORIGIN` replaces Wikimedia for tests and is the operator's choice.

### XSS and serving

Every sanitiser-corpus vector (344, plus a mutation-XSS fuzz of 400 random documents) was served as an archived page in document and reader view, as a ZIM article and as the sanitiser's bare output, and executed in Chromium and Firefox. No vector ran script or made a request. Beyond the corpus: hostile page titles, addresses, partial-page banners and credit footers; the interstitial's address and origin; error pages for 25 odd paths and methods; `?hl=` and reader preference parameters; sub-resources declared as HTML, script, SVG, XML, PDF or UTF-7 text; ZIM entries whose type disagrees with their bytes; a hostile package title, creator, licence and source; search snippets and highlighted titles. The listener never reflects a request header or cookie, answers a CORS preflight with 405, sets CORS only on font files, and carries the full header set (CSP `sandbox` without `allow-scripts` or `allow-same-origin`, `default-src 'none'`, `connect-src 'none'`, `frame-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `object-src 'none'`, `frame-ancestors` equal to the token's app origin, `nosniff`, `no-referrer`, no `Set-Cookie`) on every route class and every error page. A token with a changed character anywhere, a truncated one, one signed with another key, an expired one, and one with a forged payload are all refused with the same headers. The listener's source imports no database, fetch or API code (checked).

The web app renders untrusted strings as React text. The only `dangerouslySetInnerHTML` is the static theme script. Snippets are split on `<mark>` and rendered as text. Links built from stored addresses go through `safeLink` (http and https only), except one that did not (below).

### Isolation proof of concept

`35-isolation-poc.spec.ts`, in every browser project, uses the fixture site's `/malicious` page, whose script reads `document.cookie`, writes `localStorage`, posts to the app's real API with credentials, navigates the top window, posts a message to its parent and beacons everything it can read. In the shell's sandboxed frame and opened directly in a tab, none of it happens: no beacon, no request from the frame to the app, no postMessage, the top window does not move, the title is the page's own, the app's cookie and storage entries are not readable, `fetch` and `sendBeacon` to the API are blocked, and the shell cannot read into the frame. Cookies are shared across ports on one host, so the browser does send the session cookie to the archive port; the listener returns the same bytes with and without it and never sets one. A request that claims the archive origin is refused by the API (`csrf`), with or without the cookie. The app and the API cannot be framed. Run on Chromium and Firefox on the development machine; WebKit runs in CI (see [browser-support.md](browser-support.md)).

### Findings and fixes

| ID | Finding | Severity | Fix | Test |
|---|---|---|---|---|
| HB-10 | **The API's access checks were skipped for a percent-encoded path.** The router decodes the path before matching, so `GET /%61pi/settings` reached the `/api/settings` handler while its raw URL did not start with `/api`, and the hook that does the proxy-secret check, the CSRF check, the sign-in check, the readiness check and the security headers began with that raw prefix test. Anyone who could reach the API port got every route without signing in, from any container, before and after set-up. Through `web` the request is not forwarded (the proxy only handles `/api/...`), so the exposure was to other containers and to anyone with a published API port. | High | The hook now uses the route the router matched (`isApiRequest`), and the rate-limit exemption for health does too | `authz-matrix.test.ts` "alternative spellings" (fails without the fix); `35-isolation-poc.spec.ts` through the web app |
| HB-11 | **A copy of the proxy secret sat in the renderer and SearXNG containers by default** (`NCB_RENDERER_SECRET` and `SEARXNG_SECRET` default to it). The renderer shares the `render` network with `server`, so a compromised renderer could call the API as `web` and forge client addresses (guest access in trusted-LAN mode, login-throttle evasion). | Medium | `NCB_API_PROXY_FROM`: the secret only counts from the `backend` network. Compose fixes that subnet (`NCB_BACKEND_SUBNET`, default 172.31.249.0/24) and SearXNG leaves `backend`. Separate secrets per container remain recommended | `api-proxy-source.test.ts` |
| HB-12 | **The SSRF guard accepted IPv4-compatible IPv6 (`::127.0.0.1`, `::a00:1`) and the default port list lacked SMB (445), etcd, the Kubernetes API, WinRM and a few more.** Found by the generated corpus. Not reachable on a normal Linux or macOS stack (the address family does not route), but a guard should not rely on that. | Low | `::/96` is refused as a whole; the port list gained 445, 1883, 2379, 2380, 4243, 5672, 5985, 5986, 6443, 10250 | `ssrf-guard.test.ts`, `ssrf-entrypoints.test.ts` |
| HB-13 | **The web app's `/api` proxy dropped the API's `Content-Security-Policy`.** An API response that is ever opened as a document would then have had no policy. Nothing served HTML from the API today (imported originals are attachments with `nosniff`), so this was defence in depth. | Low | The header is forwarded | `apps/web/test/api-proxy.test.ts`, `35-isolation-poc.spec.ts` |
| HB-14 | **Addresses that become links or probes were not limited to http(s):** a knowledge package's licence address (`z.url()` accepts `javascript:`), and the connectivity probe address. The package page rendered the licence address as an `href` without the check the other places use (React 19 also blocks `javascript:` hrefs, so this was a second layer, not the first). | Low | The schemas require http or https; the page uses `safeLink` | `ssrf-entrypoints.test.ts` (ZIM and probe), `apps/web/test/zim.test.ts` |

### Dependency audit

`pnpm audit --prod`: no known vulnerabilities. `pnpm audit` (including development tools): two advisories, both in `esbuild` and both in build tools that are not in any image: a moderate one (`<=0.24.2`, the esbuild dev server answers cross-origin requests) through `drizzle-kit`'s old `@esbuild-kit` loader, and a low one (`>=0.27.3 <0.28.1`, arbitrary file read when the dev server runs) through `tsup`. Neither tool runs a server in this project. Tracked as HB-15; bump `drizzle-kit` and `tsup` when upstream releases move off the affected versions. The audit needs the registry, so it is a manual step and not part of the offline test suites.

### SBOM

`pnpm sbom` writes `sbom/nocon-brain.cdx.json`, a CycloneDX 1.5 document built from `pnpm-lock.yaml` by `scripts/sbom.mjs`: every package with its package URL, SHA-512 integrity hash, licence (from the same `pnpm licenses list` data as the licence audit), the scope (`required` when a production dependency reaches it, `excluded` when only development tooling does) and the dependency graph. `--prod` limits it to what ships; `--out` picks another path. No tool was added: the reader for the lockfile is 60 lines in the script and is unit tested, so nothing new enters the dependency tree or the licence audit. The output is generated and git-ignored. 546 components at the time of writing (276 required).

### Container hardening review

Reviewed: `compose.yml`, the three Dockerfiles, `docker/renderer/seccomp.json`. Checked by `api-proxy-source.test.ts` where a text check is possible.

- Every service drops all capabilities and sets `no-new-privileges`; only the renderer adds one back (`SYS_CHROOT`, HB-08). Every service has a read-only root file system, bounded `tmpfs` mounts, a memory limit and a process limit. No service is privileged, shares the host network or process namespace, or mounts the Docker socket.
- All images run as `node` (UID 1000), have a health check, install with `--ignore-scripts`, and the build stages that hold compilers are not the runtime stage. The server image uses `tini` as PID 1.
- Published ports: the web port and the archive port. The API port is not published. `.dockerignore` keeps `.env` out of the build context.
- Networks: `frontend` (no masquerade, `web` only), `backend` (internal, fixed subnet, `web` and `server`), `egress` (`server` and SearXNG), `render` (internal, fixed subnet, `server` and the renderer).
- Open: the base images are tagged (`node:24-trixie-slim`, `searxng/searxng:latest`), not pinned by digest. A digest pin trades automatic security updates for reproducibility; the decision is recorded as an open question below. HB-02 (does `web` reach the internet on Linux) still needs a Linux host.

### Secrets handling

A scan of the tracked files for key, token and private-key patterns found none outside tests and examples. `.env` is ignored by git and by the Docker context. The proxy secret is required (at least 16 characters) in production and redacted in logs (header, URL query, message text). Provider keys are encrypted at rest with AES-256-GCM, never returned by the API (the matrix test stores a probe token and checks that no guest or administrator response contains it), and redacted in logs. Passwords are scrypt hashes; sessions are random tokens stored hashed.

## Running the review again

```sh
pnpm test:security                                           # about 4 minutes
SECURITY_BROWSERS=chromium,firefox,webkit pnpm test:security # add WebKit (needs a machine where it starts)
pnpm sbom                                                     # sbom/nocon-brain.cdx.json
pnpm audit --prod                                             # needs the registry
pnpm test:e2e && pnpm test:e2e:firefox && pnpm test:e2e:webkit
```

When a route is added, give it an entry in `EXPECTED` in `authz-matrix.test.ts`. When a new place fetches a URL, add it to `ssrf-entrypoints.test.ts`.
