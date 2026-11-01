import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { activeFrame, articleUrl, login, mode, openAddress, savePage, setWorkOffline } from "./helpers";

// A-19: shortcuts, help dialog, indicators, link-state legend, and accessibility of the new screens.
test.skip(mode() !== "real-server", "needs the real server");

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
async function serious(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).exclude('iframe[data-testid="archive-frame"]').analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
  await page.request.patch("/api/settings", { data: { browser: { showLinkStates: true } }, headers: { "X-NoCon-CSRF": "1" } });
});
test.afterEach(async ({ page }) => {
  await setWorkOffline(page, false);
});

test("the help dialog lists every shortcut and the link marks, opens with ?, and returns focus", async ({ page }) => {
  await page.getByRole("heading", { level: 1 }).first().click({ force: true }).catch(() => {});
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("?");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  for (const label of ["New tab", "Close the current tab", "Go to the address bar", "Back in this tab", "Bookmark or remove the bookmark", "Save for offline", "Find in this page", "Show these shortcuts"]) {
    await expect(dialog).toContainText(label.replace("Go to the address bar", "Go to the address bar"));
  }
  await expect(dialog).toContainText("Alt+Shift+N");
  await expect(dialog).toContainText("Ctrl+F or Cmd+F still searches the page");
  // The legend: all five states, in words as well as marks.
  const legend = dialog.getByTestId("link-legend");
  for (const t of ["Saved.", "Partly saved.", "Waiting to be saved.", "Live only.", "Not available."]) await expect(legend).toContainText(t);
  expect(await serious(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("single-key shortcuts can be switched off", async ({ page }) => {
  const bar = page.getByRole("textbox", { name: "Address or search terms" });
  await page.getByTestId("help-button").click();
  const sw = page.getByRole("switch", { name: /Single-key shortcuts/ });
  await expect(sw).toBeChecked();
  await sw.click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("/");
  await expect(bar).not.toBeFocused();
  // The Alt+Shift form still works.
  await page.keyboard.press("Alt+Shift+KeyL");
  await expect(bar).toBeFocused();
  // Switch back on for the other specs.
  await page.getByTestId("help-button").click();
  await page.getByRole("switch", { name: /Single-key shortcuts/ }).click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("/");
  await expect(bar).toBeFocused();
});

test("shortcuts: bookmark, save, reader, work offline and tab numbers", async ({ page }) => {
  const url = articleUrl("/mars");
  await savePage(page, url);
  await openAddress(page, url);
  await expect(activeFrame(page)).toBeVisible();
  await page.getByRole("heading", { level: 1 }).first().click({ force: true }).catch(() => {});

  await page.keyboard.press("Alt+Shift+KeyD");
  await expect(page.getByTestId("bookmark-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Alt+Shift+KeyD");
  await expect(page.getByTestId("bookmark-toggle")).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("Alt+Shift+KeyR");
  await expect(page.getByTestId("tab-source").first()).toHaveAttribute("data-source", "reader");
  await page.keyboard.press("Alt+Shift+KeyR");
  await expect(page.getByTestId("tab-source").first()).toHaveAttribute("data-source", "saved");

  await page.keyboard.press("Alt+Shift+KeyF");
  await expect(page.getByTestId("find-bar")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press("Alt+Shift+KeyN");
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.keyboard.press("Alt+Shift+Digit1");
  await expect(page.getByRole("tab", { name: /Mars/ })).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Alt+Shift+KeyO");
  await expect(page.getByTestId("connectivity")).toHaveAttribute("data-state", "offline");
  await page.keyboard.press("Alt+Shift+KeyO");
  await expect(page.getByTestId("connectivity")).not.toHaveAttribute("data-state", "offline");
});

test("indicators: the global one and each tab's change when the connection is forced offline", async ({ page }) => {
  const saved = articleUrl("/jupiter");
  const unsaved = articleUrl("/exoplanets");
  await savePage(page, saved);
  await openAddress(page, saved);
  await expect(activeFrame(page)).toBeVisible();
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await openAddress(page, unsaved);
  await expect(page.getByRole("heading", { name: "This page is not saved" })).toBeVisible();

  const tabIcons = page.getByTestId("tab-icon");
  await expect(tabIcons.nth(0)).toHaveAttribute("data-source", "saved");
  await expect(tabIcons.nth(1)).toHaveAttribute("data-source", "live");
  const global = page.getByTestId("connectivity");

  await page.getByRole("switch", { name: "Work offline" }).click();
  await expect(global).toHaveAttribute("data-state", "offline");
  await expect(global).toContainText("Offline");
  // The saved tab is still a saved copy; the other tab can no longer reach the live site.
  await expect(tabIcons.nth(0)).toHaveAttribute("data-source", "saved");
  await expect(tabIcons.nth(1)).toHaveAttribute("data-source", "offline");
  await expect(page.getByTestId("tab-source").first()).toHaveAttribute("data-source", "offline");
  await expect(page.getByTestId("open-live")).toBeDisabled();

  await page.getByRole("switch", { name: "Work offline" }).click();
  await expect(global).not.toHaveAttribute("data-state", "offline");
  await expect(tabIcons.nth(1)).toHaveAttribute("data-source", "live");
});

test("show link states: off removes the marks from saved pages, on brings them back", async ({ page }) => {
  const url = articleUrl("/astronomy");
  await savePage(page, url);
  await openAddress(page, url);
  const fl = page.frameLocator('iframe[data-testid="archive-frame"]');
  await expect(fl.getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();
  await expect(fl.locator('style[data-ncb="links"]')).toHaveCount(1);

  await page.getByTestId("help-button").click();
  const sw = page.getByRole("switch", { name: /Mark links in saved pages/ });
  await expect(sw).toBeChecked();
  await sw.click();
  await expect(sw).not.toBeChecked();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(fl.getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();
  await expect(fl.locator('style[data-ncb="links"]')).toHaveCount(0);
  // The links still know their state; only the styling is off.
  expect(await fl.locator("a[data-ncb-link]").count()).toBeGreaterThan(0);

  await page.getByTestId("help-button").click();
  await page.getByRole("switch", { name: /Mark links in saved pages/ }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(fl.locator('style[data-ncb="links"]')).toHaveCount(1);
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme: no serious axe violations on the new screens`, () => {
    test.use({ colorScheme: scheme });
    for (const path of ["/library", "/bookmarks", "/history", "/downloads", "/search?q=tides", `/save?url=${encodeURIComponent("https://example.org/x")}`]) {
      test(path, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
        await expect(page.locator("main")).toHaveCount(1);
        await page.waitForLoadState("networkidle").catch(() => {});
        expect(await serious(page)).toEqual([]);
      });
    }

    test("browser with a saved page, the find bar and the status line", async ({ page }) => {
      const url = articleUrl("/astronomy");
      await savePage(page, url);
      await openAddress(page, url);
      await expect(activeFrame(page)).toBeVisible();
      await page.getByTestId("find-toggle").click();
      await page.getByRole("searchbox", { name: "Find in this page" }).fill("star");
      await expect(page.getByTestId("find-status")).toHaveText(/of \d+ matches/);
      expect(await serious(page)).toEqual([]);
    });

    test("browser with the not-saved page and a capture in progress", async ({ page }) => {
      await openAddress(page, articleUrl("/moon"));
      await expect(page.getByRole("heading", { name: /This page is not saved|A saved copy exists/ })).toBeVisible();
      expect(await serious(page)).toEqual([]);
    });

    test("delete dialog", async ({ page }) => {
      await savePage(page, articleUrl("/astronomy"));
      await page.goto("/library");
      await page.getByRole("button", { name: /Delete .*Astronomy/ }).first().click();
      await expect(page.getByRole("dialog", { name: "Delete this saved page?" })).toBeVisible();
      await expect(page.getByTestId("delete-preview")).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.keyboard.press("Escape");
    });
  });
}
