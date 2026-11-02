import { expect, test } from "@playwright/test";
import { login, mode, setWorkOffline } from "./helpers";
import { CSRF, enableDiscovery, openCandidate, resetDiscovery, rowFor, seedCandidates } from "./discovery-helpers";
import { serious } from "./storage-helpers";

// D-07: every Discovery page and dialog passes axe in light and dark, works by keyboard with visible focus, returns focus after
// dialogs, and respects reduced motion.
test.skip(mode() !== "real-server", "needs the real server");

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });
    test.beforeEach(async ({ page }) => {
      await login(page);
      await setWorkOffline(page, false);
      await resetDiscovery(page);
    });
    test.afterEach(async ({ page }) => {
      await resetDiscovery(page);
    });

    test("pages: one h1, landmarks, no serious axe violations (discovery off)", async ({ page }) => {
      for (const p of ["/discovery", "/discovery/budget", "/discovery/settings"]) {
        await page.goto(p);
        await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^(?!.*dark).*$/);
        await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
        await expect(page.locator("main")).toHaveCount(1);
        await expect(page.getByRole("status").filter({ hasText: /^Loading/ })).toHaveCount(0, { timeout: 15_000 });
        expect(await serious(page), p).toEqual([]);
      }
    });

    test("the candidates page with candidates, the why panel and the dialogs", async ({ page }) => {
      await enableDiscovery(page);
      const fresh = await seedCandidates(page, 2);
      await openCandidate(page, fresh[0]!);
      const row = rowFor(page, fresh[0]!);
      expect(await serious(page)).toEqual([]);

      await row.getByTestId("candidate-why").click();
      await expect(row.getByTestId("why-table")).toBeVisible();
      expect(await serious(page)).toEqual([]);

      // Approve dialog, then Escape: focus returns to the button that opened it.
      const approve = row.getByTestId("candidate-approve");
      await approve.click();
      await expect(page.getByTestId("approve-dialog")).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(approve).toBeFocused();

      // Bulk bar and the dismiss confirmation.
      await page.getByLabel("Address or title contains").fill("");
      await expect(page.getByTestId("candidate-row").nth(1)).toBeVisible();
      await page.getByTestId("candidate-select").nth(0).click();
      await page.getByTestId("candidate-select").nth(1).click();
      expect(await serious(page)).toEqual([]);
      await page.getByTestId("bulk-dismiss").click();
      await expect(page.getByTestId("dismiss-dialog")).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("bulk-dismiss")).toBeFocused();

      // An empty filtered list and an error-free "no match" state.
      await page.getByLabel("Site").fill("nothing.invalid");
      await expect(page.getByText("No suggestions match")).toBeVisible();
      expect(await serious(page)).toEqual([]);
    });

    test("the budget page with discovery on, a pass reported, and the kill switch dialog", async ({ page }) => {
      await enableDiscovery(page);
      const fresh = await seedCandidates(page);
      await page.request.post(`/api/discovery/candidates/${fresh[0]!.id}/approve`, { headers: CSRF, data: {} });
      await page.request.post("/api/discovery/run", { headers: CSRF });
      await page.goto("/discovery/budget");
      await expect(page.getByTestId("last-pass")).toBeVisible();
      await expect(page.getByTestId("ledger-row").first()).toBeVisible();
      expect(await serious(page)).toEqual([]);
      const pause = page.getByTestId("kill-pause");
      await pause.click();
      await expect(page.getByTestId("pause-dialog")).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(pause).toBeFocused();
      // The paused state.
      await page.request.post("/api/discovery/pause", { headers: CSRF });
      await page.reload();
      await expect(page.getByTestId("kill-resume")).toBeVisible();
      expect(await serious(page)).toEqual([]);
    });

    test("the settings page with every advanced section open, an error summary and the acknowledgement dialog", async ({ page }) => {
      await page.goto("/discovery/settings");
      await expect(page.getByTestId("settings-form")).toBeVisible();
      for (const name of [/^Limits/, /^Suggestion pool/, /^Global ceilings/, /^Scoring weights/]) await page.getByRole("button", { name }).click();
      expect(await serious(page)).toEqual([]);

      await page.getByTestId("set-active.maxDepth").fill("9");
      await page.getByTestId("set-weights.bookmarks").fill("x");
      await page.getByTestId("settings-save").click();
      await expect(page.getByTestId("error-summary")).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.getByTestId("settings-discard").click();

      await page.getByTestId("mode-automatic").click();
      await expect(page.getByTestId("ack-dialog")).toBeVisible();
      expect(await serious(page)).toEqual([]);
      await page.getByTestId("ack-checkbox").click();
      expect(await serious(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("mode-automatic")).toBeFocused();
    });
  });
}

test("the discovery screens work by keyboard alone, with visible focus", async ({ page }) => {
  await login(page);
  await resetDiscovery(page);
  await enableDiscovery(page);
  const fresh = await seedCandidates(page);
  await openCandidate(page, fresh[0]!);
  const row = rowFor(page, fresh[0]!);
  const why = row.getByTestId("candidate-why");
  await why.focus();
  const outline = await why.evaluate((el) => {
    const c = getComputedStyle(el);
    return { style: c.outlineStyle, width: parseFloat(c.outlineWidth) };
  });
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThanOrEqual(2);
  await page.keyboard.press("Enter");
  await expect(row.getByTestId("why-panel")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(row.getByTestId("why-panel")).toHaveCount(0);

  // Approve by keyboard: open the dialog with Space, Tab inside it, close with Escape, focus comes back.
  const approve = row.getByTestId("candidate-approve");
  await approve.focus();
  await page.keyboard.press("Space");
  const dialog = page.getByTestId("approve-dialog");
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(approve).toBeFocused();

  // The settings form: a switch toggles with Space, and the radios move with the arrow keys.
  await resetDiscovery(page);
  await page.goto("/discovery/settings");
  const master = page.getByTestId("set-enabled");
  await master.focus();
  await page.keyboard.press("Space");
  await expect(master).toBeChecked();
  await page.getByTestId("mode-off").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("mode-approval")).toBeChecked();
  await resetDiscovery(page);
});

test("reduced motion is respected on the discovery screens", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await login(page);
  await enableDiscovery(page);
  await page.goto("/discovery/budget");
  await expect(page.getByTestId("meter-active-requests")).toBeVisible();
  const d = await page.getByTestId("meter-active-requests").getByRole("progressbar").locator("div").first().evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(parseFloat(d)).toBeLessThan(0.01);
  await resetDiscovery(page);
  await ctx.close();
});
