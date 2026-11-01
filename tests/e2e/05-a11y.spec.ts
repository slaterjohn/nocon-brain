/// <reference lib="dom" />
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { login, trackExternalRequests } from "./helpers";

const PAGES = ["/", "/library", "/downloads", "/search", "/storage", "/storage/dashboard", "/storage/activity"];
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test("sign-in screen has no serious axe violations", async ({ page }) => {
      await page.goto("/login");
      await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^(?!.*dark).*$/);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      expect(await seriousViolations(page)).toEqual([]);
    });

    for (const path of PAGES) {
      test(`${path}: landmarks, one h1 and no serious axe violations; no external requests`, async ({ page, baseURL }) => {
        const external = trackExternalRequests(page, baseURL!);
        await login(page);
        await page.goto(path);
        await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^(?!.*dark).*$/);
        await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
        await expect(page.locator("main")).toHaveCount(1);
        await page.waitForLoadState("networkidle").catch(() => {});
        // Settled: the event stream is open and the connection is honestly reported as not checked.
        await expect(page.getByTestId("connectivity")).toHaveAttribute("data-stream", "open");
        await expect(page.getByTestId("connectivity")).toHaveAttribute("data-state", "unknown");
        expect(await seriousViolations(page)).toEqual([]);
        expect(external, "requests to external hosts").toEqual([]);
      });
    }
  });
}

test("theme toggle switches the theme and remembers it", async ({ page }) => {
  await login(page);
  const html = page.locator("html");
  const before = (await html.getAttribute("class"))?.includes("dark") ?? false;
  await page.getByTestId("theme-toggle").click();
  await expect(html).toHaveClass(before ? /^(?!.*dark).*$/ : /dark/);
  await page.reload();
  await expect(html).toHaveClass(before ? /^(?!.*dark).*$/ : /dark/);
  expect(await seriousViolations(page)).toEqual([]);
});

test("skip link is the first tab stop and moves focus into main", async ({ page }) => {
  await login(page);
  await page.goto("/library");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const skip = page.getByRole("link", { name: "Skip to main content" });
  for (let i = 0; i < 2 && !(await skip.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("main");
});

test("focused controls have a visible focus indicator", async ({ page }) => {
  await login(page);
  const link = page.getByRole("navigation", { name: "Areas" }).getByRole("link", { name: "Library" });
  await link.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  const style = await link.evaluate((el) => {
    const c = getComputedStyle(el);
    return { style: c.outlineStyle, width: parseFloat(c.outlineWidth) };
  });
  expect(style.style).not.toBe("none");
  expect(style.width).toBeGreaterThanOrEqual(2);
});

test("reduced motion removes transitions", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto("/login");
  const d = await page.getByRole("button", { name: "Sign in" }).evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(parseFloat(d)).toBeLessThan(0.01);
  await ctx.close();
});
