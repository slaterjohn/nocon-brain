import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("Browser is the landing page, with the five areas in the navigation", async ({ page }) => {
  await expect(page).toHaveURL(/\/$/);
  const nav = page.getByRole("navigation", { name: "Areas" });
  await expect(nav.getByRole("link")).toHaveText(["Browser", "Library", "Downloads", "Search", "Storage and settings"]);
  await expect(nav.getByRole("link", { name: "Browser" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("NoConBrain");
  await expect(page.getByRole("searchbox", { name: /Search your archive/ })).toBeVisible();
});

for (const [name, url, heading] of [
  ["Library", "/library", "Library"],
  ["Downloads", "/downloads", "Downloads"],
  ["Search", "/search", "Search"],
  ["Storage and settings", "/storage", "Storage and settings"],
] as const) {
  test(`navigating to ${name}`, async ({ page }) => {
    await page.getByRole("navigation", { name: "Areas" }).getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`${url}$`));
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Areas" }).getByRole("link", { name })).toHaveAttribute("aria-current", "page");
  });
}

test("the home search field says it is not connected yet", async ({ page }) => {
  await page.getByRole("searchbox", { name: /Search your archive/ }).fill("hello");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "isn't connected yet" })).toBeVisible();
});

test("browser chrome: tabs, address bar and history", async ({ page }) => {
  const tabs = page.getByRole("list", { name: "Open tabs" });
  await expect(tabs.getByTestId("browser-tab")).toHaveCount(1);

  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(tabs.getByTestId("browser-tab")).toHaveCount(2);
  await expect(tabs.locator("li[data-selected=true]")).toContainText("New tab");

  const address = page.getByRole("textbox", { name: "Address or search terms" });
  await address.fill("example.org");
  await address.press("Enter");
  await expect(tabs.locator("li[data-selected=true]")).toContainText("example.org");
  await expect(page.getByRole("heading", { name: /Opening pages isn't available yet/ })).toBeVisible();

  const back = page.getByRole("button", { name: "Back" });
  const forward = page.getByRole("button", { name: "Forward" });
  await expect(forward).toBeDisabled();
  await back.click();
  await expect(address).toHaveValue("");
  await expect(forward).toBeEnabled();
  await forward.click();
  await expect(address).toHaveValue("example.org");

  await page.getByRole("button", { name: "Close tab example.org" }).click();
  await expect(tabs.getByTestId("browser-tab")).toHaveCount(1);
});

test("browser chrome: keyboard shortcuts", async ({ page }) => {
  const tabs = page.getByRole("list", { name: "Open tabs" });
  const address = page.getByRole("textbox", { name: "Address or search terms" });

  await expect(address).toBeVisible(); // the chrome (and its key handler) mounts once the shell has loaded
  await page.keyboard.press("Control+t");
  await expect(tabs.getByTestId("browser-tab")).toHaveCount(2);
  await expect(address).toBeFocused();

  await address.fill("one.example");
  await address.press("Enter");
  await address.fill("two.example");
  await address.press("Enter");
  await expect(address).toHaveValue("two.example");

  await page.keyboard.press("Alt+ArrowLeft");
  await expect(address).toHaveValue("one.example");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(address).toHaveValue("two.example");

  await page.getByRole("heading", { level: 1 }).first().click({ force: true }).catch(() => {});
  await page.keyboard.press("Control+l");
  await expect(address).toBeFocused();

  await page.keyboard.press("Control+w");
  await expect(tabs.getByTestId("browser-tab")).toHaveCount(1);
  // Closing the last tab leaves one new tab.
  await page.keyboard.press("Control+w");
  await expect(tabs.getByTestId("browser-tab")).toHaveCount(1);
  await expect(tabs.locator("li[data-selected=true]")).toContainText("New tab");
});

test("connectivity indicator follows the event stream", async ({ page }) => {
  const indicator = page.getByTestId("connectivity");
  await expect(indicator).toHaveAttribute("data-state", "online");
  await expect(indicator).toContainText("Online");

  const r = await page.request.post("/api/system/connectivity", { data: { forceOffline: true }, headers: { "X-NoCon-CSRF": "1" } });
  expect(r.ok()).toBeTruthy();
  await expect(indicator).toHaveAttribute("data-state", "offline");
  await expect(indicator).toContainText("Offline");

  await page.request.post("/api/system/connectivity", { data: { forceOffline: false }, headers: { "X-NoCon-CSRF": "1" } });
  await expect(indicator).toHaveAttribute("data-state", "online");
});
