import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { login, mode, setWorkOffline } from "./helpers";

// The search UI against a stubbed /api/search, built from the shapes in docs/api.md section 6. It checks what the page does with a
// response (highlights, corrections, facets, empty and error states, hostile snippets), whatever state the server's search is in.
test.skip(mode() !== "real-server", "needs the real server for the sign-in and the archive");

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
async function serious(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).exclude('iframe[data-testid="archive-frame"]').analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

const result = (n: number, over: Record<string, unknown> = {}) => ({
  key: `https://example.test/p${n}`, url: `https://example.test/a/p${n}`, canonicalUrl: `https://example.test/a/p${n}`,
  title: `Page ${n} about astronomy`, snippet: `The study of <mark>astronomy</mark> number ${n}, and the <mark>stars</mark>.`,
  origin: "archive", availability: "cached", pageId: `pg_${n}`, domain: "example.test", type: "html", language: "en",
  capturedAt: "2026-10-01T10:00:00Z", publishedAt: "2026-09-01T10:00:00Z", attribution: [{ kind: "local", id: "local", name: "Saved pages", rank: n }],
  fusedRank: n, fusedScore: 1 / n, storage: "persist", actions: { open: `/library/pages/pg_${n}`, saveForOffline: false }, ...over,
});
const response = (over: Record<string, unknown> = {}) => ({
  searchId: "s1", parsed: { terms: ["astronomy"], phrases: [], excluded: [], operators: {}, warnings: [] },
  results: [result(1), result(2), result(3, { availability: "online_only", origin: "online", capturedAt: undefined, actions: { open: "", saveForOffline: true }, snippet: "<script>alert(1)</script><img src=x onerror=alert(2)> a <mark>hostile</mark> snippet &amp; more" })],
  coverage: { cachedMatches: 2, onlineMatches: 1, onlineNotArchived: 1, queued: 0, partial: 0, basis: "local_exact" },
  facets: {
    sources: [{ value: "src_1", label: "Quick saves", count: 2 }], collections: [], domains: [{ value: "example.test", label: "example.test", count: 3 }],
    types: [{ value: "html", label: "html", count: 3 }], languages: [{ value: "en", label: "en", count: 3 }],
    availability: [{ value: "cached", label: "Saved", count: 2 }], downloaded: [], published: [], approximate: false,
  },
  total: 3, totalCapped: false, page: 1, pageSize: 20,
  online: { state: "disabled", pending: [], disclosure: "" }, tookMs: { local: 4, zim: 0 }, ...over,
});

async function stub(page: Page, make: (body: Record<string, any>) => unknown | { status: number; body: unknown }) {
  const bodies: Record<string, any>[] = [];
  await page.route("**/api/search", async (route: Route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as Record<string, any>;
    bodies.push(body);
    const out = make(body) as any;
    if (out && typeof out === "object" && "status" in out && "body" in out) return route.fulfill({ status: out.status, contentType: "application/json", body: JSON.stringify(out.body) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(out) });
  });
  return bodies;
}

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

test("results render marks only, show availability, dates and a save action for online-only items", async ({ page }) => {
  const bodies = await stub(page, () => response());
  await page.goto("/search?q=astronomy");
  const items = page.getByTestId("search-result");
  await expect(items).toHaveCount(3);
  expect(bodies[0]).toMatchObject({ query: "astronomy", scope: "all", page: 1, pageSize: 10, online: "off" });
  expect(bodies[0]).not.toHaveProperty("typo");
  await expect(page.getByTestId("results-status")).toHaveText("3 results for astronomy.");
  await expect(page.getByTestId("results-count")).toHaveText("Showing 3 of 3 results");
  await expect(items.first().getByTestId("result-address")).toHaveText("example.test › a › p1");
  await expect(items.first().locator("mark")).toHaveText(["astronomy", "stars"]);
  await expect(items.first().getByTestId("result-availability")).toHaveText("Saved");
  await expect(items.first().getByTestId("result-saved-date")).toHaveText("Saved 1 Oct 2026");
  // Hostile markup in a snippet stays text; only the one mark is a mark.
  const hostile = items.nth(2);
  await expect(hostile.locator("mark")).toHaveText(["hostile"]);
  await expect(hostile.getByTestId("result-snippet")).toContainText("<script>alert(1)</script>");
  await expect(hostile.getByTestId("result-snippet")).toContainText("& more");
  expect(await page.locator("[data-testid=result-snippet] :not(mark)").count()).toBe(0);
  await expect(hostile.getByTestId("result-availability")).toHaveText("Online only");
  await expect(hostile.getByTestId("result-save")).toBeVisible();
  await expect(items.first().getByTestId("result-save")).toHaveCount(0);
  await expect(page.getByTestId("coverage-strip")).toHaveText("2 matches in your saved pages");
  // Titles of saved results are links; the online one opens the live site in a new browser tab.
  await expect(hostile.getByTestId("result-title")).toHaveAttribute("target", "_blank");
  await expect(hostile.getByTestId("result-title")).toHaveAttribute("rel", /noopener/);
  // No favicon is fetched from anywhere: a result without an archived favicon shows an icon, not an image.
  await expect(page.getByTestId("result-favicon")).toHaveCount(0);
});

