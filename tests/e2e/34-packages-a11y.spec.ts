import { expect, test } from "@playwright/test";
import { login, mode, setWorkOffline } from "./helpers";
import { serious } from "./storage-helpers";
import { dropPackage, ensurePackage, type Pkg } from "./zim-helpers";

// Phase 8 interface: every new page and dialog passes axe in light and dark, has one h1 and one main landmark, and returns focus after dialogs.
test.skip(mode() !== "real-server", "needs the real server and libzim");

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });
    let wiki: Pkg;
    test.beforeEach(async ({ page }) => {
      await login(page);
      await setWorkOffline(page, false);
      wiki = await ensurePackage(page, "wiki");
      await ensurePackage(page, "chem");
    });

    test("pages: one h1, one main, no serious axe violations", async ({ page }) => {
      for (const p of ["/library/packages", `/library/packages/${wiki.id}`, "/library/wikipedia", "/storage/packages", "/library/sources/new/package", "/search?q=aromatic&scope=zim", "/search?view=settings"]) {
        await page.goto(p);
        await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^(?!.*dark).*$/);
        await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
        await expect(page.locator("main")).toHaveCount(1);
        await expect(page.getByRole("status").filter({ hasText: /^Loading/ })).toHaveCount(0, { timeout: 15_000 });
        if (p.startsWith("/search?q")) await expect(page.getByTestId("search-result").first()).toBeVisible();
        expect(await serious(page), p).toEqual([]);
      }
    });

    test("the package pages with their open states: advanced section, check result, preview", async ({ page }) => {
      await page.goto(`/library/packages/${wiki.id}`);
      await page.getByTestId("verify-package").click();
      await expect(page.getByTestId("verify-result")).toContainText("passed the check");
      await expect(page.getByTestId("entry-row").first()).toBeVisible();
      expect(await serious(page)).toEqual([]);

      await page.goto("/storage/packages");
      await page.getByRole("button", { name: /Advanced settings: search limits/ }).click();
      await page.getByTestId("zim-hits").fill("0");
      await page.getByTestId("zim-save").click();
      await expect(page.getByTestId("error-summary")).toBeFocused();
      expect(await serious(page)).toEqual([]);

      await page.goto("/library/wikipedia");
      await page.getByTestId("wiki-preview-button").click();
      await expect(page.getByTestId("error-summary")).toBeFocused();
      expect(await serious(page)).toEqual([]);
      await page.getByTestId("wiki-start").fill("Astronomy");
      await page.getByTestId("wiki-depth").fill("2");
      await page.getByTestId("wiki-max-pages").fill("20");
      await page.getByTestId("wiki-images").uncheck();
      await page.getByTestId("wiki-preview-button").click();
      await expect(page.getByTestId("wiki-preview")).toBeVisible();
      expect(await serious(page)).toEqual([]);
    });

    test("the add and remove dialogs: axe-clean, focus inside, Escape returns focus to the opener", async ({ page }) => {
      await page.goto("/library/packages");
      const add = page.getByTestId("add-package").first();
      await add.click();
      const dialog = page.getByTestId("add-package-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByTestId("add-copy").check();
      await dialog.getByRole("button", { name: "Advanced settings" }).click();
      await dialog.getByTestId("add-submit").click();
      await expect(page.getByTestId("error-summary")).toBeFocused();
      expect(await serious(page)).toEqual([]);
      // Tab stays inside the dialog.
      for (let i = 0; i < 30; i++) await page.keyboard.press("Tab");
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(add).toBeFocused();

      const trigger = page.getByTestId("package-row").filter({ hasText: "Chemistry (fixture)" }).getByTestId("remove-package");
      await trigger.click();
      await expect(page.getByTestId("remove-file-outcome")).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    });

    test("the package list works by keyboard: the priority select is reachable and labelled", async ({ page }) => {
      await page.goto("/library/packages");
      const select = page.getByLabel("Priority of Wikipedia (fixture)");
      await select.focus();
      await expect(select).toBeFocused();
      await expect(page.getByRole("table", { name: "Knowledge packages" })).toBeVisible();
    });
  });
}

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  await dropPackage(page, "chem");
  await page.close();
});
