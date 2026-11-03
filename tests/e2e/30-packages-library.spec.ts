import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { login, mode, setWorkOffline } from "./helpers";
import { CSRF, dropPackage, ensurePackage, fixturePath, listPackages } from "./zim-helpers";

// Phase 8 interface: knowledge packages in the Library. The list, the add dialog (in place and copied), the detail page (check, articles with
// paging, references), a priority change, a source for a package, and removal with the dry-run list and the file outcome.
test.skip(mode() !== "real-server", "needs the real server and libzim");
test.describe.configure({ mode: "serial" });

const CHEM = "Chemistry (fixture)";

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
});
test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  await dropPackage(page, "chem");
  await page.close();
});

test("the add dialog: errors in an error summary, a path outside the allowed folders, then a package in place", async ({ page }) => {
  await dropPackage(page, "chem");
  const file = await fixturePath("chem");
  await page.goto("/library/packages");
  await expect(page.getByRole("navigation", { name: "Library sections" }).getByRole("link", { name: "Packages" })).toHaveAttribute("aria-current", "page");
  const add = page.getByTestId("add-package").first();
  await add.click();
  const dialog = page.getByTestId("add-package-dialog");
  await expect(dialog).toBeVisible();

  // Empty path: the summary takes focus and links to the field.
  await dialog.getByTestId("add-submit").click();
  await expect(page.getByTestId("error-summary")).toBeFocused();
  await expect(page.getByTestId("error-summary")).toContainText("Enter the full path");
  await page.getByTestId("error-summary").getByRole("link", { name: /Enter the full path/ }).click();
  await expect(dialog.getByLabel("Path to the .zim file")).toBeFocused();

  // Wrong ending, then a real file outside the folders the server may read: both are said in words, on the field.
  await dialog.getByLabel("Path to the .zim file").fill("/mnt/library/wiki.txt");
  await dialog.getByTestId("add-submit").click();
  await expect(page.getByTestId("error-summary")).toContainText("must end in .zim");
  await dialog.getByLabel("Path to the .zim file").fill("/etc/hosts.zim");
  await dialog.getByTestId("add-submit").click();
  await expect(dialog.locator("#zimadd-path-error")).toBeVisible();
  await expect(page.getByTestId("error-summary")).toBeFocused();

  // In place is the default; the copy option shows its volume choice.
  await expect(dialog.getByTestId("add-in-place")).toBeChecked();
  await dialog.getByTestId("add-copy").check();
  await expect(dialog.getByLabel("Volume for the copy")).toBeVisible();
  await dialog.getByTestId("add-in-place").check();

  await dialog.getByLabel("Path to the .zim file").fill(file);
  await dialog.getByTestId("add-submit").click();
  await expect(dialog).toBeHidden();
  const row = page.getByTestId("package-row").filter({ hasText: CHEM });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("package-state")).toHaveText("Ready");
  await expect(row).toContainText("English");
  await expect(row).toContainText("Read in place");
  await expect(row).toContainText("CC BY-SA 4.0");
  await expect(add).toBeFocused();

  // The list columns.
  await expect(page.getByRole("table", { name: "Knowledge packages" }).getByRole("columnheader")).toHaveText(["Package", "Language", "Flavour", "Size", "Articles", "State", "Priority", "Licence", "Actions"]);

  // Priority change is saved.
  await row.getByLabel(`Priority of ${CHEM}`).selectOption("P2");
  await expect.poll(async () => (await listPackages(page)).find((p) => p.title === CHEM)?.priority).toBe("P2");
});

