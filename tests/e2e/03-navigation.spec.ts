import { expect, test } from "@playwright/test";
import { login, mode } from "./helpers";

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("Browser is the landing page, with the six areas in the navigation", async ({ page }) => {
  await expect(page).toHaveURL(/\/$/);
  const nav = page.getByRole("navigation", { name: "Areas" });
  await expect(nav.getByRole("link")).toHaveText(["Browser", "Library", "Downloads", "Discovery", "Search", "Storage and settings"]);
  await expect(nav.getByRole("link", { name: "Browser" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("NoConBrain");
  await expect(page.getByRole("combobox", { name: /Search your archive/ })).toBeVisible();
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

test("searching from the home page goes to the results page", async ({ page }) => {
  await page.getByRole("combobox", { name: /Search your archive/ }).fill("hello world");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/\/search\?q=hello\+world$/);
  await expect(page.getByRole("heading", { level: 1, name: "Search results for hello world" })).toBeAttached();
  await expect(page.getByRole("tablist", { name: "Result categories" })).toBeVisible();
});

test("browser chrome: tabs, address bar and history", async ({ page }) => {
  test.skip(mode() !== "real-server", "needs the real resolve endpoint");
  const tabs = page.getByRole("tablist", { name: "Open tabs" });
  const selected = tabs.locator("[data-testid=browser-tab][data-selected=true]");
  await expect(tabs.getByTestId("browser-tab")).toHaveCount(1);

  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(tabs.getByTestId("browser-tab")).toHaveCount(2);
  await expect(selected).toContainText("New tab");

  const address = page.getByRole("textbox", { name: "Address or search terms" });
  await address.fill("example.org");
  await address.press("Enter");
  await expect(selected).toContainText("example.org");
  // Nothing saved at that address and the connection is not known to be down: the page says so and offers a save.
  await expect(page.getByRole("heading", { name: "This page is not saved" })).toBeVisible();
  await expect(address).toHaveValue("https://example.org/");

  const back = page.getByRole("button", { name: "Back" });
  const forward = page.getByRole("button", { name: "Forward" });
  await expect(forward).toBeDisabled();
  await back.click();
  await expect(address).toHaveValue("");
  await expect(forward).toBeEnabled();
  await forward.click();
  await expect(address).toHaveValue("https://example.org/");

  await page.getByRole("button", { name: "Close tab example.org" }).click();
  await expect(tabs.getByTestId("browser-tab")).toHaveCount(1);
});

test("browser chrome: keyboard shortcuts avoid the keys the browser keeps", async ({ page }) => {
  test.skip(mode() !== "real-server", "needs the real resolve endpoint");
  const tabs = page.getByRole("tablist", { name: "Open tabs" });
  const selected = tabs.locator("[data-testid=browser-tab][data-selected=true]");
  const address = page.getByRole("textbox", { name: "Address or search terms" });

  await expect(address).toBeVisible(); // the chrome (and its key handler) mounts once the shell has loaded
  await page.keyboard.press("Alt+Shift+KeyN");
  await expect(tabs.getByTestId("browser-tab")).toHaveCount(2);
  await expect(address).toBeFocused();

  await address.fill("one.example");
  await address.press("Enter");
  await expect(page.getByRole("heading", { name: "This page is not saved" })).toBeVisible();
  await address.fill("two.example");
  await address.press("Enter");
  await expect(address).toHaveValue("https://two.example/");

  await page.keyboard.press("Alt+Shift+KeyB");
  await expect(address).toHaveValue("https://one.example/");
  await page.keyboard.press("Alt+Shift+KeyG");
  await expect(address).toHaveValue("https://two.example/");

  await page.getByRole("heading", { level: 1 }).first().click({ force: true }).catch(() => {});
  await page.keyboard.press("Alt+Shift+KeyL");
  await expect(address).toBeFocused();

  await page.keyboard.press("Alt+Shift+KeyX");
  await expect(tabs.getByTestId("browser-tab")).toHaveCount(1);
  // Closing the last tab leaves one new tab.
  await page.keyboard.press("Alt+Shift+KeyX");
  await expect(tabs.getByTestId("browser-tab")).toHaveCount(1);
  await expect(selected).toContainText("New tab");
});

test("connectivity indicator is honest about not having checked, and follows the Work offline switch", async ({ page }) => {
  const indicator = page.getByTestId("connectivity");
  // The server never probes or phones home (D-8), so a fresh start is "not checked", not "online".
  await expect(indicator).toHaveAttribute("data-state", "unknown");
  await expect(indicator).toContainText("Connection not checked");

  // The manual switch forces offline and the indicator follows the event stream.
  const toggle = page.getByRole("switch", { name: "Work offline" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(indicator).toHaveAttribute("data-state", "offline");
  await expect(indicator).toContainText("Offline");

  // A change made elsewhere (another tab, the API) reaches this page through the stream.
  const off = await page.request.post("/api/system/connectivity", { data: { forceOffline: false }, headers: { "X-NoCon-CSRF": "1" } });
  expect(off.ok()).toBeTruthy();
  await expect(indicator).toHaveAttribute("data-state", "unknown");
  await expect(toggle).not.toBeChecked();
  const on = await page.request.post("/api/system/connectivity", { data: { forceOffline: true }, headers: { "X-NoCon-CSRF": "1" } });
  expect(on.ok()).toBeTruthy();
  await expect(indicator).toHaveAttribute("data-state", "offline");
  await expect(toggle).toBeChecked();

  // Switching off returns to what was observed, which is nothing yet.
  await toggle.click();
  await expect(indicator).toHaveAttribute("data-state", "unknown");
  await expect(indicator).toContainText("Connection not checked");
});
