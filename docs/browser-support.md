# Browser support

What NoConBrain is tested in, what is checked in each browser, and where the browsers are known to differ. This is the record for task H-11. The isolation checks that keep archived content away from the app are described in [security.md](security.md).

## Supported browsers

| Browser | Status | What runs |
|---|---|---|
| Chromium-based (Chrome, Edge, Brave, Vivaldi), current stable | Supported, primary | Every end-to-end spec (36 files) on Playwright Chromium, in CI on every push |
| Firefox, current stable | Supported | The cross-browser subset (15 files, listed below) on Playwright Firefox (157 at the time of writing) |
| Safari and other WebKit browsers (macOS, iOS), current stable | Supported, with one gap | The same subset on Playwright WebKit in CI on Linux. See "What is not verified" |

The app needs a browser that implements the iframe `sandbox` attribute and the `Content-Security-Policy: sandbox` header, `fetch`, `EventSource` (search streams progress over server-sent events), and the History API. All three engines above do. Mobile browsers use the same engines and the same responsive layout, but they are not in the test matrix.

## What runs where

`playwright.config.ts` defines one project per engine. Chromium runs every file in `tests/e2e`. Firefox and WebKit run `CROSS_BROWSER`, the files whose behaviour is the browser's own:

| Area | Files | Why it is cross-browser |
|---|---|---|
| Set-up wizard and sign-in | `01-setup`, `02-auth` | Focus handling, form behaviour, session cookies |
| App shell and the API proxy | `03-navigation`, `06-proxy`, `07-headers` | Routing, streaming responses, security headers |
| Archive frame | `08-browser-shell`, `11-find`, `15-offline-links` | The sandboxed cross-origin frame: `load` events, joint session history, fragment navigation, link states |
| Capture and history | `09-capture`, `10-bookmarks-history` | End to end through the shell |
| Keyboard | `12-shortcuts-indicators` | Browser-reserved shortcuts differ per engine and per platform |
| Search | `17-search-ui` | The results page, streaming, filters |
| Knowledge packages | `29-wikipedia-zim` | ZIM pages in the archive frame |
| Isolation | `35-isolation-poc`, `36-untrusted-strings` | Archived content cannot read the app's cookies or storage or call its API; hostile titles and snippets render as text |

Left on Chromium alone: the axe accessibility audits (`05`, `24`, `28`, `34` and the audits inside other files; axe checks the DOM and ARIA tree, not engine rendering), storage and discovery administration (`21` to `28`), the library wizard and package browser (`13`, `14`, `16`, `18` to `20`, `30` to `34`), and `04-dashboard`. They are server logic behind plain forms; a regression in them would show in Chromium first. If a bug turns up that only one engine shows, move the file into `CROSS_BROWSER`.

The vitest `security` project also runs the sanitiser's cross-site-scripting corpus (344 vectors) in real browser engines: Chromium and Firefox by default, and WebKit when `SECURITY_BROWSERS=chromium,firefox,webkit` is set. Each vector is checked three ways: a control that proves the harness sees script run, the sanitiser's output in a bare page, and the archive listener's response opened directly (its CSP `sandbox` header is then the only protection besides the sanitiser).

## Running it

```sh
pnpm exec playwright install chromium firefox webkit      # once; add --with-deps on Linux
pnpm test:e2e                  # Chromium, every file
pnpm test:e2e:firefox          # Firefox, the cross-browser subset
pnpm test:e2e:webkit           # WebKit, the cross-browser subset
pnpm test:e2e:matrix           # the three in turn
SECURITY_BROWSERS=chromium,firefox,webkit pnpm test:security
```

Run one engine per invocation. Each run starts its own fresh stack (server, web app and fixture sites on ports 25000 to 25002), and the specs expect a fresh one: `01-setup` creates the administrator, and `09-capture` expects a page that has never been saved. Listing several engines in `E2E_BROWSERS` shares one stack between them and fails for that reason; the config prints a warning.

## Known differences

