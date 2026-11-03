import { expect, test, type Page } from "@playwright/test";
import { articleUrl, login, mode, savePage, setWorkOffline } from "./helpers";
import { archiveBlackHole, CSRF, ensurePackage, untilIndexed, type Pkg } from "./zim-helpers";

// Phase 8 interface: knowledge packages in search. The Packages category, the mixed / separate / off control, package hits (origin label,
// bold matches, hostile snippets as text), the "also saved" marker, the package filter, a package without a full-text index, and the limits.
test.skip(mode() !== "real-server", "needs the real server and libzim");
test.describe.configure({ mode: "serial" });

let wiki: Pkg;
let chem: Pkg;

async function setZimMode(page: Page, value: "unified" | "federated" | "off") {
  const r = await page.request.patch("/api/settings/user", { data: { search: { zimResults: value } }, headers: CSRF });
  expect(r.ok(), await r.text()).toBeTruthy();
}
async function resetLimits(page: Page) {
  await page.request.patch("/api/settings", { data: { search: { zimMaxPackagesPerSearch: 5, zimHitsPerPackage: 20 } }, headers: CSRF });
}
const results = (page: Page) => page.getByTestId("search-result");

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  await setWorkOffline(page, false);
  wiki = await ensurePackage(page, "wiki");
  chem = await ensurePackage(page, "chem");
  await ensurePackage(page, "notitle");
  await ensurePackage(page, "other");
  await archiveBlackHole(page);
  await savePage(page, articleUrl("/solar-system"));
  await untilIndexed(page, "black hole");
  await page.close();
});

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
  await setZimMode(page, "unified");
  await resetLimits(page);
});
test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  await setZimMode(page, "unified");
  await resetLimits(page);
  await page.close();
});

test("the Packages category searches packages only, labels each hit with its package and bolds the matches", async ({ page }) => {
  await page.goto("/search?q=aromatic&scope=zim");
  await expect(page.getByTestId("cat-zim")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("cat-zim")).toHaveText("Packages");
  await expect(results(page).first()).toBeVisible();
  for (const r of await results(page).all()) await expect(r).toHaveAttribute("data-origin", "zim");
  const origins = await page.getByTestId("result-origin").allTextContents();
  expect(origins).toEqual(expect.arrayContaining(["Chemistry (fixture)"]));
  expect(origins.every((o) => /fixture|Notes without|Cuisine/.test(o))).toBe(true);
  await expect(page.getByTestId("result-availability").first()).toContainText("Knowledge package");
  // Matches are bold elements, not marks.
  await expect(results(page).first().locator("b").first()).toBeVisible();
  await expect(results(page).first().locator("mark")).toHaveCount(0);
  // The package-only category has no mixed/separate control (it only applies to All and Offline).
  await expect(page.getByTestId("zim-mode-control")).toHaveCount(0);
  // No remote request left the app for icons or anything else.
  const external: string[] = [];
  page.on("request", (r) => { if (!r.url().startsWith("http://127.0.0.1:25000") && !/^(data|blob|about):/.test(r.url())) external.push(r.url()); });
  await page.goto("/search?q=benzene&scope=zim");
  await expect(results(page).first()).toBeVisible();
  expect(external).toEqual([]);
  // A hit opens in the browser, in the package.
  await results(page).first().getByTestId("result-title").click();
  await expect(page.locator('iframe[data-testid="archive-frame"]:not([hidden])')).toBeVisible();
  await expect(page.getByTestId("tab-source")).toHaveAttribute("data-source", "package");
});