test("the detail page: details, a check, articles with paging, references, and opening an article", async ({ page }) => {
  const pkg = await ensurePackage(page, "chem");
  // The fixture has only a handful of articles, so ask for three at a time to see the paging.
  await page.route("**/api/zim/packages/*/entries?*", (route) => route.continue({ url: route.request().url().replace(/limit=\d+/, "limit=3") }));
  await page.goto("/library/packages");
  await page.getByTestId("package-row").filter({ hasText: CHEM }).getByTestId("package-link").click();
  await expect(page.getByRole("heading", { level: 1, name: CHEM })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/library/packages/${pkg.id}$`));
  const meta = page.getByTestId("package-meta");
  await expect(meta).toContainText("English");
  await expect(meta).toContainText("Full-text search");
  await expect(page.getByTestId("package-counts")).toContainText("articles");
  await expect(meta).toContainText("Read in place");
  await expect(meta).toContainText("Packages are never removed automatically");

  // Check: a plain-words result.
  await page.getByTestId("verify-package").click();
  await expect(page.getByTestId("verify-result")).toContainText("The package passed the check");
  await expect(page.getByTestId("verify-result").getByRole("listitem").first()).toBeVisible();

  // Articles, a page at a time: "Show more" follows the cursor and adds to the list.
  await expect(page.getByTestId("entry-row").first()).toBeVisible();
  const first = await page.getByTestId("entry-row").count();
  expect(first).toBe(3);
  await expect(page.getByTestId("entries-count")).toContainText(`Showing ${first}`);
  await page.getByTestId("entries-more").click();
  await expect.poll(async () => page.getByTestId("entry-row").count()).toBeGreaterThan(first);
  await page.getByTestId("entry-find").fill("Benz");
  await expect(page.getByTestId("entry-row")).toHaveCount(1);
  await expect(page.getByTestId("entry-row")).toContainText("Benzene");

  // References.
  await expect(page.getByTestId("package-refs")).toBeVisible();
  await expect(page.getByTestId("package-refs")).toContainText("Bookmarks (0)");

  // Opening an article puts it in the browser, with the package named in the chrome.
  await page.getByTestId("entry-row").getByRole("button", { name: "Benzene" }).click();
  await expect(page.locator('iframe[data-testid="archive-frame"]:not([hidden])')).toBeVisible();
  await expect(page.getByTestId("tab-source")).toHaveAttribute("data-source", "package");
  await expect(page.getByTestId("tab-source")).toContainText(`Package: ${CHEM}`);
  await expect(page.frameLocator('iframe[data-testid="archive-frame"]').getByText("aromatic ring hydrocarbon")).toBeVisible();
});

test("a source for a package: the wizard type points to the form, the form makes it, and its page shows the package", async ({ page }) => {
  await dropPackage(page, "chem");
  const pkg = await ensurePackage(page, "chem", { createSource: false });
  expect(pkg.sourceId).toBeNull();

  await page.goto("/library/sources/new");
  await expect(page.getByRole("radio", { name: "Knowledge package" })).toBeDisabled();
  await expect(page.getByText("Added separately")).toBeVisible();
  await page.getByTestId("package-source-link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Source for a knowledge package" })).toBeVisible();
  await page.getByLabel("Package", { exact: true }).selectOption({ label: CHEM });
  await page.getByTestId("package-source-create").click();

  await expect(page.getByRole("heading", { level: 1, name: CHEM })).toBeVisible();
  await expect(page.getByTestId("source-package")).toContainText(CHEM);
  await expect(page.getByTestId("run-now")).toHaveCount(0);
  await expect(page.getByTestId("source-articles")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open the package" })).toBeVisible();

  // The package now links to its source, and a second source is not offered.
  await page.goto(`/library/packages/${pkg.id}`);
  await expect(page.getByTestId("package-source-link")).toBeVisible();
  await page.goto("/library/sources/new/package");
  await expect(page.getByText("Every package already has a source")).toBeVisible();
  // The Sources list shows its type and size.
  await page.goto("/library/sources");
  await expect(page.getByTestId("source-row").filter({ hasText: CHEM })).toContainText("Knowledge package");
});

test("removal: the dry-run list, an acknowledgement, and a file added in place stays on disk", async ({ page }) => {
  const pkg = await ensurePackage(page, "chem");
  const file = await fixturePath("chem");
  // A bookmark of an article refers to the package.
  const bm = await page.request.post("/api/bookmarks", { data: { zimId: pkg.id, zimPath: "Benzene", title: "Chemistry benzene (UI test)" }, headers: CSRF });
  expect(bm.ok(), await bm.text()).toBeTruthy();

  await page.goto("/library/packages");
  const row = page.getByTestId("package-row").filter({ hasText: CHEM });
  const trigger = row.getByTestId("remove-package");
  await trigger.click();
  const dialog = page.getByTestId("remove-package-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("remove-file-outcome")).toContainText("stays on disk");
  await expect(page.getByTestId("ref-bookmarks")).toContainText("1 bookmark");
  await expect(page.getByTestId("ref-sources")).toContainText("bound to this package");
  const confirm = page.getByTestId("remove-confirm");
  await expect(confirm).toBeDisabled();

  // Cancel returns focus to the button that opened the dialog, and removes nothing.
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  expect((await listPackages(page)).some((p) => p.title === CHEM)).toBe(true);

  await trigger.click();
  await page.getByTestId("remove-ack").click();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(row).toHaveCount(0);
  expect((await listPackages(page)).some((p) => p.title === CHEM)).toBe(false);
  // The bookmark that pointed only at the package went with it; the file is untouched.
  expect(fs.existsSync(file)).toBe(true);
  const left = (await (await page.request.get("/api/bookmarks")).json()) as { items: { title: string }[] };
  expect(left.items.some((b) => b.title === "Chemistry benzene (UI test)")).toBe(false);
});

test("a copied package: progress in the dialog, and removal deletes only the copy", async ({ page }) => {
  await dropPackage(page, "chem");
  const file = await fixturePath("chem");
  await page.goto("/library/packages");
  await page.getByTestId("add-package").first().click();
  const dialog = page.getByTestId("add-package-dialog");
  await dialog.getByLabel("Path to the .zim file").fill(file);
  await dialog.getByTestId("add-copy").check();
  await dialog.getByTestId("add-submit").click();
  // A small file copies at once, so the dialog may show the progress note only briefly; either way it ends saying the copy is ready.
  await expect(dialog.getByTestId("copy-progress")).toBeVisible();
  await expect(dialog.getByTestId("copy-done")).toContainText("is copied and ready", { timeout: 30_000 });
  await dialog.getByTestId("add-close").click();

  const row = page.getByTestId("package-row").filter({ hasText: CHEM });
  await expect(row).toContainText("Copied into storage");
  const copy = (await listPackages(page)).find((p) => p.title === CHEM)!;
  expect(copy.storageMode).toBe("copied");
  expect(copy.path).not.toBe(file);
  expect(fs.existsSync(copy.path)).toBe(true);

  await row.getByTestId("remove-package").click();
  await expect(page.getByTestId("remove-file-outcome")).toContainText("deletes that copy");
  await expect(page.getByTestId("remove-file-outcome")).toContainText("original file you added is not touched");
  // Its bound source is a reference too, so removal asks for the acknowledgement.
  await page.getByTestId("remove-ack").click();
  await page.getByTestId("remove-confirm").click();
  await expect(row).toHaveCount(0);
  expect(fs.existsSync(copy.path)).toBe(false);
  expect(fs.existsSync(file)).toBe(true);
});
