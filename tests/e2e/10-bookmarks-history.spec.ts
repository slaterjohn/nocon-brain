import { expect, test } from "@playwright/test";
import { activeFrame, articleUrl, login, mode, openAddress, savePage, setWorkOffline } from "./helpers";

// A-17: bookmarks and history in the UI.
test.skip(mode() !== "real-server", "needs the real server");

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
  await page.request.delete("/api/history", { headers: { "X-NoCon-CSRF": "1" } });
  await page.request.patch("/api/settings", { data: { privacy: { history: { enabled: true } } }, headers: { "X-NoCon-CSRF": "1" } });
});

test("the star bookmarks a saved page with its copy, and removes the bookmark again", async ({ page }) => {
  const url = articleUrl("/stars");
  await savePage(page, url);
  await openAddress(page, url);
  await expect(activeFrame(page)).toBeVisible();

  const star = page.getByTestId("bookmark-toggle");
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await expect(star).toHaveAccessibleName("Bookmark this page");
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "true");
  await expect(star).toHaveAccessibleName("Remove bookmark");

  // It shows in the menu and on the page, linked to the saved copy.
  await page.getByTestId("bookmarks-menu").click();
  await expect(page.getByRole("menuitem", { name: /Saved copy/ }).first()).toBeVisible();
  await page.getByRole("menuitem", { name: /All bookmarks/ }).click();
  await expect(page).toHaveURL(/\/bookmarks$/);
  const row = page.getByTestId("bookmark-row").filter({ hasText: "/stars" });
  await expect(row).toContainText("Saved copy");
  // Opening it goes back to the Browser area and the saved copy.
  await row.getByRole("button", { name: /Open/ }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(activeFrame(page)).toBeVisible();
  await expect(page.getByTestId("bookmark-toggle")).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("bookmark-toggle").click();
  await expect(page.getByTestId("bookmark-toggle")).toHaveAttribute("aria-pressed", "false");
});

test("a bookmark of an address that is not saved offers 'Save for offline'", async ({ page }) => {
  const url = articleUrl("/galaxies");
  await openAddress(page, url);
  await expect(page.getByRole("heading", { name: "This page is not saved" })).toBeVisible();
  await page.getByTestId("bookmark-toggle").click();
  await expect(page.getByTestId("bookmark-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.goto("/bookmarks");
  const row = page.getByTestId("bookmark-row").filter({ hasText: "/galaxies" });
  await expect(row).toContainText("Not saved");
  await row.getByRole("button", { name: /Save for offline/ }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("bookmark-row").filter({ hasText: "/galaxies" })).toContainText("Saved copy");
  }).toPass({ timeout: 20_000 });
  // Clean up so other specs see a stable list.
  await page.getByTestId("bookmark-row").filter({ hasText: "/galaxies" }).getByRole("button", { name: /Remove bookmark/ }).click();
  await expect(page.getByTestId("bookmark-row").filter({ hasText: "/galaxies" })).toHaveCount(0);
});

test("history records saved and live visits with the marker, can be turned off, and cleared", async ({ page }) => {
  const saved = articleUrl("/comets");
  const live = articleUrl("/telescopes");
  await savePage(page, saved);
  await openAddress(page, saved);
  await expect(activeFrame(page)).toBeVisible();
  await openAddress(page, live);
  await expect(page.getByRole("heading", { name: "This page is not saved" })).toBeVisible();

  await page.goto("/history");
  await expect(page.getByRole("heading", { level: 1, name: "History" })).toBeVisible();
  const savedRow = page.getByTestId("history-row").filter({ hasText: "/comets" });
  const liveRow = page.getByTestId("history-row").filter({ hasText: "/telescopes" });
  await expect(savedRow).toContainText("Saved copy");
  await expect(liveRow).toContainText("Live site");
  await expect(page.getByTestId("history-row").filter({ hasText: "/comets" })).toHaveCount(1);

  // Turn history off: a new visit is not recorded.
  await page.getByRole("switch", { name: "Record history" }).click();
  await expect(page.getByText("History is switched off")).toBeVisible();
  await page.getByRole("link", { name: "Bookmarks" }).first().click();
  await page.getByRole("link", { name: "Browser" }).click();
  await openAddress(page, articleUrl("/moon"));
  await expect(page.getByRole("heading", { name: "This page is not saved" })).toBeVisible();
  await page.goto("/history");
  await expect(page.getByTestId("history-row").filter({ hasText: "/moon" })).toHaveCount(0);

  // Clearing deletes everything.
  await page.getByTestId("clear-history").click();
  await expect(page.getByTestId("history-row")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No history" })).toBeVisible();
});