test("a hostile snippet is shown as text: no elements, no script, no dialog", async ({ page }) => {
  let dialogs = 0;
  page.on("dialog", async (d) => { dialogs++; await d.dismiss(); });
  await page.goto("/search?q=xyzzy&scope=zim");
  const hit = results(page).filter({ hasText: "Xyzzy compound" });
  await expect(hit).toBeVisible();
  const snippet = hit.getByTestId("result-snippet");
  await expect(snippet).toContainText("compound is");
  // The article text is escaped markup, so the snippet is all literal text: not one element comes out of it. The only bold on the hit is the
  // match in the title, which the server marked itself.
  await expect(snippet.locator("b, img, script, a, style, iframe")).toHaveCount(0);
  await expect(snippet).toContainText("<b>xyzzy</b>");
  await expect(hit.getByTestId("result-title").locator("b")).toHaveCount(1);
  await expect(snippet).toContainText('<img src=x onerror="alert(1)">');
  await expect(snippet).toContainText("<script>alert('xss')</script>");
  await expect(hit.locator("img[onerror], script")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(dialogs).toBe(0);
});

test("package results: mixed into the list, in their own groups, or not searched, and the choice is kept", async ({ page }) => {
  const posts: Record<string, unknown>[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/search") posts.push(r.postDataJSON() as Record<string, unknown>); });

  // Mixed (the default): saved pages and package hits in one list.
  await page.goto("/search?q=moon");
  await expect(results(page).first()).toBeVisible();
  await expect(page.getByTestId("zim-mode-control")).toBeVisible();
  await expect(page.locator("#zim-mode")).toHaveValue("unified");
  await expect.poll(async () => (await page.locator('[data-testid="search-result"][data-origin="zim"]').count())).toBeGreaterThan(0);
  expect(await page.locator('[data-testid="search-result"][data-origin="archive"]').count()).toBeGreaterThan(0);
  await expect(page.getByTestId("zim-groups")).toHaveCount(0);
  expect(posts.at(-1)).not.toHaveProperty("zim");

  // Separate: the saved pages alone in the list, each package in its own group.
  await page.locator("#zim-mode").selectOption("federated");
  await expect(page.getByTestId("zim-groups")).toBeVisible();
  await expect(page.getByTestId("zim-group").filter({ hasText: "Wikipedia (fixture)" })).toBeVisible();
  await expect(page.locator('[data-testid="results-list"] [data-origin="zim"]')).toHaveCount(0);
  expect(posts.at(-1)).toMatchObject({ zim: "federated" });
  // It is kept for the next visit.
  await page.reload();
  await expect(page.locator("#zim-mode")).toHaveValue("federated");
  await expect(page.getByTestId("zim-groups")).toBeVisible();

  // Off: packages are not asked.
  await page.locator("#zim-mode").selectOption("off");
  await expect(page.getByTestId("zim-groups")).toHaveCount(0);
  await expect(page.locator('[data-testid="search-result"][data-origin="zim"]')).toHaveCount(0);
  expect(posts.at(-1)).toMatchObject({ zim: "off" });
  await expect.poll(async () => ((await (await page.request.get("/api/settings/user")).json()) as { search: { zimResults: string } }).search.zimResults).toBe("off");
});

test("a package hit for an article that is also saved says so, and is left out of the mixed list", async ({ page }) => {
  await page.goto("/search?q=black%20hole&scope=zim");
  const hit = results(page).filter({ hasText: "Black hole" }).filter({ has: page.getByTestId("result-archived-as") });
  await expect(hit.first()).toBeVisible();
  await expect(hit.first().getByTestId("result-archived-as")).toHaveText(/Also saved as a page/);
  await expect(hit.first().getByTestId("result-archived-as")).toHaveAttribute("href", /\/library\/pages\/pg_/);
  // In the mixed list the saved page stands for it.
  await page.goto("/search?q=black%20hole");
  await expect(results(page).first()).toBeVisible();
  await expect(page.locator('[data-testid="search-result"][data-origin="archive"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="search-result"][data-origin="zim"]').filter({ hasText: "Black hole" })).toHaveCount(0);
});

test("the package filter keeps one package; a package with no full-text index says only titles were searched", async ({ page }) => {
  await page.goto("/search?q=aromatic&scope=zim");
  await expect(page.getByTestId("zim-notes")).toContainText("only titles were searched");
  await expect(page.getByTestId("zim-notes")).toContainText("Notes without a full-text index");

  const filter = page.getByTestId("filter-packages");
  await expect(filter).toBeVisible();
  await filter.getByLabel("Chemistry (fixture)").click();
  await expect(page).toHaveURL(new RegExp(`pkg=${chem.id}`));
  await expect(page.getByTestId("active-filters")).toContainText("Package: Chemistry (fixture)");
  await expect(results(page).first()).toBeVisible();
  const origins = await page.getByTestId("result-origin").allTextContents();
  expect(new Set(origins)).toEqual(new Set(["Chemistry (fixture)"]));
  // Clearing the chip goes back to every package.
  await page.getByTestId("active-filters").getByRole("button", { name: /Package: Chemistry/ }).click();
  await expect(page).not.toHaveURL(/pkg=/);
});

test("the limits in settings change what a search takes from each package", async ({ page }) => {
  await page.goto("/storage/packages");
  await expect(page.getByRole("heading", { level: 1, name: "Knowledge packages" })).toBeVisible();
  // Limits are in an advanced section.
  await page.getByRole("button", { name: /Advanced settings: search limits/ }).click();
  await page.getByTestId("zim-hits").fill("0");
  await page.getByTestId("zim-save").click();
  await expect(page.getByTestId("error-summary")).toBeFocused();
  await expect(page.getByTestId("error-summary")).toContainText("1 to 50");
  await page.getByTestId("zim-hits").fill("1");
  await page.getByTestId("zim-max-packages").fill("2");
  await page.getByTestId("zim-save").click();
  await expect.poll(async () => ((await (await page.request.get("/api/settings")).json()) as { search: { zimHitsPerPackage: number } }).search.zimHitsPerPackage).toBe(1);

  await page.goto("/search?q=aromatic&scope=zim");
  await expect(results(page).first()).toBeVisible();
  expect(await results(page).count()).toBeLessThanOrEqual(2);
  // The mode can also be set here.
  await page.goto("/storage/packages");
  await page.getByTestId("zim-mode").selectOption("off");
  await expect.poll(async () => ((await (await page.request.get("/api/settings/user")).json()) as { search: { zimResults: string } }).search.zimResults).toBe("off");
  void wiki;
});