test("an automatic correction says what is shown and offers the original", async ({ page }) => {
  const bodies = await stub(page, (b) => (b.query === "astronamy" ? response({ didYouMean: { text: "astronomy", corrected: [{ from: "astronamy", to: "astronomy" }], appliedAutomatically: true } }) : response()));
  await page.goto("/search?q=astronamy");
  const dym = page.getByTestId("did-you-mean");
  await expect(dym).toContainText("Showing results for astronomy");
  await expect(dym).toContainText("Search instead for astronamy");
  await dym.getByTestId("dym-original").click();
  await expect(page).toHaveURL(/q=astronamy&exact=1/);
  // The server is told not to correct the words this time.
  await expect.poll(() => bodies.at(-1)).toMatchObject({ query: "astronamy", typo: false });
});

test("a suggested correction asks 'Did you mean'", async ({ page }) => {
  await stub(page, () => response({ results: [], total: 0, didYouMean: { text: "astronomy", corrected: [{ from: "astronamy", to: "astronomy" }], appliedAutomatically: false } }));
  await page.goto("/search?q=astronamy");
  await expect(page.getByTestId("did-you-mean")).toHaveText("Did you mean astronomy?");
  await page.getByTestId("dym-text").click();
  await expect(page).toHaveURL(/q=astronomy/);
});

test("filters send the API shape and the facets carry counts", async ({ page }) => {
  const bodies = await stub(page, () => response());
  await page.goto("/search?q=astronomy&scope=offline&type=html&source=src_1&dlFrom=2026-01-02&avail=cached&lang=en");
  await expect(page.getByTestId("search-result").first()).toBeVisible();
  expect(bodies[0]).toMatchObject({
    scope: "offline", online: "off",
    filters: { types: ["html"], sources: ["src_1"], downloadedFrom: "2026-01-02T00:00:00.000Z", availability: ["cached"], languages: ["en"] },
  });
  await expect(page.getByTestId("filter-source")).toContainText("Quick saves (2)");
  await expect(page.getByTestId("filter-domain")).toContainText("example.test (3)");
  await expect(page.getByRole("checkbox", { name: /Quick saves/ })).toBeChecked();
  await page.getByRole("button", { name: /Advanced filters/ }).click();
  await expect(page.getByLabel("From").first()).toHaveValue("2026-01-02");
  await page.getByTestId("clear-filters").click();
  await expect(page).toHaveURL(/\/search\?q=astronomy&scope=offline$/);
});

test("empty and error states, and Load more", async ({ page }) => {
  let mode: "empty" | "error" | "many" = "empty";
  await stub(page, (b) => {
    if (mode === "error") return { status: 500, body: { error: "internal", message: "Search is down.", requestId: "r" } };
    if (mode === "many") return response({ results: [result(b.page * 10), result(b.page * 10 + 1)], total: 4, nextCursor: b.page < 2 ? "2" : undefined });
    return response({ results: [], total: 0, facets: undefined });
  });
  await page.goto("/search?q=zzz");
  await expect(page.getByRole("heading", { name: 'No results for "zzz"' })).toBeVisible();
  await expect(page.getByTestId("results-status")).toHaveText("No results for zzz.");
  mode = "error";
  await page.goto("/search?q=zzz2");
  await expect(page.getByRole("alert").filter({ hasText: "Search is down." })).toBeVisible();
  mode = "many";
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("search-result")).toHaveCount(2);
  await page.getByTestId("load-more").click();
  await expect(page.getByTestId("search-result")).toHaveCount(4);
  await expect(page.getByTestId("load-more")).toHaveCount(0);
  await expect(page.getByTestId("results-status")).toContainText("2 more results loaded, 4 in total.");
});

