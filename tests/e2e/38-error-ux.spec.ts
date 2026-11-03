import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER, articleUrl, login, mode, openAddress, setWorkOffline } from "./helpers";

// H-08: what the Human sees when something goes wrong. For each failure mode: a plain sentence, a next step, no stack trace, no bare code.
// Failures the real server cannot be made to produce on demand (a full disk, a 500, an ended session, a dead server) are made by answering
// the browser's own request, so the test covers exactly what the interface does with the answer. Errors the server does produce (a damaged
// package, a bad form) are made for real. `apps/web/test/errors.test.ts` covers the wording rules on their own.
test.skip(mode() !== "real-server", "needs the real server");

/** What must never reach a person: stack frames, runtime error names, JSON, a lone code. */
const TECHNICAL = /(\n\s+at\s|TypeError|ReferenceError|ECONN\w*|ENOSPC|ENOENT|SQLITE|undefined|\[object|"error"\s*:|Failed to fetch)/;

const json = (status: number, body: unknown) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

async function noTechnicalText(page: Page) {
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(TECHNICAL);
  expect(text).not.toMatch(/\bOops\b|[a-z]!(\s|$)/);
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
});

test("the server cannot be reached: the shell says so, names the next step, and Try again recovers", async ({ page }) => {
  await page.goto("/library");
  let down = true;
  await page.route("**/api/auth/me", (route) => (down ? route.abort("connectionrefused") : route.continue()));
  await page.reload();
  const alert = page.getByRole("alert").filter({ hasText: "Couldn't reach the server" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Check the connection, then try again.");
  await noTechnicalText(page);
  down = false;
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("the web app cannot reach the API (a 502 from its own proxy) reads as a plain sentence", async ({ page }) => {
  await page.route(/\/api\/downloads(\?|$)/, (route) =>
    route.fulfill(json(502, { error: "unavailable", message: "The NoConBrain server isn't reachable. Check that the server service is running, then try again.", requestId: "web-proxy" })),
  );
  await page.goto("/downloads");
  const alert = page.getByRole("alert").filter({ hasText: "Couldn't load downloads" });
  await expect(alert).toContainText("Check that the server service is running");
  await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a 500 whose message is technical is replaced by a plain sentence with a next step", async ({ page }) => {
  await page.route(/\/api\/history(\?|$)/, (route) =>
    route.fulfill(json(500, { error: "internal", message: "TypeError: Cannot read properties of undefined (reading 'x')\n    at Object.run (/app/dist/index.js:10:5)", requestId: "r1" })),
  );
  await page.goto("/history");
  const alert = page.getByRole("alert").filter({ hasText: "Couldn't load history" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("activity log");
  await expect(alert).not.toContainText(/TypeError|dist\/index|\bat Object/);
  await noTechnicalText(page);
});

test("a 500 with no body at all still reads as a sentence", async ({ page }) => {
  await page.route(/\/api\/bookmarks(\?|$)/, (route) => route.fulfill({ status: 500, contentType: "text/plain", body: "" }));
  await page.goto("/bookmarks");
  const alert = page.getByRole("alert").filter({ hasText: "Couldn't load bookmarks" });
  await expect(alert).toContainText("Try again");
  await noTechnicalText(page);
});

test("a page that does not exist says so and links back", async ({ page }) => {
  const res = await page.goto("/no-such-page-at-all");
  expect(res?.status()).toBe(404);
  await expect(page.getByText("That page doesn't exist")).toBeVisible();
  await expect(page.getByText("Check the address, or go back to the browser.")).toBeVisible();
  await page.getByRole("link", { name: "Go to the browser" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("an ended session returns to sign-in with a message, and signing in again returns to the page", async ({ page }) => {
  let ended = true;
  await page.route(/\/api\/downloads(\?|$)/, (route) => (ended ? route.fulfill(json(401, { error: "unauthorized", message: "Sign in to continue.", requestId: "r" })) : route.continue()));
  await page.goto("/downloads");
  await expect(page).toHaveURL(/\/login\?expired=1&next=%2Fdownloads/);
  await expect(page.getByTestId("session-ended")).toContainText("Your session has ended. Sign in again");
  ended = false;
  await page.getByLabel("Username").fill(ADMIN_USER);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/downloads$/);
  await expect(page.getByRole("heading", { level: 1, name: "Downloads" })).toBeVisible();
});

test("sign-in: empty fields, wrong password and too many attempts each say what to do", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Enter the username.")).toBeVisible();
  await expect(page.getByText("Enter the password.")).toBeVisible();
  await page.route("**/api/auth/login", (route) => route.fulfill(json(429, { error: "rate_limited", message: "rate_limited", requestId: "r" })));
  await page.getByLabel("Username").fill("someone");
  await page.getByLabel("Password").fill("not-the-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Too many sign-in attempts. Wait a minute, then try again.")).toBeVisible();
  await page.unroute("**/api/auth/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "username or password" })).toContainText("The username or password is wrong. Check both and try again.");
  await ctx.close();
});

test("the disk is full when saving a page: the toast says what is full and where to make space", async ({ page }) => {
  await page.goto("/");
  await page.route("**/api/browser/save", (route) => route.fulfill(json(507, { error: "insufficient_storage", message: "ENOSPC: no space left on device, write", requestId: "r" })));
  await openAddress(page, articleUrl("/never-saved-for-error-ux"));
  await page.getByRole("button", { name: "Save for offline" }).first().click();
  const toast = page.getByRole("alert").filter({ hasText: "Couldn't start the save" });
  await expect(toast).toContainText("There isn't enough storage space. Free some space or add a volume under Storage, then try again.");
  await expect(toast).not.toContainText("ENOSPC");
});

test("a save the server refuses while offline says it is offline and offers the queue", async ({ page }) => {
  await setWorkOffline(page, true);
  await page.goto("/");
  await openAddress(page, "https://example.org/error-ux-offline");
  await expect(page.getByText("This page is not saved, and you're offline")).toBeVisible();
  await expect(page.getByText("Work offline is on, so nothing is fetched from the web.")).toBeVisible();
  await expect(page.getByTestId("panel-queue")).toBeVisible();
});

test("a failed download shows what happened in words, what to do, and keeps the code in the details", async ({ page }) => {
  const bad = await page.request.post("/api/archive/capture", { headers: { "X-NoCon-CSRF": "1" }, data: { url: articleUrl("/missing-for-error-ux") } });
  expect(bad.status()).toBe(202);
  await page.goto("/downloads");
  await page.getByTestId("tab-failed").click();
  const row = page.getByTestId("download-row").filter({ hasText: "missing-for-error-ux" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  const failure = row.getByTestId("download-failure");
  await expect(failure).toContainText(/refused the request|does not exist/);
  await expect(failure).toContainText(/Check the address|Retry|Try again/);
  // The raw code is behind "Details", not in the sentence.
  await expect(failure.locator("p").first()).not.toContainText(/http_4xx|http_5xx|internal/);
  await noTechnicalText(page);
});

test("a damaged knowledge package is refused in words, on the field, and nothing is added", async ({ page }) => {
  const dir = path.join(process.env.E2E_VOLUMES_ROOT!, "library");
  fs.mkdirSync(dir, { recursive: true });
  const bad = path.join(dir, "damaged-error-ux.zim");
  fs.writeFileSync(bad, Buffer.alloc(8192, "this is not a ZIM file. "));
  await page.goto("/library/packages");
  await page.getByTestId("add-package").first().click();
  const dialog = page.getByTestId("add-package-dialog");
  await dialog.getByLabel("Path to the .zim file").fill(bad);
  await dialog.getByTestId("add-submit").click();
  await expect(page.getByTestId("error-summary")).toBeFocused();
  await expect(page.getByTestId("error-summary")).toContainText(/too small|not a valid ZIM package|damaged/i);
  await expect(dialog).toBeVisible();
  await noTechnicalText(page);
  const list = (await (await page.request.get("/api/zim/packages")).json()) as { items: { path: string }[] };
  expect(list.items.some((p) => p.path.includes("damaged-error-ux"))).toBe(false);
});
