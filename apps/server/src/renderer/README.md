# Optional renderer

Task C-16, decision D-4. Off unless `NCB_RENDERER_URL` is set. Code here: `triggers.ts`, `service.ts`, `client.ts`, `proxy.ts`. The container is `apps/renderer` + `docker/renderer`. Overview: `docs/architecture.md` "Renderer".

## Flow

1. A capture finishes the 15 stages (`PipelineService.runVersion`, which both plain captures and the crawl engine use) and calls `onVersionDone`. `RenderService.consider` reads the stored HTML and extracted text and applies `triggers.ts`.
2. A trigger fires: a `render` job is queued (queue `crawl`, `idempotencyKey render:<versionId>`, pseudo-host `renderer.internal`). `host_state.max_concurrent` for that host is set from the render concurrency (`resources.renderConcurrency` (read live; `NCB_RENDER_CONCURRENCY` is only the default of that setting), default 1), so the queue itself never runs more render jobs than allowed. At most `mainConcurrency - 1` of the runner's main-thread slots are taken by renders when concurrency is 1; fetch and process jobs keep the other slot.
3. The handler checks the connection (offline stops it) and robots.txt (a user-initiated save may override it, as for the plain fetch), then calls `POST <NCB_RENDERER_URL>/render` with a bearer token. The renderer returns the DOM after scripts ran.
4. The DOM is stored as a new version of the same page with `render_mode = 'browser'` (`download_job_id` NULL, so a failed render never marks the download failed) and a `process` job runs the normal 15 stages on it: assets are discovered in the rendered DOM and fetched by the server's own guarded fetcher, metadata and reader text are extracted, and the version becomes the page's latest. The plain version stays unless the capture's versioning policy supersedes it (`latest_only` does). The rendered version is never rendered again.
5. If the renderer is down, busy, slow or fails, the plain capture stands and the activity log says why. A busy renderer (429) retries after 5 s. Timeouts, oversize pages and navigation failures are not retried.

## Triggers (`triggers.ts`)

Never for non-HTML, non-2xx, hosts on `NCB_RENDER_NEVER_HOSTS`, sources with `renderMode: "never"`, or an already rendered version. `renderMode: "always"` renders every HTML page of that source. In `auto` (the default) any of:

| Reason | Rule |
|---|---|
| `little_text` | extracted text under 200 characters, raw HTML over 20 KiB, at least one `<script src>` |
| `empty_mount` | extracted text under 400 characters and an empty framework mount node (`#root`, `#app`, `#__next`, `#__nuxt`, ...), an empty `<app-root>`-style element, or a `<noscript>` note asking for JavaScript |
| `no_article` | neither Readability nor defuddle found an article (`body_text` or `none`), text under 1,500 characters, at least one `<script src>` |

## The forward proxy (`proxy.ts`)

Started by `createServer` when `NCB_RENDERER_URL` is set, on `NCB_RENDER_PROXY_HOST:NCB_RENDER_PROXY_PORT` (all interfaces, 3128), never published. It answers `http://` requests in absolute form and `CONNECT host:port`. Every request goes through the SSRF guard (`@ncb/fetch`): scheme, credentials, port policy, IP literals in every spelling (decimal, hex, octal, IPv4-mapped IPv6), and a validating `lookup` for the connection, so the address that was checked is the address that is used. Redirects are not followed; the browser follows them and each hop is checked as a new request. Other rules: `Proxy-Authorization` with the renderer secret is required (407 otherwise); nothing is sent while the server works offline (503); at most 6 connections per host and 50 ms between new ones; 100 MiB per tunnel or response; 64 open connections; idle timeout 60 s. Blocked requests are counted (`proxy.stats`) and logged at warn.

HTTPS content passes through `CONNECT` tunnels uninspected. The renderer enforces its own page budget (wall clock `NCB_RENDER_TIMEOUT_SECONDS`, bytes loaded, DOM size).

## Tests

- `apps/server/test/render-triggers.test.ts`: the triggers.
- `tests/integration/renderer/proxy.test.ts`: every `ssrfBait` target as a plain request and as CONNECT (canary stays 0), private, loopback, link-local and metadata addresses, hostnames resolving to private addresses, redirects, authentication, politeness, offline.
- `tests/integration/renderer/render.test.ts`: the whole flow against a stand-in renderer (no browser): off by default, empty shell rendered into a flagged version, sanitised at serve time, source options, failures, concurrency.
- `tests/integration/renderer/docker.test.ts` (needs Docker; `NCB_DOCKER_TESTS=1`): builds the image for arm64, renders the script-built fixture in a real Chromium, and checks the container's network.
