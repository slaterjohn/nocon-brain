import { expect, test, type Page } from "@playwright/test";
import { login, mode, openAddress, setWorkOffline } from "./helpers";
import { archiveBlackHole, BLACK_HOLE, CSRF, ensurePackage, type Pkg } from "./zim-helpers";

// Phase 8 interface: the address bar and the browser frame with knowledge packages. A Wikipedia address typed offline opens the package
// article; an archived copy and a package copy of the same article can be switched between; the chrome names the package; bookmarks and
// History show and reopen package entries; a Wikipedia saved page shows its credit.
test.skip(mode() !== "real-server", "needs the real server and libzim");
test.describe.configure({ mode: "serial" });

let wiki: Pkg;
let chem: Pkg;
const frame = (page: Page) => page.frameLocator('iframe[data-testid="archive-frame"]:not([hidden])');
const visibleFrame = (page: Page) => page.locator('iframe[data-testid="archive-frame"]:not([hidden])');

async function openAndWait(page: Page, address: string) {
  const read = page.waitForResponse((r) => r.request().method() === "GET" && r.url().includes("/api/browser/frame-state") && r.status() === 200);
  await openAddress(page, address);
  await expect(visibleFrame(page)).toBeVisible();
  await read;
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  await setWorkOffline(page, false);
  wiki = await ensurePackage(page, "wiki");
  chem = await ensurePackage(page, "chem");
  await page.close();
});

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
  await page.request.delete("/api/history", { headers: CSRF });
  await page.request.patch("/api/settings", { data: { privacy: { history: { enabled: true } } }, headers: CSRF });
});
test.afterEach(async ({ page }) => {
  await setWorkOffline(page, false);
});

