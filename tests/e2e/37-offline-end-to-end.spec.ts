import { expect, test, type Page } from "@playwright/test";
import { activeFrame, articleUrl, blockExternal, login, mode, openAddress, savePage, setWorkOffline } from "./helpers";
import { ensurePackage, untilIndexed, type Pkg } from "./zim-helpers";

// H-06: the whole app with no internet. Everything saved first (a page, a knowledge package), then "Work offline" goes on and the browser is
// stopped from reaching anything but the app and the archive listener (every other request is refused and recorded). The pages must open,
// say plainly that they are offline, find what is saved, read it, and never sit waiting for a network that is not there. The fixture site is
// also asked how many requests it has seen: the server must not have fetched from it while offline either. `15-offline-links` covers the link
// states inside saved pages; `tests/offline/check.mjs` runs the server side inside a Docker network with no route out.
test.skip(mode() !== "real-server", "needs the real server and libzim");
test.describe.configure({ mode: "serial" });

let wiki: Pkg;
let attempted: string[] = [];
let fixtureRequests = 0;

const fixtureTotal = async (page: Page) => ((await (await page.request.get(articleUrl("/__log"))).json()) as { total: number }).total;

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  await setWorkOffline(page, false);
  await savePage(page, articleUrl("/astronomy"));
  await savePage(page, articleUrl("/planets"));
  wiki = await ensurePackage(page, "wiki");
  await untilIndexed(page, "astronomy", "archive");
  await untilIndexed(page, "benzene", "zim");
  await page.close();
});

test.beforeEach(async ({ page, baseURL }) => {
  await login(page);
  await setWorkOffline(page, true);
  attempted = await blockExternal(page, baseURL!);
  fixtureRequests = await fixtureTotal(page);
});
test.afterEach(async ({ page }) => {
  // Nothing left the app, and the server fetched nothing from the fixture site while the switch was on.
  expect(attempted, "requests that tried to leave the app").toEqual([]);
  expect(await fixtureTotal(page)).toBe(fixtureRequests);
  await setWorkOffline(page, false);
});

const offline = (page: Page) => expect(page.getByTestId("connectivity")).toHaveAttribute("data-state", "offline");

test("every area opens offline, says so, and has nothing still loading", async ({ page }) => {
  test.setTimeout(180_000);
  const routes = [
    "/", "/library", "/library/sources", "/library/collections", "/library/packages", "/library/wikipedia", "/downloads", "/save", "/bookmarks",
    "/history", "/search", "/storage", "/storage/dashboard", "/storage/space", "/storage/activity", "/storage/online-search", "/storage/packages",
    "/discovery", "/discovery/budget", "/discovery/settings",
  ];
  const problems: string[] = [];
  for (const route of routes) {
    await page.goto(route);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await offline(page);
    await expect(page.getByTestId("connectivity")).toContainText("Offline");
    // Nothing waits on the internet: within a few seconds every placeholder is gone.
    await expect(page.locator('main [aria-busy="true"]'), `${route} is still loading`).toHaveCount(0, { timeout: 8_000 });
    const alerts = await page.locator('main [role="alert"]').allTextContents();
    if (alerts.length) problems.push(`${route}: ${alerts.join(" | ").slice(0, 160)}`);
  }
  expect(problems, "no page should report a failure just because it is offline").toEqual([]);
});

test("the switch says what still works, and the home page shows the connection", async ({ page }) => {
  await page.goto("/");
  await offline(page);
  await expect(page.getByRole("switch", { name: "Work offline" })).toBeChecked();
  await expect(page.getByTestId("connectivity")).toHaveAttribute("title", /Work offline is on\. Saved pages and local search still work\./);
  await expect(page.getByTestId("home-connection")).toBeVisible();
});

test("search finds saved pages and package articles, and says the results come from the saved copy", async ({ page }) => {
  await page.goto("/");
  const box = page.getByRole("combobox", { name: /Search your archive/ });
  await box.fill("astronomy");
  await box.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=astronomy/);
  await expect(page.getByTestId("search-result").first()).toBeVisible();
  await expect(page.getByTestId("search-result").first().getByTestId("result-availability")).toHaveText(/^(Partly )?[Ss]aved$/);
  // With no search provider the note names that; either way it says the results are the saved ones, and the connection badge says Offline.
  await expect(page.getByTestId("online-note")).toContainText("Results come from your saved pages.");
  await expect(page.getByRole("tab", { name: "Online" })).toBeDisabled();
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);

  await page.goto("/search?q=benzene");
  await expect(page.getByText(/Benzene/).first()).toBeVisible();
  await expect(page.getByText(wiki.title).first()).toBeVisible();
});

test("a saved page and a package article open and read offline", async ({ page }) => {
  await page.goto("/");
  await openAddress(page, articleUrl("/astronomy"));
  await expect(activeFrame(page)).toBeVisible();
  const fl = page.frameLocator('iframe[data-testid="archive-frame"]:not([hidden])');
  await expect(fl.getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();

  await openAddress(page, "https://en.m.wikipedia.org/wiki/Benzene");
  await expect(fl.getByText("is an aromatic hydrocarbon")).toBeVisible();
  await expect(page.getByTestId("tab-source")).toContainText(`Package: ${wiki.title}`);
});

test("an address that is not saved gets a plain notice with the next step, not a spinner", async ({ page }) => {
  await page.goto("/");
  await openAddress(page, "https://example.org/never-saved-page");
  await expect(page.getByText("This page is not saved, and you're offline")).toBeVisible();
  await expect(page.getByText("Work offline is on, so nothing is fetched from the web.")).toBeVisible();
  await expect(page.getByText("Pages you saved earlier still open.")).toBeVisible();
  await expect(page.getByTestId("panel-queue")).toBeVisible();
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
});

test("the library lists saved pages, the package opens its page, and settings load", async ({ page }) => {
  await page.goto("/library");
  await expect(page.getByText(/astronomy/i).first()).toBeVisible();
  await page.goto("/library/packages");
  await expect(page.getByTestId("package-row").filter({ hasText: wiki.title })).toBeVisible();
  await page.goto(`/library/packages/${wiki.id}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(wiki.title);
  await page.goto("/storage/online-search");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goto("/discovery/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Discovery" })).toBeVisible();
});

test("online-only actions say they need a connection and what to do instead", async ({ page }) => {
  // A live save of an address that is not saved is refused with a plain answer, and the Wikipedia page tells the Human where they stand.
  const r = await page.request.post("/api/browser/save", { data: { url: "https://example.org/needs-the-internet" }, headers: { "X-NoCon-CSRF": "1" } });
  expect(r.status()).toBe(409);
  const body = (await r.json()) as { error: string; message: string };
  expect(body.error).toBe("offline");
  expect(body.message).toMatch(/offline/i);
  expect(body.message).not.toMatch(/\bat \w+\.|ECONN|stack/);
  await page.goto("/library/wikipedia");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText(/offline/i).first()).toBeVisible();
});
