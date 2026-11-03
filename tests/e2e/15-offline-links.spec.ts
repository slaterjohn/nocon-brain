import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { activeFrame, articleUrl, blockExternal as guardNetwork, login, mode, openAddress, savePage, setWorkOffline } from "./helpers";

// C-12: link states in saved pages, the legend, and the offline interstitial. With Work offline on, following a link that is not
// saved shows a notice and no request leaves the app and the archive.
test.skip(mode() !== "real-server", "needs the real server");

const CSRF = { "X-NoCon-CSRF": "1" };

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
  await page.request.patch("/api/settings", { data: { browser: { showLinkStates: true } }, headers: CSRF });
});
test.afterEach(async ({ page }) => {
  await setWorkOffline(page, false);
});

test("saved pages mark their links by state, the legend explains them, and the states follow the connection", async ({ page, baseURL }) => {
  const home = articleUrl("/astronomy");
  await savePage(page, articleUrl("/planets"));
  await savePage(page, home);
  const attempted = await guardNetwork(page, baseURL!);
  await openAddress(page, home);
  await expect(activeFrame(page)).toBeVisible();
  const fl = page.frameLocator('iframe[data-testid="archive-frame"]');
  await expect(fl.getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();

  // Online: the saved neighbour is cached; the others are live only.
  const planets = fl.locator('a[data-ncb-link]', { hasText: /planets/i }).first();
  await expect(planets).toHaveAttribute("data-ncb-link", "cached");
  // Addresses on example.org are never saved by any spec, so their states depend only on the connection and the queue.
  const ext1 = fl.locator('a[href*="astronomy-1"]');
  const ext2 = fl.locator('a[href*="astronomy-2"]');
  await expect(ext1).toHaveAttribute("data-ncb-link", "live-only");
  await expect(ext2).toHaveAttribute("data-ncb-link", "live-only");

  // The legend lists all five states, in words as well as marks.
  await page.getByTestId("help-button").click();
  const legend = page.getByTestId("link-legend");
  for (const t of ["Saved.", "Partly saved.", "Waiting to be saved.", "Live only.", "Not available."]) await expect(legend).toContainText(t);
  await page.keyboard.press("Escape");

  // Work offline (the switch): unsaved links become "not available", and queueing one makes it "waiting".
  await page.getByRole("switch", { name: "Work offline" }).click();
  await expect(page.getByTestId("connectivity")).toHaveAttribute("data-state", "offline");
  const queuedUrl = "https://example.org/ref/astronomy-1";
  const q = await page.request.post("/api/browser/save", { data: { url: queuedUrl, queue: true }, headers: CSRF });
  expect(q.status(), await q.text()).toBe(202);
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(fl.getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();
  await expect(fl.locator('a[data-ncb-link="cached"]', { hasText: /planets/i }).first()).toBeVisible();
  await expect(ext1).toHaveAttribute("data-ncb-link", "queued");
  await expect(ext2).toHaveAttribute("data-ncb-link", "unavailable");
  await expect(fl.locator('a[data-ncb-link="live-only"]').filter({ hasText: /./ })).toHaveCount(0);

  const logBefore = await (await page.request.get(articleUrl("/__log"))).json() as { total: number };

  // A saved link opens the saved copy.
  await fl.locator('a[data-ncb-link="cached"]', { hasText: /planets/i }).first().click();
  await expect(fl.getByRole("heading", { level: 1, name: /Planets/ })).toBeVisible();
  // The shell learns of an in-frame click only when it reads the frame's state after the load. Back before that has nothing to go back
  // to, so wait for the address bar to show where the frame is (the condition that matters), not just for the frame's content.
  await expect(page.getByRole("textbox", { name: "Address or search terms" })).toHaveValue(articleUrl("/planets"));
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(fl.getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();

  // An unsaved link shows the interstitial: the live action is disabled, and nothing leaves the app.
  await ext2.click();
  await expect(fl.getByRole("heading", { level: 1 })).toHaveText(/cannot be fetched right now/);
  await expect(fl.locator("[data-ncb-url]")).toContainText("astronomy-2");
  await expect(fl.getByText("NoConBrain is offline.")).toBeVisible();
  const live = fl.locator('a[aria-disabled="true"]', { hasText: "Open live in new tab" });
  await expect(live).toBeVisible();
  await expect(live).not.toHaveAttribute("href", /.+/);
  await expect(fl.locator('a[target="_blank"]', { hasText: "Open live in new tab" })).toHaveCount(0);
  await expect(fl.getByRole("link", { name: "Queue for download" })).toBeVisible();
  await expect(fl.getByRole("link", { name: "Back" })).toBeVisible();

  // A queued link shows its own state.
  await fl.getByRole("link", { name: "Back" }).click();
  await expect(fl.getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();
  await ext1.click();
  await expect(fl.getByRole("heading", { level: 1 })).toHaveText(/waiting in the download queue/);
  await expect(fl.locator('a[aria-disabled="true"]', { hasText: "Open live in new tab" })).toBeVisible();

  // The network log: nothing was attempted outside the app and the archive, and the article site itself saw no request.
  expect(attempted, "requests that tried to leave the app").toEqual([]);
  const logAfter = await (await page.request.get(articleUrl("/__log"))).json() as { total: number };
  expect(logAfter.total).toBe(logBefore.total);
  // Cancel the held save before going online, so nothing is fetched from example.org when the connection "returns".
  const { downloadId } = (await q.json()) as { downloadId: string };
  expect((await page.request.post(`/api/downloads/${downloadId}/cancel`, { headers: CSRF })).ok()).toBeTruthy();
  await setWorkOffline(page, false);
  await page.getByRole("button", { name: "Reload" }).click();
  await openAddress(page, home);
  await expect(fl.locator('a[href*="astronomy-1"]')).toHaveAttribute("data-ncb-link", "live-only");
});

test("with the browser context offline as well as the switch, saved pages still open and the notice still shows", async ({ page, context, baseURL }) => {
  const home = articleUrl("/astronomy");
  await savePage(page, home);
  const attempted = await guardNetwork(page, baseURL!);
  await openAddress(page, home);
  await expect(activeFrame(page)).toBeVisible();
  const fl = page.frameLocator('iframe[data-testid="archive-frame"]');
  await expect(fl.getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();
  await page.getByRole("switch", { name: "Work offline" }).click();
  await expect(page.getByTestId("connectivity")).toHaveAttribute("data-state", "offline");
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(fl.locator('a[data-ncb-link="unavailable"]').first()).toBeVisible();

  // The notice is up. Now Chromium itself goes offline as well (it blocks every request, local ones too), so the only thing
  // left to check is that the notice's controls do nothing and nothing tries to leave.
  await fl.locator('a[data-ncb-link="unavailable"]').first().click();
  const live = fl.locator('a[aria-disabled="true"]', { hasText: "Open live in new tab" });
  await expect(live).toBeVisible();
  await context.setOffline(true);
  try {
    await live.click({ force: true });
    await page.waitForTimeout(500);
    await expect(live).toBeVisible();
    await expect(fl.locator("[data-ncb-url]")).toBeVisible();
    expect(attempted, "requests that tried to leave the app").toEqual([]);
  } finally {
    await context.setOffline(false);
  }
});

test("page detail explains link states and the notice for pages that are not saved", async ({ page }) => {
  const saved = await savePage(page, articleUrl("/comets"));
  await page.goto(`/library/pages/${saved.pageId}`);
  await expect(page.getByRole("heading", { name: "Links in saved pages" })).toBeVisible();
  await expect(page.getByTestId("link-legend")).toContainText("Not available.");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).exclude('iframe[data-testid="archive-frame"]').analyze();
  expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});
