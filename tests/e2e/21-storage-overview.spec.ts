import { expect, test } from "@playwright/test";
import { articleUrl, login, mode, savePage, setWorkOffline } from "./helpers";
import { deleteSource, makeSourcedPage, serious, usage } from "./storage-helpers";

// T-09: the storage overview, and changing a source's priority to see the effect on usage and on the removal preview.
test.skip(mode() !== "real-server", "needs the real server");

test.beforeEach(async ({ page }) => {
  await login(page);
  await setWorkOffline(page, false);
});

test("the Storage area links to every storage screen", async ({ page }) => {
  await page.goto("/storage");
  const nav = page.getByRole("navigation", { name: "Storage and settings sections" });
  for (const name of ["Space", "Volumes", "Policy", "Removal preview", "Check and repair", "Removal record"]) await expect(nav.getByRole("link", { name })).toBeVisible();
  await page.getByRole("link", { name: "Open the storage overview" }).click();
  await expect(page).toHaveURL(/\/storage\/space$/);
  await expect(page.getByRole("navigation", { name: "Storage and settings sections" }).getByRole("link", { name: "Space" })).toHaveAttribute("aria-current", "page");
});

test("the overview shows volumes, usage four ways, an honest forecast and the removal state", async ({ page }) => {
  await savePage(page, articleUrl("/astronomy"));
  await page.goto("/storage/space");
  await expect(page.getByRole("heading", { level: 1, name: "Storage overview" })).toBeVisible();

  // Volumes: capacity, used, available, reservations and a disk-usage figure.
  const card = page.getByTestId("volume-card").first();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("volume-state")).toHaveText("Online");
  await expect(card).toContainText("Size of the volume");
  await expect(card).toContainText("Used by NoConBrain");
  await expect(card).toContainText("Available");
  await expect(card).toContainText("Promised to running downloads");
  await expect(card.getByRole("progressbar", { name: /Disk usage of/ })).toBeVisible();
  await expect(card.getByTestId("volume-pct")).toContainText(/Disk usage \d+%/);

  // Usage by priority, source, kind and volume. Each is a table, so the numbers are text, not only bars.
  for (const [by, name] of [["priority", "Usage by priority"], ["source", "Usage by source"], ["kind", "Usage by kind of file"], ["volume", "Usage by volume"]] as const) {
    const section = page.getByTestId(`usage-${by}`);
    await expect(section.getByRole("heading", { name })).toBeVisible();
    await expect(section.getByRole("table", { name })).toBeVisible();
    await expect(section.getByTestId("usage-total")).toContainText(/\d/);
  }
  const prio = page.getByTestId("usage-priority");
  await expect(prio.getByRole("columnheader")).toHaveText(["Priority", "Only here", "Shared", "Files"]);
  await expect(prio.getByTestId("usage-row").filter({ hasText: "P1 Protected" })).toBeVisible();
  await expect(prio.getByTestId("usage-row").filter({ hasText: "P4 Opportunistic" })).toBeVisible();

  // The forecast is labelled as an estimate, is a range, and lists what it assumes.
  const fc = page.getByTestId("forecast");
  await expect(fc.getByTestId("forecast-label")).toHaveText("Estimate");
  await expect(fc.getByTestId("forecast-note")).toContainText("This is an estimate, not a promise");
  await expect(fc.getByTestId("forecast-growth")).toHaveText(/^(Between .* and .* a day|No growth expected)/);
  await expect(fc.getByTestId("forecast-used")).toHaveText(/^Between .* and .* in \d+ days$/);
  expect(await fc.getByTestId("forecast-assumptions").getByRole("listitem").count()).toBeGreaterThan(0);

  // Eviction and maintenance state.
  await expect(page.getByTestId("eviction-state")).toContainText("Protected (P1) content is never removed automatically");
  await expect(page.getByTestId("eviction-state")).toContainText("Automatic removal");
  await expect(page.getByTestId("maintenance-state")).toBeVisible();
  expect(await serious(page)).toEqual([]);
});

test("changing a source's priority changes usage by priority and the removal preview", async ({ page }) => {
  const name = `Impact ${Date.now() % 100000}`;
  const { source, pageId, url } = await makeSourcedPage(page, name, "/moon", "P3");
  try {
    const preview = async () => {
      await page.goto("/storage/eviction");
      await page.getByRole("button", { name: /Advanced settings/ }).click();
      await page.getByTestId("ev-need").fill("500");
      await page.getByLabel("Room needed, unit").selectOption("GB");
      await page.getByTestId("plan-preview").click();
      await expect(page.getByTestId("plan")).toBeVisible();
    };

    // Before: at P3 the page is on the list, with a reason.
    await preview();
    await expect(page.getByTestId("plan-dry")).toHaveText("Dry run: nothing has been removed");
    const item = page.getByTestId("plan-item").filter({ hasText: url });
    await expect(item).toBeVisible();
    await expect(item.getByTestId("plan-item-reason")).not.toBeEmpty();
    await expect(item).toContainText("P3 Standard");
    const before = await usage(page, "priority");
    const p1Before = before.items.find((i) => i.key === "P1")?.exclusiveBytes ?? 0;
    const p3Before = before.items.find((i) => i.key === "P3")?.exclusiveBytes ?? 0;

    // Change the priority where the usage is shown.
    await page.goto("/storage/space");
    const srcRow = page.getByTestId("usage-source").getByTestId("usage-row").filter({ hasText: name });
    await expect(srcRow).toBeVisible();
    const prioRows = page.getByTestId("usage-priority").getByTestId("usage-row");
    const p1Text = await prioRows.filter({ hasText: "P1 Protected" }).getByTestId("usage-exclusive").innerText();
    const select = srcRow.getByLabel(`Priority of ${name}`);
    await expect(select).toHaveValue("P3");
    await select.selectOption("P1");
    await expect(page.getByText("Priority changed")).toBeVisible();
    await expect(select).toHaveValue("P1");

    // After: usage moved up to P1 (screen and server agree).
    await expect(prioRows.filter({ hasText: "P1 Protected" }).getByTestId("usage-exclusive")).not.toHaveText(p1Text);
    const after = await usage(page, "priority");
    expect(after.items.find((i) => i.key === "P1")!.exclusiveBytes).toBeGreaterThan(p1Before);
    expect(after.items.find((i) => i.key === "P3")?.exclusiveBytes ?? 0).toBeLessThan(p3Before);

    // And the preview now leaves it alone, naming Protected as the reason.
    await preview();
    await expect(page.getByTestId("plan-item").filter({ hasText: url })).toHaveCount(0);
    const skipped = page.getByTestId("skip-item").filter({ hasText: url });
    await expect(skipped).toBeVisible();
    await expect(skipped.getByTestId("skip-reason")).toContainText("Protected content is never removed automatically");
    await expect(page.getByTestId("skip-counts")).toContainText("Protected (P1)");

    // The explanation page agrees.
    await page.goto(`/storage/pages/${pageId}`);
    await expect(page.getByTestId("why-headline")).toHaveText("Automatic removal can't take this page now.");
    await expect(page.getByTestId("reference-row").filter({ hasText: name })).toContainText("P1 Protected");
  } finally {
    await deleteSource(page, source.id);
  }
});