test("Online is disabled with the reason while there are no providers", async ({ page }) => {
  await stub(page, () => response());
  await page.goto("/search?q=astronomy");
  const online = page.getByRole("tab", { name: /Online/ });
  await expect(online).toHaveAttribute("aria-disabled", "true");
  await expect(online).toHaveAccessibleDescription("Online search is off");
  await expect(page.getByText("Online search is off. Results come from your saved pages.")).toBeVisible();
});

test("suggestions: debounced, keyboard navigable, Enter on an option searches for it", async ({ page }) => {
  const calls: string[] = [];
  await page.route("**/api/search/suggestions**", (route) => {
    calls.push(new URL(route.request().url()).searchParams.get("q") ?? "");
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ q: "astr", items: [{ kind: "title", text: "Astronomy", url: "https://x.test/", pageId: "pg_1", domain: "x.test" }, { kind: "query", text: "astronomy" }, { kind: "domain", text: "example.test", count: 3 }] }) });
  });
  await stub(page, () => response());
  await page.goto("/");
  const box = page.getByRole("combobox", { name: /Search your archive/ });
  await box.click();
  await box.pressSequentially("astr", { delay: 20 });
  const list = page.getByRole("listbox", { name: "Suggestions" });
  await expect(list.getByRole("option")).toHaveCount(3);
  expect(calls).toEqual(["astr"]); // one request for the finished word, not one per key
  await expect(page.getByTestId("suggestions-status")).toContainText("3 suggestions available");
  await box.press("ArrowUp");
  await expect(list.getByRole("option").nth(2)).toHaveAttribute("aria-selected", "true");
  await box.press("Enter");
  await expect(page).toHaveURL(/q=site%3Aexample\.test/);
});

test("results page has no serious axe violations in both themes", async ({ page }) => {
  await stub(page, () => response({ didYouMean: { text: "astronomy", corrected: [], appliedAutomatically: true } }));
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/search?q=astronamy&type=html");
    await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^(?!.*dark).*$/);
    await expect(page.getByTestId("search-result")).toHaveCount(3);
    await page.getByRole("button", { name: /Advanced filters/ }).click();
    await page.getByTestId("operator-help").click();
    expect(await serious(page)).toEqual([]);
    await page.keyboard.press("Escape");
  }
});

test("on a narrow screen the filters sit behind a button and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await stub(page, () => response());
  await page.goto("/search?q=astronomy");
  await expect(page.getByTestId("search-result").first()).toBeVisible();
  await expect(page.getByTestId("filters")).toBeHidden();
  await page.getByTestId("filters-toggle").click();
  await expect(page.getByTestId("filters")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a saved search is run through its own endpoint, and changing a filter makes it a new search", async ({ page }) => {
  const runs: string[] = [];
  const bodies = await stub(page, () => response());
  await page.route("**/api/search/saved/ss_1/run", (route) => {
    runs.push(route.request().postData() ?? "");
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response()) });
  });
  await page.goto("/search?q=astronomy&saved=ss_1");
  await expect(page.getByTestId("search-result")).toHaveCount(3);
  expect(runs).toHaveLength(1);
  expect(bodies).toHaveLength(0);
  await page.getByRole("checkbox", { name: /example\.test/ }).click();
  await expect(page).not.toHaveURL(/saved=/);
  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toMatchObject({ filters: { domains: ["example.test"] } });
});

test("a result collapses near copies under 'Also at' and shows the title with marks", async ({ page }) => {
  await stub(page, () => response({ results: [result(1, { titleHtml: "Page 1 about <mark>astronomy</mark>", alsoAt: [{ pageId: "pg_9", url: "https://mirror.test/x", title: "Mirror of page 1" }] })] }));
  await page.goto("/search?q=astronomy");
  const item = page.getByTestId("search-result").first();
  await expect(item.getByTestId("result-title").locator("mark")).toHaveText("astronomy");
  await expect(item.getByTestId("result-also-at")).toContainText("Also at 1 other page: Mirror of page 1");
});
