import { expect, test } from "@playwright/test";
import { articleUrl, login, mode, setWorkOffline } from "./helpers";
import { CSRF, candidates, enableDiscovery, openCandidate, resetDiscovery, rowFor, seedCandidates, showState, waitDownloadDone } from "./discovery-helpers";

// D-07: the Discovery candidates page against the real server. Candidates come from real captures of the fixture site with link
// collection switched on, so the whole path runs: pipeline stage 14, the store, the scorer, the runner and an ordinary download.
test.skip(mode() !== "real-server", "needs the real server");

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
  await resetDiscovery(page);
  await enableDiscovery(page);
});
test.afterEach(async ({ page }) => {
  await resetDiscovery(page);
});

test("review candidates, approve one, run a pass and see the resulting download job", async ({ page }) => {
  const fresh = await seedCandidates(page, 2);
  const target = fresh[0]!;

  await openCandidate(page, target);
  await expect(page.getByRole("heading", { level: 1, name: "Discovery" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Areas" }).getByRole("link", { name: "Discovery" })).toHaveAttribute("aria-current", "page");
  const row = rowFor(page, target);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("candidate-url")).toHaveText(target.url);
  await expect(row.getByTestId("candidate-state")).toHaveText("To review");
  await expect(row.getByTestId("candidate-score")).toContainText("Score");

  // Approve: a dialog lets the Human pick a source or collection, both optional.
  await row.getByTestId("candidate-approve").click();
  const dialog = page.getByTestId("approve-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("File under a source (optional)")).toBeVisible();
  await expect(dialog.getByLabel("Add to a collection once saved (optional)")).toBeVisible();
  await dialog.getByTestId("approve-confirm").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("announce")).toContainText("Approved");
  await expect(rowFor(page, target)).toHaveCount(0); // left the "To review" tab

  await showState(page, "approved");
  const approved = rowFor(page, target);
  await expect(approved).toBeVisible();
  await expect(approved.getByTestId("candidate-job")).toContainText("downloads on the next pass");
  expect((await candidates(page, "state=approved")).items.map((c) => c.id)).toContain(target.id);

  // Nothing is downloaded until a pass runs.
  const job0 = await (await page.request.get(`/api/discovery/candidates/${target.id}`)).json();
  expect(job0.downloadId).toBeUndefined();

  await page.getByTestId("run-pass").click();
  await expect(page.getByText(/Started \d+ downloads?/).first()).toBeVisible();

  // The candidate now has a download, and the Downloads page lists that job.
  let downloadId = "";
  await expect
    .poll(async () => {
      const c = (await (await page.request.get(`/api/discovery/candidates/${target.id}`)).json()) as { downloadId?: string; state: string };
      downloadId = c.downloadId ?? "";
      return c.state;
    }, { timeout: 30_000 })
    .toMatch(/queued|archived/);
  expect(downloadId).not.toBe("");
  const job = (await (await page.request.get(`/api/downloads/${downloadId}`)).json()) as { requestedBy: string; priority?: string };
  expect(job.requestedBy).toBe("discovery");
  await waitDownloadDone(page, downloadId);

  // The candidate moves to Saved when the next pass reconciles it (the timer does it every 30 seconds; here the button does).
  await page.getByTestId("run-pass").click();
  await showState(page, "archived");
  const saved = rowFor(page, target);
  await expect(saved).toBeVisible({ timeout: 15_000 });
  await saved.getByRole("link", { name: /Open Downloads/ }).click();
  await expect(page).toHaveURL(/\/downloads$/);
  await page.getByTestId("tab-completed").click();
  await expect(page.locator(`[data-testid="download-row"][data-id="${downloadId}"]`)).toBeVisible();
});

test("dismiss removes a candidate for good", async ({ page }) => {
  const fresh = await seedCandidates(page);
  const target = fresh[0]!;
  await openCandidate(page, target);
  const row = rowFor(page, target);
  await row.getByTestId("candidate-dismiss").click();
  await expect(page.getByTestId("announce")).toContainText("will not be suggested again");
  await expect(rowFor(page, target)).toHaveCount(0);
  // Focus is not lost to the page body when the row it was on goes away.
  await expect(page.getByTestId("list-heading")).toBeFocused();

  await showState(page, "dismissed");
  await expect(rowFor(page, target).getByTestId("candidate-state")).toHaveText("Dismissed");
  expect((await candidates(page, "state=dismissed")).items.map((c) => c.id)).toContain(target.id);
  // A dismissed candidate offers no Dismiss button, and can still be approved again.
  await expect(rowFor(page, target).getByTestId("candidate-dismiss")).toHaveCount(0);
  await expect(rowFor(page, target).getByTestId("candidate-approve")).toBeVisible();
});

test("why suggested: the score components add up to the score", async ({ page }) => {
  const fresh = await seedCandidates(page);
  const target = fresh[0]!;
  await openCandidate(page, target);
  const row = rowFor(page, target);
  const why = row.getByTestId("candidate-why");
  await expect(why).toHaveAttribute("aria-expanded", "false");
  await why.click();
  await expect(why).toHaveAttribute("aria-expanded", "true");
  const panel = row.getByTestId("why-panel");
  await expect(panel.getByRole("heading", { name: "Why this was suggested" })).toBeVisible();
  await expect(panel.getByTestId("why-table")).toBeVisible();

  const values = (await panel.getByTestId("why-contribution").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-value"))))) as number[];
  expect(values.length).toBe(8); // all eight factors are listed, even those that add nothing
  const total = Number((await panel.getByTestId("why-total").innerText()).trim());
  const sum = values.reduce((a, b) => a + b, 0);
  expect(Math.abs(sum - total)).toBeLessThan(1e-6);
  await expect(panel.getByTestId("why-sum")).toHaveAttribute("data-adds-up", "true");

  // The same figures as the server's explain API, and the plain sentences and provenance are there.
  const explain = (await (await page.request.get(`/api/discovery/candidates/${target.id}/explain`)).json()) as { score: number; summary: string[]; components: { contribution: number }[] };
  // Recent activity fades with time, so a second look a moment later can differ in the fifth decimal place.
  expect(Math.abs(explain.score - total)).toBeLessThan(0.01);
  expect(explain.components).toHaveLength(values.length);
  expect(explain.summary.length).toBeGreaterThan(0);
  await expect(panel.getByTestId("why-sentences").locator("li")).toHaveCount(explain.summary.length);
  await expect(panel.getByTestId("why-provenance-item").first()).toContainText("Link on a saved page");
  await expect(panel.getByTestId("why-not-stored")).toHaveCount(0);

  // It closes again, and focus stays on the button.
  await why.press("Enter");
  await expect(why).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toHaveCount(0);
  await expect(why).toBeFocused();
});

test("a candidate whose score is not stored says so, and shows no title", async ({ page }) => {
  const fresh = await seedCandidates(page);
  const target = fresh[0]!;
  // Stand in for a search provider that allows no storage (Brave): the server answers with the address only and scoreStored false.
  await page.route(`**/api/discovery/candidates/${target.id}/explain`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const r = await route.fetch();
    const body = (await r.json()) as Record<string, unknown>;
    await route.fulfill({ response: r, json: { ...body, scoreStored: false } });
  });
  await openCandidate(page, target);
  const row = rowFor(page, target);
  await expect(row.getByTestId("candidate-title")).toHaveCount(0);
  await row.getByTestId("candidate-why").click();
  const note = row.getByTestId("why-not-stored");
  await expect(note).toBeVisible();
  await expect(note).toContainText("Only the address is kept");
  await expect(note).toContainText("worked out again");
  // The table is still shown: it is recomputed, and it still adds up.
  await expect(row.getByTestId("why-sum")).toHaveAttribute("data-adds-up", "true");
});

test("filters, sort, cursor paging and bulk actions", async ({ page }) => {
  // Thirty bookmarks of unsaved addresses make thirty candidates with one reason, "bookmark", so the filter can isolate them.
  const tag = `bulk${Date.now() % 100000}`;
  await enableDiscovery(page, { passive: { fromLinks: true, fromBookmarks: true } });
  const made: string[] = [];
  for (let i = 0; i < 30; i++) {
    const url = articleUrl(`/${tag}/${String(i).padStart(2, "0")}`);
    const r = await page.request.post("/api/bookmarks", { headers: CSRF, data: { url, title: `Bulk ${i}` } });
    expect(r.ok(), await r.text()).toBeTruthy();
    made.push(((await r.json()) as { id: string }).id);
  }
  const coll = await page.request.post("/api/collections", { headers: CSRF, data: { name: `Bulk ${tag}` } });
  expect(coll.ok(), await coll.text()).toBeTruthy();
  const collection = (await coll.json()) as { id: string; name: string };
  try {
    await expect.poll(async () => (await candidates(page, `provenance=bookmark&q=${tag}&limit=200`)).total, { timeout: 30_000 }).toBe(30);
    await page.goto("/discovery");

    // Text filter and reason filter narrow the list; the total says how many.
    await page.getByLabel("Address or title contains").fill(tag);
    await page.getByLabel("Reason").selectOption("bookmark");
    await expect(page.getByTestId("list-total")).toContainText("30 suggestions");
    await expect(page.getByTestId("candidate-row")).toHaveCount(25);
    await expect(page.getByTestId("candidate-row").first().getByTestId("candidate-state")).toHaveText("To review");

    // Cursor paging: "Show more" appends the rest.
    await page.getByTestId("load-more").click();
    await expect(page.getByTestId("candidate-row")).toHaveCount(30);
    await expect(page.getByTestId("load-more")).toHaveCount(0);

    // Sort: oldest first and newest first put different rows at the top.
    const firstUrl = () => page.getByTestId("candidate-url").first().innerText();
    await page.getByLabel("Order").selectOption("recent");
    await expect(page.getByTestId("candidate-row")).toHaveCount(25);
    const recent = await firstUrl();
    await page.getByLabel("Order").selectOption("oldest");
    await expect(page.getByTestId("candidate-row")).toHaveCount(25);
    await expect.poll(firstUrl).not.toBe(recent);

    // Host and score range.
    await page.getByLabel("Site").fill("no-such-host.invalid");
    await expect(page.getByText("No suggestions match")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await page.getByLabel("Address or title contains").fill(tag);
    await page.getByLabel("Lowest score").fill("100000");
    await expect(page.getByText("No suggestions match")).toBeVisible();
    await page.getByLabel("Lowest score").fill("");

    // Bulk: select three, approve into a collection, then dismiss two with a confirmation.
    await expect(page.getByTestId("candidate-row")).toHaveCount(25);
    const boxes = page.getByTestId("candidate-select");
    await boxes.nth(0).click();
    await boxes.nth(1).click();
    await boxes.nth(2).click();
    await expect(page.getByTestId("bulk-count")).toHaveText("3 selected");
    await page.getByTestId("bulk-approve").click();
    const dlg = page.getByTestId("approve-dialog");
    await dlg.getByLabel("Add to a collection once saved (optional)").selectOption({ label: collection.name });
    await dlg.getByTestId("approve-confirm").click();
    await expect(page.getByTestId("announce")).toContainText("Approved 3 of 3");
    const approved = await candidates(page, `state=approved&q=${tag}`);
    expect(approved.total).toBe(3);
    expect(approved.items.every((c) => c.suggestedCollectionId === collection.id)).toBe(true);

    await boxes.nth(0).click();
    await boxes.nth(1).click();
    await page.getByTestId("bulk-dismiss").click();
    const confirm = page.getByTestId("dismiss-dialog");
    await expect(confirm).toContainText("never suggested again");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("bulk-dismiss")).toBeFocused(); // focus returns to the button that opened it
    await page.getByTestId("bulk-dismiss").click();
    await page.getByTestId("dismiss-confirm").click();
    await expect(page.getByTestId("announce")).toContainText("Dismissed 2 of 2");
    expect((await candidates(page, `state=dismissed&q=${tag}`)).total).toBe(2);
  } finally {
    await page.request.delete(`/api/collections/${collection.id}`, { headers: CSRF });
    for (const id of made) await page.request.delete(`/api/bookmarks/${id}`, { headers: CSRF });
  }
});

test("with discovery off the page explains it and offers the settings", async ({ page }) => {
  await resetDiscovery(page);
  await page.goto("/discovery");
  await expect(page.getByTestId("discovery-off")).toContainText("off by default");
  await expect(page.getByRole("link", { name: "Open the settings" }).first()).toBeVisible();
  await expect(page.getByTestId("run-pass")).toBeDisabled();
});
