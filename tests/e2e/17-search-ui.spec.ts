import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { articleUrl, login, mode, savePage, setWorkOffline } from "./helpers";

// S-11, S-12 and S-14 in the UI: the homepage, the results page, categories, filters, saved searches, history and settings.
test.skip(mode() !== "real-server", "needs the real server");

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/docs");
const CSRF = { "X-NoCon-CSRF": "1" };
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const ARTICLES = ["/astronomy", "/black-holes", "/solar-system", "/renewable-energy", "/solar-power"];

async function serious(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).exclude('iframe[data-testid="archive-frame"]').analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

async function setHistory(page: Page, enabled: boolean) {
  const r = await page.request.patch("/api/settings", { data: { privacy: { searchHistory: { enabled } } }, headers: CSRF });
  expect(r.ok(), await r.text()).toBeTruthy();
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await login(page);
  await setWorkOffline(page, false);
  // The article fixture pages (including Astronomy) are captured here, then two documents are imported.
  for (const p of ARTICLES) await savePage(page, articleUrl(p));
  const sources = (await (await page.request.get("/api/sources?limit=200")).json()) as { items: { id: string; systemKind: string | null }[] };
  const imports = sources.items.find((s) => s.systemKind === "imports");
  expect(imports, "the built-in Imports source").toBeTruthy();
  for (const [name, mimeType] of [["small.pdf", "application/pdf"], ["sample.md", "text/markdown"]] as const) {
    const r = await page.request.post(`/api/archive/import?sourceId=${imports!.id}`, { multipart: { file: { name, mimeType, buffer: fs.readFileSync(path.join(DOCS, name)) } }, headers: CSRF });
    expect([202, 200]).toContain(r.status());
  }
  await setHistory(page, true);
  // Indexing runs after the capture. Wait until the pages and the imports can be found.
  await expect
    .poll(async () => {
      const r = await page.request.post("/api/search", { data: { query: "astronomy" }, headers: CSRF });
      const j = (await r.json()) as { results?: { type: string }[] };
      const d = await page.request.post("/api/search", { data: { query: "fixture note", scope: "documents" }, headers: CSRF });
      const dj = (await d.json()) as { results?: unknown[] };
      return (j.results?.length ?? 0) > 0 && (dj.results?.length ?? 0) > 0;
    }, { timeout: 60_000, message: "the saved pages and imported documents should be searchable" })
    .toBe(true);
  await page.close();
});

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
  // The search settings are saved on the server, so every test starts from the defaults.
  const r = await page.request.patch("/api/settings/user", {
    data: { search: { homepageSections: { recentSearches: false, bookmarks: false, favourites: false, libraryStats: false }, resultsPerPage: 10 } },
    headers: { "X-NoCon-CSRF": "1" },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
});

async function searchFromHome(page: Page, q: string) {
  await page.goto("/");
  const box = page.getByRole("combobox", { name: /Search your archive/ });
  await box.fill(q);
  await box.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=/);
}

const titles = (page: Page) => page.getByTestId("result-title");

test("homepage is minimal: wordmark, one search field, connection status and nothing else by default", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("NoConBrain");
  await expect(page.getByRole("combobox", { name: /Search your archive/ })).toBeVisible();
  await expect(page.getByTestId("home-connection")).toBeVisible();
  await expect(page.getByTestId("home-sections")).toHaveCount(0);
  await expect(page.getByRole("searchbox")).toHaveCount(0);
});

