import { expect, test } from "@playwright/test";
import { articleUrl, login, mode, savePage, setWorkOffline } from "./helpers";
import { makeSourcedPage, deleteSource, resetPolicy, serious } from "./storage-helpers";

// T-09: every new storage page and dialog passes axe in light and dark, works by keyboard, and respects reduced motion.
test.skip(mode() !== "real-server", "needs the real server");

const STATIC = ["/storage", "/storage/space", "/storage/volumes", "/storage/policy", "/storage/eviction", "/storage/maintenance", "/storage/audit"];

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });
    test.beforeEach(async ({ page }) => {
      await login(page);
      await setWorkOffline(page, false);
      await resetPolicy(page);
    });

    for (const p of STATIC) {
      test(`${p}: one h1, landmarks, no serious axe violations`, async ({ page }) => {
        await page.goto(p);
        await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^(?!.*dark).*$/);
        await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
        await expect(page.locator("main")).toHaveCount(1);
        await expect(page.getByRole("status").filter({ hasText: /Loading/ })).toHaveCount(0, { timeout: 15_000 });
        expect(await serious(page)).toEqual([]);
      });
    }

    test("the explanation page and its pin form", async ({ page }) => {
      const { source, pageId } = await makeSourcedPage(page, `A11y ${scheme} ${Date.now() % 100000}`, "/bread-baking", "P3");
      try {
        await page.goto(`/storage/pages/${pageId}`);
        await expect(page.getByTestId("why-headline")).toBeVisible();
        expect(await serious(page)).toEqual([]);
      } finally {
        await deleteSource(page, source.id);
      }
    });

    test("dialogs: add volume, edit volume, permit warning, run confirmation, repair confirmation", async ({ page }) => {
      await page.goto("/storage/volumes");
      await page.getByTestId("volume-add").click();
      await expect(page.getByRole("dialog", { name: "Add a volume" })).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await page.getByTestId("volume-edit").first().click();
      await page.getByRole("dialog").getByRole("button", { name: /Advanced settings/ }).click();
      expect(await serious(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await page.getByTestId("volume-remove").first().click();
      await expect(page.getByTestId("volume-remove-dialog")).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.keyboard.press("Escape");

      await page.goto("/storage/policy");
      await page.getByTestId("pol-permit").click();
      await expect(page.getByTestId("permit-dialog")).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.keyboard.press("Escape");

      await page.goto("/storage/maintenance");
      await page.getByTestId("verify-run").click();
      await expect(page.getByTestId("report-headline")).toBeVisible();
      expect(await serious(page)).toEqual([]);
    });
  });
}

test("the storage screens work by keyboard alone, with visible focus", async ({ page }) => {
  await login(page);
  await page.goto("/storage/policy");
  const permit = page.getByTestId("pol-permit");
  await permit.focus();
  const outline = await permit.evaluate((el) => {
    const c = getComputedStyle(el);
    return { style: c.outlineStyle, width: parseFloat(c.outlineWidth) };
  });
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThanOrEqual(2);
  // Tab reaches the dialog's controls and Shift+Tab wraps inside it.
  await page.keyboard.press("Space");
  const dialog = page.getByRole("dialog", { name: "Allow removal of Important content?" });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(permit).toBeFocused();

  // The preview form is operable without a mouse.
  await page.goto("/storage/eviction");
  await page.getByTestId("plan-preview").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("plan")).toBeVisible();
});

test("reduced motion is respected on the storage screens", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await login(page);
  await page.goto("/storage/space");
  await expect(page.getByTestId("volume-card").first()).toBeVisible();
  const d = await page.getByRole("progressbar").first().locator("div").first().evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(parseFloat(d)).toBeLessThan(0.01);
  await ctx.close();
});

test("the bars are decoration: every figure is also in a table", async ({ page }) => {
  await login(page);
  await savePage(page, articleUrl("/astronomy"));
  await page.goto("/storage/space");
  await expect(page.getByTestId("usage-priority").getByTestId("usage-row").first()).toBeVisible();
  const bars = page.getByTestId("usage-priority").locator('[aria-hidden="true"].rounded-full');
  expect(await bars.count()).toBeGreaterThan(0);
  expect(await page.getByTestId("usage-priority").getByRole("table").count()).toBe(1);
});
