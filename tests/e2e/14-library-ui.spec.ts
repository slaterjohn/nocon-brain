import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { activeFrame, linkGraphUrl, login, mode, savePage, articleUrl, setWorkOffline } from "./helpers";

// C-17: the Library UI. Create a source, preview it, run it, watch the downloads, browse the result, add pages to a collection.
test.skip(mode() !== "real-server", "needs the real server");

const CSRF = { "X-NoCon-CSRF": "1" };
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
async function serious(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).exclude('iframe[data-testid="archive-frame"]').analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
});

test("the source wizard: type, address, scope, schedule, preview, create, run, watch, browse, add to a collection", async ({ page }) => {
  const name = `Link graph ${Date.now() % 100000}`;
  await page.goto("/library/sources");
  await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Library sections" }).getByRole("link", { name: "Sources" })).toHaveAttribute("aria-current", "page");
  // The built-in sources are listed with status, pages and priority.
  await expect(page.getByTestId("source-row").filter({ hasText: "Quick saves" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Sources" }).getByRole("columnheader")).toHaveText(["Name", "Status", "Last run", "Next run", "Pages", "Size", "Priority", "Actions"]);
  await page.getByTestId("new-source").click();
  await expect(page.getByTestId("step-heading")).toContainText("Step 1 of 4: Type");

  // Step 1, by keyboard: types that are not built yet are listed, disabled, with the reason.
  for (const t of ["Saved search", "Knowledge package"]) {
    await expect(page.getByRole("radio", { name: t })).toBeDisabled();
  }
  await expect(page.getByText("Coming later. Arrives with online search.")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByTestId("error-summary")).toBeFocused();
  await expect(page.getByTestId("error-summary")).toContainText("Choose a source type.");
  await page.getByRole("radio", { name: "Website" }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("radio", { name: "Website" })).toBeChecked();
  await page.getByRole("button", { name: "Next" }).click();

  // Step 2: live validation of the address, then the mode, profile and custom limits.
  await expect(page.getByTestId("step-heading")).toContainText("Step 2 of 4");
  await expect(page.getByTestId("step-heading")).toBeFocused();
  await page.getByLabel("Name", { exact: true }).fill(name);
  const url = page.getByTestId("start-url");
  await url.fill("not a url");
  await url.blur();
  await expect(page.getByText("Enter a web address, such as https://example.org/.")).toBeVisible();
  await url.fill("example.org/docs");
  await expect(page.getByRole("button", { name: "Use https://example.org/docs" })).toBeVisible();
  await url.fill(linkGraphUrl("/"));
  await expect(page.getByTestId("url-status")).toContainText("This looks like a valid web address.");
  await page.getByRole("radio", { name: "Custom" }).check();
  await page.getByLabel("Depth (links from the start)").fill("1");
  await page.getByLabel("Maximum pages").fill("3");
  // Rarely changed scope options are behind the disclosure.
  const adv = page.getByRole("button", { name: /Advanced settings: scope/ });
  await expect(adv).toHaveAttribute("aria-expanded", "false");
  await adv.click();
  await expect(page.getByLabel("Respect robots.txt")).toBeChecked();
  await adv.click();
  await page.getByRole("button", { name: "Next" }).click();

  // Step 3: schedule, window, priority, retention and eviction.
  await expect(page.getByTestId("step-heading")).toContainText("Step 3 of 4");
  await page.getByTestId("schedule-kind").selectOption("daily");
  await page.getByLabel("Time of day").fill("03:30");
  await page.getByLabel("Only download between certain hours").click();
  await expect(page.getByLabel("Opens at")).toBeVisible();
  for (const p of ["P1 Protected", "P2 Important", "P3 Standard", "P4 Opportunistic"]) await expect(page.getByRole("radio", { name: p })).toBeVisible();
  await page.getByRole("radio", { name: "P1 Protected" }).check();
  await expect(page.getByTestId("p1-note")).toBeHidden(); // automatic removal is off by default for P1
  await page.getByLabel("Allow automatic removal when space runs short").click();
  await expect(page.getByTestId("p1-note")).toContainText("Protected (P1) takes precedence");
  await page.getByRole("radio", { name: "P3 Standard" }).check();
  await page.getByTestId("retention-mode").selectOption("all");
  await page.getByRole("button", { name: "Next" }).click();

  // Step 4: the preview is an estimate, with scope and warnings, before anything runs.
  await expect(page.getByTestId("step-heading")).toContainText("Step 4 of 4");
  await expect(page.getByTestId("review-summary")).toContainText(name);
  await expect(page.getByTestId("preview-pages")).toContainText("3");
  await expect(page.getByTestId("preview-panel")).toContainText("Pages (estimate)");
  // The size is a range from the server's byte estimate, labelled as an estimate; the size limit is stated separately.
  await expect(page.getByTestId("preview-panel")).toContainText("Size (estimate)");
  await expect(page.getByTestId("preview-bytes")).toHaveText(/\d.* to \d/);
  await expect(page.getByTestId("preview-size-limit")).toContainText("Size limit:");
  await expect(page.getByTestId("preview-panel")).toContainText("These figures are an estimate");
  await expect(page.getByTestId("preview-scope")).toContainText("Saves pages on the same site");
  // Nothing has been created yet.
  const before = (await (await page.request.get("/api/sources?limit=200")).json()) as { items: { name: string }[] };
  expect(before.items.some((s) => s.name === name)).toBe(false);

  await page.getByTestId("create-and-run").click();
  await expect(page).toHaveURL(/\/library\/sources\/src_/);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

  // Watch the download: it shows up in Completed by itself, with a live update and no reload.
  await page.goto("/downloads");
  await expect(page.getByRole("heading", { level: 1, name: "Downloads" })).toBeVisible();
  await expect(page.getByTestId("window-status")).toBeVisible();
  await page.getByTestId("tab-completed").click();
  const row = page.getByTestId("download-row").filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 45_000 });
  await expect(row.getByTestId("download-state")).toHaveText("Completed");

  // Browse the result.
  await page.getByRole("navigation", { name: "Areas" }).getByRole("link", { name: "Library" }).click();
  await page.getByRole("navigation", { name: "Library sections" }).getByRole("link", { name: "Sources" }).click();
  const srcRow = page.getByTestId("source-row").filter({ hasText: name });
  await expect(srcRow).toBeVisible();
  await expect(srcRow.getByTestId("source-status")).toHaveText("Up to date");
  await srcRow.getByRole("link", { name }).click();
  await expect(page.getByTestId("source-stats")).toContainText("Pages");
  const pageRows = page.getByTestId("source-page-row");
  await expect(pageRows.first()).toBeVisible();
  expect(await pageRows.count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId("run-row").first()).toBeVisible();

  // Page detail: metadata, version selector, references, legend, open in the browser.
  await pageRows.first().getByRole("link").click();
  await expect(page.getByTestId("page-meta")).toContainText("Last saved");
  await expect(page.getByTestId("version-option").first()).toBeChecked();
  await expect(page.getByTestId("version-details")).toContainText("Version 1");
  await expect(page.getByTestId("page-refs")).toContainText(name);
  await expect(page.getByTestId("link-legend")).toContainText("Live only.");
  await page.getByTestId("open-version").click();
  await expect(activeFrame(page)).toBeVisible();

  // Library: search, filter by source, select two pages and add them to a new collection.
  await page.goto("/library");
  await page.getByRole("button", { name: /Filters/ }).click();
  await page.getByLabel("Source", { exact: true }).selectOption({ label: name });
  const rows = page.getByTestId("library-row");
  await expect(rows.first()).toBeVisible();
  await expect(page.getByTestId("library-count")).toHaveText(/^[2-3] pages$/);
  const total = Number((await page.getByTestId("library-count").innerText()).split(" ")[0]);
  await expect(rows).toHaveCount(total);
  await rows.nth(0).getByRole("checkbox").check();
  await rows.nth(1).getByRole("checkbox").check();
  await expect(page.getByTestId("bulk-bar")).toContainText("2 selected");
  await page.getByTestId("bulk-add").click();
  const dialog = page.getByRole("dialog", { name: "Add to a collection" });
  await dialog.getByTestId("add-col-target").selectOption({ label: "New collection…" });
  const colName = `Reading ${Date.now() % 100000}`;
  await dialog.getByLabel("Name of the new collection").fill(colName);
  await dialog.getByTestId("add-col-confirm").click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole("navigation", { name: "Library sections" }).getByRole("link", { name: "Collections" }).click();
  const node = page.getByTestId("collection-node").filter({ hasText: colName });
  await expect(node).toBeVisible();
  await node.click();
  await expect(page.getByTestId("collection-item")).toHaveCount(2);
});

test("source controls: pause, resume, switch off and on, and delete with its consequences", async ({ page }) => {
  const name = `Controls ${Date.now() % 100000}`;
  const created = await page.request.post("/api/sources", {
    headers: CSRF,
    data: { name, type: "single_page", startUrl: articleUrl("/tide-pools"), profile: "focused", priority: "P2" },
  });
  expect(created.status(), await created.text()).toBe(201);
  const src = (await created.json()) as { id: string };
  await page.goto(`/library/sources/${src.id}`);
  await expect(page.getByTestId("source-status")).toHaveText("Not run yet");

  await page.getByTestId("pause-source").click();
  await expect(page.getByTestId("resume-source")).toBeVisible();
  await expect(page.getByTestId("source-status")).toHaveText("Paused");
  await page.getByTestId("resume-source").click();
  await expect(page.getByTestId("pause-source")).toBeVisible();

  await page.getByTestId("toggle-enabled").click();
  await expect(page.getByTestId("source-status")).toHaveText("Switched off");
  await expect(page.getByTestId("run-now")).toBeDisabled();
  await page.getByTestId("toggle-enabled").click();
  await expect(page.getByTestId("run-now")).toBeEnabled();

  await page.getByTestId("run-now").click();
  await expect.poll(async () => ((await (await page.request.get(`/api/sources/${src.id}/stats`)).json()) as { pages: number }).pages, { timeout: 30_000 }).toBe(1);

  await page.getByTestId("delete-source").click();
  const dialog = page.getByRole("dialog", { name: "Delete this source?" });
  await expect(dialog.getByTestId("delete-source-preview")).toContainText("stays in your Library");
  await expect(dialog.getByTestId("delete-source-preview")).toContainText("lose the protection");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("delete-source")).toBeFocused();
  await page.getByTestId("delete-source").click();
  await page.getByTestId("confirm-delete-source").click();
  await expect(page).toHaveURL(/\/library\/sources$/);
  await expect(page.getByTestId("source-row").filter({ hasText: name })).toHaveCount(0);
  // The page is still in the Library.
  await page.goto("/library");
  await page.getByLabel("Search saved pages").fill("tide-pools");
  await expect(page.getByTestId("library-row").filter({ hasText: "/tide-pools" })).toBeVisible();
});

