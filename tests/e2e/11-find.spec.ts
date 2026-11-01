import { expect, test } from "@playwright/test";
import { activeFrame, articleUrl, login, mode, openAddress, savePage, setWorkOffline } from "./helpers";

// A-18: find in page. These assertions double as the spike for fragment navigation in a sandboxed, cross-origin frame:
// moving between hits must scroll the frame without a new document request.
test.skip(mode() !== "real-server", "needs the real server");

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
});

test("count, next, previous and close drive the sandboxed frame by fragment, with no reload", async ({ page }) => {
  const url = articleUrl("/astronomy");
  const saved = await savePage(page, url);
  await openAddress(page, url);
  const fl = page.frameLocator('iframe[data-testid="archive-frame"]');
  await expect(fl.getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();

  // Count the document requests the frame makes to the listener from now on.
  const docs: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith(process.env.E2E_ARCHIVE_URL!) && r.resourceType() === "document") docs.push(r.url());
  });

  const joint = await page.evaluate(() => history.length);
  await page.getByTestId("find-toggle").click();
  const input = page.getByRole("searchbox", { name: "Find in this page" });
  await expect(input).toBeFocused();
  await input.fill("star");

  const status = page.getByTestId("find-status");
  await expect(status).toHaveText(/^1 of \d+ matches$/);
  const total = Number((await status.textContent())!.match(/of (\d+)/)![1]);
  expect(total).toBeGreaterThan(1);

  // The count the API gives is the number of marks the listener put in the page.
  const api = await page.request.get(`/api/archive/versions/${saved.versionId}/find?q=star`);
  expect(((await api.json()) as { count: number }).count).toBe(total);
  const marks = fl.locator("mark.ncb-hit");
  await expect(marks).toHaveCount(total);
  // Exactly one document load happened for the highlight (the reload with ?hl=).
  await expect.poll(() => docs.length).toBe(1);
  expect(docs[0]).toContain("hl=star");
  await expect(fl.locator("mark:target")).toHaveAttribute("id", "ncb-hit-1");
  await expect(fl.locator("mark:target")).toBeInViewport();

  const before = docs.length;
  await page.getByRole("button", { name: "Next match" }).click();
  await expect(status).toHaveText(`2 of ${total} matches`);
  await expect(fl.locator("mark:target")).toHaveAttribute("id", "ncb-hit-2");
  await expect(fl.locator("mark:target")).toBeInViewport();
  await page.getByRole("button", { name: "Previous match" }).click();
  await expect(fl.locator("mark:target")).toHaveAttribute("id", "ncb-hit-1");
  await page.getByRole("button", { name: "Previous match" }).click();
  await expect(status).toHaveText(`${total} of ${total} matches`);
  await expect(fl.locator("mark:target")).toHaveAttribute("id", `ncb-hit-${total}`);
  await expect(fl.locator("mark:target")).toBeInViewport();
  // Enter in the box goes to the next match, Shift+Enter to the previous one.
  await input.press("Enter");
  await expect(status).toHaveText(`1 of ${total} matches`);
  await input.press("Shift+Enter");
  await expect(status).toHaveText(`${total} of ${total} matches`);
  // Spike result: fragment moves made no further document request.
  expect(docs.length).toBe(before);

  // The address bar did not change, and no history entry was added by the highlight.
  await expect(page.getByRole("textbox", { name: "Address or search terms" })).toHaveValue(url);
  expect(await page.evaluate(() => history.length)).toBe(joint);

  // No match, then close: the marks go and focus returns to the control that opened the bar.
  await input.fill("zzzzqqq");
  await expect(status).toHaveText("No matches");
  await expect(page.getByRole("button", { name: "Next match" })).toBeDisabled();
  await input.fill("star");
  await expect(status).toHaveText(/^1 of \d+ matches$/);
  await input.press("Escape");
  await expect(page.getByTestId("find-bar")).toHaveCount(0);
  await expect(fl.locator("mark.ncb-hit")).toHaveCount(0);
  await expect(page.getByTestId("find-toggle")).toBeFocused();
});

test("find follows an in-frame click to another page, and reader view says to use the browser's own find", async ({ page }) => {
  const a = articleUrl("/astronomy");
  await savePage(page, a);
  await savePage(page, articleUrl("/solar-system"));
  await openAddress(page, a);
  const fl = page.frameLocator('iframe[data-testid="archive-frame"]');
  await expect(fl.getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();
  await page.getByTestId("find-toggle").click();
  const input = page.getByRole("searchbox", { name: "Find in this page" });
  await input.fill("planet");
  await expect(page.getByTestId("find-status")).toHaveText(/^1 of \d+ matches$/);
  // Close, click through to the other saved page, find again: counts are for the page now shown.
  await input.press("Escape");
  await fl.locator('a[data-ncb-link="cached"]', { hasText: /Solar System/i }).first().click();
  await expect(fl.getByRole("heading", { level: 1, name: /Solar System/ })).toBeVisible();
  await page.getByTestId("find-toggle").click();
  await page.getByRole("searchbox", { name: "Find in this page" }).fill("planet");
  await expect(page.getByTestId("find-status")).toHaveText(/^1 of \d+ matches$/);
  await page.getByRole("searchbox", { name: "Find in this page" }).press("Escape");

  await page.getByRole("radio", { name: "Reader" }).click();
  await expect(activeFrame(page)).toHaveAttribute("src", /\/reader$/);
  await page.getByTestId("find-toggle").click();
  await expect(page.getByTestId("find-status")).toContainText("Ctrl+F or Cmd+F");
});

test("the page's own find is not intercepted by the app", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const w = window as unknown as { __prevented: Record<string, boolean> };
    w.__prevented = {};
    window.addEventListener("keydown", (e) => { w.__prevented[`${e.ctrlKey ? "Ctrl+" : ""}${e.metaKey ? "Meta+" : ""}${e.altKey ? "Alt+" : ""}${e.key}`] = e.defaultPrevented; });
  });
  for (const combo of ["Control+f", "Meta+f", "Control+t", "Control+w", "Control+n", "Control+l", "Control+r", "Control+d", "Alt+ArrowLeft", "Alt+ArrowRight"]) await page.keyboard.press(combo);
  const prevented = await page.evaluate(() => (window as unknown as { __prevented: Record<string, boolean> }).__prevented);
  expect(Object.entries(prevented).filter(([, v]) => v)).toEqual([]);
  expect(Object.keys(prevented).length).toBeGreaterThanOrEqual(8);
});
