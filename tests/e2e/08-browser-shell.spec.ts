import { expect, test } from "@playwright/test";
import { activeFrame, articleUrl, login, mode, openAddress, savePage, setWorkOffline } from "./helpers";

// A-14 (browser shell), A-16 (URL flow in the UI). These need the real server and the fixture article site.
test.skip(mode() !== "real-server", "needs the real server");

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
});
test.afterEach(async ({ page }) => {
  await setWorkOffline(page, false);
});

const bar = (page: import("@playwright/test").Page) => page.getByRole("textbox", { name: "Address or search terms" });

test("opens an archived page in a sandboxed frame with no scripts and no same-origin", async ({ page }) => {
  const url = articleUrl("/astronomy");
  await savePage(page, url);
  await openAddress(page, url);

  const frame = activeFrame(page);
  await expect(frame).toBeVisible();
  // The attribute is exactly this and never contains allow-scripts or allow-same-origin (asserted, A-14).
  await expect(frame).toHaveAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
  const sandbox = (await frame.getAttribute("sandbox")) ?? "";
  expect(sandbox).not.toMatch(/allow-scripts|allow-same-origin|allow-top-navigation|allow-forms/);
  // The frame is the archive listener's origin, not the app's.
  const src = (await frame.getAttribute("src")) ?? "";
  expect(src.startsWith(`${process.env.E2E_ARCHIVE_URL}/a/`)).toBe(true);
  expect(src).toMatch(/\/p\/pg_/);

  await expect(page.frameLocator('iframe[data-testid="archive-frame"]').getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();
  await expect(page.getByTestId("tab-source").first()).toHaveAttribute("data-source", "saved");
  await expect(bar(page)).toHaveValue(url);
  // No script ran in the frame: the page's own scripts are blocked, so a request to the app's API from it never happens.
  await expect(page.getByRole("tab", { name: /Astronomy/ })).toBeVisible();
});

test("the address bar follows in-frame clicks, the browser's own Back, the shell's Back and Forward, and reload", async ({ page }) => {
  const astro = articleUrl("/astronomy");
  const solar = articleUrl("/solar-system");
  await savePage(page, astro);
  await savePage(page, solar);
  await openAddress(page, astro);
  const fl = page.frameLocator('iframe[data-testid="archive-frame"]');
  await expect(fl.getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();

  // Click a link inside the archived page that leads to another saved page.
  const link = fl.locator('a[data-ncb-link="cached"]', { hasText: /Solar System/i }).first();
  await link.click();
  await expect(fl.getByRole("heading", { level: 1, name: /Solar System/ })).toBeVisible();
  await expect(bar(page)).toHaveValue(solar);
  await expect(page.getByRole("tab", { name: /Solar System/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back" })).toBeEnabled();

  // The browser's own Back button moves the frame back; the shell notices through the load event and frame state.
  await page.evaluate(() => history.back()); // joint session history: moves the frame, not the page
  await expect(fl.getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();
  await expect(bar(page)).toHaveValue(astro);
  await page.evaluate(() => history.forward());
  await expect(bar(page)).toHaveValue(solar);

  // The shell's Back and Forward re-open the earlier page in a fresh frame.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(bar(page)).toHaveValue(astro);
  await expect(fl.getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();
  await page.getByRole("button", { name: "Forward" }).click();
  await expect(bar(page)).toHaveValue(solar);
  await expect(fl.getByRole("heading", { level: 1, name: /Solar System/ })).toBeVisible();

  // Reload re-opens the same page.
  const before = await activeFrame(page).getAttribute("src");
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(fl.getByRole("heading", { level: 1, name: /Solar System/ })).toBeVisible();
  await expect(bar(page)).toHaveValue(solar);
  expect(before).toBeTruthy();
});

test("an address that redirected when it was saved opens the saved page, and the address bar shows where the page is", async ({ page }) => {
  const target = articleUrl("/tide-pools");
  const redirecting = `${process.env.E2E_EDGE_URL}/redirect/302?to=${encodeURIComponent(target)}`;
  await savePage(page, redirecting);
  await openAddress(page, redirecting);
  const fl = page.frameLocator('iframe[data-testid="archive-frame"]');
  await expect(fl.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(bar(page)).toHaveValue(target);
  await expect(page.getByTestId("tab-source").first()).toHaveAttribute("data-source", "saved");
  // The saved page is also found by its own address.
  await openAddress(page, target);
  await expect(bar(page)).toHaveValue(target);
  await expect(activeFrame(page)).toBeVisible();
});

test("a link to a page that is not saved shows the listener's notice and the address bar follows it", async ({ page }) => {
  const astro = articleUrl("/astronomy");
  await savePage(page, astro);
  await openAddress(page, astro);
  const fl = page.frameLocator('iframe[data-testid="archive-frame"]');
  await expect(fl.getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();
  const missing = fl.locator('a[data-ncb-link="live-only"]').first();
  await missing.click();
  await expect(fl.getByText("Save for offline").first()).toBeVisible();
  await expect(page.getByTestId("tab-source").first()).toHaveAttribute("data-source", "unsaved");
  await expect(bar(page)).toHaveValue(/^http:\/\/127\.0\.0\.1:\d+\//);
});

test("reader view, the saved view and the original (live) view switch from the toolbar", async ({ page }) => {
  const url = articleUrl("/astronomy");
  await savePage(page, url);
  await openAddress(page, url);
  const fl = page.frameLocator('iframe[data-testid="archive-frame"]');
  await expect(fl.getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();

  const view = page.getByRole("radiogroup", { name: "View" });
  await expect(view.getByRole("radio", { name: "Saved" })).toBeChecked();
  await view.getByRole("radio", { name: "Reader" }).click();
  await expect(page.getByTestId("tab-source").first()).toHaveAttribute("data-source", "reader");
  await expect(activeFrame(page)).toHaveAttribute("src", /\/reader$/);
  await expect(fl.locator("body.ncb-reader")).toBeVisible();

  await view.getByRole("radio", { name: /Original/ }).click();
  await expect(page.getByRole("heading", { name: "A saved copy exists" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Open live site/ }).first()).toBeEnabled();
  await page.getByRole("button", { name: "Open the saved copy" }).click();
  await expect(fl.getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();
});

test("open live opens the real site in a new browser tab, not in the shell", async ({ page, context }) => {
  const url = articleUrl("/astronomy");
  await savePage(page, url);
  await openAddress(page, url);
  await expect(activeFrame(page)).toBeVisible();
  const [popup] = await Promise.all([context.waitForEvent("page"), page.getByTestId("open-live").click()]);
  await popup.waitForLoadState("domcontentloaded");
  expect(popup.url()).toBe(url);
  await popup.close();
});

test("an address that is not saved offers the live site and a save; offline it shows the offline page", async ({ page }) => {
  const url = articleUrl("/black-holes");
  await openAddress(page, url);
  await expect(page.getByRole("heading", { name: "This page is not saved" })).toBeVisible();
  await expect(page.getByTestId("live-url")).toHaveText(url);
  await expect(page.getByTestId("panel-save")).toBeVisible();
  await expect(page.getByTestId("tab-source").first()).toHaveAttribute("data-source", "live");

  await setWorkOffline(page, true);
  await openAddress(page, articleUrl("/planets"));
  await expect(page.getByRole("heading", { name: /not saved, and you're offline/ })).toBeVisible();
  await expect(page.getByTestId("panel-queue")).toBeVisible();
  await expect(page.getByTestId("tab-source").first()).toHaveAttribute("data-source", "offline");
});

test("tabs keep their own pages, and focus moves sensibly when tabs change", async ({ page }) => {
  const astro = articleUrl("/astronomy");
  await savePage(page, astro);
  await openAddress(page, astro);
  await expect(activeFrame(page)).toBeVisible();

  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(bar(page)).toBeFocused();
  await expect(page.getByRole("heading", { level: 1, name: "NoConBrain" })).toBeVisible();
  await expect(page.locator('iframe[data-testid="archive-frame"][hidden]')).toHaveCount(1);

  // Back to the first tab with the keyboard: arrow keys move between tabs, and the frame is still there.
  const tabs = page.getByRole("tablist", { name: "Open tabs" });
  await tabs.getByRole("tab", { selected: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.getByRole("tab", { name: /Astronomy/ })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab", { name: /Astronomy/ })).toBeFocused();
  await expect(activeFrame(page)).toBeVisible();
  await expect(bar(page)).toHaveValue(astro);

  // Closing the tab that has focus lands focus on what is shown next: here a new tab, whose address bar is empty.
  await page.getByRole("button", { name: /^Close tab Astronomy/ }).click();
  await expect(bar(page)).toBeFocused();
  await expect(tabs.getByRole("tab")).toHaveCount(1);
});

test("works at phone width: no sideways scrolling, and every control is reachable", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  const url = articleUrl("/astronomy");
  await savePage(page, url);
  await openAddress(page, url);
  await expect(activeFrame(page)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(bar(page)).toBeVisible();
  const box = await bar(page).boundingBox();
  expect(box!.width).toBeGreaterThan(250);
  await expect(page.getByRole("radiogroup", { name: "View" })).toBeVisible();
  await expect(page.getByTestId("find-toggle")).toBeVisible();
  const frameBox = await activeFrame(page).boundingBox();
  expect(frameBox!.width).toBeLessThanOrEqual(375);
  expect(frameBox!.height).toBeGreaterThan(300);
});