test("editing a source: server field errors land on the field, and the advanced disclosure opens for them", async ({ page }) => {
  const name = `Edit ${Date.now() % 100000}`;
  const created = await page.request.post("/api/sources", {
    headers: CSRF,
    data: { name, type: "website", startUrl: linkGraphUrl("/"), profile: "focused", priority: "P3" },
  });
  const src = (await created.json()) as { id: string };
  await page.goto(`/library/sources/${src.id}/edit`);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(name);
  await page.getByLabel("Name", { exact: true }).fill(`${name} renamed`);
  const adv = page.getByRole("button", { name: /Advanced settings: behaviour/ });
  await adv.click();
  await page.getByLabel(/Requests at once/).fill("99");
  await page.getByTestId("save-source").click();
  const summary = page.getByTestId("error-summary");
  await expect(summary).toBeFocused();
  await expect(summary).toContainText("Requests at once");
  await page.getByLabel(/Requests at once/).fill("1");
  await page.getByTestId("save-source").click();
  await expect(page.getByRole("heading", { level: 1, name: `${name} renamed` })).toBeVisible();
  await expect(page.getByTestId("source-settings")).toContainText("Priority");
});

test("collections: nested tree with keyboard navigation, move, rule editor and priority floor", async ({ page }) => {
  const stamp = Date.now() % 100000;
  const mk = async (data: object) => ((await (await page.request.post("/api/collections", { headers: CSRF, data })).json()) as { id: string });
  const parent = await mk({ name: `Parent ${stamp}`, kind: "manual", icon: "library" });
  await mk({ name: `Child ${stamp}`, kind: "manual", parentId: parent.id, icon: "folder-open" });
  await page.goto(`/library/collections?c=${parent.id}`);

  const tree = page.getByRole("tree", { name: "Collections" });
  await expect(tree).toBeVisible();
  const parentItem = tree.getByRole("treeitem", { name: new RegExp(`Parent ${stamp}`) }).first();
  await expect(parentItem).toHaveAttribute("aria-level", "1");
  await expect(parentItem).toHaveAttribute("aria-expanded", "true");
  const child = tree.getByRole("treeitem", { name: new RegExp(`Child ${stamp}`) });
  await expect(child).toHaveAttribute("aria-level", "2");

  // Keyboard: arrows move, Left closes, Right opens, Enter selects.
  await parentItem.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(parentItem).toHaveAttribute("aria-expanded", "false");
  await expect(child).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(parentItem).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowRight");
  await expect(child).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(child).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(parentItem).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  await expect(tree.getByRole("treeitem").first()).toBeFocused();

  // Move the child to the top level with the keyboard-friendly control.
  await child.focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("move-to").selectOption("");
  await page.getByTestId("move-button").click();
  await expect(tree.getByRole("treeitem", { name: new RegExp(`Child ${stamp}`) })).toHaveAttribute("aria-level", "1");

  // Create an automatic collection with a rule and a priority floor.
  await page.getByTestId("new-collection").click();
  const dialog = page.getByRole("dialog", { name: "New collection" });
  await dialog.getByLabel("Name", { exact: true }).fill(`Auto ${stamp}`);
  await dialog.getByLabel("Kind").selectOption("auto");
  await dialog.getByTestId("icon-picker").getByRole("radio", { name: "rocket" }).check({ force: true });
  await dialog.getByTestId("priority-floor").selectOption("P2");
  await dialog.getByLabel("Value for condition 1").fill(new URL(articleUrl("/")).hostname);
  await dialog.getByTestId("save-collection").click();
  await expect(dialog).toHaveCount(0);
  const auto = tree.getByRole("treeitem", { name: new RegExp(`Auto ${stamp}`) });
  await expect(auto).toBeVisible();
  await auto.click();
  await expect(page.getByTestId("collection-detail")).toContainText("Priority floor: P2 Important");

  // Delete: the explanation says pages stay.
  await page.getByTestId("delete-collection").click();
  await expect(page.getByRole("dialog", { name: "Delete this collection?" })).toContainText("stay in the Library");
  await page.getByTestId("confirm-delete-collection").click();
  await expect(tree.getByRole("treeitem", { name: new RegExp(`Auto ${stamp}`) })).toHaveCount(0);
});