test("a Wikipedia address typed offline opens the package article, named in the chrome", async ({ page }) => {
  await setWorkOffline(page, true);
  await page.goto("/");
  await openAndWait(page, "https://en.m.wikipedia.org/wiki/Benzene");
  await expect(frame(page).getByText("is an aromatic hydrocarbon")).toBeVisible();
  const badge = page.getByTestId("tab-source");
  await expect(badge).toHaveAttribute("data-source", "package");
  await expect(badge).toContainText("Package: Wikipedia (fixture)");
  // The address bar shows the Wikipedia address the Human typed, in its normal form.
  await expect(page.getByRole("textbox", { name: "Address or search terms" })).toHaveValue("https://en.wikipedia.org/wiki/Benzene");
  await expect(page.getByRole("heading", { level: 1, name: "Benzene" })).toBeAttached();
  // The package is not a live site and not a save: no save button, and the live site is not offered while offline.
  await expect(page.getByTestId("save-button")).toHaveCount(0);
  await expect(page.getByTestId("open-live")).toBeDisabled();
  // A page that is neither saved nor in a package is the offline page, not a request to Wikipedia.
  await openAddress(page, "https://en.wikipedia.org/wiki/Zirconium");
  await expect(page.getByRole("heading", { name: /not saved, and you're offline/ })).toBeVisible();
});

test("a link inside the package article follows the frame: the address bar and history move with it", async ({ page }) => {
  await setWorkOffline(page, true);
  await page.goto("/");
  await openAndWait(page, "https://en.wikipedia.org/wiki/Benzene");
  const next = page.waitForResponse((r) => r.url().includes("/api/browser/frame-state") && r.status() === 200);
  await frame(page).getByRole("link", { name: "toluene" }).click();
  await next;
  await expect(page.getByRole("textbox", { name: "Address or search terms" })).toHaveValue("https://en.wikipedia.org/wiki/Toluene");
  await expect(page.getByTestId("tab-source")).toContainText("Package: Wikipedia (fixture)");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(frame(page).getByText("is an aromatic hydrocarbon")).toBeVisible();
});

test("an archived copy and the package copy of the same article: switch between them", async ({ page }) => {
  await archiveBlackHole(page);
  await page.goto("/");
  await openAndWait(page, BLACK_HOLE);
  // The archived copy wins, and the package copy is offered.
  await expect(page.getByTestId("tab-source")).toHaveAttribute("data-source", /^(saved|partial)$/);
  await expect(page.getByTestId("alt-archive")).toHaveCount(0);
  const toPackage = page.getByTestId("alt-package");
  await expect(toPackage).toBeVisible();
  await expect(toPackage).toContainText("Also in a knowledge package");
  await toPackage.click();
  await expect(page.getByTestId("tab-source")).toHaveAttribute("data-source", "package");
  await expect(frame(page).getByText("region of spacetime")).toBeVisible();
  await expect(page.getByTestId("alt-package")).toHaveCount(0);
  const toArchive = page.getByTestId("alt-archive");
  await expect(toArchive).toContainText("Also archived");
  await toArchive.click();
  await expect(page.getByTestId("tab-source")).toHaveAttribute("data-source", /^(saved|partial)$/);
  await expect(page.getByTestId("alt-package")).toBeVisible();
  // The attribution of the saved copy is on the page's details.
  const r = await page.request.post("/api/browser/resolve", { data: { input: BLACK_HOLE }, headers: CSRF });
  const saved = ((await r.json()) as { resolution: { page?: { id: string } } }).resolution.page;
  expect(saved, "the saved Wikipedia page").toBeTruthy();
  await page.goto(`/library/pages/${saved!.id}`);
  const credit = page.getByTestId("version-attribution");
  await expect(credit).toBeVisible();
  await expect(credit).toContainText("CC BY-SA 4.0");
  await expect(credit.getByTestId("attribution-revision")).not.toBeEmpty();
  await expect(credit.getByRole("link", { name: /article history/ })).toHaveAttribute("href", /action=history/);
  await expect(credit.getByRole("link", { name: /article history/ })).toHaveAttribute("target", "_blank");
});

test("bookmarks and History show the package and reopen the article", async ({ page }) => {
  await setWorkOffline(page, true);
  await page.goto("/");
  await openAndWait(page, "https://en.wikipedia.org/wiki/Aromaticity");
  await page.getByTestId("bookmark-toggle").click();
  await expect(page.getByTestId("bookmark-toggle")).toHaveAttribute("aria-pressed", "true");

  await page.goto("/history");
  const hrow = page.getByTestId("history-row").filter({ hasText: "Aromaticity" });
  await expect(hrow).toHaveCount(1);
  await expect(hrow).toContainText("Knowledge package");
  await expect(hrow.getByTestId("history-package")).toContainText("Wikipedia (fixture)");
  await hrow.getByRole("button", { name: "Aromaticity", exact: true }).click();
  await expect(visibleFrame(page)).toBeVisible();
  await expect(frame(page).getByText("stability of a ring")).toBeVisible();

  await page.goto("/bookmarks");
  const brow = page.getByTestId("bookmark-row").filter({ hasText: "Aromaticity" });
  await expect(brow.getByTestId("bookmark-package")).toContainText("Wikipedia (fixture)");
  await brow.getByRole("button", { name: /Open/ }).click();
  await expect(visibleFrame(page)).toBeVisible();
  await expect(frame(page).getByText("stability of a ring")).toBeVisible();
  // Toggle it off again.
  await page.getByTestId("bookmark-toggle").click();
  await expect(page.getByTestId("bookmark-toggle")).toHaveAttribute("aria-pressed", "false");
});

test("an article of a package that has no web address: the address bar shows its package address, and it can be bookmarked", async ({ page }) => {
  await page.goto(`/library/packages/${chem.id}`);
  await page.getByTestId("entry-find").fill("Water");
  const read = page.waitForResponse((r) => r.url().includes("/api/browser/frame-state") && r.status() === 200);
  await page.getByTestId("entry-row").getByRole("button", { name: "Water" }).click();
  await expect(visibleFrame(page)).toBeVisible();
  await read;
  await expect(page.getByTestId("tab-source")).toContainText("Package: Chemistry (fixture)");
  await expect(page.getByRole("textbox", { name: "Address or search terms" })).toHaveValue(new RegExp(`^zim://${chem.id}/Water`));
  await expect(page.getByTestId("alt-package")).toHaveCount(0);
  await page.getByTestId("bookmark-toggle").click();
  await expect(page.getByTestId("bookmark-toggle")).toHaveAttribute("aria-pressed", "true");

  await page.goto("/bookmarks");
  const brow = page.getByTestId("bookmark-row").filter({ hasText: "Water" });
  await expect(brow.getByTestId("bookmark-package")).toContainText("Chemistry (fixture)");
  await expect(brow.getByRole("button", { name: /Save for offline/ })).toHaveCount(0);
  await brow.getByRole("button", { name: /Open/ }).click();
  await expect(frame(page).getByText("H2O")).toBeVisible();
  await page.getByTestId("bookmark-toggle").click();
  await expect(page.getByTestId("bookmark-toggle")).toHaveAttribute("aria-pressed", "false");
});
