import { expect, test, type Page } from "@playwright/test";
import { activeFrame, articleUrl, login, mode, openAddress, savePage, setWorkOffline } from "./helpers";

// H-03: the web UI renders strings from archived pages as text. The fixture article site's /hostile-title has a title, a heading and body text
// that are markup (an <img onerror>, a <script>, a javascript: link, an <b onmouseover>). Every place the app shows a title, address or snippet
// must show them as characters: no dialog, no element created from them, no script run, in every browser project.
test.skip(mode() !== "real-server", "needs the real server");

const CSRF = { "X-NoCon-CSRF": "1" };
const TITLE_TEXT = `<img src=x onerror="document.title='pwned-title'"><script>document.title='pwned-script'</script>`;

let dialogs: string[] = [];
test.beforeEach(async ({ page }) => {
  dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await login(page);
  await setWorkOffline(page, false);
});

async function expectInert(page: Page, where: string) {
  await page.waitForTimeout(300);
  expect(dialogs, `${where}: dialogs`).toEqual([]);
  expect(await page.title(), `${where}: document title`).not.toMatch(/pwned/);
  // nothing the page made from the text: no broken image, no script with our payload, no handler attribute
  expect(await page.locator('img[src="x"]').count(), `${where}: img from text`).toBe(0);
  expect(await page.locator('script:has-text("pwned")').count(), `${where}: script from text`).toBe(0);
  expect(await page.locator("[onerror], [onmouseover], [onclick]").count(), `${where}: handler attributes`).toBe(0);
  expect(await page.locator('a[href^="javascript:" i]').count(), `${where}: javascript: link`).toBe(0);
}

test("titles and snippets from a hostile page are text in search, the library, history and bookmarks", async ({ page }) => {
  const url = articleUrl("/hostile-title");
  const saved = await savePage(page, url);
  expect(saved.pageId).toBeTruthy();
  // find it by its words once the index has caught up
  await expect
    .poll(async () => {
      const r = await page.request.post("/api/search", { data: { query: "quokkazorn" }, headers: CSRF });
      return (((await r.json()) as { results?: unknown[] }).results ?? []).length;
    }, { timeout: 60_000 })
    .toBeGreaterThan(0);

  // Search results: the title is the literal text, and so is the snippet.
  await page.goto("/search?q=quokkazorn");
  const result = page.getByTestId("search-result").first();
  await expect(result).toBeVisible();
  await expect(result.getByTestId("result-title")).toContainText("<img src=x onerror=");
  await expectInert(page, "search results");

  // The library lists the page by that title.
  await page.goto("/library");
  await expectInert(page, "library");
  await page.goto(`/library/pages/${saved.pageId}`);
  await expect(page.getByText("<img src=x onerror=").first()).toBeVisible();
  await expectInert(page, "library page");
  await page.goto("/downloads");
  await expectInert(page, "downloads");

  // Open it in the browser shell, then bookmark it: the tab, the address bar, History and Bookmarks all show the title as text.
  await page.goto("/");
  await openAddress(page, url);
  await expect(activeFrame(page)).toBeVisible();
  await expect(page.getByRole("tab", { name: /<img src=x onerror=/ })).toBeVisible();
  await expectInert(page, "browser shell");
  const star = page.getByRole("button", { name: /Bookmark/ }).first();
  if (await star.isVisible().catch(() => false)) await star.click();
  await page.goto("/history");
  await expect(page.getByText("<img src=x onerror=").first()).toBeVisible();
  await expectInert(page, "history");
  await page.goto("/bookmarks");
  await expectInert(page, "bookmarks");
  await page.goto("/");
  await expectInert(page, "home");
});

test("a hostile address is text too: the address bar, the save page and the unsaved-page panel", async ({ page }) => {
  const nasty = `http://127.0.0.1:9/"><img src=x onerror=alert(1)>?q=<script>alert(2)</script>`;
  await page.goto(`/save?url=${encodeURIComponent(nasty)}`);
  await expectInert(page, "save page");
  await page.goto("/");
  await openAddress(page, nasty);
  await expectInert(page, "address bar");
  await page.goto(`/search?q=${encodeURIComponent(`<img src=x onerror=alert(1)> "><script>alert(2)</script>`)}`);
  await expectInert(page, "search box");
  await page.goto(`/library/pages/${encodeURIComponent(`<img src=x onerror=alert(1)>`)}`);
  await expectInert(page, "library page with a hostile id");
  await page.goto(`/library/sources/${encodeURIComponent(`"><script>alert(1)</script>`)}`);
  await expectInert(page, "source page with a hostile id");
});