- **Firefox.** Playwright's Firefox build passes the spikes recorded under A-14 and A-18 in [implementation-plan.md](implementation-plan.md): address-bar sync, the browser's own Back and Forward in a cross-origin frame, and fragment navigation for find. The results of the full subset run for H-11 are in the table at the end of this page.
- **WebKit.** Safari's handling of a sandboxed frame without `allow-same-origin` is the reason the shell reads the frame's state from the server (`GET /api/browser/frame-state` after each `load`) and never from the frame's `contentWindow`. The tests assert that approach in every engine.
- **Cookies are shared across ports on one host** in every browser. The archive listener (port 3002) therefore receives the app's session cookie when both are served from the same host name. It ignores it, never sets one, and the isolation spec asserts all three. Serving the archive from a separate host name (see [deployment.md](deployment.md)) removes the cookie from the request altogether and is the recommended setup behind a reverse proxy.
- **ARM64 and AMD64.** The end-to-end suite runs on AMD64 in CI. On ARM64 runners a different spec timed out each run (HB-09 in [hardening-backlog.md](hardening-backlog.md)), so ARM64 is checked by the integration and security suites, which run on both architectures, and by hand on a Raspberry Pi. Nothing in the app depends on the architecture except the native modules (`better-sqlite3`, `@openzim/libzim`), which ship builds for both.

## What is not verified

- **Real Safari.** Playwright's WebKit is the WebKit engine without Safari's UI, its content blockers, its Intelligent Tracking Prevention or its iOS variants. A hand check of the archive frame in current Safari on macOS and iOS (open an archived page, follow a link, press Back, use find) is still to do before a release. Record the result here.
- **WebKit on the development Mac.** Playwright 1.64's WebKit builds (2272, 2336, 2370) crash at launch on macOS 26.0.1 before any page loads, so the WebKit runs for H-11 could not be done on this machine. The WebKit project and specs are in place and run on Linux in CI (see below). Until a CI run has passed, treat WebKit as unverified.

## CI

CI runs Chromium only today (`.github/workflows/ci.yml` installs `chromium` and runs `pnpm test:e2e` as an advisory step on AMD64). To run the matrix there, the workflow needs, in the end-to-end job (this repository's wave B did not edit `.github`):

1. `pnpm exec playwright install --with-deps chromium firefox webkit` in place of the Chromium-only install (and the Playwright cache key unchanged: it already includes the Playwright version).
2. Three steps in turn, each advisory at first (`continue-on-error: true`, `--retries=2`) and made blocking once they have passed on a few runs: `pnpm test:e2e`, `pnpm test:e2e:firefox`, `pnpm test:e2e:webkit`. Each starts its own stack, so they must not run in parallel on one runner (they share ports 25000 to 25002).
3. `SECURITY_BROWSERS=chromium,firefox,webkit pnpm test:security` after the browsers are installed, so the XSS corpus runs in all three engines.

Time on the development Mac (Apple Silicon, warm build cache): 6.5 minutes for the full Chromium run and 2.8 minutes for the Firefox subset; a hosted AMD64 runner is usually two to three times slower. The extra browser downloads are about 250 MB.

## Results

| Date | Engine | Version | Run | Result |
|---|---|---|---|---|
| 2026-11-03 | Chromium | Playwright 1.64.1 build (`chromium-1248`) | `pnpm test:e2e`, all 36 files | 259 passed, 3 skipped (mock-API-only specs), 6.5 minutes |
| 2026-11-03 | Firefox | 157.0 | `pnpm test:e2e:firefox`, 15 files | 102 passed, 3 skipped (the same mock-API-only specs), 2.8 minutes |
| 2026-11-03 | Chromium, Firefox | as above | `pnpm test:security` browser tests: XSS corpus, 344 vectors, three ways | passed in both |
| not run | WebKit | Playwright build 2370 | `pnpm test:e2e:webkit` | The browser crashes at launch on macOS 26.0.1 (before any page loads), so there is no result. Run it on Linux in CI |
| not run | Safari | current macOS and iOS | by hand | Still to do before a release |

What the Firefox runs found, and what was changed:

- **Nothing in the app.** All 102 tests pass: the wizard, sign-in, the sandboxed archive frame (address-bar sync, Back and Forward, find by fragment), capture, bookmarks and History, shortcuts, offline link states, search, ZIM frames, the isolation checks and the untrusted-string checks.
- **One test-rig difference.** With the context-level `colorScheme: "dark"` that Playwright's runner passes, Playwright's Firefox does not apply the dark colour scheme (the page reports `prefers-color-scheme: light`), while `page.emulateMedia({ colorScheme })` works. Six dark-theme accessibility tests in `17-search-ui` failed their "page is dark" assertion for that reason. The app is not at fault (a plain Firefox page with the same script gets the dark class). `12-shortcuts-indicators` and `17-search-ui` now call `emulateMedia` in `beforeEach`; the other dark-theme audits (`05`, `14`, `24`, `28`) stay Chromium-only.
- **No flaky test** in the Firefox runs (`--retries=0`).