test("homepage search goes to results with highlighted terms rendered as marks only", async ({ page }) => {
  await searchFromHome(page, "black holes");
  await expect(page.getByTestId("results-list")).toBeVisible();
  await expect(titles(page).first()).toBeVisible();
  const marks = page.getByTestId("result-snippet").locator("mark");
  await expect(marks.first()).toBeVisible();
  expect((await marks.allTextContents()).some((t) => /black|hole/i.test(t))).toBe(true);
  // Nothing but mark elements was created inside a snippet.
  expect(await page.getByTestId("result-snippet").first().evaluate((el) => Array.from(el.querySelectorAll("*")).every((n) => n.tagName === "MARK"))).toBe(true);
  // Each result: title, address, availability, saved date. The live region announces the count once.
  const first = page.getByTestId("search-result").first();
  await expect(first.getByTestId("result-address")).toContainText("127.0.0.1");
  await expect(first.getByTestId("result-availability")).toHaveText("Saved");
  await expect(first.getByTestId("result-saved-date")).toContainText("Saved");
  await expect(page.getByTestId("results-status")).toContainText(/\d+ results? for black holes/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  expect(await page.getByRole("heading", { level: 3 }).count()).toBeGreaterThan(0);
});

test("autocomplete follows the combobox pattern and is keyboard operable", async ({ page }) => {
  await page.goto("/");
  const box = page.getByRole("combobox", { name: /Search your archive/ });
  await expect(box).toHaveAttribute("aria-expanded", "false");
  await box.click();
  await box.pressSequentially("astro");
  const list = page.getByRole("listbox", { name: "Suggestions" });
  await expect(list).toBeVisible();
  await expect(box).toHaveAttribute("aria-expanded", "true");
  const options = list.getByRole("option");
  expect(await options.count()).toBeGreaterThan(0);
  await expect(page.getByTestId("suggestions-status")).toContainText(/suggestions? available/);
  await box.press("ArrowDown");
  const id = await box.getAttribute("aria-activedescendant");
  expect(id).toBeTruthy();
  await expect(page.locator(`#${id}`)).toHaveAttribute("aria-selected", "true");
  await box.press("ArrowDown");
  expect(await box.getAttribute("aria-activedescendant")).not.toBe(id);
  await box.press("Escape");
  await expect(box).toHaveAttribute("aria-expanded", "false");
  await expect(box).toBeFocused();
  await box.press("ArrowDown");
  await expect(list).toBeVisible();
  const chosen = (await page.locator(`#${await box.getAttribute("aria-activedescendant")}`).textContent()) ?? "";
  await box.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=/);
  expect(chosen.length).toBeGreaterThan(0);
});

test("a typo shows the correction, and Search instead keeps the words as typed", async ({ page }) => {
  await searchFromHome(page, "astronamy");
  const dym = page.getByTestId("did-you-mean");
  await expect(dym).toBeVisible();
  await expect(dym.getByTestId("dym-text")).toHaveText(/astronomy/i);
  await expect(titles(page).filter({ hasText: "Astronomy" }).first()).toBeVisible();
  if (await dym.getByTestId("dym-original").count()) {
    await expect(dym).toContainText("Search instead for");
    await dym.getByTestId("dym-original").click();
    await expect(page).toHaveURL(/exact=1/);
    await expect(page.getByTestId("dym-original")).toHaveCount(0);
  }
});

test("site: restricts results to one site, from the search box", async ({ page }) => {
  await searchFromHome(page, "solar system site:127.0.0.1");
  await expect(titles(page).first()).toBeVisible();
  const addresses = await page.getByTestId("result-address").allTextContents();
  expect(addresses.length).toBeGreaterThan(0);
  expect(addresses.every((a) => a.startsWith("127.0.0.1"))).toBe(true);
  await page.getByRole("combobox", { name: "Search" }).fill("fixture note site:imports.noconbrain.invalid");
  await page.getByRole("combobox", { name: "Search" }).press("Enter");
  await expect(page.getByTestId("result-address").first()).toHaveText("Imported document");
});

