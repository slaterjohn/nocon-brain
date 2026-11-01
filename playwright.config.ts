import { defineConfig, devices } from "@playwright/test";

// Ports 25000+ so the suite never clashes with other projects or with the dev stack on 3000 to 3002.
export const WEB_PORT = 25000;
export const API_PORT = 25001;

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
  // Chromium by default. `E2E_BROWSERS=chromium,webkit,firefox` adds the others (used for the frame spikes in H-03 and H-11).
  projects: (process.env.E2E_BROWSERS ?? "chromium").split(",").map((name) => ({
    name,
    use: { ...devices[name === "webkit" ? "Desktop Safari" : name === "firefox" ? "Desktop Firefox" : "Desktop Chrome"] },
  })),
});
