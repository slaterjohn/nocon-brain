import { defineConfig, devices } from "@playwright/test";

// Ports 25000+ so the suite never clashes with other projects or with the dev stack on 3000 to 3002.
export const WEB_PORT = 25000;
export const API_PORT = 25001;

const BROWSERS = (process.env.E2E_BROWSERS ?? "chromium").split(",").map((b) => b.trim()).filter(Boolean);
if (BROWSERS.length > 1) console.warn(`E2E_BROWSERS lists ${BROWSERS.join(", ")}: they share one stack and the specs expect a fresh one. Use one engine per run (pnpm test:e2e:matrix).`);

/**
 * The specs that also run on Firefox and WebKit (task H-11). Chosen because the behaviour under test is the browser's own: the setup wizard and
 * sign-in (cookies, focus), the headers the app and the archive send, the sandboxed archive frame (load events, history, fragment navigation,
 * find), capture end to end, bookmarks and history, keyboard shortcuts, offline link states, the search UI, ZIM frames, the isolation proof of
 * concept and untrusted strings, the offline end-to-end run and the error messages. Left on Chromium alone: the axe accessibility audits (engine independent), storage, discovery, packages and
 * online-search administration (server logic with plain forms), and the library wizard.
 */
const CROSS_BROWSER = /(?:^|[\\/])(01-setup|02-auth|03-navigation|06-proxy|07-headers|08-browser-shell|09-capture|10-bookmarks-history|11-find|12-shortcuts-indicators|15-offline-links|17-search-ui|29-wikipedia-zim|35-isolation-poc|36-untrusted-strings|37-offline-end-to-end|38-error-ux)\.spec\.ts$/;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // Chromium runs every spec. Firefox and WebKit run CROSS_BROWSER (H-11). Chromium by default; `E2E_BROWSERS=firefox` (or `webkit`) selects
  // another engine. Run ONE engine per invocation: each run starts its own fresh stack, and the specs assume a fresh one (01-setup creates the
  // administrator, 09-capture expects a page that has never been saved). `pnpm test:e2e:matrix` does the three in turn.
  projects: BROWSERS.map((name) => ({
    name,
    use: { ...devices[name === "webkit" ? "Desktop Safari" : name === "firefox" ? "Desktop Firefox" : "Desktop Chrome"] },
    ...(name === "chromium" ? {} : { testMatch: CROSS_BROWSER }),
  })),
});