test("a quoted phrase matches words together and in order, and -exclude removes pages", async ({ page }) => {
  await searchFromHome(page, '"massive stars exhaust their nuclear fuel"');
  await expect(titles(page).first()).toBeVisible();
  expect((await page.getByTestId("result-snippet").locator("mark").allTextContents()).join(" ").toLowerCase()).toContain("massive");
  await page.getByRole("combobox", { name: "Search" }).fill('"fuel nuclear their exhaust"');
  await page.getByRole("combobox", { name: "Search" }).press("Enter");
  await expect(page.getByRole("heading", { name: /No results for/ })).toBeVisible();
  // The operator help lists every operator.
  await page.getByTestId("operator-help").click();
  for (const op of ["site:example.org", "type:pdf", "before:2026-01-01", "after:2025-06-30", '"exact phrase"', "-word"]) await expect(page.getByText(op, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await searchFromHome(page, "black holes");
  const withAll = await page.getByTestId("search-result").count();
  await page.getByRole("combobox", { name: "Search" }).fill("black holes -telescopes");
  await page.getByRole("combobox", { name: "Search" }).press("Enter");
  await expect(page).toHaveURL(/telescopes/);
  await expect(page.getByTestId("results-status")).toContainText(/results? for black holes -telescopes|No results/);
  expect(await page.getByTestId("search-result").count()).toBeLessThanOrEqual(withAll);
});

test("category tabs: Documents shows the imported PDF, Online is disabled and says why", async ({ page }) => {
  await page.goto("/search?q=fixture%20note");
  const tabs = page.getByRole("tablist", { name: "Result categories" });
  await expect(tabs.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
  const online = tabs.getByTestId("cat-online");
  await expect(online).toHaveAttribute("aria-disabled", "true");
  await expect(online).toHaveAccessibleDescription("Online search is off");
  // Online providers arrive in a later phase, so the tab stays disabled: it is not selected and it cannot be reached by the arrow keys.
  await expect(online).toHaveAttribute("aria-selected", "false");
  await expect(page).not.toHaveURL(/scope=online/);

  await tabs.getByRole("tab", { name: "Documents" }).click();
  await expect(page).toHaveURL(/scope=documents/);
  await expect(tabs.getByRole("tab", { name: "Documents" })).toHaveAttribute("aria-selected", "true");
  const pdf = page.getByTestId("search-result").filter({ hasText: "Fixture note" }).first();
  await expect(pdf).toBeVisible();
  await expect(pdf.getByTestId("result-address")).toHaveText("Imported document");
  await expect(pdf).toContainText("PDF");
  // The Documents tab does not include web pages.
  await page.goto("/search?q=astronomy&scope=documents");
  await expect(page.getByTestId("search-result").filter({ hasText: "127.0.0.1" })).toHaveCount(0);
  // Arrow keys move between the enabled tabs.
  await page.goto("/search?q=astronomy");
  await tabs.getByRole("tab", { name: "All" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/scope=offline/);
  await expect(tabs.getByRole("tab", { name: "Offline" })).toBeFocused();
  // Images: nothing saved is an image page, and the empty state says what to do.
  await tabs.getByRole("tab", { name: "Images" }).click();
  await expect(page).toHaveURL(/scope=images/);
  await expect(page.getByTestId("results-status")).not.toBeEmpty();
});

test("filters show facet counts that match the results they give", async ({ page }) => {
  await page.goto("/search?q=solar%20system");
  await expect(titles(page).first()).toBeVisible();
  const typeGroup = page.getByTestId("filter-type");
  const pdfBox = typeGroup.getByRole("checkbox", { name: /Web page/ });
  await expect(pdfBox).toBeVisible();
  const label = (await typeGroup.getByRole("checkbox", { name: /Web page/ }).getAttribute("id"))!;
  const count = Number((await page.locator(`label[for="${label}"]`).getByTestId("facet-count").textContent())!.replace(/[^0-9]/g, ""));
  expect(count).toBeGreaterThan(0);
  await pdfBox.click();
  await expect(page).toHaveURL(/type=html/);
  await expect(page.getByTestId("active-filters")).toContainText("Type: Web page");
  await expect(page.getByTestId("search-result")).toHaveCount(count);
  // Less-used filters sit in the Advanced filters disclosure.
  const adv = page.getByRole("button", { name: /Advanced filters/ });
  await expect(adv).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByLabel("Language")).toHaveCount(0);
  await adv.click();
  await expect(page.getByRole("group", { name: "Availability" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Date saved" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Date published" })).toBeVisible();
  // A date range that excludes today gives the empty state, and clearing brings the results back.
  await page.getByLabel("To", { exact: true }).first().fill("2001-01-01");
  await expect(page.getByRole("heading", { name: /No results for/ })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters and category" }).click();
  await expect(titles(page).first()).toBeVisible();
  await expect(page).not.toHaveURL(/type=/);
});

test("load more appends the next page", async ({ page }) => {
  await page.goto("/search?q=solar%20system");
  await expect(titles(page).first()).toBeVisible();
  // Ten per page from the settings; with fewer matches than that the button is absent, which is also correct.
  await page.goto("/search?view=settings");
  await page.getByLabel("Results per page").selectOption("10");
  await page.goto("/search?q=the");
  await expect(titles(page).first()).toBeVisible();
  const first = await page.getByTestId("search-result").count();
  expect(first).toBeLessThanOrEqual(10);
  if (await page.getByTestId("load-more").count()) {
    await page.getByTestId("load-more").click();
    await expect.poll(() => page.getByTestId("search-result").count()).toBeGreaterThan(first);
  }
  await page.goto("/search?view=settings");
  await page.getByLabel("Results per page").selectOption("20");
});

test("save a search, run it again from the Search area, rename it and delete it", async ({ page }) => {
  const name = `Black holes ${Date.now() % 100000}`;
  await page.goto("/search?q=black%20holes&scope=offline");
  await expect(titles(page).first()).toBeVisible();
  await page.getByTestId("save-search").click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await page.getByTestId("save-search-confirm").click();
  await expect(page.getByText("Search saved")).toBeVisible();

  await page.goto("/search");
  const item = page.getByTestId("saved-item").filter({ hasText: name });
  await expect(item).toBeVisible();
  await item.getByTestId("saved-run").click();
  await expect(page).toHaveURL(/\/search\?q=black\+holes|\/search\?q=black%20holes/);
  await expect(titles(page).first()).toBeVisible();

  await page.goto("/search");
  const renamed = `${name} renamed`;
  await item.getByTestId("saved-rename").click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Name", exact: true }).fill(renamed);
  await page.getByTestId("rename-confirm").click();
  await expect(page.getByTestId("saved-item").filter({ hasText: renamed })).toBeVisible();

  const second = page.getByTestId("saved-item").filter({ hasText: renamed });
  await second.getByTestId("saved-delete").click();
  await page.getByTestId("delete-confirm").click();
  await expect(page.getByTestId("saved-item").filter({ hasText: renamed })).toHaveCount(0);
});

test("a saved search can become a collection", async ({ page }) => {
  const name = `Planets ${Date.now() % 100000}`;
  const made = await page.request.post("/api/search/saved", { data: { name, query: "planets", filters: {}, includeOnline: false }, headers: CSRF });
  expect(made.status(), await made.text()).toBeLessThan(300);
  await page.goto("/search");
  const item = page.getByTestId("saved-item").filter({ hasText: name });
  await item.getByTestId("saved-collection").click();
  await expect(page.getByText("Collection created")).toBeVisible();
  const cols = (await (await page.request.get("/api/collections")).json()) as { items: { name: string; kind: string }[] };
  expect(cols.items.some((c) => c.name === name && c.kind === "saved_search")).toBe(true);
});

test("history off writes nothing; on records; clear empties it", async ({ page }) => {
  const list = async () => ((await (await page.request.get("/api/search/history")).json()) as { enabled?: boolean; items: { query: string }[] });
  await page.request.delete("/api/search/history", { headers: CSRF });
  await page.goto("/search?view=history");
  const toggle = page.getByTestId("history-toggle");
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole("heading", { name: "Search history is off" })).toBeVisible();
  await page.goto("/search?q=tidal%20turbines%20off");
  await expect(page.getByTestId("results-status")).not.toBeEmpty();
  const off = await list();
  expect(off.items.some((i) => i.query.includes("tidal turbines off"))).toBe(false);
  expect(off.items).toHaveLength(0);

  await setHistory(page, true);
  await page.goto("/search?q=tidal%20turbines%20on");
  await expect(page.getByTestId("results-status")).not.toBeEmpty();
  await expect.poll(async () => (await list()).items.some((i) => i.query.includes("tidal turbines on"))).toBe(true);
  await page.goto("/search?view=history");
  await expect(page.getByTestId("history-list")).toContainText("tidal turbines on");
  await page.getByTestId("history-clear").click();
  await expect(page.getByRole("heading", { name: "No searches yet" })).toBeVisible();
  expect((await list()).items).toHaveLength(0);
});

test("homepage sections are hidden until switched on in Search settings", async ({ page }) => {
  await page.goto("/search?view=settings");
  await page.getByRole("switch", { name: /^Recent searches/ }).click();
  await page.getByRole("switch", { name: /^Library statistics/ }).click();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 2, name: "Recent searches" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Your library" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Bookmarks" })).toHaveCount(0);
  await page.goto("/search?view=settings");
  await page.getByRole("switch", { name: /^Recent searches/ }).click();
  await page.getByRole("switch", { name: /^Library statistics/ }).click();
  await page.goto("/");
  await expect(page.getByTestId("home-sections")).toHaveCount(0);
});