test("downloads: tabs by state, failure reasons in plain English with the code in details, retry, pause and cancel", async ({ page }) => {
  // A page that does not exist fails with an HTTP error.
  const bad = await page.request.post("/api/archive/capture", { headers: CSRF, data: { url: articleUrl("/missing-for-downloads-test") } });
  expect(bad.status()).toBe(202);
  const api = await page.request.get("/api/downloads?state=failed&limit=100");
  expect(api.status(), await api.text()).toBe(200);
  await page.goto("/downloads");
  for (const t of ["Queued", "Running", "Paused", "Completed", "Failed", "Cancelled"]) await expect(page.getByRole("tab", { name: new RegExp(`^${t}`) })).toBeVisible();
  await page.getByTestId("tab-failed").click();
  const row = page.getByTestId("download-row").filter({ hasText: "missing-for-downloads-test" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByTestId("download-failure")).toContainText(/refused the request|does not exist/);
  await row.getByText("Details").click();
  await expect(row.getByTestId("failure-code")).toHaveText(/http_4xx|internal|network/);
  // A slow crawl can be paused, resumed and cancelled.
  const run = await page.request.post("/api/downloads", {
    headers: CSRF,
    data: { kind: "explore", url: linkGraphUrl("/"), priority: "P4", config: { depth: 2, maxPages: 30 } },
  });
  expect(run.status(), await run.text()).toBe(202);
  const job = (await run.json()) as { id: string; title: string };
  await page.getByTestId("tab-running").click();
  const live = page.getByTestId("download-row").filter({ has: page.locator(`[data-id="${job.id}"]`) }).or(page.locator(`[data-testid="download-row"][data-id="${job.id}"]`));
  await expect(live).toBeVisible({ timeout: 20_000 });
  await expect(live.getByRole("progressbar")).toBeVisible();
  await expect(live.getByTestId("dl-priority")).toHaveValue("P4");
  await live.getByTestId("dl-priority").selectOption("P2");
  await live.getByTestId("dl-pause").click();
  await page.getByTestId("tab-paused").click();
  const paused = page.locator(`[data-testid="download-row"][data-id="${job.id}"]`);
  await expect(paused).toBeVisible();
  await paused.getByTestId("dl-resume").click();
  await page.getByTestId("tab-running").click();
  await expect(page.locator(`[data-testid="download-row"][data-id="${job.id}"]`)).toBeVisible();
  await page.locator(`[data-testid="download-row"][data-id="${job.id}"]`).getByTestId("dl-cancel").click();
  await page.getByTestId("tab-cancelled").click();
  await expect(page.locator(`[data-testid="download-row"][data-id="${job.id}"]`)).toBeVisible({ timeout: 20_000 });
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme: no serious axe violations in the Library area`, () => {
    test.use({ colorScheme: scheme });

    test("lists, wizard steps, detail screens and dialogs", async ({ page }) => {
      const saved = await savePage(page, articleUrl("/astronomy"));
      const check = async (label: string) => expect(await serious(page), label).toEqual([]);
      await page.goto("/library");
      await expect(page.getByTestId("library-row").first()).toBeVisible();
      await page.getByRole("button", { name: /Filters/ }).click();
      await check("library with filters");
      await page.getByTestId("library-row").first().getByRole("checkbox").check();
      await check("library with bulk bar");
      await page.getByTestId("bulk-add").click();
      await expect(page.getByRole("dialog", { name: "Add to a collection" })).toBeVisible();
      await check("add to collection dialog");
      await page.keyboard.press("Escape");

      await page.goto(`/library/pages/${saved.pageId}`);
      await expect(page.getByTestId("page-meta")).toBeVisible();
      await check("page detail");

      await page.goto("/library/sources");
      await expect(page.getByTestId("source-row").first()).toBeVisible();
      await check("sources list");
      await page.goto("/library/sources/new");
      await check("wizard step 1");
      await page.getByRole("radio", { name: "Section of a site" }).check();
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByLabel("Name", { exact: true }).fill("Axe section");
      await page.getByTestId("start-url").fill(articleUrl("/"));
      await page.getByRole("button", { name: /Advanced settings: scope/ }).click();
      await check("wizard step 2 with advanced open");
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByTestId("schedule-kind").selectOption("weekly");
      await page.getByLabel("Only download between certain hours").click();
      await page.getByRole("button", { name: /Advanced settings: behaviour/ }).click();
      await check("wizard step 3 with advanced open");
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.getByTestId("preview-panel")).toContainText("Pages (estimate)");
      await check("wizard step 4 preview");
      await page.getByRole("button", { name: "Back" }).click();
      await page.getByRole("button", { name: "Back" }).click();
      await page.getByLabel("Name", { exact: true }).fill("");
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.getByTestId("error-summary")).toBeVisible();
      await check("wizard error summary");

      const first = page.getByTestId("source-row");
      await page.goto("/library/sources");
      await first.filter({ hasText: "Quick saves" }).getByRole("link", { name: "Quick saves" }).click();
      await expect(page.getByTestId("source-settings")).toBeVisible();
      await check("source detail");
      await page.getByTestId("edit-source").click();
      await expect(page.getByTestId("source-form")).toBeVisible();
      await check("source edit");

      await page.goto("/library/collections");
      await expect(page.getByRole("tree", { name: "Collections" })).toBeVisible();
      await check("collections");
      await page.getByTestId("new-collection").click();
      await page.getByLabel("Kind").selectOption("auto");
      await check("new collection dialog with rule editor");
      await page.keyboard.press("Escape");

      await page.goto("/downloads");
      await expect(page.getByTestId("window-status")).toBeVisible();
      await check("downloads");
    });
  });
}

test("copy is UK English and sentence case on the Library screens", async ({ page }) => {
  const banned = [/\bcolor\b/i, /\borganize/i, /\bcatalog\b/i, /\bbehavior\b/i, /\bcancelled\b.*\bcanceled\b/i, /\bprioritize/i];
  for (const path of ["/library", "/library/sources", "/library/sources/new", "/library/collections", "/downloads"]) {
    await page.goto(path);
    await expect(page.locator("main h1")).toBeVisible();
    const text = await page.locator("main").innerText();
    for (const re of banned) expect(text, `${path} ${re}`).not.toMatch(re);
  }
});
