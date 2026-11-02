import { expect, test } from "@playwright/test";
import { activeFrame, articleUrl, login, mode, savePage, setWorkOffline } from "./helpers";

// The basic Library (Phase 2 deliverable): list, open, delete with a confirmation.
test.skip(mode() !== "real-server", "needs the real server");

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
});

test("lists saved pages with title, site, saved date, versions and size, and opens one in the browser", async ({ page }) => {
  await savePage(page, articleUrl("/planets"));
  await page.getByRole("navigation", { name: "Areas" }).getByRole("link", { name: "Library" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
  const table = page.getByRole("table", { name: "Saved pages" });
  await expect(table.getByRole("columnheader")).toHaveText(["", "Title", "Site", "Saved", "Versions", "Size", "Actions"]);
  const row = page.getByTestId("library-row").filter({ hasText: "/planets" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("127.0.0.1");
  await expect(row.getByRole("cell").nth(4)).toHaveText("1");
  await expect(row.getByRole("cell").nth(5)).toHaveText(/\d+(\.\d)? (KB|MB)/);
  await expect(row.getByRole("cell").nth(3)).not.toBeEmpty();

  await page.getByLabel("Search saved pages").fill("planets");
  await expect(page.getByTestId("library-count")).toContainText(/^1 page$/);
  await page.getByLabel("Search saved pages").fill("no-such-page-xyz");
  await expect(page.getByRole("heading", { name: "No saved page matches" })).toBeVisible();
  await page.getByLabel("Search saved pages").fill("planets");

  await page.getByTestId("library-row").filter({ hasText: "/planets" }).getByRole("button", { name: /Open .* in the browser/ }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(activeFrame(page)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Address or search terms" })).toHaveValue(articleUrl("/planets"));
});

test("deleting asks first, shows what goes, and the page is then no longer saved", async ({ page }) => {
  const url = articleUrl("/hydropower");
  await savePage(page, url);
  await page.goto("/library");
  await page.getByLabel("Search saved pages").fill("hydropower");
  const row = page.getByTestId("library-row").filter({ hasText: "/hydropower" });
  await expect(row).toBeVisible();

  // Cancel keeps it.
  await row.getByRole("button", { name: /Delete/ }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this saved page?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("delete-preview")).toContainText("1 version will be deleted");
  await expect(dialog.getByTestId("delete-preview")).toContainText("space is freed");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByRole("button", { name: /Delete/ })).toBeFocused(); // focus returns to the control that opened it
  await expect(row).toBeVisible();

  // Confirm removes it.
  await row.getByRole("button", { name: /Delete/ }).click();
  await page.getByTestId("confirm-delete").click();
  await expect(page.getByTestId("library-row").filter({ hasText: "/hydropower" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No saved page matches" })).toBeVisible();

  const r = await page.request.post("/api/browser/resolve", { data: { input: url }, headers: { "X-NoCon-CSRF": "1" } });
  expect(((await r.json()) as { resolution: { kind: string } }).resolution.kind).toBe("live");
});

test("the empty Library says what to do", async ({ page }) => {
  await page.goto("/library");
  await page.getByLabel("Search saved pages").fill("nothing-matches-this");
  await expect(page.getByRole("heading", { name: "No saved page matches" })).toBeVisible();
});