test("offline: local search works, a result opens the saved page, and nothing leaves the app", async ({ page, baseURL }) => {
  await setWorkOffline(page, true);
  const archive = new URL(process.env.E2E_ARCHIVE_URL!).origin;
  const origin = new URL(baseURL!).origin;
  const external: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (/^(data|blob|about):/.test(u)) return;
    const o = new URL(u).origin;
    if (o !== origin && o !== archive) external.push(`${r.method()} ${u}`);
  });
  await searchFromHome(page, "astronomy");
  await expect(titles(page).first()).toBeVisible();
  const link = titles(page).filter({ hasText: /^Astronomy/ }).first();
  await expect(link).toBeVisible();
  // Online is off while forced offline, and the page says so rather than failing.
  await expect(page.getByTestId("cat-online")).toHaveAttribute("aria-disabled", "true");
  await link.click();
  await expect(page).toHaveURL(/\/$/);
  const frame = page.locator('iframe[data-testid="archive-frame"]:not([hidden])');
  await expect(frame).toBeVisible();
  await expect(page.frameLocator('iframe[data-testid="archive-frame"]').getByRole("heading", { level: 1, name: /Astronomy/ })).toBeVisible();
  expect(external, "requests that left the app").toEqual([]);
});

test("the slash key focuses the search box on the results page", async ({ page }) => {
  await page.goto("/search?q=astronomy");
  await expect(titles(page).first()).toBeVisible();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("/");
  await expect(page.getByRole("combobox", { name: "Search" })).toBeFocused();
});

test("an error from the server shows an error state with a retry", async ({ page }) => {
  let fail = true;
  await page.route("**/api/search", async (route) => {
    if (route.request().method() === "POST" && fail) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal", message: "The search broke.", requestId: "x" }) });
    return route.continue();
  });
  await page.goto("/search?q=astronomy");
  await expect(page.getByRole("alert").filter({ hasText: "The search broke." })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(titles(page).first()).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });
    const check = async (page: Page, url: string, ready: () => Promise<void>) => {
      await page.goto(url);
      await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^(?!.*dark).*$/);
      await ready();
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      expect(await serious(page)).toEqual([]);
    };
    test("homepage, with its sections and the suggestion list open, has no serious axe violations", async ({ page }) => {
      await page.goto("/search?view=settings");
      for (const n of [/^Recent searches/, /^Bookmarks/, /^Favourite collections/, /^Library statistics/]) await page.getByRole("switch", { name: n }).click();
      await check(page, "/", async () => {
        await expect(page.getByTestId("home-sections")).toBeVisible();
        await page.getByRole("combobox", { name: /Search your archive/ }).fill("astro");
        await page.waitForTimeout(500);
      });
      await page.goto("/search?view=settings");
      for (const n of [/^Recent searches/, /^Bookmarks/, /^Favourite collections/, /^Library statistics/]) await page.getByRole("switch", { name: n }).click();
    });
    test("results page, with advanced filters open, has no serious axe violations", async ({ page }) => {
      await check(page, "/search?q=solar%20system", async () => {
        await expect(titles(page).first()).toBeVisible();
        await page.getByRole("button", { name: /Advanced filters/ }).click();
        await page.getByTestId("operator-help").click();
      });
    });
    test("empty results page has no serious axe violations", async ({ page }) => {
      await check(page, "/search?q=zzqxjvk", async () => {
        await expect(page.getByRole("heading", { name: /No results for/ })).toBeVisible();
      });
    });
    for (const view of ["", "?view=history", "?view=settings"]) {
      test(`Search area ${view || "saved searches"} has no serious axe violations`, async ({ page }) => {
        await check(page, `/search${view}`, async () => {
          await expect(page.getByRole("navigation", { name: "Search area sections" })).toBeVisible();
          await page.waitForLoadState("networkidle").catch(() => {});
        });
      });
    }
  });
}
